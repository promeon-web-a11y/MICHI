// Pure logic for the route-plan Edge Function (mobile Step 4-6).
// No Deno / Supabase APIs here so it can be unit-tested with `node --test`.
//
// For an ACCEPTED plan of the caller: origin → place 1 → place 2 … each leg is routed with the
// Google Routes API (computeRoutes). Everything shown to the user about travel comes from the API
// response: durations, distances, stops, lines, departure/arrival times and — only when Google returns
// it — the transit fare. Nothing is estimated by AI. Missing values stay null ("unknown").
//
// Facts from the official docs this file relies on:
// - TRANSIT cannot have intermediate waypoints → one request per leg.
// - routingPreference must not be set for WALK / TRANSIT. DRIVE uses TRAFFIC_UNAWARE (Essentials SKU).
// - routes[].travelAdvisory.transitFare (Money) is returned only if the fare of ALL transit steps is known.
// - transitDetails: stopDetails{arrivalStop{name}, arrivalTime, departureStop{name}, departureTime},
//   headsign, stopCount, transitLine{name, nameShort, color, vehicle{type, name{text}}, agencies[{name}]}.

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------
export type TransportMode = "walking" | "train" | "bus" | "car";
const TRANSPORT_MODES: TransportMode[] = ["walking", "train", "bus", "car"];

export type RouteRequest = { planId: string; origin: { latitude: number; longitude: number } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validLatLng(lat: unknown, lng: unknown): boolean {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

export function parseRouteRequest(body: unknown): { ok: true; value: RouteRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;
  if (typeof b.plan_id !== "string" || !UUID.test(b.plan_id)) return { ok: false, error: "plan_id_required" };
  const o = b.origin as Record<string, unknown> | undefined;
  if (!o || !validLatLng(o.latitude, o.longitude)) return { ok: false, error: "origin_required" };
  return { ok: true, value: { planId: b.plan_id, origin: { latitude: o.latitude as number, longitude: o.longitude as number } } };
}

// ---------------------------------------------------------------------------
// Plan loaded from the DB (RLS: the caller's own rows only)
// ---------------------------------------------------------------------------
export type PlanStop = {
  place_id: string;
  google_place_id: string | null;
  name: string;
  category: string;
  address: string;
  latitude: number;
  longitude: number;
  stay_minutes: number;
};

export type LoadedPlan = {
  id: string;
  status: string;
  durationMinutes: number;
  budgetYen: number | null;
  transportModes: TransportMode[];
  placesBudgetYen: number | null;
  placesBudgetStatus: "estimated" | "partial" | "unknown";
  stops: PlanStop[];
};

/** DB rows → LoadedPlan. Only plans made by generate-plan-options (mobile) carry transport_modes. */
// deno-lint-ignore no-explicit-any
export function toLoadedPlan(plan: any, items: any[]): { ok: true; plan: LoadedPlan } | { ok: false; error: string } {
  if (!plan || typeof plan.id !== "string") return { ok: false, error: "plan_not_found" };
  if (plan.status !== "accepted") return { ok: false, error: "plan_not_accepted" };
  const c = plan.condition_json ?? {};
  if (c.source !== "mobile_plan_options") return { ok: false, error: "unsupported_plan" };
  const modes = Array.isArray(c.transport_modes) ? TRANSPORT_MODES.filter((m) => c.transport_modes.includes(m)) : [];
  const duration = Number(c.duration_minutes);
  if (modes.length === 0 || !Number.isInteger(duration) || duration <= 0) return { ok: false, error: "unsupported_plan" };
  const stops: PlanStop[] = [];
  for (const item of [...(items ?? [])].sort((a, b) => a.sequence - b.sequence)) {
    const p = item.places;
    const lat = p?.latitude == null ? NaN : Number(p.latitude);
    const lng = p?.longitude == null ? NaN : Number(p.longitude);
    if (!p || !validLatLng(lat, lng)) return { ok: false, error: "place_without_location" };
    stops.push({
      place_id: p.id,
      google_place_id: p.provider === "google" && typeof p.provider_place_id === "string" ? p.provider_place_id : null,
      name: String(p.name ?? ""),
      category: String(p.category ?? "other"),
      address: String(p.address ?? ""),
      latitude: lat,
      longitude: lng,
      stay_minutes: Number(item.stay_minutes),
    });
  }
  if (stops.length === 0) return { ok: false, error: "plan_has_no_items" };
  const status = c.option?.budget_status;
  return {
    ok: true,
    plan: {
      id: plan.id,
      status: plan.status,
      durationMinutes: duration,
      budgetYen: typeof c.budget_yen === "number" ? c.budget_yen : null,
      transportModes: modes,
      placesBudgetYen: typeof plan.estimated_budget === "number" ? plan.estimated_budget : null,
      placesBudgetStatus: status === "estimated" || status === "partial" ? status : "unknown",
      stops,
    },
  };
}

// ---------------------------------------------------------------------------
// Google Routes API request / response
// ---------------------------------------------------------------------------
export type RouteMode = "WALK" | "TRANSIT" | "DRIVE";

export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
/** Only what Mikke shows. No alternatives, no traffic-aware routing (keeps the Essentials SKU for DRIVE). */
export const ROUTES_FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.transitDetails",
  "routes.travelAdvisory.transitFare",
].join(",");

type LatLng = { latitude: number; longitude: number };

/** Transit vehicle kinds for transitPreferences.allowedTravelModes */
export function allowedTransitModes(modes: readonly TransportMode[]): string[] {
  const out: string[] = [];
  if (modes.includes("train")) out.push("SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL");
  if (modes.includes("bus")) out.push("BUS");
  return out;
}

export function buildRoutesRequest(
  mode: RouteMode,
  from: LatLng,
  to: LatLng,
  departure: Date,
  modes: readonly TransportMode[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } },
    destination: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } },
    travelMode: mode,
    languageCode: "ja",
    regionCode: "JP",
    units: "METRIC",
  };
  if (mode === "TRANSIT") {
    // Timetables depend on the departure time. routingPreference must not be set for TRANSIT.
    body.departureTime = departure.toISOString();
    body.transitPreferences = { allowedTravelModes: allowedTransitModes(modes) };
  }
  if (mode === "DRIVE") body.routingPreference = "TRAFFIC_UNAWARE";
  return body;
}

