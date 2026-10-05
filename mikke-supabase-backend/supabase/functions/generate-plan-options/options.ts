// Pure logic for the generate-plan-options Edge Function (mobile Step 4-5: A/B/C plans).
// No Deno / Supabase APIs here so it can be unit-tested with `node --test`.
//
// It reuses the proven single-plan machinery of generate-plan/plan.ts unchanged:
//   - schedulePlan(): the server (not the AI) computes every clock time, waits for opening hours,
//     and rejects plans that do not fit the time window / budget
//   - validatePlan(): the final gate before the DB
//   - estimateTravelMinutes(), hoursOnDate(), normalizedHoursStatus(), priceCeiling()
// What is new here: PlanConditions (mobile) → candidates within a duration-based straight-line radius,
// one AI call returning up to three *different* plans, per-plan validation, and cross-plan de-duplication.
//
// The AI only chooses WHICH saved places (by opaque key), in WHAT order, HOW LONG, and writes the
// title / concept / summary / reasons. Names, addresses, coordinates, prices, hours and travel times
// shown to the user are rebuilt from the database and server-side estimates, never from AI output.

import {
  type AiCallResult,
  type Candidate,
  type Conditions,
  createPlanContext,
  estimateTravelMinutes,
  haversineKm,
  hoursOnDate,
  MAX_ITEMS,
  MAX_LEG_TRAVEL_MINUTES,
  MAX_STAY_MINUTES,
  MIN_STAY_MINUTES,
  minutesToHhmm,
  normalizedHoursStatus,
  type PlanContext,
  type PlanItem,
  priceCeiling,
  schedulePlan,
  type TravelMode,
  validatePlan,
  type Violation,
  zonedParts,
} from "../generate-plan/plan.ts";

// ---------------------------------------------------------------------------
// Request (mobile PlanConditions v1) validation
// ---------------------------------------------------------------------------
export const TRANSPORT_MODES = ["walking", "train", "bus", "car"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export const PREFERENCES = ["omakase", "eat", "cafe", "shopping", "sightseeing", "relaxing", "active"] as const;
export type Preference = (typeof PREFERENCES)[number];

export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 720;
export const MAX_BUDGET_YEN = 1_000_000;
export const MAX_PREFERENCES = 3;

export type OptionsInput = {
  origin: { latitude: number; longitude: number; accuracy_m: number | null };
  durationMinutes: number;
  budgetYen: number | null;
  transportModes: TransportMode[];
  preferences: Preference[];
  generationSequence: number;
  startAt: Date;
  endAt: Date;
  /**
   * v3「今日向けに調整」: 候補をこの場所（本人の保存場所のうち）に限る。null なら保存場所すべて
   */
  placeIds?: string[] | null;
  /** v3: 元にした公開ルート（記録用。候補の選び方には使わない） */
  basedOnRoutePostId?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PLACE_IDS = 20;

/** place_ids（任意）: 1〜20件の UUID。重複は除く。未指定は null */
export function parsePlaceIds(value: unknown): { ok: true; ids: string[] | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, ids: null };
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLACE_IDS) return { ok: false };
  if (value.some((v) => typeof v !== "string" || !UUID_RE.test(v))) return { ok: false };
  return { ok: true, ids: [...new Set(value.map((v) => (v as string).toLowerCase()))] };
}

