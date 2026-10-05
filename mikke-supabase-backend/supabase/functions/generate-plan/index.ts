import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  type AiCallResult,
  buildAiUserPayload,
  type Conditions,
  createPlanContext,
  generateValidPlan,
  planSchema,
  rankCandidates,
  SYSTEM_PROMPT,
  validateRequestedWindow,
} from "./plan.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// Total AI attempts per request (first try + one feedback-driven retry). Kept at 2 so the
// whole request stays well inside the frontend's 20 s timeout.
const MAX_AI_ATTEMPTS = 2;
const OPENAI_TIMEOUT_MS = 9_000;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function log(level: "info" | "error", message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

// Event tracking must never block plan generation, but a failed insert silently
// drops KPI data, so log it where it shows up in the Edge Function logs.
async function recordEvent(
  supabase: SupabaseClient,
  event: { p_name: string; p_properties: Record<string, unknown> },
) {
  try {
    const { error } = await supabase.rpc("track_event", event);
    if (error) {
      console.error(JSON.stringify({
        level: "error",
        message: "track_event_failed",
        event_name: event.p_name,
        code: error.code,
        detail: error.message,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: "error",
      message: "track_event_threw",
      event_name: event.p_name,
      detail: err instanceof Error ? err.message : String(err),
    }));
  }
}

// deno-lint-ignore no-explicit-any
function getOutputText(payload: any): string | null {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return reply(401, { error: "authentication_required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_PLAN_MODEL");
  if (!supabaseUrl || !anonKey || !openAiKey || !model) {
    return reply(500, { error: "server_configuration_missing" });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return reply(401, { error: "invalid_session" });

  let body: { conditions: Conditions; generation_sequence?: number };
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  if (!body.conditions?.start_at || !body.conditions?.end_at || !body.conditions?.travel_mode || !body.conditions?.companion) {
    return reply(400, { error: "required_conditions_missing" });
  }
  const generationSequence = body.generation_sequence ?? 1;
  // end <= start is still invalid_time_range (unchanged); format / length / past are checked in addition.
  const requestedWindow = validateRequestedWindow(body.conditions.start_at, body.conditions.end_at);
  if (!requestedWindow.ok) {
    log("info", "plan_request_rejected", {
      error: requestedWindow.error,
      start_at: String(body.conditions.start_at).slice(0, 40),
      end_at: String(body.conditions.end_at).slice(0, 40),
    });
    return reply(400, { error: requestedWindow.error });
  }
  if (!Number.isInteger(generationSequence) || generationSequence < 1 || generationSequence > 3) {
    return reply(400, { error: "generation_sequence_must_be_1_to_3" });
  }

  await recordEvent(supabase, {
    p_name: "plan_request_submitted",
    p_properties: {
      condition_json: body.conditions,
      generation_sequence: generationSequence,
    },
  });
  if (generationSequence > 1) {
    await recordEvent(supabase, {
      p_name: "plan_regenerated",
      p_properties: { generation_sequence: generationSequence },
    });
  }

  const { data: savedRows, error: savedError } = await supabase
    .from("saved_places")
    .select("saved_at,visited_status,places!inner(id,name,category,address,latitude,longitude,price_band,opening_hours)")
    .neq("visited_status", "dismissed");
  if (savedError) {
    await recordEvent(supabase, {
      p_name: "plan_generation_failed",
      p_properties: { stage: "candidate_query", error_code: "database_error" },
    });
    return reply(500, { error: "candidate_query_failed", detail: savedError.message });
  }

  const candidates = rankCandidates(savedRows ?? [], body.conditions);
  if (candidates.length === 0) {
    await recordEvent(supabase, {
      p_name: "plan_generation_failed",
      p_properties: { stage: "candidate_filter", error_code: "no_candidates" },
    });
    return reply(422, { error: "no_candidates", action: "change_conditions_or_save_places" });
  }

  const ctx = createPlanContext(candidates, body.conditions);
  const userPayload = JSON.stringify(buildAiUserPayload(ctx));
  const schema = planSchema(ctx);
  const requestId = crypto.randomUUID();

  const callAi = async (feedback: string | null): Promise<AiCallResult> => {
    const input = [
      { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "input_text", text: userPayload }] },
    ];
    if (feedback) input.push({ role: "user", content: [{ type: "input_text", text: feedback }] });
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input,
          text: { format: { type: "json_schema", name: "mikke_plan", strict: true, schema } },
        }),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      log("error", "openai_request_failed", { request_id: requestId, detail: String(err) });
      return { ok: false, stage: "openai", error_code: timedOut ? "timeout" : "network_error", retryable: true };
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      log("error", "openai_http_error", { request_id: requestId, status: response.status, detail });
      return {
        ok: false,
        stage: "openai",
        error_code: `http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    const payload = await response.json();
    if (payload.status && payload.status !== "completed") {
      return { ok: false, stage: "openai", error_code: `response_${payload.status}`, retryable: true };
    }
    const text = getOutputText(payload);
    if (!text) return { ok: false, stage: "openai", error_code: "output_missing_or_refused", retryable: true };
    return { ok: true, text };
  };

  const result = await generateValidPlan(ctx, callAi, MAX_AI_ATTEMPTS);

  // Every rejected attempt is logged with the exact reasons and the raw AI output, so a
  // failure can be diagnosed from the Edge Function logs without reproducing it.
  for (const failed of result.failedAttempts) {
    log("error", "plan_attempt_rejected", {
      request_id: requestId,
      model,
      attempt: failed.attempt,
      candidate_count: candidates.length,
      violations: failed.violations,
      raw: failed.raw,
    });
  }

  if (!result.ok) {
    const lastRejected = [...result.failedAttempts].reverse().find((a) => a.raw !== null);
    await recordEvent(supabase, {
      p_name: "plan_generation_failed",
      p_properties: {
        stage: result.stage,
        error_code: result.error_code,
        attempts: result.attempts,
        violations: result.failedAttempts.flatMap((a) => a.violations.map((v) => v.code)),
        candidate_ids: candidates.map((c) => c.id),
        generated_raw: lastRejected?.raw ?? null,
      },
    });
    if (result.stage === "openai") {
      return reply(502, { error: "ai_generation_failed", retryable: true });
    }
    return reply(422, { error: "ai_output_failed_validation", retryable: true });
  }

  if (result.truncatedFrom) {
    log("info", "plan_truncated_to_valid_prefix", {
      request_id: requestId,
      attempts: result.attempts,
      ai_items: result.truncatedFrom,
      saved_items: result.plan.items.length,
    });
  } else if (result.attempts > 1) {
    log("info", "plan_generated_after_retry", { request_id: requestId, attempts: result.attempts });
  }

  const { data: plan, error: planError } = await supabase.rpc("create_generated_plan", {
    p_conditions: body.conditions,
    p_items: result.plan.items,
    p_candidate_count: candidates.length,
    p_total_duration_minutes: result.plan.total_duration_minutes,
    p_estimated_budget: result.plan.estimated_budget,
    p_generation_sequence: generationSequence,
  });
  if (planError) {
    await recordEvent(supabase, {
      p_name: "plan_generation_failed",
      p_properties: { stage: "plan_save", error_code: "database_error" },
    });
    return reply(500, { error: "plan_save_failed", detail: planError.message });
  }

  return reply(200, { plan, items: result.plan.items, candidate_count: candidates.length });
});