/** "165s" / "1.5s" → seconds, null if missing */
export function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Math.round(Number(m[1])) : null;
}

export type WalkStep = { kind: "walk"; duration_seconds: number; distance_meters: number | null };
export type DriveStep = { kind: "drive"; duration_seconds: number; distance_meters: number | null };
export type TransitStep = {
  kind: "transit";
  vehicle_type: string | null;
  vehicle_name: string | null;
  line_name: string | null;
  line_short_name: string | null;
  line_color: string | null;
  agency: string | null;
  headsign: string | null;
  departure_stop: string | null;
  arrival_stop: string | null;
  departure_at: string | null;
  arrival_at: string | null;
  stop_count: number | null;
  duration_seconds: number | null;
};
export type RouteStep = WalkStep | DriveStep | TransitStep;

export type ParsedRoute = {
  mode: RouteMode;
  duration_seconds: number;
  distance_meters: number | null;
  steps: RouteStep[];
  /** Only when Google returned travelAdvisory.transitFare */
  fare: { amount: number; currency: string } | null;
  polyline: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Money → amount (units + nanos). units is int64 and may arrive as a string. */
export function parseMoney(money: unknown): { amount: number; currency: string } | null {
  if (!money || typeof money !== "object") return null;
  const m = money as Record<string, unknown>;
  const currency = str(m.currencyCode);
  const units = typeof m.units === "string" ? Number(m.units) : typeof m.units === "number" ? m.units : 0;
  const nanos = typeof m.nanos === "number" ? m.nanos : 0;
  if (!currency || !Number.isFinite(units) || (m.units === undefined && m.nanos === undefined)) return null;
  const amount = units + nanos / 1e9;
  return amount >= 0 ? { amount: Math.round(amount * 100) / 100, currency } : null;
}

/** First route of a computeRoutes response, or null when Google returned no route. */
// deno-lint-ignore no-explicit-any
export function parseRoutesResponse(json: any, mode: RouteMode): ParsedRoute | null {
  const route = Array.isArray(json?.routes) ? json.routes[0] : null;
  const duration = parseDuration(route?.duration);
  if (!route || duration === null) return null;
  const steps: RouteStep[] = [];
  for (const leg of Array.isArray(route.legs) ? route.legs : []) {
    for (const s of Array.isArray(leg?.steps) ? leg.steps : []) {
      const seconds = parseDuration(s?.staticDuration);
      const distance = num(s?.distanceMeters);
      if (s?.travelMode === "TRANSIT" && s.transitDetails) {
        const t = s.transitDetails;
        const line = t.transitLine ?? {};
        steps.push({
          kind: "transit",
          vehicle_type: str(line.vehicle?.type),
          vehicle_name: str(line.vehicle?.name?.text),
          line_name: str(line.name),
          line_short_name: str(line.nameShort),
          line_color: str(line.color),
          agency: str(Array.isArray(line.agencies) ? line.agencies[0]?.name : null),
          headsign: str(t.headsign),
          departure_stop: str(t.stopDetails?.departureStop?.name),
          arrival_stop: str(t.stopDetails?.arrivalStop?.name),
          departure_at: str(t.stopDetails?.departureTime),
          arrival_at: str(t.stopDetails?.arrivalTime),
          stop_count: num(t.stopCount),
          duration_seconds: seconds,
        });
        continue;
      }
      const kind = s?.travelMode === "DRIVE" ? "drive" : "walk";
      const prev = steps[steps.length - 1];
      // Merge consecutive turn-by-turn steps of the same kind into one segment.
      if (prev && prev.kind === kind) {
        prev.duration_seconds += seconds ?? 0;
        prev.distance_meters = prev.distance_meters === null || distance === null ? prev.distance_meters ?? distance : prev.distance_meters + distance;
      } else {
        steps.push({ kind, duration_seconds: seconds ?? 0, distance_meters: distance });
      }
    }
  }
  return {
    mode,
    duration_seconds: duration,
    distance_meters: num(route.distanceMeters),
    steps,
    fare: mode === "TRANSIT" ? parseMoney(route.travelAdvisory?.transitFare) : null,
    polyline: str(route.polyline?.encodedPolyline),
  };
}

// ---------------------------------------------------------------------------
// Diagnostics: classify every Routes API call (no coordinates, no keys)
// ---------------------------------------------------------------------------
/**
 * ok               HTTP 2xx and a usable route
 * no_route         HTTP 2xx and routes missing / [] (the docs: "If the array is empty, no route could be found")
 * invalid_response HTTP 2xx but the body is not JSON, or routes[0] lacks the fields we rely on (duration)
 * api_error        HTTP 4xx / 5xx (or the request could not reach Google: http_status null, error_status "NETWORK_ERROR")
 * timeout          our AbortSignal timeout fired
 */
export type RouteCallStatus = "ok" | "no_route" | "invalid_response" | "api_error" | "timeout";

export type RouteDiagnostic = {
  mode: RouteMode;
  status: RouteCallStatus;
  http_status: number | null;
  /** Google error.status, e.g. INVALID_ARGUMENT / PERMISSION_DENIED / RESOURCE_EXHAUSTED */
  error_status: string | null;
  /** Google error.code (usually equals the HTTP status) */
  error_code: number | null;
  /** Sanitized, truncated Google error.message (keys, tokens and coordinates masked) */
  error_message: string | null;
  /** true when Google answered with fallbackInfo (it relaxed some preference) */
  fallback: boolean;
};

/**
 * Mask anything that must never reach logs: API keys, bearer tokens / JWTs, and decimal coordinates
 * (Google error messages can echo request values). Keeps the message short.
 */
export function sanitizeForLog(value: string, max = 200): string {
  return value
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "AIza[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)?/g, "[jwt-redacted]")
    .replace(/sk-[A-Za-z0-9_\-*]{6,}/g, "sk-[redacted]")
    .replace(/-?\d{1,3}\.\d{3,}/g, "[num]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const diag = (mode: RouteMode, status: RouteCallStatus, extra: Partial<RouteDiagnostic> = {}): RouteDiagnostic => ({
  mode,
  status,
  http_status: null,
  error_status: null,
  error_code: null,
  error_message: null,
  fallback: false,
  ...extra,
});

/** Classify a completed HTTP exchange with the Routes API. Pure: used by index.ts and the tests. */
export function classifyRoutesResponse(mode: RouteMode, httpStatus: number, bodyText: string): RouteCallResult {
  if (httpStatus < 200 || httpStatus >= 300) {
    let error: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(bodyText);
      error = parsed && typeof parsed.error === "object" ? parsed.error : null;
    } catch {
      error = null;
    }
    return {
      diagnostic: diag(mode, "api_error", {
        http_status: httpStatus,
        error_status: typeof error?.status === "string" ? error.status : null,
        error_code: typeof error?.code === "number" ? error.code : null,
        error_message: typeof error?.message === "string" ? sanitizeForLog(error.message) : bodyText ? sanitizeForLog(bodyText) : null,
      }),
      route: null,
    };
  }
  let json: unknown;
  try {
    json = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return { diagnostic: diag(mode, "invalid_response", { http_status: httpStatus, error_message: "body is not JSON" }), route: null };
  }
  const fallback = !!(json && typeof json === "object" && "fallbackInfo" in json);
  const routes = (json as { routes?: unknown })?.routes;
  if (routes === undefined || (Array.isArray(routes) && routes.length === 0)) {
    return { diagnostic: diag(mode, "no_route", { http_status: httpStatus, fallback }), route: null };
  }
  const route = Array.isArray(routes) ? parseRoutesResponse(json, mode) : null;
  if (!route) {
    return {
      diagnostic: diag(mode, "invalid_response", { http_status: httpStatus, fallback, error_message: "routes[0] has no usable duration" }),
      route: null,
    };
  }
  return { diagnostic: diag(mode, "ok", { http_status: httpStatus, fallback }), route };
}