/** 候補行（saved_places + places）を place_ids で絞る。ids が null なら全件 */
// deno-lint-ignore no-explicit-any
export function filterRowsByPlaceIds<T extends { places?: any }>(rows: T[], ids: string[] | null | undefined): T[] {
  if (!ids) return rows;
  const wanted = new Set(ids);
  return rows.filter((row) => {
    const place = Array.isArray(row.places) ? row.places[0] : row.places;
    return typeof place?.id === "string" && wanted.has(place.id.toLowerCase());
  });
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function validCoordinate(lat: unknown, lng: unknown): boolean {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** Plans start at the next 5-minute mark from "now" and last duration_minutes. */
export function planWindow(now: Date, durationMinutes: number) {
  const step = 5 * 60_000;
  const start = new Date(Math.ceil(now.getTime() / step) * step);
  return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
}

export function parseOptionsRequest(body: unknown, now: Date):
  { ok: true; input: OptionsInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;
  const c = b.conditions as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return { ok: false, error: "conditions_required" };
  if (c.version !== 1) return { ok: false, error: "unsupported_conditions_version" };
  const origin = c.origin as Record<string, unknown> | undefined;
  if (!origin || !validCoordinate(origin.latitude, origin.longitude)) return { ok: false, error: "origin_required" };
  if (!isInt(c.duration_minutes) || c.duration_minutes < MIN_DURATION_MINUTES || c.duration_minutes > MAX_DURATION_MINUTES) {
    return { ok: false, error: "invalid_duration" };
  }
  if (!(c.budget_yen === null || (isInt(c.budget_yen) && c.budget_yen > 0 && c.budget_yen <= MAX_BUDGET_YEN))) {
    return { ok: false, error: "invalid_budget" };
  }
  const modes = Array.isArray(c.transport_modes) ? TRANSPORT_MODES.filter((m) => (c.transport_modes as unknown[]).includes(m)) : [];
  if (modes.length === 0 || (c.transport_modes as unknown[]).length !== new Set(c.transport_modes as unknown[]).size) {
    return { ok: false, error: "invalid_transport_modes" };
  }
  if ((c.transport_modes as unknown[]).some((m) => !TRANSPORT_MODES.includes(m as TransportMode))) {
    return { ok: false, error: "invalid_transport_modes" };
  }
  const rawPrefs = Array.isArray(c.preferences) ? (c.preferences as unknown[]) : [];
  if (rawPrefs.length < 1 || rawPrefs.length > MAX_PREFERENCES || rawPrefs.some((p) => !PREFERENCES.includes(p as Preference))) {
    return { ok: false, error: "invalid_preferences" };
  }
  let prefs = PREFERENCES.filter((p) => rawPrefs.includes(p));
  if (prefs.includes("omakase")) prefs = ["omakase"];
  const sequence = b.generation_sequence ?? 1;
  if (!isInt(sequence) || sequence < 1 || sequence > 3) return { ok: false, error: "generation_sequence_must_be_1_to_3" };
  const accuracy = typeof origin.accuracy_m === "number" && Number.isFinite(origin.accuracy_m) && origin.accuracy_m >= 0
    ? Math.round(origin.accuracy_m)
    : null;
  const placeIds = parsePlaceIds(b.place_ids);
  if (!placeIds.ok) return { ok: false, error: "invalid_place_ids" };
  const basedOn = b.based_on_route_post_id ?? null;
  if (basedOn !== null && (typeof basedOn !== "string" || !UUID_RE.test(basedOn))) {
    return { ok: false, error: "invalid_based_on_route_post_id" };
  }
  const window = planWindow(now, c.duration_minutes);
  return {
    ok: true,
    input: {
      origin: { latitude: origin.latitude as number, longitude: origin.longitude as number, accuracy_m: accuracy },
      durationMinutes: c.duration_minutes,
      budgetYen: c.budget_yen as number | null,
      transportModes: modes,
      preferences: prefs,
      generationSequence: sequence,
      startAt: window.start,
      endAt: window.end,
      placeIds: placeIds.ids,
      basedOnRoutePostId: basedOn,
    },
  };
}

// ---------------------------------------------------------------------------
// Transport modes → the existing single travel-mode estimator
// ---------------------------------------------------------------------------
/**
 * The fastest selected mode sets how far the plan can reach (car > train/bus > walking).
 * Walking between nearby places is still modelled by the 5-minute floor in estimateTravelMinutes.
 */
export function effectiveTravelMode(modes: readonly TransportMode[]): TravelMode {
  if (modes.includes("car")) return "car";
  if (modes.includes("train") || modes.includes("bus")) return "public_transit";
  return "walk";
}

/**
 * Straight-line search radius from the origin (km), used ONLY to pick candidates.
 * Roughly: the outbound leg may use about a third of the available time.
 *   walk:            1.5 km per hour of duration, 1.5 – 5 km
 *   public transit:  5 km per hour,               5 – 30 km
 *   car:             10 km per hour,              10 – 50 km
 * The maxima equal generate-plan's travelRadiusKm() so both functions agree on "too far".
 */
export const RADIUS_PROFILE: Record<TravelMode, { perHour: number; min: number; max: number }> = {
  walk: { perHour: 1.5, min: 1.5, max: 5 },
  bicycle: { perHour: 4, min: 3, max: 12 },
  public_transit: { perHour: 5, min: 5, max: 30 },
  car: { perHour: 10, min: 10, max: 50 },
};

export function searchRadiusKm(mode: TravelMode, durationMinutes: number): number {
  const p = RADIUS_PROFILE[mode];
  return Math.min(p.max, Math.max(p.min, (durationMinutes / 60) * p.perHour));
}

/** The legacy Conditions shape so the existing scheduler / validator can be reused as-is. */
export function toLegacyConditions(input: OptionsInput): Conditions {
  return {
    current_location: { latitude: input.origin.latitude, longitude: input.origin.longitude },
    start_at: input.startAt.toISOString(),
    end_at: input.endAt.toISOString(),
    budget_max: input.budgetYen,
    travel_mode: effectiveTravelMode(input.transportModes),
    companion: "alone",
    moods: input.preferences,
  };
}

// ---------------------------------------------------------------------------
// Candidates (the user's own saved places only; rows come from an RLS-scoped query)
// ---------------------------------------------------------------------------
export const MAX_OPTION_CANDIDATES = 15;

const PREFERENCE_CATEGORIES: Record<Exclude<Preference, "omakase">, string[]> = {
  eat: ["lunch", "dinner", "sweets", "bakery"],
  cafe: ["cafe", "sweets", "bakery"],
  shopping: ["shopping"],
  sightseeing: ["sightseeing", "activity"],
  relaxing: ["cafe", "onsen", "sightseeing"],
  active: ["activity", "sightseeing"],
};

function preferenceScore(category: string, prefs: readonly Preference[]): number {
  if (prefs.includes("omakase")) return 8;
  return prefs.some((p) => PREFERENCE_CATEGORIES[p as Exclude<Preference, "omakase">]?.includes(category)) ? 25 : 0;
}

export type CandidateStats = {
  total: number;
  dismissed: number;
  no_coordinates: number;
  too_far: number;
  over_budget: number;
  closed: number;
  eligible: number;
};

export type OptionCandidates = { candidates: Candidate[]; stats: CandidateStats; radiusKm: number };

// deno-lint-ignore no-explicit-any
export function selectCandidates(rows: any[], input: OptionsInput, now: Date): OptionCandidates {
  const mode = effectiveTravelMode(input.transportModes);
  const radiusKm = searchRadiusKm(mode, input.durationMinutes);
  const stats: CandidateStats = { total: 0, dismissed: 0, no_coordinates: 0, too_far: 0, over_budget: 0, closed: 0, eligible: 0 };
  const startAt = input.startAt.toISOString();
  const endAt = input.endAt.toISOString();
  const seen = new Set<string>();
  const eligible: Candidate[] = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const place = row?.places;
    if (!place || typeof place.id !== "string" || seen.has(place.id)) continue;
    seen.add(place.id);
    stats.total++;
    if (row.visited_status === "dismissed") {
      stats.dismissed++;
      continue;
    }
    const lat = place.latitude == null ? NaN : Number(place.latitude);
    const lng = place.longitude == null ? NaN : Number(place.longitude);
    // Without coordinates the distance / travel buffer cannot be checked, so the place is not offered.
    if (!validCoordinate(lat, lng)) {
      stats.no_coordinates++;
      continue;
    }
    const distance = haversineKm(input.origin, { latitude: lat, longitude: lng });
    if (distance > radiusKm) {
      stats.too_far++;
      continue;
    }
    const ceiling = priceCeiling(String(place.price_band ?? "unknown"));
    if (input.budgetYen != null && ceiling != null && ceiling > input.budgetYen) {
      stats.over_budget++;
      continue;
    }
    const hoursStatus = normalizedHoursStatus(place.opening_hours, startAt, endAt);
    if (hoursStatus === "closed") {
      stats.closed++;
      continue;
    }
    const savedAt = new Date(row.saved_at).getTime();
    const ageDays = Number.isFinite(savedAt) ? Math.max(0, (now.getTime() - savedAt) / 86_400_000) : 0;
    const score = 30
      + preferenceScore(String(place.category), input.preferences)
      + Math.max(0, 15 * (1 - distance / radiusKm))
      + (hoursStatus === "confirmed_open" ? 10 : 0)
      + Math.min(10, ageDays / 18);
    eligible.push({
      id: place.id,
      name: String(place.name ?? ""),
      category: String(place.category ?? "other"),
      address: String(place.address ?? ""),
      latitude: lat,
      longitude: lng,
      price_band: String(place.price_band ?? "unknown"),
      opening_hours: place.opening_hours ?? null,
      saved_at: String(row.saved_at ?? ""),
      score: Math.round(score * 10) / 10,
      distance_km: Math.round(distance * 10) / 10,
      hours_status: hoursStatus,
    });
  }
  stats.eligible = eligible.length;
  const candidates = eligible.sort((a, b) => b.score - a.score).slice(0, MAX_OPTION_CANDIDATES);
  return { candidates, stats, radiusKm };
}

/** 3 plans need at least 3 places; with fewer places we make fewer plans instead of inventing any. */
export function planCountFor(candidateCount: number): number {
  return Math.max(0, Math.min(3, candidateCount));
}

export const VARIANTS = ["A", "B", "C"] as const;
export type Variant = (typeof VARIANTS)[number];

// ---------------------------------------------------------------------------
// AI request
// ---------------------------------------------------------------------------
export const TITLE_MAX = 24;
export const CONCEPT_MAX = 40;
export const SUMMARY_MAX = 140;
export const REASON_MAX = 120;

export function optionsSchema(ctx: PlanContext, planCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["plans"],
    properties: {
      plans: {
        type: "array",
        minItems: planCount,
        maxItems: planCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variant", "title", "concept", "summary", "items"],
          properties: {
            variant: { type: "string", enum: VARIANTS.slice(0, planCount) },
            title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
            concept: { type: "string", minLength: 1, maxLength: CONCEPT_MAX },
            summary: { type: "string", minLength: 1, maxLength: SUMMARY_MAX },
            items: {
              type: "array",
              minItems: 1,
              maxItems: MAX_ITEMS,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["place_key", "stay_minutes", "reason"],
                properties: {
                  place_key: { type: "string", enum: [...ctx.keyToCandidate.keys()] },
                  stay_minutes: { type: "integer", minimum: MIN_STAY_MINUTES, maximum: MAX_STAY_MINUTES },
                  reason: { type: "string", minLength: 1, maxLength: REASON_MAX },
                },
              },
            },
          },
        },
      },
    },
  };
}

