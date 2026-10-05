// MICHI Route Planner v1。TripRequest から、実際に回れる1日のルートを作る。サーバー専用（/api/plan から呼ぶ）。
//
//   TripRequest
//     → 文章があるときだけ、文章を決まった項目に読み取る（AI・小さい呼び出し）
//     → 条件の整理（brief.ts。守る条件 / 好み / 前提、食い違い、仮定）
//     → 候補の場所を集める（Google Places。検索語はプログラムが作り、並列に検索）
//     → 守る条件と明らかにぶつかる場所・休みの場所を外す（candidates.ts）
//     → MICHI 独自データ（いまは無い。michi-data.ts）
//     → ルートを組む（AI・1回）
//     → 時刻の計算・軽い修正・検証（validate.ts。プログラム）
//     → fail のときだけ、問題を伝えて1回だけ作り直す
//
// - 詳細設定だけの依頼は、AI の呼び出しは1回。構造化済みの条件を、文章に潰して AI に読み直させない
// - 安全に関わる文（アレルギー・食事の制限・営業時間が分からない等）は、AI ではなく messages.ts の決まった文で付ける
// - 外部 API が失敗したら、その情報は「分からない」のまま扱う（AI に埋めさせない）
import type { Locale } from "@/content/locale";
import { callStructured, type AiResult } from "@/services/ai/openai";
import { PLAN_ERROR_MESSAGES } from "@/services/plan/errors";
import {
  ALLERGY_OPTIONS,
  AVOID_OPTIONS,
  DIETARY_OPTIONS,
  FOOD_OPTIONS,
  GROUP_NEED_OPTIONS,
  INTEREST_OPTIONS,
  PACE_OPTIONS,
  SETTING_OPTIONS,
  SPOT_STYLE_OPTIONS,
  TRAVELER_TYPE_OPTIONS,
  WALKING_OPTIONS,
  labelOf,
  summarizeTripRequest,
  tripRequestLanguage,
  type TripRequest,
} from "@/services/plan/trip-request";
import type { PlanApiResponse, PlanErrorCode, PlanNotice, PlanStop, StopEvidence, TripPlan } from "@/services/plan/types";
import { searchPlacesByText, type PlacesSearchResult } from "@/services/places/google-places";

import { buildBrief, toChatReading, toMinutes, toTime, type ChatReading, type PlannerBrief } from "./brief";
import { MAX_CANDIDATES, buildSearchPlan, collectCandidates, formatDayHours, walkableCluster, type RouteCandidate, type SearchItem } from "./candidates";
import { plannerMessages } from "./messages";
import { NO_MICHI_DATA, type MichiDataProvider, type MichiPlaceData } from "./michi-data";
import { ACTIVE_PROMPTS, type PlannerPrompts } from "./prompts";
import { repairRoute, resolveStart, validateRoute, type ChosenStop, type RouteCheck, type ScheduledRoute } from "./validate";

/** 検証で fail になったときに、作り直す回数の上限（無限に繰り返さない） */
export const MAX_REGENERATIONS = 1;
/** 文章を読み取っている間に、先に始めておく検索の数 */
const EARLY_SEARCHES = 3;