/** The request never produced an HTTP response. */
export function classifyFetchFailure(mode: RouteMode, timedOut: boolean, detail: string): RouteCallResult {
  return timedOut
    ? { diagnostic: diag(mode, "timeout"), route: null }
    : { diagnostic: diag(mode, "api_error", { error_status: "NETWORK_ERROR", error_message: sanitizeForLog(detail) }), route: null };
}

/** Log line for one Routes call. Contains no coordinates, keys or tokens. */
export function routeCallLogEntry(requestId: string, legIndex: number | null, d: RouteDiagnostic) {
  const message = d.status === "ok"
    ? `${d.mode} request succeeded`
    : d.status === "no_route"
    ? `${d.mode} request succeeded but no route was returned`
    : d.status === "invalid_response"
    ? `${d.mode} request succeeded but the response could not be used`
    : d.status === "timeout"
    ? `${d.mode} request timed out`
    : `${d.mode} request failed`;
  return {
    level: d.status === "api_error" || d.status === "invalid_response" || d.status === "timeout" ? "error" as const : "info" as const,
    message,
    fields: {
      request_id: requestId,
      leg: legIndex,
      mode: d.mode,
      status: d.status,
      http_status: d.http_status,
      error_status: d.error_status,
      error_code: d.error_code,
      error_message: d.error_message,
      fallback: d.fallback,
    },
  };
}