export const OPTIONS_SYSTEM_PROMPT = [
  "You design same-day outing plans in Japan using ONLY the user's own saved places listed in candidates.",
  "Return exactly plan_count plans with variants A, B, C (in that order, as many as plan_count).",
  "Each plan must have a clearly DIFFERENT concept (e.g. slow cafe walk / food-centred / pack in many spots), not the same places reshuffled:",
  "the set of places must differ between plans. Follow the user's preferences first; with 'omakase', create the differences from the candidates' categories.",
  "You only choose WHICH places (place_key), in WHAT order, HOW LONG to stay, and write title, concept, summary and one reason per place.",
  "The server computes clock times and travel itself. The whole plan must fit in duration_minutes including",
  "travel_minutes_from_origin to the first place, travel_minutes between consecutive places, and all stays.",
  "Two places may be consecutive only if travel_minutes[previous][next] exists. Hours 'closed' must not be used; 'unknown' may be used.",
  "Fewer places (even one) are better than an infeasible plan.",
  "Never invent places, addresses, prices, opening hours, travel times, station names or routes, and never mention clock times, yen amounts or train lines.",
  "Write title (<=24 chars), concept (<=40 chars), summary (<=140 chars) and reason (<=120 chars) in natural, friendly Japanese.",
].join(" ");