const OUTPUT_LANGUAGE: Record<Locale, string> = { ja: "Japanese", en: "English" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TEXT_LIMITS: Record<Locale, { title: number; concept: number; reason: number; unmet: number }> = {
  ja: { title: 40, concept: 100, reason: 80, unmet: 40 },
  en: { title: 80, concept: 160, reason: 160, unmet: 80 },
};
const FALLBACK_TITLE: Record<Locale, string> = { ja: "今日のプラン", en: "Your trip plan" };

export type PlannerLogEntry = Record<string, unknown>;

/** 外部とのやり取り。テストや評価では、ここを差し替える */
export type PlannerDeps = {
  callAi: typeof callStructured;
  searchPlaces: (query: string, language: Locale) => Promise<PlacesSearchResult>;
  michi: MichiDataProvider;
  now: () => Date;
  log: (entry: PlannerLogEntry) => void;
  prompts: PlannerPrompts;
};

export const defaultPlannerDeps = (): PlannerDeps => ({
  callAi: callStructured,
  searchPlaces: searchPlacesByText,
  michi: NO_MICHI_DATA,
  now: () => new Date(),
  log: (entry) => console.info("[mikke] route_planner", JSON.stringify(entry)),
  prompts: ACTIVE_PROMPTS,
});

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * アレルギー・食事の制限・バリアフリーに触れている文かどうか。
 * これらの条件があるとき、AI が書いた文（タイトル・説明・理由）がこれに当たれば、その文は使わない。
 * 「豚肉なしで楽しめる」「アレルギー対応」のような、確認していない適合を AI に書かせないための、プログラム側の歯止め
 * （Prompt でも禁じているが、守られないことがあった）。
 */
const HARD_CONSTRAINT_CLAIM =
  /allerg|shellfish|peanut|gluten|halal|kosher|vegan|vegetarian|pork|alcohol|dietar|restrict|wheelchair|accessib|step-free|barrier|\bsafe|[a-z]-free\b|\bfree of\b|without|suitable|friendly|アレルギ|アレルゲン|ハラール|ハラル|コーシャ|ヴィーガン|ビーガン|ベジタリアン|菜食|豚|アルコール|グルテン|制限|対応|安全|安心|不使用|抜き|フリー|車いす|車椅子|段差|甲殻|小麦/i;
/** 確認する手段が無い評判（地元の人に人気、など）を、事実のように書いた文。条件の有無にかかわらず使わない */
const UNVERIFIED_REPUTATION =
  /favou?red by locals|popular (?:with|among) locals|loved by locals|locals love|local favou?rites?|where locals (?:go|eat)|地元(?:の人|民|客)?に(?:人気|愛され|親しまれ)|地元民|地元で人気/i;
/** AI が、内部の ID や注意の符号を文に混ぜたとき */
const INTERNAL_TOKEN = /[a-z]+_[a-z]+|\bcaution\b|\bcandidates?\b|\bp\d+\b/i;

const cleanString = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
};

/** ログに残す依頼の形。文章の中身・アレルギーや食事の制限の中身・自由入力は残さない（件数と有無だけ） */
function requestShape(request: TripRequest): PlannerLogEntry {
  return {
    language: request.language,
    message_chars: request.natural_language_request.length,
    destinations: request.destinations.map((d) => d.id ?? "other"),
    has_date: request.dates.start !== null,
    has_time: request.available_time.start !== null || request.available_time.end !== null,
    has_budget: request.budget.amount !== null,
    travelers: request.travelers.type,
    interests: request.interests,
    food_preferences: request.food_preferences,
    transportation: request.transportation,
    pace: request.pace,
    hard_constraint_count: request.allergies.length + request.allergies_other.length + request.dietary_restrictions.length,
    avoid_count: request.avoid.length + request.avoid_other.length,
    must_visit_count: request.must_visit.length,
  };
}