// ---------------------------------------------------------------------------
// Choosing a mode per leg (rule-based, from real API results only)
// ---------------------------------------------------------------------------
/** Walking is chosen when it takes at most this long (and walking was selected). */
export const WALK_PREFERRED_MAX_MINUTES = 15;

/** route is non-null only when diagnostic.status === "ok" */
export type RouteCallResult = { diagnostic: RouteDiagnostic; route: ParsedRoute | null };

export type ComputeRoute = (mode: RouteMode, from: LatLng, to: LatLng, departure: Date) => Promise<RouteCallResult>;

export type LegFailure = "no_route" | "api_error" | "timeout" | "deadline_exceeded";

/**
 * What happened with TRANSIT on a leg.
 * not_requested: walking was short enough, or train/bus not selected.
 * disabled: train/bus selected but Google Routes TRANSIT is switched off (Japan MVP) → hand off to Google Maps.
 */
export type TransitStatus = RouteCallStatus | "not_requested" | "disabled";

/**
 * Step 4-6 production check: in Sapporo, Routes API TRANSIT answered HTTP 200 with no routes (no_route).
 * For the Japan MVP we therefore do not send TRANSIT requests at all and hand public transport off to Google Maps.
 * Re-enable later with the ENABLE_GOOGLE_TRANSIT=true function secret (index.ts) or { enableTransit: true }.
 */
export const ENABLE_GOOGLE_TRANSIT_DEFAULT = false;

export type RoutingOptions = { enableTransit?: boolean };

export type LegChoice =
  | {
    ok: true;
    route: ParsedRoute;
    alternatives: { mode: RouteMode; duration_seconds: number }[];
    transitStatus: TransitStatus;
    diagnostics: RouteDiagnostic[];
  }
  | {
    /** Public transport is the realistic choice but is not routed by Mikke: the user checks it in Google Maps. */
    ok: "external_transit";
    /** Google's real walking route for reference only (never presented as a transit time) */
    walkReference: ParsedRoute | null;
    transitStatus: "disabled";
    diagnostics: RouteDiagnostic[];
  }
  | { ok: false; reason: LegFailure; transitStatus: TransitStatus; diagnostics: RouteDiagnostic[] };

