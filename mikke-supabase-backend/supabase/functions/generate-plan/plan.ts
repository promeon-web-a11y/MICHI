// Pure plan-generation logic for the generate-plan Edge Function.
// No Deno / Supabase APIs here so it can be unit-tested with `node --test`.
//
// Responsibility split (why this file exists):
// - The AI only decides WHICH saved places to visit, in WHAT order, for HOW LONG, and WHY.
// - The server deterministically computes every clock time (travel, waiting for opening)
//   and then re-validates the finished plan before anything is written to the DB.
// Letting the model do clock arithmetic was the root cause of ai_output_failed_validation:
// it regularly scheduled places before their opening time (and chained far-apart places).

export type TravelMode = "walk" | "public_transit" | "bicycle" | "car";

export type Conditions = {
  current_location?: { latitude: number; longitude: number; label?: string };
  start_at: string;
  end_at: string;
  budget_max?: number | null;
  travel_mode: TravelMode;
  companion: "alone" | "friends" | "partner" | "family";
  moods?: string[];
};

export type Candidate = {
  id: string;
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  price_band: string;
  opening_hours: unknown;
  saved_at: string;
  score: number;
  distance_km: number | null;
  hours_status: "confirmed_open" | "unknown";
};

export type PlanItem = {
  place_id: string;
  sequence: number;
  start_at: string;
  stay_minutes: number;
  travel_minutes: number;
  travel_mode: TravelMode;
  selection_reason: string;
};

export type Violation = { code: string; item?: number; place_key?: string; detail?: string };