/** AI に渡す入力（JSON）。旅行の条件と候補の場所だけを渡す。個人を特定する情報は含まない */
function plannerInput(
  brief: PlannerBrief,
  shortIds: Map<string, RouteCandidate>,
  michi: Map<string, MichiPlaceData>,
  previous: { stop_ids: string[]; removed_ids: string[]; problems: string[] } | null,
) {
  const label = (options: readonly { id: string; label: Record<Locale, string> }[], id: string) => labelOf(options, id, "en");
  const { hard, soft, context } = brief;
  const time = (minutes: number | null) => (minutes === null ? null : toTime(minutes));
  return {
    output_language: OUTPUT_LANGUAGE[brief.language],
    plan_window: {
      date: brief.date,
      weekday: WEEKDAYS[brief.weekday],
      start: time(brief.window.start),
      end: time(brief.window.end),
      max_minutes: brief.window.maxMinutes,
      earliest_start: time(brief.window.earliestStart),
    },
    party_size: brief.partySize,
    hard_constraints: {
      allergies: [...hard.allergies.map((id) => label(ALLERGY_OPTIONS, id)), ...hard.allergiesOther],
      dietary_restrictions: hard.dietary.map((id) => label(DIETARY_OPTIONS, id)),
      accessibility: hard.wheelchair ? ["wheelchair user"] : [],
      exclusions: [
        ...hard.excludedFoods.map((id) => label(FOOD_OPTIONS, id)),
        ...hard.excludedInterests.map((id) => label(INTEREST_OPTIONS, id)),
        ...hard.excludedTexts,
        ...(hard.avoidExpensive ? ["expensive restaurants"] : []),
      ],
      budget_yen: hard.budgetYen,
    },
    soft_preferences: {
      foods: soft.foods.map((id) => label(FOOD_OPTIONS, id)),
      interests: soft.interests.map((id) => label(INTEREST_OPTIONS, id)),
      other_wishes: soft.keywords.map((k) => k.label),
      must_visit: soft.mustVisit,
      pace: soft.pace ? label(PACE_OPTIONS, soft.pace) : null,
      kind_of_places: soft.spotStyle ? label(SPOT_STYLE_OPTIONS, soft.spotStyle) : null,
      indoor_outdoor: soft.setting ? label(SETTING_OPTIONS, soft.setting) : null,
      walking: soft.walking ? label(WALKING_OPTIONS, soft.walking) : null,
      avoid: soft.avoid.map((id) => label(AVOID_OPTIONS, id)),
    },
    context: {
      destination: brief.area.label,
      traveler_type: context.travelerType ? label(TRAVELER_TYPE_OPTIONS, context.travelerType) : null,
      group: context.groupNeeds.map((id) => label(GROUP_NEED_OPTIONS, id)),
      transport: brief.transportMode,
      starting_point: context.startingPoint,
      ending_point: context.endingPoint,
    },
    traveler_message: brief.message,
    limits: { min_stops: brief.limits.minStops, max_stops: brief.limits.maxStops },
    candidates: [...shortIds].map(([id, c]) => ({
      id,
      name: c.place.name,
      kind: c.place.category,
      type: c.found.kind,
      found_for: c.found.label,
      requested: c.found.requested,
      must_visit: c.found.mustVisit !== null,
      lat: Number(c.place.latitude.toFixed(3)),
      lng: Number(c.place.longitude.toFixed(3)),
      // 営業時間が取れなかった場所は "unknown"（開いている、とは渡さない）
      open: formatDayHours(c.hours) ?? "unknown",
      price_level: c.place.priceLevel,
      rating: c.place.rating,
      reviews: c.place.ratingCount,
      caution: c.cautions.length > 0 ? c.cautions.join(", ") : null,
      michi: michi.get(c.place.id) ?? null,
    })),
    previous_attempt: previous,
  };
}

/** 作り直しを頼むときに、AI に伝える問題の説明 */
const PROBLEM_TEXT: Record<string, string> = {
  too_few_stops: "Too few usable stops remained. Choose more candidates that fit the open hours, time and budget.",
  duplicate_place: "A place was used twice.",
  outside_opening_hours: "A stop could not be visited within its open hours.",
  long_wait: "A stop was reached long before it opens.",
  leg_too_long: "Two consecutive stops are too far apart for the transport. Choose places closer together.",
  over_available_time: "The route does not fit the available time. Use fewer stops or shorter stays.",
  over_budget: "The estimated total cost exceeds budget_yen. Choose cheaper stops.",
  backtracking: "The order goes back and forth. Reorder so nearby places are consecutive.",
  must_visit_left_out: "A must_visit candidate was left out. Include it.",
};