/**
 * Rules (documented for the report):
 * 1. walking selected → ask WALK first; if it is ≤ 15 min, walk (no other calls).
 * 2. otherwise ask TRANSIT (train/bus selected, only when enabled) and DRIVE (car selected) in parallel and take the faster.
 * 3. TRANSIT disabled and train/bus selected → external_transit (Google Maps hand-off), not a long walk.
 * 4. if nothing else exists, fall back to the walking route when walking was selected (even if long).
 * The choice is always one of Google's actual routes, or an explicit hand-off.
 */
export async function chooseLegRoute(
  modes: readonly TransportMode[],
  from: LatLng,
  to: LatLng,
  departure: Date,
  compute: ComputeRoute,
  options: RoutingOptions = {},
): Promise<LegChoice> {
  const diagnostics: RouteDiagnostic[] = [];
  let walk: ParsedRoute | null = null;
  if (modes.includes("walking")) {
    const r = await compute("WALK", from, to, departure);
    diagnostics.push(r.diagnostic);
    walk = r.route;
    if (walk && walk.duration_seconds <= WALK_PREFERRED_MAX_MINUTES * 60) {
      return { ok: true, route: walk, alternatives: [], transitStatus: "not_requested", diagnostics };
    }
  }
  const wantTransit = modes.includes("train") || modes.includes("bus");
  const transitEnabled = options.enableTransit ?? ENABLE_GOOGLE_TRANSIT_DEFAULT;
  const wantDrive = modes.includes("car");
  const [transit, drive] = await Promise.all([
    wantTransit && transitEnabled ? compute("TRANSIT", from, to, departure) : Promise.resolve(null),
    wantDrive ? compute("DRIVE", from, to, departure) : Promise.resolve(null),
  ]);
  const routes: ParsedRoute[] = [];
  for (const r of [transit, drive]) {
    if (!r) continue;
    diagnostics.push(r.diagnostic);
    if (r.route) routes.push(r.route);
  }
  const transitStatus: TransitStatus = transit ? transit.diagnostic.status : wantTransit && !transitEnabled ? "disabled" : "not_requested";
  const alternatives = [walk, ...routes].filter((r): r is ParsedRoute => !!r).map((r) => ({ mode: r.mode, duration_seconds: r.duration_seconds }));
  if (routes.length > 0) {
    const best = routes.reduce((a, b) => (b.duration_seconds < a.duration_seconds ? b : a));
    return { ok: true, route: best, alternatives: alternatives.filter((a) => a.mode !== best.mode), transitStatus, diagnostics };
  }
  // Public transport selected but not routed here: never substitute a long walk as if it were the plan's travel.
  if (wantTransit && !transitEnabled) {
    return { ok: "external_transit", walkReference: walk, transitStatus: "disabled", diagnostics };
  }
  if (walk) return { ok: true, route: walk, alternatives: [], transitStatus, diagnostics };
  const statuses = diagnostics.map((d) => d.status);
  const reason: LegFailure = statuses.includes("timeout")
    ? "timeout"
    : statuses.some((s) => s === "api_error" || s === "invalid_response")
    ? "api_error"
    : "no_route";
  return { ok: false, reason, transitStatus, diagnostics };
}

// ---------------------------------------------------------------------------
// Schedule with real durations, then fit into duration_minutes
// ---------------------------------------------------------------------------
export type Leg = {
  index: number;
  from_name: string;
  to_place_id: string;
  from: LatLng;
  to: LatLng;
  /**
   * ok: a real Google route / failed: no route could be obtained /
   * external_transit: public transport, to be checked in Google Maps (no duration, line, time or fare from Mikke)
   */
  status: "ok" | "failed" | "external_transit";
  failure_reason: LegFailure | null;
  /** true when the leg (or an earlier one) has no real duration, so clock times after it are not reliable */
  times_uncertain: boolean;
  mode: RouteMode | null;
  departure_at: string;
  arrival_at: string | null;
  duration_minutes: number | null;
  distance_meters: number | null;
  steps: RouteStep[];
  fare: { amount: number; currency: string } | null;
  /** external: public transport fare is not known to Mikke (check in Google Maps) */
  fare_status: "known" | "unknown" | "not_applicable" | "external";
  /** external_transit legs only: Google's real walking route, for reference ("徒歩で行く場合") — never a transit time */
  walk_reference: { duration_minutes: number; distance_meters: number | null; polyline: string | null } | null;
  /**
   * TRANSIT outcome for this leg. The app can tell
   * "公共交通の経路が見つかりませんでした" (no_route) from "公共交通の経路を取得できませんでした" (api_error / timeout / invalid_response).
   */
  transit_status: TransitStatus;
  /** kept for older app builds: true when TRANSIT was requested but not usable */
  transit_unavailable: boolean;
  /** One entry per Routes API call made for this leg (no coordinates, no keys) */
  diagnostics: RouteDiagnostic[];
  alternatives: { mode: RouteMode; duration_minutes: number }[];
  polyline: string | null;
};