function hoursText(openingHours: unknown, ymd: string): string | string[] {
  const day = hoursOnDate(openingHours, ymd);
  if (day.status !== "open") return day.status;
  return day.windows.map(([open, close]) => `${minutesToHhmm(open)}-${minutesToHhmm(close)}`);
}

export function buildOptionsPayload(ctx: PlanContext, input: OptionsInput, planCount: number) {
  const mode = ctx.conditions.travel_mode;
  const keys = [...ctx.keyToCandidate.keys()];
  const start = zonedParts(ctx.requestedStart, ctx.timeZone);
  const fromOrigin: Record<string, number> = {};
  const travel: Record<string, Record<string, number>> = {};
  for (const key of keys) {
    const c = ctx.keyToCandidate.get(key)!;
    fromOrigin[key] = estimateTravelMinutes(input.origin, c, mode) ?? MAX_LEG_TRAVEL_MINUTES;
    travel[key] = {};
    for (const other of keys) {
      if (other === key) continue;
      const minutes = estimateTravelMinutes(c, ctx.keyToCandidate.get(other)!, mode);
      if (minutes != null && minutes <= MAX_LEG_TRAVEL_MINUTES) travel[key][other] = minutes;
    }
  }
  const categoryCounts: Record<string, number> = {};
  for (const c of ctx.candidates) categoryCounts[c.category] = (categoryCounts[c.category] ?? 0) + 1;
  return {
    request: {
      plan_count: planCount,
      variants: VARIANTS.slice(0, planCount),
      duration_minutes: input.durationMinutes,
      start_local: `${start.ymd} ${minutesToHhmm(start.minutes)} (${start.weekday})`,
      transport_modes: input.transportModes,
      preferences: input.preferences,
      budget_max_yen: input.budgetYen,
      candidate_categories: categoryCounts,
    },
    // No addresses or coordinates: the AI needs names, categories and precomputed numbers only.
    candidates: keys.map((key) => {
      const c = ctx.keyToCandidate.get(key)!;
      return {
        place_key: key,
        name: c.name,
        category: c.category,
        price_band: c.price_band,
        open_hours: hoursText(c.opening_hours, start.ymd),
      };
    }),
    travel_minutes_from_origin: fromOrigin,
    travel_minutes: travel,
  };
}