export const MAX_ITEMS = 4;
export const MIN_STAY_MINUTES = 15;
export const MAX_STAY_MINUTES = 240;
// A single leg longer than this is not a realistic same-day outing, even in a long window.
export const MAX_LEG_TRAVEL_MINUTES = 150;
// Used only when a place has no coordinates (manual entries); deliberately conservative.
export const UNKNOWN_TRAVEL_MINUTES = 30;
const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// ---------------------------------------------------------------------------
// Time zone helpers (no external libraries; Intl only)
// ---------------------------------------------------------------------------
type ZonedParts = { ymd: string; weekday: string; minutes: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: String(parts.weekday).toLowerCase(),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function offsetMinutes(date: Date, timeZone: string) {
  const p = zonedParts(date, timeZone);
  const [y, m, d] = p.ymd.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, Math.floor(p.minutes / 60), p.minutes % 60);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

// Local wall-clock (date + minutes since midnight) in `timeZone` -> absolute Date.
export function zonedToDate(ymd: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let result = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  result = guess - offsetMinutes(new Date(result), timeZone) * 60_000;
  return new Date(result);
}

function addDays(ymd: string, days: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function weekdayOf(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function hhmmToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

export function minutesToHhmm(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------
export type DayHours =
  | { status: "unknown" }
  | { status: "closed" }
  | { status: "open"; windows: Array<[number, number]> };

export function hoursTimeZone(openingHours: unknown): string {
  const tz = (openingHours as { timezone?: unknown } | null)?.timezone;
  return typeof tz === "string" && tz ? tz : DEFAULT_TIME_ZONE;
}

// Opening windows (minutes since local midnight) for one local date.
// A weekly table that lists some days but not this one means the place is closed that day
// (resolve-place only emits days that have Google opening periods).
export function hoursOnDate(openingHours: unknown, ymd: string): DayHours {
  const hours = openingHours as { weekly?: Record<string, unknown>; timezone?: unknown } | null;
  const weekly = hours?.weekly;
  if (!weekly || typeof weekly !== "object" || typeof hours?.timezone !== "string") return { status: "unknown" };
  const listedDays = Object.keys(weekly).filter((day) => WEEKDAYS.includes(day));
  if (listedDays.length === 0) return { status: "unknown" };
  const raw = weekly[weekdayOf(ymd)];
  if (raw === undefined || raw === null) return { status: "closed" };
  if (!Array.isArray(raw)) return { status: "unknown" };
  const windows: Array<[number, number]> = [];
  for (const window of raw) {
    if (!Array.isArray(window) || window.length !== 2) continue;
    const open = hhmmToMinutes(window[0]);
    const close = hhmmToMinutes(window[1]);
    if (open === null || close === null || close <= open) continue;
    windows.push([open, close]);
  }
  if (raw.length > 0 && windows.length === 0) return { status: "unknown" };
  if (windows.length === 0) return { status: "closed" };
  return { status: "open", windows: windows.sort((a, b) => a[0] - b[0]) };
}

// "confirmed_open" / "closed" / "unknown" for a time range that stays within one local day.
export function normalizedHoursStatus(
  openingHours: unknown,
  startAt: string,
  endAt: string,
  requireFullCoverage = false,
): "confirmed_open" | "closed" | "unknown" {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "unknown";
  const timeZone = hoursTimeZone(openingHours);
  const s = zonedParts(start, timeZone);
  const e = zonedParts(end, timeZone);
  const endMinutes = e.ymd === s.ymd ? e.minutes : e.ymd === addDays(s.ymd, 1) && e.minutes === 0 ? 24 * 60 : null;
  if (endMinutes === null) return "unknown";
  const day = hoursOnDate(openingHours, s.ymd);
  if (day.status !== "open") return day.status;
  return day.windows.some(([open, close]) => requireFullCoverage
      ? open <= s.minutes && endMinutes <= close
      : open < endMinutes && s.minutes < close)
    ? "confirmed_open"
    : "closed";
}

// ---------------------------------------------------------------------------
// Requested time window (request validation)
// ---------------------------------------------------------------------------
// Date + time + an explicit offset are required. Without an offset the Edge runtime (UTC)
// would silently read "2026-09-24T10:00:00" as 10:00 UTC = 19:00 JST instead of failing.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const MAX_PLAN_WINDOW_MINUTES = 24 * 60;

export type WindowCheck =
  | { ok: true; start: Date; end: Date }
  | { ok: false; error: "invalid_time_format" | "invalid_time_range" | "time_range_too_long" | "time_range_in_past" };

// Date() silently rolls impossible dates over (2026-02-30 -> 2026-03-02), so check the calendar and clock fields.
function isRealDateTime(value: string) {
  const [y, m, d, h, mi] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10), value.slice(11, 13), value.slice(14, 16)]
    .map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth && h <= 23 && mi <= 59;
}

export function validateRequestedWindow(startAt: unknown, endAt: unknown, now: Date = new Date()): WindowCheck {
  if (typeof startAt !== "string" || typeof endAt !== "string"
    || !ISO_WITH_OFFSET.test(startAt) || !ISO_WITH_OFFSET.test(endAt)
    || !isRealDateTime(startAt) || !isRealDateTime(endAt)) {
    return { ok: false, error: "invalid_time_format" };
  }
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { ok: false, error: "invalid_time_format" };
  if (end <= start) return { ok: false, error: "invalid_time_range" };
  if (end.getTime() - start.getTime() > MAX_PLAN_WINDOW_MINUTES * 60_000) return { ok: false, error: "time_range_too_long" };
  if (end <= now) return { ok: false, error: "time_range_in_past" };
  return { ok: true, start, end };
}

// ---------------------------------------------------------------------------
// Distance / travel
// ---------------------------------------------------------------------------
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = 6371;
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

const TRAVEL_PROFILE: Record<TravelMode, { kmh: number; overhead: number }> = {
  walk: { kmh: 4.5, overhead: 0 },
  bicycle: { kmh: 13, overhead: 3 },
  public_transit: { kmh: 25, overhead: 10 },
  car: { kmh: 30, overhead: 5 },
};
const ROUTE_DETOUR_FACTOR = 1.3;

// Conservative estimate from straight-line distance. null when either place lacks coordinates.
export function estimateTravelMinutes(
  from: { latitude: number | null; longitude: number | null },
  to: { latitude: number | null; longitude: number | null },
  mode: TravelMode,
): number | null {
  if (from.latitude == null || from.longitude == null || to.latitude == null || to.longitude == null) return null;
  const km = haversineKm(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
  ) * ROUTE_DETOUR_FACTOR;
  if (km < 0.3) return 5;
  const profile = TRAVEL_PROFILE[mode] ?? TRAVEL_PROFILE.public_transit;
  return Math.max(5, Math.ceil((km / profile.kmh) * 60 + profile.overhead));
}

function travelMinutesBetween(from: Candidate, to: Candidate, mode: TravelMode) {
  return estimateTravelMinutes(from, to, mode) ?? UNKNOWN_TRAVEL_MINUTES;
}

export function travelRadiusKm(mode: TravelMode) {
  return { walk: 5, bicycle: 12, public_transit: 30, car: 50 }[mode];
}

// ---------------------------------------------------------------------------
// Candidate ranking (unchanged behaviour, moved here from index.ts)
// ---------------------------------------------------------------------------
// Exported for generate-plan-options (mobile A/B/C plans); behaviour unchanged.
export function priceCeiling(priceBand: string) {
  const ceilings: Record<string, number | null> = {
    under_1000: 1000, under_3000: 3000, under_5000: 5000, under_10000: 10000, unknown: null,
  };
  return ceilings[priceBand] ?? null;
}

function moodScore(category: string, moods: string[]) {
  if (moods.length === 0 || moods.includes("omakase")) return 8;
  const mapping: Record<string, string[]> = {
    relaxing: ["cafe", "onsen", "sightseeing"],
    eat: ["lunch", "dinner", "sweets", "bakery"],
    cafe: ["cafe", "sweets", "bakery"],
    shopping: ["shopping"],
    active: ["activity", "sightseeing"],
    healing: ["onsen", "cafe", "sightseeing"],
    new_place: ["other", "sightseeing", "activity"],
  };
  return moods.some((mood) => mapping[mood]?.includes(category)) ? 25 : 0;
}

// deno-lint-ignore no-explicit-any
export function rankCandidates(rows: any[], conditions: Conditions): Candidate[] {
  return rows
    .map((row) => {
      const place = row.places;
      const distance = conditions.current_location && place.latitude != null && place.longitude != null
        ? haversineKm(conditions.current_location, {
          latitude: Number(place.latitude),
          longitude: Number(place.longitude),
        })
        : null;
      const ceiling = priceCeiling(place.price_band);
      if (conditions.budget_max && ceiling && ceiling > conditions.budget_max) return null;
      if (distance != null && distance > travelRadiusKm(conditions.travel_mode)) return null;
      const hoursStatus = normalizedHoursStatus(place.opening_hours, conditions.start_at, conditions.end_at);
      if (hoursStatus === "closed") return null;

      const ageDays = Math.max(0, (Date.now() - new Date(row.saved_at).getTime()) / 86_400_000);
      const distanceScore = distance == null ? 4 : Math.max(0, 15 - distance * 1.5);
      const oldSaveScore = Math.min(10, ageDays / 18);
      const hoursScore = hoursStatus === "confirmed_open" ? 10 : 0;
      const score = 30 + moodScore(place.category, conditions.moods ?? []) + distanceScore + hoursScore + oldSaveScore;

      return {
        id: place.id,
        name: place.name,
        category: place.category,
        address: place.address,
        latitude: place.latitude == null ? null : Number(place.latitude),
        longitude: place.longitude == null ? null : Number(place.longitude),
        price_band: place.price_band,
        opening_hours: place.opening_hours,
        saved_at: row.saved_at,
        score: Math.round(score * 10) / 10,
        distance_km: distance == null ? null : Math.round(distance * 10) / 10,
        hours_status: hoursStatus,
      } satisfies Candidate;
    })
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// AI request: short candidate keys, precomputed hours and travel times
// ---------------------------------------------------------------------------
export type PlanContext = {
  conditions: Conditions;
  candidates: Candidate[];
  keyToCandidate: Map<string, Candidate>;
  requestedStart: Date;
  requestedEnd: Date;
  timeZone: string;
};

export function createPlanContext(candidates: Candidate[], conditions: Conditions): PlanContext {
  const keyToCandidate = new Map<string, Candidate>();
  candidates.forEach((candidate, index) => keyToCandidate.set(`c${index + 1}`, candidate));
  return {
    conditions,
    candidates,
    keyToCandidate,
    requestedStart: new Date(conditions.start_at),
    requestedEnd: new Date(conditions.end_at),
    timeZone: DEFAULT_TIME_ZONE,
  };
}

function datesInWindow(ctx: PlanContext) {
  const first = zonedParts(ctx.requestedStart, ctx.timeZone).ymd;
  const last = zonedParts(new Date(ctx.requestedEnd.getTime() - 1), ctx.timeZone).ymd;
  const dates = [first];
  while (dates[dates.length - 1] < last && dates.length < 4) dates.push(addDays(dates[dates.length - 1], 1));
  return dates;
}

function describeHours(openingHours: unknown, ymd: string) {
  const day = hoursOnDate(openingHours, ymd);
  if (day.status === "unknown") return "unknown";
  if (day.status === "closed") return "closed";
  return day.windows.map(([open, close]) => `${minutesToHhmm(open)}-${minutesToHhmm(close)}`);
}

export function planSchema(ctx: PlanContext) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["estimated_budget", "items"],
    properties: {
      estimated_budget: { type: "integer", minimum: 0 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ITEMS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["place_key", "stay_minutes", "selection_reason"],
          properties: {
            place_key: { type: "string", enum: [...ctx.keyToCandidate.keys()] },
            stay_minutes: { type: "integer", minimum: MIN_STAY_MINUTES, maximum: MAX_STAY_MINUTES },
            selection_reason: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
    },
  };
}

export const SYSTEM_PROMPT = [
  "You plan a same-day outing from the user's own saved places. You only choose WHICH places, in WHAT order, and HOW LONG to stay.",
  "The server computes every clock time itself: the first place starts at the request start (or later, when that place opens);",
  "each next place starts after the previous stay plus travel_minutes[previous][next], waiting until the place opens if needed.",
  "Therefore: order places so each is open when you would arrive (see open_hours, local time), put later-opening places later,",
  "and make sure the whole plan ends by the request end. travel_minutes[a][b] lists ONLY reachable pairs:",
  "two places may be consecutive only if travel_minutes[previous][next] exists. If a place has no reachable partner, plan it alone.",
  "Returning fewer places (even 1) is better than an infeasible plan.",
  "Places marked closed on the date must not be used. Hours 'unknown' may be used. Keep estimated_budget (yen, total per person) within budget_max_yen when given.",
  "Use only the given place_key values. Never invent places, hours or prices.",
  "Write selection_reason in natural Japanese (max 120 characters) and do NOT mention specific clock times, because the server decides them.",
].join(" ");

export function buildAiUserPayload(ctx: PlanContext) {
  const { conditions } = ctx;
  const start = zonedParts(ctx.requestedStart, ctx.timeZone);
  const end = zonedParts(ctx.requestedEnd, ctx.timeZone);
  const dates = datesInWindow(ctx);
  const keys = [...ctx.keyToCandidate.keys()];
  const travel: Record<string, Record<string, number>> = {};
  // Only reachable pairs are listed: the model reliably ignores large numbers but not missing entries.
  for (const from of keys) {
    travel[from] = {};
    for (const to of keys) {
      if (from === to) continue;
      const minutes = travelMinutesBetween(ctx.keyToCandidate.get(from)!, ctx.keyToCandidate.get(to)!, conditions.travel_mode);
      if (minutes <= MAX_LEG_TRAVEL_MINUTES) travel[from][to] = minutes;
    }
  }
  return {
    request: {
      start: `${start.ymd} ${minutesToHhmm(start.minutes)} (${start.weekday})`,
      end: `${end.ymd} ${minutesToHhmm(end.minutes)} (${end.weekday})`,
      time_zone: ctx.timeZone,
      travel_mode: conditions.travel_mode,
      companion: conditions.companion,
      moods: conditions.moods ?? [],
      budget_max_yen: conditions.budget_max ?? null,
    },
    candidates: keys.map((key) => {
      const c = ctx.keyToCandidate.get(key)!;
      return {
        place_key: key,
        name: c.name,
        category: c.category,
        price_band: c.price_band,
        address: c.address,
        open_hours: Object.fromEntries(dates.map((ymd) => [ymd, describeHours(c.opening_hours, ymd)])),
      };
    }),
    travel_minutes: travel,
  };
}

// ---------------------------------------------------------------------------
// Deterministic scheduling of the AI's choice
// ---------------------------------------------------------------------------
export type AiPlanOutput = {
  estimated_budget: number;
  items: Array<{ place_key: string; stay_minutes: number; selection_reason: string }>;
};

export type ScheduledPlan = {
  items: PlanItem[];
  total_duration_minutes: number;
  estimated_budget: number;
};

// Earliest start >= earliest at which the place is open for the whole stay, or null.
function earliestOpenStart(candidate: Candidate, earliest: Date, stayMinutes: number, latestEnd: Date): Date | null {
  const timeZone = hoursTimeZone(candidate.opening_hours);
  let ymd = zonedParts(earliest, timeZone).ymd;
  for (let dayOffset = 0; dayOffset < 4; dayOffset++, ymd = addDays(ymd, 1)) {
    const dayStart = zonedToDate(ymd, 0, timeZone);
    if (dayStart > latestEnd) break;
    const day = hoursOnDate(candidate.opening_hours, ymd);
    // Hours not verifiable: keep the previous behaviour (allowed, shown as 要確認) on the arrival day only.
    if (day.status === "unknown") return dayOffset === 0 ? earliest : null;
    if (day.status === "closed") continue;
    for (const [open, close] of day.windows) {
      const windowOpen = zonedToDate(ymd, open, timeZone);
      const windowClose = zonedToDate(ymd, close, timeZone);
      const start = windowOpen > earliest ? windowOpen : earliest;
      if (start.getTime() + stayMinutes * 60_000 <= windowClose.getTime()) return start;
    }
  }
  return null;
}

export function schedulePlan(output: AiPlanOutput, ctx: PlanContext):
  { ok: true; plan: ScheduledPlan } | { ok: false; violations: Violation[] } {
  const violations: Violation[] = [];
  const items = Array.isArray(output?.items) ? output.items : [];
  if (items.length === 0) violations.push({ code: "no_items" });
  if (items.length > MAX_ITEMS) violations.push({ code: "too_many_items", detail: String(items.length) });

  const scheduled: PlanItem[] = [];
  const seen = new Set<string>();
  let previous: Candidate | null = null;
  let previousEnd = ctx.requestedStart;

  items.slice(0, MAX_ITEMS).forEach((item, index) => {
    const tag = { item: index + 1, place_key: item?.place_key };
    const candidate = ctx.keyToCandidate.get(item?.place_key);
    if (!candidate) {
      violations.push({ ...tag, code: "unknown_place" });
      return;
    }
    if (seen.has(item.place_key)) {
      violations.push({ ...tag, code: "duplicate_place" });
      return;
    }
    seen.add(item.place_key);
    if (!Number.isInteger(item.stay_minutes) || item.stay_minutes < MIN_STAY_MINUTES || item.stay_minutes > MAX_STAY_MINUTES) {
      violations.push({ ...tag, code: "invalid_stay_minutes", detail: String(item.stay_minutes) });
      return;
    }
    if (typeof item.selection_reason !== "string" || item.selection_reason.trim() === "" || item.selection_reason.length > 120) {
      violations.push({ ...tag, code: "invalid_selection_reason" });
      return;
    }

    const travel = previous ? travelMinutesBetween(previous, candidate, ctx.conditions.travel_mode) : 0;
    if (travel > MAX_LEG_TRAVEL_MINUTES) {
      violations.push({ ...tag, code: "travel_too_long", detail: `${travel}min from ${previous!.name} to ${candidate.name}` });
      return;
    }
    const earliest = new Date(previousEnd.getTime() + travel * 60_000);
    const start = earliestOpenStart(candidate, earliest, item.stay_minutes, ctx.requestedEnd);
    if (!start) {
      const ymd = zonedParts(earliest, hoursTimeZone(candidate.opening_hours)).ymd;
      violations.push({ ...tag, code: "not_open_during_visit", detail: `${candidate.name} open_hours=${JSON.stringify(describeHours(candidate.opening_hours, ymd))}` });
      return;
    }
    const end = new Date(start.getTime() + item.stay_minutes * 60_000);
    if (end > ctx.requestedEnd) {
      violations.push({ ...tag, code: "exceeds_time_window", detail: `${candidate.name} would end at ${end.toISOString()}` });
      return;
    }
    scheduled.push({
      place_id: candidate.id,
      sequence: scheduled.length + 1,
      start_at: start.toISOString(),
      stay_minutes: item.stay_minutes,
      travel_minutes: travel,
      travel_mode: ctx.conditions.travel_mode,
      selection_reason: item.selection_reason.trim(),
    });
    previous = candidate;
    previousEnd = end;
  });

  if (!Number.isInteger(output?.estimated_budget) || output.estimated_budget < 0) {
    violations.push({ code: "invalid_budget" });
  } else if (ctx.conditions.budget_max != null && output.estimated_budget > ctx.conditions.budget_max) {
    violations.push({ code: "over_budget", detail: `${output.estimated_budget} > ${ctx.conditions.budget_max}` });
  }

  if (violations.length > 0 || scheduled.length === 0) {
    return { ok: false, violations: violations.length ? violations : [{ code: "no_items" }] };
  }
  const first = new Date(scheduled[0].start_at).getTime();
  const last = scheduled[scheduled.length - 1];
  const lastEnd = new Date(last.start_at).getTime() + last.stay_minutes * 60_000;
  return {
    ok: true,
    plan: {
      items: scheduled,
      total_duration_minutes: Math.round((lastEnd - first) / 60_000),
      estimated_budget: output.estimated_budget,
    },
  };
}

// ---------------------------------------------------------------------------
// Final gate before the DB. Independent of how the plan was produced: every rule the
// previous validator enforced, plus travel-time feasibility between consecutive places.
// ---------------------------------------------------------------------------
export function validatePlan(plan: ScheduledPlan, ctx: PlanContext): Violation[] {
  const violations: Violation[] = [];
  const byId = new Map(ctx.candidates.map((c) => [c.id, c]));
  if (!Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > MAX_ITEMS) {
    violations.push({ code: "item_count", detail: String(plan.items?.length) });
    return violations;
  }
  const seen = new Set<string>();
  let previous: Candidate | null = null;
  let previousEnd = ctx.requestedStart.getTime();
  plan.items.forEach((item, index) => {
    const tag = { item: index + 1 };
    const candidate = byId.get(item.place_id);
    if (!candidate) violations.push({ ...tag, code: "not_a_candidate" });
    if (seen.has(item.place_id)) violations.push({ ...tag, code: "duplicate_place" });
    seen.add(item.place_id);
    if (item.sequence !== index + 1) violations.push({ ...tag, code: "bad_sequence" });
    const start = new Date(item.start_at);
    if (Number.isNaN(start.getTime())) {
      violations.push({ ...tag, code: "invalid_start_at" });
      return;
    }
    if (!Number.isInteger(item.stay_minutes) || item.stay_minutes < MIN_STAY_MINUTES) {
      violations.push({ ...tag, code: "invalid_stay_minutes" });
    }
    const end = start.getTime() + item.stay_minutes * 60_000;
    const minTravel = previous && candidate ? travelMinutesBetween(previous, candidate, ctx.conditions.travel_mode) : 0;
    if (start.getTime() < previousEnd + minTravel * 60_000) violations.push({ ...tag, code: "overlap_or_insufficient_travel" });
    if (start < ctx.requestedStart) violations.push({ ...tag, code: "before_time_window" });
    if (end > ctx.requestedEnd.getTime()) violations.push({ ...tag, code: "exceeds_time_window" });
    if (candidate && normalizedHoursStatus(candidate.opening_hours, item.start_at, new Date(end).toISOString(), true) === "closed") {
      violations.push({ ...tag, code: "not_open_during_visit" });
    }
    if (typeof item.selection_reason !== "string" || item.selection_reason.trim() === "") {
      violations.push({ ...tag, code: "invalid_selection_reason" });
    }
    previous = candidate ?? previous;
    previousEnd = end;
  });
  if (ctx.conditions.budget_max != null && plan.estimated_budget > ctx.conditions.budget_max) {
    violations.push({ code: "over_budget" });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Orchestration with a bounded, feedback-driven retry
// ---------------------------------------------------------------------------
export type AiCallResult =
  | { ok: true; text: string }
  | { ok: false; stage: "openai"; error_code: string; retryable: boolean };

export type AttemptLog = { attempt: number; violations: Violation[]; raw: string | null };

export type GenerationResult =
  | { ok: true; plan: ScheduledPlan; attempts: number; failedAttempts: AttemptLog[]; truncatedFrom?: number }
  | {
    ok: false;
    stage: "openai" | "validation";
    error_code: string;
    attempts: number;
    failedAttempts: AttemptLog[];
  };

export function feedbackFor(violations: Violation[]) {
  const lines = violations.slice(0, 8).map((v) =>
    `- ${v.code}${v.item ? ` (item ${v.item}${v.place_key ? `, ${v.place_key}` : ""})` : ""}${v.detail ? `: ${v.detail}` : ""}`
  );
  return "Your previous answer was rejected by the server for these reasons:\n" + lines.join("\n")
    + "\nChoose again so that every place is open when reached, travel between places is short enough, and everything ends by the request end."
    + " Return fewer places if needed.";
}

// Last resort after all attempts failed: the longest leading part of the AI's own plan that
// passes exactly the same scheduling and DB-gate checks (e.g. keep stop 1 when stop 2 is in
// another city). Nothing is invented or relaxed; later stops are simply not included.
function longestValidPrefix(outputs: AiPlanOutput[], ctx: PlanContext) {
  for (const output of [...outputs].reverse()) {
    const items = Array.isArray(output?.items) ? output.items : [];
    for (let length = Math.min(items.length, MAX_ITEMS) - 1; length >= 1; length--) {
      const scheduled = schedulePlan({ ...output, items: items.slice(0, length) }, ctx);
      if (scheduled.ok && validatePlan(scheduled.plan, ctx).length === 0) {
        return { plan: scheduled.plan, truncatedFrom: items.length };
      }
    }
  }
  return null;
}

export async function generateValidPlan(
  ctx: PlanContext,
  callAi: (feedback: string | null) => Promise<AiCallResult>,
  maxAttempts = 2,
): Promise<GenerationResult> {
  const failedAttempts: AttemptLog[] = [];
  const rejectedOutputs: AiPlanOutput[] = [];
  let feedback: string | null = null;
  let lastFailure: { stage: "openai" | "validation"; error_code: string } = { stage: "validation", error_code: "candidate_violation" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await callAi(feedback);
    if (!result.ok) {
      failedAttempts.push({ attempt, violations: [{ code: result.error_code }], raw: null });
      lastFailure = { stage: "openai", error_code: result.error_code };
      if (!result.retryable) break;
      continue;
    }
    let parsed: AiPlanOutput;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      const violations = [{ code: "invalid_json" }];
      failedAttempts.push({ attempt, violations, raw: result.text.slice(0, 800) });
      lastFailure = { stage: "validation", error_code: "invalid_json" };
      feedback = feedbackFor(violations);
      continue;
    }
    const scheduled = schedulePlan(parsed, ctx);
    const violations = scheduled.ok ? validatePlan(scheduled.plan, ctx) : scheduled.violations;
    if (scheduled.ok && violations.length === 0) {
      return { ok: true, plan: scheduled.plan, attempts: attempt, failedAttempts };
    }
    failedAttempts.push({ attempt, violations, raw: result.text.slice(0, 800) });
    rejectedOutputs.push(parsed);
    lastFailure = { stage: "validation", error_code: "candidate_violation" };
    feedback = feedbackFor(violations);
  }
  const prefix = longestValidPrefix(rejectedOutputs, ctx);
  if (prefix) {
    return { ok: true, plan: prefix.plan, attempts: failedAttempts.length, failedAttempts, truncatedFrom: prefix.truncatedFrom };
  }
  return { ok: false, ...lastFailure, attempts: failedAttempts.length, failedAttempts };
}