export type ScheduledStop = PlanStop & {
  arrival_at: string | null;
  leave_at: string | null;
  original_stay_minutes: number;
};

/** Stays are never shortened below this when fitting into the time. */
export function minStayMinutes(original: number): number {
  return Math.max(15, Math.ceil(original * 0.5));
}

/** Overall wall-clock budget for Routes calls inside one request. */
export const ROUTING_DEADLINE_MS = 40_000;

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

export async function routeLegs(
  plan: LoadedPlan,
  origin: LatLng,
  departure: Date,
  compute: ComputeRoute,
  now: () => number = Date.now,
  options: RoutingOptions = {},
): Promise<{ legs: Leg[]; stops: ScheduledStop[] }> {
  const deadline = now() + ROUTING_DEADLINE_MS;
  const legs: Leg[] = [];
  const stops: ScheduledStop[] = [];
  let t: Date = departure;
  let uncertain = false;
  let from: LatLng = origin;
  let fromName = "現在地";

  for (const [i, stop] of plan.stops.entries()) {
    const to = { latitude: stop.latitude, longitude: stop.longitude };
    const base = { index: i, from_name: fromName, to_place_id: stop.place_id, from, to, departure_at: t.toISOString() };
    const choice: LegChoice = now() > deadline
      ? { ok: false, reason: "deadline_exceeded", transitStatus: "not_requested", diagnostics: [] }
      : await chooseLegRoute(plan.transportModes, from, to, t, compute, options);
    const transitFields = {
      transit_status: choice.transitStatus,
      transit_unavailable: choice.transitStatus !== "not_requested" && choice.transitStatus !== "ok" && choice.transitStatus !== "disabled",
      diagnostics: choice.diagnostics,
    };
    if (choice.ok === "external_transit") {
      // Not routed by Mikke: no duration / line / time / fare. Later clock times become uncertain.
      uncertain = true;
      const w = choice.walkReference;
      legs.push({
        ...base,
        status: "external_transit",
        failure_reason: null,
        times_uncertain: true,
        mode: "TRANSIT",
        arrival_at: null,
        duration_minutes: null,
        distance_meters: null,
        steps: [],
        fare: null,
        fare_status: "external",
        walk_reference: w ? { duration_minutes: minutes(w.duration_seconds), distance_meters: w.distance_meters, polyline: w.polyline } : null,
        ...transitFields,
        alternatives: [],
        polyline: null,
      });
    } else if (choice.ok) {
      const r = choice.route;
      const duration = minutes(r.duration_seconds);
      const arrival = addMinutes(t, duration);
      legs.push({
        ...base,
        status: "ok",
        failure_reason: null,
        times_uncertain: uncertain,
        mode: r.mode,
        arrival_at: arrival.toISOString(),
        duration_minutes: duration,
        distance_meters: r.distance_meters,
        steps: r.steps,
        fare: r.fare,
        fare_status: r.mode !== "TRANSIT" || !r.steps.some((s) => s.kind === "transit") ? "not_applicable" : r.fare ? "known" : "unknown",
        walk_reference: null,
        ...transitFields,
        alternatives: choice.alternatives.map((a) => ({ mode: a.mode, duration_minutes: minutes(a.duration_seconds) })),
        polyline: r.polyline,
      });
      t = arrival;
    } else {
      // No real route for this leg: we do not invent one. Later clock times become uncertain.
      uncertain = true;
      legs.push({
        ...base,
        status: "failed",
        failure_reason: choice.reason,
        times_uncertain: true,
        mode: null,
        arrival_at: null,
        duration_minutes: null,
        distance_meters: null,
        steps: [],
        fare: null,
        fare_status: "unknown",
        walk_reference: null,
        ...transitFields,
        alternatives: [],
        polyline: null,
      });
    }
    const leave = addMinutes(t, stop.stay_minutes);
    stops.push({
      ...stop,
      arrival_at: uncertain ? null : t.toISOString(),
      leave_at: uncertain ? null : leave.toISOString(),
      original_stay_minutes: stop.stay_minutes,
    });
    t = leave;
    from = to;
    fromName = stop.name;
  }
  return { legs, stops };
}