// ---------------------------------------------------------------------------
// Validation of one AI plan → a PlanOption rebuilt from DB data
// ---------------------------------------------------------------------------
export type BudgetStatus = "estimated" | "partial" | "unknown";

export type PlanOptionItem = {
  order: number;
  place_id: string;
  place_name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** Estimated arrival (server-computed from straight-line travel estimates). Not a timetable. */
  estimated_arrival_at: string;
  estimated_stay_minutes: number;
  /** Rough travel buffer before this stop (straight-line based). Not a route or timetable. */
  travel_buffer_minutes: number;
  reason: string;
  hours_status: "confirmed_open" | "unknown";
  price_band: string;
};

export type PlanOption = {
  variant: Variant;
  title: string;
  concept: string;
  summary: string;
  estimated_start_at: string;
  estimated_end_at: string;
  /** Travel buffer from the origin + stays + travel buffers. Always <= duration_minutes. */
  estimated_total_minutes: number;
  travel_buffer_minutes: number;
  /** Sum of the known price-band ceilings (per person). null when no place has price information. */
  estimated_budget_yen: number | null;
  budget_status: BudgetStatus;
  /** true / false against budget_yen when every price is known; null when unknown or no budget. */
  within_budget: boolean | null;
  items: PlanOptionItem[];
  /** Rows for create_generated_plan (not sent to the client). */
  db_items: PlanItem[];
};

export type RawAiPlan = {
  variant?: unknown;
  title?: unknown;
  concept?: unknown;
  summary?: unknown;
  items?: Array<{ place_key?: unknown; stay_minutes?: unknown; reason?: unknown }>;
};

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > max) return null;
  return text;
}