function toChosenStops(raw: Record<string, unknown>, shortIds: Map<string, RouteCandidate>, brief: PlannerBrief): ChosenStop[] {
  const stops: ChosenStop[] = [];
  const used = new Set<string>();
  for (const item of Array.isArray(raw.stops) ? raw.stops : []) {
    const record = (item ?? {}) as Record<string, unknown>;
    const candidate = typeof record.id === "string" ? shortIds.get(record.id) : undefined;
    // 候補に無い ID（AI の作り話）と重複は捨てる
    if (!candidate || used.has(candidate.place.id)) continue;
    used.add(candidate.place.id);
    const stay = typeof record.stay_minutes === "number" && Number.isFinite(record.stay_minutes) ? record.stay_minutes : 60;
    const cost = record.estimated_cost_yen;
    stops.push({
      candidate,
      stayMinutes: Math.min(240, Math.max(brief.soft.pace === "relaxed" ? 45 : 15, Math.round(stay / 5) * 5)),
      reason: cleanString(record.reason, TEXT_LIMITS[brief.language].reason) ?? "",
      costYen: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? Math.min(500_000, Math.round(cost / 100) * 100) : null,
    });
  }
  return stops;
}

type Attempt = { route: ScheduledRoute; check: RouteCheck; raw: Record<string, unknown> };

const NEUTRAL: Record<Locale, { reason: (label: string) => string; title: (area: string) => string }> = {
  en: { reason: (label) => `Stop for ${label}.`, title: (area) => `${area} route` },
  ja: { reason: (label) => `${label}の立ち寄りです。`, title: (area) => `${area}のプラン` },
};