export type Adjustment =
  | { type: "shortened_stay"; place_id: string; place_name: string; from_minutes: number; to_minutes: number }
  | { type: "dropped_place"; place_id: string; place_name: string };

export type FitResult = {
  status: "fits" | "adjusted" | "does_not_fit" | "unknown";
  legs: Leg[];
  stops: ScheduledStop[];
  adjustments: Adjustment[];
  end_at: string | null;
  total_minutes: number | null;
};

/**
 * Keep the plan within duration_minutes without making the shown times wrong:
 * only the LAST stop is changed (shorten its stay to minStay, else drop it and retry),
 * because anything earlier would shift the departure of later legs and invalidate real timetables.
 */
export function fitIntoDuration(legs: Leg[], stops: ScheduledStop[], departure: Date, durationMinutes: number): FitResult {
  const limit = departure.getTime() + durationMinutes * 60_000;
  let L = [...legs];
  let S = stops.map((s) => ({ ...s }));
  const adjustments: Adjustment[] = [];
  // A leg without a real duration (failed, or public transport checked in Google Maps) → times cannot be verified.
  if (L.some((l) => l.status !== "ok")) {
    const last = S[S.length - 1];
    return { status: "unknown", legs: L, stops: S, adjustments, end_at: last?.leave_at ?? null, total_minutes: null };
  }
  while (S.length > 0) {
    const last = S[S.length - 1];
    const arrival = Date.parse(last.arrival_at!);
    if (arrival + last.stay_minutes * 60_000 <= limit) break;
    const room = Math.floor((limit - arrival) / 60_000);
    if (room >= minStayMinutes(last.original_stay_minutes)) {
      adjustments.push({ type: "shortened_stay", place_id: last.place_id, place_name: last.name, from_minutes: last.stay_minutes, to_minutes: room });
      last.stay_minutes = room;
      last.leave_at = new Date(arrival + room * 60_000).toISOString();
      break;
    }
    if (S.length === 1) {
      return { status: "does_not_fit", legs: L, stops: S, adjustments, end_at: last.leave_at, total_minutes: Math.round((Date.parse(last.leave_at!) - departure.getTime()) / 60_000) };
    }
    adjustments.push({ type: "dropped_place", place_id: last.place_id, place_name: last.name });
    S = S.slice(0, -1);
    L = L.slice(0, -1);
  }
  const end = S[S.length - 1].leave_at!;
  return {
    status: adjustments.length > 0 ? "adjusted" : "fits",
    legs: L,
    stops: S,
    adjustments,
    end_at: end,
    total_minutes: Math.round((Date.parse(end) - departure.getTime()) / 60_000),
  };
}

// ---------------------------------------------------------------------------
// Fares and budget (never estimated)
// ---------------------------------------------------------------------------
export type FareSummary = {
  /** over legs routed by Google (external_transit legs are counted separately) */
  status: "all_known" | "partial" | "none_known" | "not_applicable";
  known_total: number;
  currency: string | null;
  unknown_legs: number;
  /** public transport legs handed off to Google Maps: their fare is not known to Mikke */
  external_legs: number;
};

export function summarizeFares(legs: Leg[]): FareSummary {
  const external = legs.filter((l) => l.fare_status === "external").length;
  const relevant = legs.filter((l) => l.fare_status === "known" || l.fare_status === "unknown");
  if (relevant.length === 0) return { status: "not_applicable", known_total: 0, currency: null, unknown_legs: 0, external_legs: external };
  const known = relevant.filter((l) => l.fare_status === "known" && l.fare);
  const currencies = new Set(known.map((l) => l.fare!.currency));
  // Mixed currencies cannot be summed honestly.
  if (currencies.size > 1) return { status: "partial", known_total: 0, currency: null, unknown_legs: relevant.length, external_legs: external };
  const total = known.reduce((sum, l) => sum + l.fare!.amount, 0);
  const unknown = relevant.length - known.length;
  return {
    status: unknown === 0 ? "all_known" : known.length === 0 ? "none_known" : "partial",
    known_total: Math.round(total),
    currency: known[0]?.fare?.currency ?? null,
    unknown_legs: unknown,
    external_legs: external,
  };
}