export function budgetFor(candidates: Candidate[], budgetYen: number | null) {
  let known = 0;
  let unknown = 0;
  for (const c of candidates) {
    const ceiling = priceCeiling(c.price_band);
    if (ceiling == null) unknown++;
    else known += ceiling;
  }
  const status: BudgetStatus = unknown === 0 ? "estimated" : unknown === candidates.length ? "unknown" : "partial";
  return {
    knownSum: known,
    estimated_budget_yen: status === "unknown" ? null : known,
    budget_status: status,
    within_budget: budgetYen == null || status !== "estimated" ? null : known <= budgetYen,
  };
}

export function validateOption(
  raw: RawAiPlan,
  ctx: PlanContext,
  input: OptionsInput,
): { ok: true; option: Omit<PlanOption, "variant"> & { variant: string } } | { ok: false; violations: Violation[] } {
  const violations: Violation[] = [];
  const title = cleanText(raw?.title, TITLE_MAX);
  const concept = cleanText(raw?.concept, CONCEPT_MAX);
  const summary = cleanText(raw?.summary, SUMMARY_MAX);
  if (!title) violations.push({ code: "invalid_title" });
  if (!concept) violations.push({ code: "invalid_concept" });
  if (!summary) violations.push({ code: "invalid_summary" });
  const items = Array.isArray(raw?.items) ? raw.items : [];
  if (items.length === 0) violations.push({ code: "no_items" });
  if (violations.length > 0) return { ok: false, violations };

  const mode = ctx.conditions.travel_mode;
  const first = ctx.keyToCandidate.get(String(items[0]?.place_key));
  if (!first) return { ok: false, violations: [{ code: "unknown_place", item: 1, place_key: String(items[0]?.place_key) }] };
  const firstLeg = estimateTravelMinutes(input.origin, first, mode);
  if (firstLeg == null || firstLeg > MAX_LEG_TRAVEL_MINUTES) {
    return { ok: false, violations: [{ code: "first_place_too_far", item: 1, place_key: String(items[0]?.place_key) }] };
  }
  // The scheduler starts the first stay after the (estimated) trip from the origin.
  const shifted: PlanContext = { ...ctx, requestedStart: new Date(ctx.requestedStart.getTime() + firstLeg * 60_000) };
  const chosen = items.map((i) => ctx.keyToCandidate.get(String(i?.place_key))).filter((c): c is Candidate => !!c);
  const budget = budgetFor(chosen, input.budgetYen);
  const scheduled = schedulePlan({
    // Only the known price-band ceilings count; the AI never states prices.
    estimated_budget: budget.knownSum,
    items: items.map((i) => ({
      place_key: String(i?.place_key),
      stay_minutes: i?.stay_minutes as number,
      selection_reason: typeof i?.reason === "string" ? i.reason : "",
    })),
  }, shifted);
  if (!scheduled.ok) return { ok: false, violations: scheduled.violations };
  const gate = validatePlan(scheduled.plan, shifted);
  if (gate.length > 0) return { ok: false, violations: gate };

  const byId = new Map(ctx.candidates.map((c) => [c.id, c]));
  const dbItems = scheduled.plan.items.map((item, index) => index === 0 ? { ...item, travel_minutes: firstLeg } : item);
  const last = dbItems[dbItems.length - 1];
  const end = new Date(new Date(last.start_at).getTime() + last.stay_minutes * 60_000);
  const totalMinutes = Math.round((end.getTime() - ctx.requestedStart.getTime()) / 60_000);
  if (totalMinutes > input.durationMinutes) return { ok: false, violations: [{ code: "exceeds_duration" }] };

  return {
    ok: true,
    option: {
      variant: String(raw.variant ?? ""),
      title: title!,
      concept: concept!,
      summary: summary!,
      estimated_start_at: ctx.requestedStart.toISOString(),
      estimated_end_at: end.toISOString(),
      estimated_total_minutes: totalMinutes,
      travel_buffer_minutes: dbItems.reduce((sum, i) => sum + i.travel_minutes, 0),
      estimated_budget_yen: budget.estimated_budget_yen,
      budget_status: budget.budget_status,
      within_budget: budget.within_budget,
      items: dbItems.map((item) => {
        const c = byId.get(item.place_id)!; // DB data, never the AI's
        return {
          order: item.sequence,
          place_id: c.id,
          place_name: c.name,
          category: c.category,
          address: c.address,
          latitude: c.latitude,
          longitude: c.longitude,
          estimated_arrival_at: item.start_at,
          estimated_stay_minutes: item.stay_minutes,
          travel_buffer_minutes: item.travel_minutes,
          reason: item.selection_reason,
          hours_status: c.hours_status,
          price_band: c.price_band,
        };
      }),
      db_items: dbItems,
    },
  };
}