function buildPlan(brief: PlannerBrief, attempt: Attempt, candidates: RouteCandidate[], plan: SearchItem[]): TripPlan {
  const m = plannerMessages(brief.language);
  const limits = TEXT_LIMITS[brief.language];
  const { route, check, raw } = attempt;
  const needsEvidence = brief.hasDietConstraints || brief.hard.wheelchair;
  // 守る条件があるとき、それに触れた AI の文は使わず、決まった文に置き換える
  let claimsRemoved = 0;
  const safeText = (value: string | null, fallback: string): string => {
    const unusable = value !== null && ((needsEvidence && HARD_CONSTRAINT_CLAIM.test(value)) || UNVERIFIED_REPUTATION.test(value) || INTERNAL_TOKEN.test(value));
    if (value && !unusable) return value;
    if (value) claimsRemoved++;
    return fallback;
  };

  const stops: PlanStop[] = route.stops.map((stop, index) => {
    const { place, hours, cautions } = stop.candidate;
    const evidence: StopEvidence = {
      openingHours: hours.status === "open" ? "external" : "unknown",
      cost: stop.costYen !== null ? "estimated" : "unknown",
      travelTime: "estimated",
      // 食事の制限・アレルギーは、どのお店についても確認できていない。車いすだけのときは、入口の情報（Google）があれば external
      hardConstraints: !needsEvidence ? null : !brief.hasDietConstraints && place.wheelchairEntrance === true ? "external" : "unknown",
    };
    return {
      placeId: place.id,
      name: place.name,
      category: place.category,
      description: safeText(stop.reason || null, NEUTRAL[brief.language].reason(stop.candidate.found.label)),
      address: place.address,
      mapsUrl: place.mapsUrl,
      photoUrl: place.photoName ? `/api/place-photo?name=${encodeURIComponent(place.photoName)}` : null,
      photoCredit: place.photoCredit,
      arrival: toTime(route.arrivals[index]),
      departure: toTime(route.departures[index]),
      stayMinutes: route.departures[index] - route.arrivals[index],
      estimatedCostYen: stop.costYen,
      openingHours: formatDayHours(hours),
      notes: [...cautions.map((topic) => m.caution[topic]), ...(hours.status === "unknown" ? [m.stopHoursUnknown] : [])],
      evidence,
    };
  });

  const assumptions = [...brief.assumptions];
  if (brief.window.start === null) assumptions.push(m.startAssumed(toTime(route.start)));
  const general = [...new Set(route.stops.filter((s) => !s.candidate.found.requested).map((s) => s.candidate.found.label))];
  if (general.length > 0) assumptions.push(m.generalOptions(general.join(m.listSeparator)));

  const warnings: PlanNotice[] = [...brief.warnings];
  const issueCodes = new Set(check.issues.map((i) => i.code));
  const unknownHours = route.stops.filter((s) => s.candidate.hours.status === "unknown").map((s) => s.candidate.place.name);
  if (unknownHours.length > 0) warnings.push({ code: "opening_hours_unknown", message: m.hoursUnknown(unknownHours.join(m.listSeparator)) });
  if (brief.hard.wheelchair) {
    const known = route.stops.filter((s) => s.candidate.place.wheelchairEntrance === true).length;
    warnings.push({ code: "accessibility_unverified", message: m.accessibilityPartial(known, route.stops.length) });
  }
  if (issueCodes.has("cost_unknown")) warnings.push({ code: "cost_unknown", message: m.costUnknown });
  const chosenIds = new Set(route.stops.map((s) => s.candidate.place.id));
  for (const name of brief.soft.mustVisit) {
    const found = candidates.find((c) => c.found.mustVisit === name);
    if (!found) warnings.push({ code: "must_visit_not_found", message: m.mustVisitNotFound(name) });
    else if (!chosenIds.has(found.place.id)) warnings.push({ code: "must_visit_left_out", message: m.mustVisitLeftOut(name) });
  }
  if (issueCodes.has("no_meal_stop")) warnings.push({ code: "no_meal_stop", message: m.noMeal });
  if (issueCodes.has("backtracking")) warnings.push({ code: "backtracking", message: m.backtracking });

  const unmet: string[] = [];
  for (const item of Array.isArray(raw.unmet_requests) ? raw.unmet_requests : []) {
    const value = cleanString(item, limits.unmet);
    if (value && (INTERNAL_TOKEN.test(value) || (needsEvidence && HARD_CONSTRAINT_CLAIM.test(value)))) continue;
    if (value && !unmet.includes(value)) unmet.push(value);
    if (unmet.length >= 4) break;
  }
  // 検索の枠に入らなかった条件は、候補を探せていない
  const searched = new Set(plan.map((p) => p.label));
  const notSearched = [
    ...brief.soft.foods.map((id) => labelOf(FOOD_OPTIONS, id, brief.language)),
    ...brief.soft.interests.filter((id) => id !== "food").map((id) => labelOf(INTEREST_OPTIONS, id, brief.language)),
  ].filter((name) => !searched.has(name) && !unmet.includes(name));

  const title = safeText(cleanString(raw.title, limits.title), NEUTRAL[brief.language].title(brief.area.label)) || FALLBACK_TITLE[brief.language];
  const summary = safeText(cleanString(raw.concept, limits.concept), "");
  const validation: RouteCheck =
    claimsRemoved > 0
      ? { status: check.status === "pass" ? "warning" : check.status, issues: [...check.issues, { code: "ai_text_replaced", severity: "warning" }] }
      : check;

  return {
    language: brief.language,
    title,
    summary,
    conditions: {
      area: brief.area.label,
      budgetYen: brief.hard.budgetYen,
      partySize: brief.partySize,
      companions: brief.context.travelerType ? labelOf(TRAVELER_TYPE_OPTIONS, brief.context.travelerType, brief.language) : null,
      transport: brief.transportMode,
      durationMinutes: brief.window.maxMinutes,
      purpose: null,
    },
    stops,
    legs: route.legs,
    startTime: toTime(route.start),
    endTime: toTime(route.end),
    totalCostYen: route.totalCostYen,
    date: brief.date,
    currency: "JPY",
    totalMinutes: route.end - route.start,
    assumptions,
    warnings,
    conflicts: brief.conflicts,
    unresolvedConstraints: [...brief.unresolved, ...unmet, ...notSearched],
    validation,
  };
}