export type BudgetSummary = {
  budget_yen: number | null;
  places_yen: number | null;
  places_status: "estimated" | "partial" | "unknown";
  transit_fare_yen: number;
  confirmed_total_yen: number;
  /** complete: every price known / partial: some unknown */
  completeness: "complete" | "partial";
  /** true when the KNOWN amounts alone already exceed the budget; null when it cannot be decided */
  over_budget: boolean | null;
};

export function summarizeBudget(plan: LoadedPlan, fares: FareSummary, droppedPlaces: number): BudgetSummary {
  const jpyFares = fares.currency === null || fares.currency === "JPY" ? fares.known_total : 0;
  // A public transport leg checked in Google Maps has an unknown fare → the total cannot be complete.
  const faresComplete = (fares.status === "all_known" || fares.status === "not_applicable") && fares.external_legs === 0;
  // After dropping places the stored place estimate is an upper bound only → treat as partial.
  const placesStatus = droppedPlaces > 0 && plan.placesBudgetStatus === "estimated" ? "partial" : plan.placesBudgetStatus;
  const places = plan.placesBudgetYen ?? 0;
  const confirmed = places + jpyFares;
  const complete = faresComplete && placesStatus === "estimated" && (fares.currency === null || fares.currency === "JPY");
  let over: boolean | null = null;
  if (plan.budgetYen != null) {
    if (confirmed > plan.budgetYen) over = true;
    else if (complete) over = false;
  }
  return {
    budget_yen: plan.budgetYen,
    places_yen: plan.placesBudgetYen,
    places_status: placesStatus,
    transit_fare_yen: jpyFares,
    confirmed_total_yen: confirmed,
    completeness: complete ? "complete" : "partial",
    over_budget: over,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/** Departure = next full minute. */
export function departureFrom(now: Date): Date {
  return new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
}

export async function buildRoutedPlan(
  plan: LoadedPlan,
  origin: LatLng,
  now: Date,
  compute: ComputeRoute,
  clock?: () => number,
  options: RoutingOptions = {},
) {
  const departure = departureFrom(now);
  const routed = await routeLegs(plan, origin, departure, compute, clock, options);
  const fit = fitIntoDuration(routed.legs, routed.stops, departure, plan.durationMinutes);
  const fares = summarizeFares(fit.legs);
  const dropped = fit.adjustments.filter((a) => a.type === "dropped_place").length;
  const failed = fit.legs.filter((l) => l.status === "failed").length;
  const transitEnabled = options.enableTransit ?? ENABLE_GOOGLE_TRANSIT_DEFAULT;
  return {
    plan_id: plan.id,
    computed_at: now.toISOString(),
    departure_at: departure.toISOString(),
    duration_minutes: plan.durationMinutes,
    transport_modes: plan.transportModes,
    /** routes_api: TRANSIT routed by Google Routes / google_maps: public transport is handed off to Google Maps */
    transit_routing: transitEnabled ? "routes_api" : "google_maps",
    /** ok: every leg routed or handed off / partial: some legs failed / failed: no leg could be routed */
    route_status: failed === 0 ? "ok" : failed === fit.legs.length ? "failed" : "partial",
    fit_status: fit.status,
    adjustments: fit.adjustments,
    end_at: fit.end_at,
    total_minutes: fit.total_minutes,
    legs: fit.legs.map(({ from: _from, to: _to, ...rest }) => rest), // coordinates are not echoed back
    stops: fit.stops,
    fares,
    budget: summarizeBudget(plan, fares, dropped),
  };
}

export type RoutedPlan = Awaited<ReturnType<typeof buildRoutedPlan>>;

/** Safe aggregate for the plan_routed log: per call mode / status / HTTP status only. */
export function routeDiagnosticsSummary(legs: { index: number; diagnostics: RouteDiagnostic[] }[]) {
  return legs.flatMap((l) =>
    l.diagnostics.map((d) => ({ leg: l.index, mode: d.mode, status: d.status, http_status: d.http_status, error_status: d.error_status }))
  );
}