const placeSetKey = (option: { items: { place_id: string }[] }) =>
  option.items.map((i) => i.place_id).sort().join(",");

/**
 * Validate every plan of one AI answer. Invalid plans are cut down to their longest valid
 * leading part (nothing is invented); plans visiting exactly the same set of places as an
 * earlier plan are dropped so the options really differ.
 */
export function collectOptions(parsed: unknown, ctx: PlanContext, input: OptionsInput, planCount: number) {
  const violations: Violation[] = [];
  const valid: (Omit<PlanOption, "variant"> & { variant: string })[] = [];
  const plans = (parsed as { plans?: unknown })?.plans;
  if (!Array.isArray(plans)) return { valid, violations: [{ code: "plans_missing" }] };
  if (plans.length !== planCount) violations.push({ code: "plan_count", detail: `${plans.length} != ${planCount}` });
  const seenVariants = new Set<string>();
  const seenSets = new Set<string>();

  for (const [index, raw] of plans.slice(0, planCount).entries()) {
    const variant = String((raw as RawAiPlan)?.variant ?? "");
    const tag = `plan ${variant || index + 1}`;
    if (!VARIANTS.slice(0, planCount).includes(variant as Variant) || seenVariants.has(variant)) {
      violations.push({ code: "invalid_or_duplicate_variant", detail: tag });
      continue;
    }
    seenVariants.add(variant);
    let result = validateOption(raw as RawAiPlan, ctx, input);
    if (!result.ok) {
      violations.push(...result.violations.map((v) => ({ ...v, detail: `${tag}${v.detail ? `: ${v.detail}` : ""}` })));
      const items = Array.isArray((raw as RawAiPlan).items) ? (raw as RawAiPlan).items! : [];
      for (let length = Math.min(items.length, MAX_ITEMS) - 1; length >= 1 && !result.ok; length--) {
        result = validateOption({ ...(raw as RawAiPlan), items: items.slice(0, length) }, ctx, input);
      }
      if (!result.ok) continue;
    }
    const key = placeSetKey(result.option);
    if (seenSets.has(key)) {
      violations.push({ code: "same_places_as_other_plan", detail: tag });
      continue;
    }
    seenSets.add(key);
    valid.push(result.option);
  }
  return { valid, violations };
}