export async function planRoute(request: TripRequest, deps: PlannerDeps = defaultPlannerDeps()): Promise<PlanApiResponse> {
  const startedAt = performance.now();
  const timings: Record<string, number> = { trip_request_ms: 0, candidate_fetch_ms: 0, michi_data_fetch_ms: 0, ai_generation_ms: 0, validation_ms: 0, total_ms: 0 };
  const counters = { llm_calls: 0, places_calls: 0, cache_hits: 0, regenerations: 0, candidates: 0 };
  const language = tripRequestLanguage(request);
  let lastCheck: RouteCheck | null = null;

  const finish = (response: PlanApiResponse): PlanApiResponse => {
    timings.total_ms = Math.round(performance.now() - startedAt);
    const planner = { promptVersion: deps.prompts.planner.version, regenerations: counters.regenerations, llmCalls: counters.llm_calls, timings };
    deps.log({
      prompt_version: deps.prompts.planner.version,
      interpreter_version: request.natural_language_request ? deps.prompts.interpreter.version : null,
      ok: response.ok,
      error: response.ok ? null : response.error,
      validation: lastCheck?.status ?? null,
      issues: lastCheck?.issues.map((i) => i.code) ?? [],
      stops: response.ok ? response.plan.stops.length : 0,
      ...counters,
      timings,
      request: requestShape(request),
    });
    return response.ok ? { ok: true, plan: { ...response.plan, planner } } : response;
  };
  const fail = (error: PlanErrorCode) => finish({ ok: false, error, message: PLAN_ERROR_MESSAGES[error] });

  const callAi = async (prompt: PlannerPrompts["planner"], user: unknown): Promise<AiResult> => {
    const args = { schemaName: prompt.schemaName, schema: prompt.schema, system: prompt.system, user: JSON.stringify(user) };
    counters.llm_calls++;
    const first = await deps.callAi(args);
    // 通信の失敗・混雑（429 / 5xx）のときだけ、同じ依頼をもう1回送る
    if (first.ok || !first.retryable) return first;
    counters.llm_calls++;
    return deps.callAi(args);
  };

  // 同じ検索は、この依頼の中で1回だけ実行する（先に始めた検索を、あとでそのまま使う）
  const searches = new Map<string, Promise<PlacesSearchResult>>();
  const search = (item: SearchItem): Promise<PlacesSearchResult> => {
    let pending = searches.get(item.query);
    if (!pending) {
      counters.places_calls++;
      pending = deps
        .searchPlaces(item.query, language)
        .then((result) => {
          if (result.ok && result.cached) counters.cache_hits++;
          return result;
        })
        .catch((): PlacesSearchResult => ({ ok: false, code: "error" }));
      searches.set(item.query, pending);
    }
    return pending;
  };

  // ---- 1. 文章の読み取り（文章があるときだけ。詳細設定は読み直さない）
  let stepAt = performance.now();
  const hasDetails = summarizeTripRequest(request, "en").length > 0;
  let chat: ChatReading | null = null;
  if (request.natural_language_request) {
    // 行き先が設定で決まっているなら、読み取りを待たずに検索を始める
    if (request.destinations.length > 0) {
      const early = buildSearchPlan(buildBrief(request, null, deps.now())).filter((item) => item.requested);
      for (const item of early.slice(0, EARLY_SEARCHES)) void search(item);
    }
    const read = await callAi(deps.prompts.interpreter, { message: request.natural_language_request, output_language: OUTPUT_LANGUAGE[language] });
    if (!read.ok && read.code === "not_configured") return fail("not_configured");
    const raw = read.ok ? parseJson(read.text) : null;
    chat = raw ? toChatReading(raw) : null;
    // 文章を使えないとき: 詳細設定があればそれだけで作り、無ければ作れない
    if (!chat && !hasDetails) return fail("ai_failed");
    if (chat && !chat.plannable && !hasDetails) return fail("not_plannable");
  }
  const brief = buildBrief(request, chat, deps.now());
  timings.trip_request_ms = Math.round(performance.now() - stepAt);

  // ---- 2. 候補の場所（並列に検索）
  stepAt = performance.now();
  const searchPlan = buildSearchPlan(brief);
  const results = await Promise.all(searchPlan.map(search));
  timings.candidate_fetch_ms = Math.round(performance.now() - stepAt);
  if (results.some((r) => !r.ok && r.code === "not_configured")) return fail("not_configured");
  if (results.every((r) => !r.ok)) return fail("places_failed");
  const places = results.map((r) => (r.ok ? r.places : null));
  let candidates = collectCandidates(searchPlan, places, brief);
  if (brief.transportMode === "walk") {
    // 徒歩だけのときは、すべての検索結果から歩ける1つのエリアを選び、その中の候補だけを AI に渡す
    const cluster = walkableCluster(collectCandidates(searchPlan, places, brief, Number.MAX_SAFE_INTEGER), brief);
    if (cluster.narrowed) {
      candidates = cluster.candidates.slice(0, MAX_CANDIDATES);
      brief.assumptions.push(plannerMessages(brief.language).walkableArea);
    }
  }
  counters.candidates = candidates.length;
  if (candidates.length < Math.max(2, brief.limits.minStops)) return fail("no_places");

  // ---- 3. MICHI 独自データ（無くても、取得に失敗しても、そのまま進む）
  stepAt = performance.now();
  let michi = new Map<string, MichiPlaceData>();
  try {
    michi = await deps.michi.placeData(candidates.map((c) => c.place.id));
  } catch {
    michi = new Map();
  }
  timings.michi_data_fetch_ms = Math.round(performance.now() - stepAt);

  // ---- 4. ルートを組む → 検証。fail のときだけ、問題を伝えて作り直す（MAX_REGENERATIONS 回まで）
  const shortIds = new Map(candidates.map((c, i) => [`p${i + 1}`, c] as const));
  const shortIdOf = new Map([...shortIds].map(([id, c]) => [c.place.id, id] as const));
  let previous: { stop_ids: string[]; removed_ids: string[]; problems: string[] } | null = null;
  let sawRoute = false;
  for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt++) {
    stepAt = performance.now();
    const composed = await callAi(deps.prompts.planner, plannerInput(brief, shortIds, michi, previous));
    timings.ai_generation_ms += Math.round(performance.now() - stepAt);
    if (!composed.ok) return fail(composed.code === "not_configured" ? "not_configured" : "ai_failed");
    const raw = parseJson(composed.text);
    if (!raw) return fail("ai_failed");

    stepAt = performance.now();
    const chosen = toChosenStops(raw, shortIds, brief);
    sawRoute ||= chosen.length > 0;
    const suggested = typeof raw.start_time === "string" ? toMinutes(raw.start_time) : null;
    const { route, removed } = repairRoute(chosen, resolveStart(brief, suggested), brief);
    const check = validateRoute(route, brief, candidates, attempt === MAX_REGENERATIONS);
    timings.validation_ms += Math.round(performance.now() - stepAt);
    lastCheck = check;

    if (check.status !== "fail") return finish({ ok: true, plan: buildPlan(brief, { route, check, raw }, candidates, searchPlan) });
    if (attempt === MAX_REGENERATIONS) break;
    counters.regenerations++;
    previous = {
      stop_ids: chosen.map((s) => shortIdOf.get(s.candidate.place.id) ?? ""),
      removed_ids: removed.map((id) => shortIdOf.get(id) ?? ""),
      problems: [...new Set(check.issues.filter((i) => i.severity === "fail").map((i) => PROBLEM_TEXT[i.code] ?? i.code))],
    };
  }
  // 作り直しても検証を通らなかった。検証を通っていないルートは見せない
  return fail(sawRoute ? "not_feasible" : "ai_failed");
}
