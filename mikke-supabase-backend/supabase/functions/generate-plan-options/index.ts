import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

import type { AiCallResult } from "../generate-plan/plan.ts";
import {
  filterRowsByPlaceIds,
  generatePlanOptions,
  OPTIONS_SYSTEM_PROMPT,
  parseOptionsRequest,
  storedConditions,
  toPublicOption,
} from "./options.ts";

// Mobile Step 4-5: PlanConditions → up to three different plans (A/B/C) from the user's own saved places.
// - generate-plan (used by mikke-frontend) is NOT changed; this function reuses its pure logic (plan.ts).
// - Auth: the caller's JWT. Queries run with that JWT so RLS limits them to the user's own rows;
//   no service role key. Each plan is saved with the existing create_generated_plan RPC
//   (security definer, auth.uid(), rejects places that are not in the user's saved_places).
// - Exact coordinates are used only in memory; logs, events and plans.condition_json get ~1 km precision.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const MAX_AI_ATTEMPTS = 2;
const OPENAI_TIMEOUT_MS = 30_000;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function log(level: "info" | "error", message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function redact(value: string) {
  return value.replace(/sk-[A-Za-z0-9_\-*]{6,}/g, "sk-[redacted]").replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
}

async function recordEvent(supabase: SupabaseClient, name: string, properties: Record<string, unknown>) {
  try {
    const { error } = await supabase.rpc("track_event", { p_name: name, p_properties: properties });
    if (error) log("error", "track_event_failed", { event_name: name, code: error.code, detail: error.message });
  } catch (err) {
    log("error", "track_event_threw", { event_name: name, detail: err instanceof Error ? err.message : String(err) });
  }
}

// deno-lint-ignore no-explicit-any
function getOutputText(payload: any): string | null {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output ?? []) {
    for (const content of item.content ?? []) {
      if (content?.type === "refusal") return null;
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
    log("error", "server_configuration_missing", { supabase: !!supabaseUrl && !!anonKey, openai: !!openAiKey, model: !!model });
    return reply(500, { error: "server_configuration_missing" });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return reply(401, { error: "invalid_session" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  const now = new Date();
  const parsed = parseOptionsRequest(body, now);
  if (!parsed.ok) return reply(400, { error: parsed.error });
  const input = parsed.input;
  const requestId = crypto.randomUUID();

  const conditionSummary = {
    duration_minutes: input.durationMinutes,
    budget_yen: input.budgetYen,
    transport_modes: input.transportModes,
    preferences: input.preferences,
  };
  await recordEvent(supabase, "plan_request_submitted", {
    source: "mobile_plan_options",
    condition_json: conditionSummary, // no coordinates
    generation_sequence: input.generationSequence,
  });
  if (input.generationSequence > 1) {
    await recordEvent(supabase, "plan_regenerated", { generation_sequence: input.generationSequence });
  }

  // RLS: saved_places_all_own → only the caller's rows.
  const { data: rows, error: rowsError } = await supabase
    .from("saved_places")
    .select("saved_at,visited_status,places!inner(id,name,category,address,latitude,longitude,price_band,opening_hours)");
  if (rowsError) {
    log("error", "candidate_query_failed", { request_id: requestId, code: rowsError.code });
    await recordEvent(supabase, "plan_generation_failed", { stage: "candidate_query", error_code: "database_error" });
    return reply(500, { error: "candidate_query_failed" });
  }

  const callAi = async ({ schema, payload, feedback }: { schema: unknown; payload: string; feedback: string | null }): Promise<AiCallResult> => {
    const aiInput = [
      { role: "system", content: [{ type: "input_text", text: OPTIONS_SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "input_text", text: payload }] },
    ];
    if (feedback) aiInput.push({ role: "user", content: [{ type: "input_text", text: feedback }] });
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          store: false,
          input: aiInput,
          text: { format: { type: "json_schema", name: "mikke_plan_options", strict: true, schema } },
        }),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
      log("error", "openai_request_failed", { request_id: requestId, detail: redact(String(err)) });
      return { ok: false, stage: "openai", error_code: timedOut ? "timeout" : "network_error", retryable: !timedOut };
    }
    if (!response.ok) {
      const detail = redact((await response.text().catch(() => "")).slice(0, 300));
      log("error", "openai_http_error", { request_id: requestId, status: response.status, detail });
      return { ok: false, stage: "openai", error_code: `http_${response.status}`, retryable: response.status === 429 || response.status >= 500 };
    }
    // deno-lint-ignore no-explicit-any
    let payloadJson: any;
    try {
      payloadJson = await response.json();
    } catch {
      return { ok: false, stage: "openai", error_code: "response_not_json", retryable: true };
    }
    if (payloadJson.status && payloadJson.status !== "completed") {
      return { ok: false, stage: "openai", error_code: `response_${payloadJson.status}`, retryable: true };
    }
    const text = getOutputText(payloadJson);
    if (!text) return { ok: false, stage: "openai", error_code: "output_missing_or_refused", retryable: true };
    return { ok: true, text };
  };

  // v3「今日向けに調整」: 元ルートの場所（本人の保存場所に加えたもの）だけを候補にする
  const candidateRows = filterRowsByPlaceIds(rows ?? [], input.placeIds);
  const result = await generatePlanOptions(input, candidateRows, { callAi, now, maxAttempts: MAX_AI_ATTEMPTS });

  for (const failed of result.failedAttempts) {
    log("error", "plan_options_attempt_rejected", {
      request_id: requestId,
      model,
      attempt: failed.attempt,
      violations: failed.violations,
      raw: failed.raw,
    });
  }

  if (!result.ok) {
    log("info", "plan_options_failed", { request_id: requestId, error: result.error, stats: result.stats, radius_km: result.radiusKm });
    await recordEvent(supabase, "plan_generation_failed", {
      stage: result.error === "ai_generation_failed" ? "openai" : result.error === "ai_output_failed_validation" ? "validation" : "candidate_filter",
      error_code: result.error,
      attempts: result.attempts,
    });
    const status = result.error === "ai_generation_failed" ? 502 : 422;
    return reply(status, {
      error: result.error,
      retryable: result.error === "ai_generation_failed" || result.error === "ai_output_failed_validation",
      candidate_stats: result.stats,
      search_radius_km: result.radiusKm,
    });
  }

  // Save each option as a plans row through the existing RPC (validated items only).
  const setId = crypto.randomUUID();
  const saved: ReturnType<typeof toPublicOption>[] = [];
  for (const option of result.options) {
    const { data: plan, error: planError } = await supabase.rpc("create_generated_plan", {
      p_conditions: storedConditions(input, {
        set_id: setId,
        variant: option.variant,
        title: option.title,
        concept: option.concept,
        summary: option.summary,
        budget_status: option.budget_status,
      }),
      p_items: option.db_items,
      p_candidate_count: result.candidateCount,
      p_total_duration_minutes: option.estimated_total_minutes,
      p_estimated_budget: option.estimated_budget_yen,
      p_generation_sequence: input.generationSequence,
    });
    if (planError || !plan?.id) {
      log("error", "plan_save_failed", { request_id: requestId, variant: option.variant, code: planError?.code });
      await recordEvent(supabase, "plan_generation_failed", { stage: "plan_save", error_code: "database_error" });
      return reply(500, { error: "plan_save_failed" });
    }
    saved.push(toPublicOption(option, plan.id));
  }

  log("info", "plan_options_generated", {
    request_id: requestId,
    plans: saved.length,
    plan_count_target: result.planCount,
    candidates: result.candidateCount,
    attempts: result.attempts,
    radius_km: result.radiusKm,
  });

  return reply(200, {
    set_id: setId,
    generated_at: now.toISOString(),
    plan_count: saved.length,
    candidate_count: result.candidateCount,
    search_radius_km: result.radiusKm,
    // few_candidates: fewer than 3 usable places, so fewer plans were made on purpose
    notice: result.candidateCount < 3 ? "few_candidates" : saved.length < result.planCount ? "partial" : null,
    plans: saved,
  });
});