export function feedbackForOptions(violations: Violation[]): string {
  const lines = violations.slice(0, 10).map((v) =>
    `- ${v.code}${v.item ? ` (item ${v.item}${v.place_key ? `, ${v.place_key}` : ""})` : ""}${v.detail ? `: ${v.detail}` : ""}`
  );
  return "Your previous answer was rejected by the server for these reasons:\n" + lines.join("\n")
    + "\nAnswer again. Every plan must fit in duration_minutes including travel from the origin, use different sets of places,"
    + " and use only reachable consecutive pairs. Return fewer places per plan if needed.";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export type OptionsResult =
  | {
    ok: true;
    options: PlanOption[];
    planCount: number;
    candidateCount: number;
    stats: CandidateStats;
    radiusKm: number;
    attempts: number;
    failedAttempts: { attempt: number; violations: Violation[]; raw: string | null }[];
  }
  | {
    ok: false;
    error: "no_saved_places" | "no_candidates" | "ai_generation_failed" | "ai_output_failed_validation";
    stats: CandidateStats;
    radiusKm: number;
    attempts: number;
    failedAttempts: { attempt: number; violations: Violation[]; raw: string | null }[];
  };

export async function generatePlanOptions(
  input: OptionsInput,
  // deno-lint-ignore no-explicit-any
  rows: any[],
  deps: {
    callAi: (args: { schema: unknown; payload: string; feedback: string | null }) => Promise<AiCallResult>;
    now: Date;
    maxAttempts?: number;
  },
): Promise<OptionsResult> {
  const { candidates, stats, radiusKm } = selectCandidates(rows, input, deps.now);
  const failedAttempts: { attempt: number; violations: Violation[]; raw: string | null }[] = [];
  if (stats.total === 0) return { ok: false, error: "no_saved_places", stats, radiusKm, attempts: 0, failedAttempts };
  if (candidates.length === 0) return { ok: false, error: "no_candidates", stats, radiusKm, attempts: 0, failedAttempts };

  const planCount = planCountFor(candidates.length);
  const ctx = createPlanContext(candidates, toLegacyConditions(input));
  const payload = JSON.stringify(buildOptionsPayload(ctx, input, planCount));
  const schema = optionsSchema(ctx, planCount);

  // Like generate-plan: a rejected answer gets one feedback-driven retry first; plans that were cut
  // down to a valid prefix are only used when no cleaner answer arrives.
  let best: (Omit<PlanOption, "variant"> & { variant: string })[] = [];
  let bestViolationCount = Infinity;
  let feedback: string | null = null;
  let lastError: "ai_generation_failed" | "ai_output_failed_validation" = "ai_output_failed_validation";
  const maxAttempts = deps.maxAttempts ?? 2;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const result = await deps.callAi({ schema, payload, feedback });
    if (!result.ok) {
      failedAttempts.push({ attempt, violations: [{ code: result.error_code }], raw: null });
      lastError = "ai_generation_failed";
      if (!result.retryable) break;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      failedAttempts.push({ attempt, violations: [{ code: "invalid_json" }], raw: result.text.slice(0, 800) });
      lastError = "ai_output_failed_validation";
      feedback = feedbackForOptions([{ code: "invalid_json" }]);
      continue;
    }
    const { valid, violations } = collectOptions(parsed, ctx, input, planCount);
    if (valid.length > best.length || (valid.length === best.length && valid.length > 0 && violations.length < bestViolationCount)) {
      best = valid;
      bestViolationCount = violations.length;
    }
    if (violations.length === 0 && valid.length === planCount) break;
    failedAttempts.push({ attempt, violations, raw: result.text.slice(0, 800) });
    lastError = "ai_output_failed_validation";
    feedback = feedbackForOptions(violations);
  }

  if (best.length === 0) return { ok: false, error: lastError, stats, radiusKm, attempts, failedAttempts };
  // Re-letter so the user always sees A, B, C in order even if one plan was dropped.
  const options = best.map((o, i) => ({ ...o, variant: VARIANTS[i] })) as PlanOption[];
  return { ok: true, options, planCount, candidateCount: candidates.length, stats, radiusKm, attempts, failedAttempts };
}

// ---------------------------------------------------------------------------
// Privacy: what may be stored / logged about the origin
// ---------------------------------------------------------------------------
/** ~1 km precision. Exact coordinates are used for computation only and never stored or logged. */
export function coarseOrigin(origin: { latitude: number; longitude: number }) {
  return { latitude: Math.round(origin.latitude * 100) / 100, longitude: Math.round(origin.longitude * 100) / 100 };
}

/** condition_json stored with each plans row (no exact coordinates). */
export function storedConditions(input: OptionsInput, meta: { set_id: string; variant: string; title: string; concept: string; summary: string; budget_status: BudgetStatus }) {
  return {
    source: "mobile_plan_options",
    version: 1,
    origin_coarse: coarseOrigin(input.origin),
    start_at: input.startAt.toISOString(),
    end_at: input.endAt.toISOString(),
    duration_minutes: input.durationMinutes,
    budget_yen: input.budgetYen,
    transport_modes: input.transportModes,
    preferences: input.preferences,
    ...(input.basedOnRoutePostId ? { based_on_route_post_id: input.basedOnRoutePostId } : {}),
    option: meta,
  };
}

/** Public response shape (db_items are internal). */
export function toPublicOption(option: PlanOption, planId: string) {
  const { db_items: _dbItems, ...rest } = option;
  return { plan_id: planId, ...rest };
}
