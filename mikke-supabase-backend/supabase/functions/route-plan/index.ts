import { createClient } from "npm:@supabase/supabase-js@2";

import {
  buildRoutedPlan,
  buildRoutesRequest,
  classifyFetchFailure,
  classifyRoutesResponse,
  type ComputeRoute,
  parseRouteRequest,
  routeCallLogEntry,
  routeDiagnosticsSummary,
  ROUTES_ENDPOINT,
  ROUTES_FIELD_MASK,
  sanitizeForLog,
  toLoadedPlan,
} from "./route.ts";

// Mobile Step 4-6: real routes (walk / transit / drive) for the caller's ACCEPTED plan via the Google Routes API.
// - Auth: the caller's JWT; plans / plan_items are read with it, so RLS limits them to the caller's own rows.
//   No service role key. user_id is never taken from the request.
// - The origin (exact current location) comes from the app, is used only in memory, and is never logged or stored.
// - Google key: GOOGLE_ROUTES_API_KEY (recommended, server-only, restricted to Routes API).
//   Falls back to GOOGLE_PLACES_API_KEY only if that key is also allowed to call the Routes API.
// - Nothing is written to the DB (no new columns needed for the MVP).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const ROUTES_TIMEOUT_MS = 8_000;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function log(level: "info" | "error", message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return reply(401, { error: "authentication_required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const routesKey = Deno.env.get("GOOGLE_ROUTES_API_KEY") || Deno.env.get("GOOGLE_PLACES_API_KEY");
  const keyName = Deno.env.get("GOOGLE_ROUTES_API_KEY") ? "GOOGLE_ROUTES_API_KEY" : "GOOGLE_PLACES_API_KEY";
  if (!supabaseUrl || !anonKey || !routesKey) {
    log("error", "server_configuration_missing", { supabase: !!supabaseUrl && !!anonKey, routes_key: !!routesKey });
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
  const parsed = parseRouteRequest(body);
  if (!parsed.ok) return reply(400, { error: parsed.error });
  const { planId, origin } = parsed.value;
  const requestId = crypto.randomUUID();

  // RLS (plans_all_own / plan_items_select_own): another user's plan simply is not found.
  const { data: planRow, error: planError } = await supabase
    .from("plans")
    .select("id,status,accepted_at,estimated_budget,condition_json")
    .eq("id", planId)
    .maybeSingle();
  if (planError) {
    log("error", "plan_query_failed", { request_id: requestId, code: planError.code });
    return reply(500, { error: "plan_query_failed" });
  }
  if (!planRow) return reply(404, { error: "plan_not_found" });
  const { data: itemRows, error: itemsError } = await supabase
    .from("plan_items")
    .select("sequence,stay_minutes,places(id,name,category,address,latitude,longitude,provider,provider_place_id)")
    .eq("plan_id", planId)
    .order("sequence", { ascending: true });
  if (itemsError) {
    log("error", "plan_items_query_failed", { request_id: requestId, code: itemsError.code });
    return reply(500, { error: "plan_query_failed" });
  }
  const loaded = toLoadedPlan(planRow, itemRows ?? []);
  if (!loaded.ok) {
    const status = loaded.error === "plan_not_found" ? 404 : loaded.error === "plan_not_accepted" ? 409 : 422;
    return reply(status, { error: loaded.error });
  }

  let calls = 0;
  const compute: ComputeRoute = async (mode, from, to, departure) => {
    calls++;
    let result;
    try {
      const response = await fetch(ROUTES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": routesKey,
          "X-Goog-FieldMask": ROUTES_FIELD_MASK,
        },
        body: JSON.stringify(buildRoutesRequest(mode, from, to, departure, loaded.plan.transportModes)),
        signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS),
      });
      // ok / no_route (routes [] or missing) / invalid_response / api_error (4xx, 5xx) — see classifyRoutesResponse
      result = classifyRoutesResponse(mode, response.status, await response.text().catch(() => ""));
    } catch (err) {
      const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
      result = classifyFetchFailure(mode, timedOut, sanitizeForLog(String(err)));
    }
    // One line per Routes call. No coordinates, keys or tokens (error_message is sanitized).
    const entry = routeCallLogEntry(requestId, null, result.diagnostic);
    log(entry.level, entry.message, { event: "routes_call", ...entry.fields, key_name: keyName });
    return result;
  };

  // Japan MVP: Routes TRANSIT returned no routes in Sapporo (Step 4-6 production check), so it is OFF unless
  // the function secret ENABLE_GOOGLE_TRANSIT is exactly "true". Public transport is handed off to Google Maps.
  const enableTransit = Deno.env.get("ENABLE_GOOGLE_TRANSIT") === "true";
  const result = await buildRoutedPlan(loaded.plan, origin, new Date(), compute, undefined, { enableTransit });
  log("info", "plan_routed", {
    request_id: requestId,
    legs: result.legs.length,
    route_status: result.route_status,
    fit_status: result.fit_status,
    modes: result.legs.map((l) => l.mode ?? l.failure_reason),
    transit_status: result.legs.map((l) => l.transit_status),
    transit_routing: result.transit_routing,
    route_diagnostics: routeDiagnosticsSummary(result.legs),
    fare_status: result.fares.status,
    routes_calls: calls,
    key_name: keyName,
  });
  if (result.route_status === "failed") {
    return reply(502, { error: "routes_unavailable", reasons: result.legs.map((l) => l.failure_reason) });
  }
  return reply(200, result);
});
