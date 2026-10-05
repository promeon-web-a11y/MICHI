// 【旧処理】/api/plan は、いまは services/route-planner/plan-route.ts（Route Planner v1）を使う。このファイルはどこからも呼ばれていない。
// 比較用に残してある（削除は承認を得てから）。
// 文章 → 条件の整理（AI）→ 実在する場所の検索（Google Places）→ ルートの組み立て（AI）→ 時刻の計算。
// サーバー専用。UI からは /api/plan（src/app/api/plan/route.ts）経由で呼ぶ。
// 天気・交通・予約などの API を足すときは、候補を集める手順（collectCandidates）に並べて追加する。

import { detectTextLocale, type Locale } from "@/content/locale";
import { callStructured, type AiResult } from "@/services/ai/openai";
import { estimateLeg } from "@/services/maps/travel-estimate";
import { searchPlacesByText, type PlaceCandidate } from "@/services/places/google-places";

import { PLAN_ERROR_MESSAGES } from "./errors";
import { ANALYZE_SCHEMA, ANALYZE_SYSTEM_PROMPT, COMPOSE_SCHEMA, COMPOSE_SYSTEM_PROMPT } from "./prompts";
import type { PlanApiResponse, PlanConditions, PlanErrorCode, PlanLeg, PlanStop, TransportMode, TripPlan } from "./types";

const MAX_QUERIES = 4;
const MAX_CANDIDATES = 20;
const MAX_STOPS = 5;
const DEFAULT_START_TIME = "11:00";
const WANTS_NOW = /今日|今から|これから|いまから|今すぐ|今夜|今晩|このあと|\b(?:today|tonight|right now|from now|this (?:morning|afternoon|evening))\b/i;

// AI に渡す出力言語の名前と、AI が書く文章の長さの上限（英語は同じ内容でも文字数が増える）
const OUTPUT_LANGUAGE: Record<Locale, string> = { ja: "Japanese", en: "English" };
const TEXT_LIMITS: Record<Locale, { label: number; title: number; summary: number; description: number }> = {
  ja: { label: 30, title: 40, summary: 100, description: 80 },
  en: { label: 40, title: 80, summary: 160, description: 160 },
};
const FALLBACK_TITLE: Record<Locale, string> = { ja: "今日のプラン", en: "Your trip plan" };

export { PLAN_ERROR_MESSAGES };

function fail(error: PlanErrorCode): PlanApiResponse {
  return { ok: false, error, message: PLAN_ERROR_MESSAGES[error] };
}

async function callWithRetry(args: Parameters<typeof callStructured>[0]): Promise<AiResult> {
  const first = await callStructured(args);
  if (first.ok || !first.retryable) return first;
  return callStructured(args);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const cleanString = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
};
const positiveNumber = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(max, Math.round(value)) : null;

// ---------------------------------------------------------------------------------------------
// 1. 条件の整理
// ---------------------------------------------------------------------------------------------

type Analysis = { plannable: boolean; conditions: PlanConditions; queries: { query: string; role: string }[] };

function toAnalysis(raw: Record<string, unknown>, language: Locale): Analysis {
  const transport = raw.transport;
  const limits = TEXT_LIMITS[language];
  const queries: Analysis["queries"] = [];
  for (const item of Array.isArray(raw.search_queries) ? raw.search_queries : []) {
    const query = cleanString((item as { query?: unknown })?.query, 60);
    if (!query || queries.some((q) => q.query === query)) continue;
    queries.push({ query, role: cleanString((item as { role?: unknown })?.role, 20) ?? "" });
    if (queries.length >= MAX_QUERIES) break;
  }
  return {
    plannable: raw.plannable === true,
    conditions: {
      area: cleanString(raw.area, limits.label),
      budgetYen: positiveNumber(raw.budget_yen, 10_000_000),
      partySize: positiveNumber(raw.party_size, 50),
      companions: cleanString(raw.companions, language === "en" ? 20 : 12),
      transport: transport === "walk" || transport === "public_transit" || transport === "car" ? transport : null,
      durationMinutes: positiveNumber(raw.duration_minutes, 24 * 60),
      purpose: cleanString(raw.purpose, limits.label),
    },
    queries,
  };
}

// ---------------------------------------------------------------------------------------------
// 2. 実在する場所の候補
// ---------------------------------------------------------------------------------------------

type Candidate = PlaceCandidate & { role: string };

async function collectCandidates(queries: Analysis["queries"], language: Locale): Promise<{ candidates: Candidate[]; allFailed: boolean }> {
  // 場所の名前・住所・種別は、Google がその言語で持っている表記をそのまま使う（こちらでは訳さない）
  const results = await Promise.all(queries.map((q) => searchPlacesByText(q.query, language)));
  const byId = new Map<string, Candidate>();
  // 検索ごとに1件ずつ順番に取り、特定の種類の場所だけで候補が埋まらないようにする
  for (let rank = 0; byId.size < MAX_CANDIDATES; rank++) {
    let any = false;
    results.forEach((result, index) => {
      const place = result.ok ? result.places[rank] : undefined;
      if (!place) return;
      any = true;
      if (!byId.has(place.id) && byId.size < MAX_CANDIDATES) byId.set(place.id, { ...place, role: queries[index].role });
    });
    if (!any) break;
  }
  return { candidates: [...byId.values()], allFailed: results.every((r) => !r.ok) };
}

// ---------------------------------------------------------------------------------------------
// 3. ルートの組み立て
// ---------------------------------------------------------------------------------------------

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (time: string): number => {
  const m = TIME_PATTERN.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 11 * 60;
};
const toTime = (minutes: number): string => {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

type ChosenStop = { place: Candidate; stayMinutes: number; description: string; costYen: number | null };

function toChosenStops(raw: Record<string, unknown>, byShortId: Map<string, Candidate>, descriptionLimit: number): ChosenStop[] {
  const stops: ChosenStop[] = [];
  const used = new Set<string>();
  for (const item of Array.isArray(raw.stops) ? raw.stops : []) {
    const record = (item ?? {}) as Record<string, unknown>;
    const place = typeof record.id === "string" ? byShortId.get(record.id) : undefined;
    // 候補に無い ID（AI の作り話）と重複は捨てる
    if (!place || used.has(place.id)) continue;
    used.add(place.id);
    const stay = typeof record.stay_minutes === "number" && Number.isFinite(record.stay_minutes) ? record.stay_minutes : 60;
    const cost = record.estimated_cost_yen;
    stops.push({
      place,
      stayMinutes: Math.min(240, Math.max(15, Math.round(stay / 5) * 5)),
      description: cleanString(record.description, descriptionLimit) ?? "",
      costYen: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? Math.min(500_000, Math.round(cost / 100) * 100) : null,
    });
    if (stops.length >= MAX_STOPS) break;
  }
  return stops;
}

function schedule(chosen: ChosenStop[], startTime: string, conditions: PlanConditions) {
  let stops = chosen;
  for (;;) {
    const legs: PlanLeg[] = [];
    const arrivals: number[] = [];
    let clock = toMinutes(startTime);
    stops.forEach((stop, index) => {
      if (index > 0) {
        const leg = estimateLeg(stops[index - 1].place, stop.place, conditions.transport as TransportMode | null);
        legs.push(leg);
        clock += leg.minutes;
      }
      arrivals.push(clock);
      clock += stop.stayMinutes;
    });
    const total = clock - toMinutes(startTime);
    // 使える時間を大きく超えるときは、最後の立ち寄りから減らす
    const limit = conditions.durationMinutes ? conditions.durationMinutes * 1.25 + 15 : null;
    if (limit !== null && total > limit && stops.length > 2) {
      stops = stops.slice(0, -1);
      continue;
    }
    return { stops, legs, arrivals, end: clock };
  }
}

function localTimeLabel(now: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
}

// ---------------------------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------------------------

export async function generateTripPlan(prompt: string, now: Date, outputLanguage?: Locale): Promise<PlanApiResponse> {
  // プランの文章は、入力された文章の言語に合わせる（日本語の文字が無ければ英語）。
  // 詳細設定つきの依頼は、呼び出し側が言語を決めて渡す（自由入力の地名に日本語があっても、文章の言語を変えない）
  const language = outputLanguage ?? detectTextLocale(prompt);
  const limits = TEXT_LIMITS[language];
  const analyzed = await callWithRetry({
    schemaName: "mikke_plan_request",
    schema: ANALYZE_SCHEMA,
    system: ANALYZE_SYSTEM_PROMPT,
    user: JSON.stringify({ request: prompt, output_language: OUTPUT_LANGUAGE[language], current_local_time: localTimeLabel(now) }),
  });
  if (!analyzed.ok) return fail(analyzed.code === "not_configured" ? "not_configured" : "ai_failed");
  const analysisRaw = parseJson(analyzed.text);
  if (!analysisRaw) return fail("ai_failed");
  const analysis = toAnalysis(analysisRaw, language);
  if (!analysis.plannable || analysis.queries.length === 0) return fail("not_plannable");

  const { candidates, allFailed } = await collectCandidates(analysis.queries, language);
  if (allFailed) return fail("places_failed");
  if (candidates.length < 2) return fail("no_places");

  // AI には短い ID（p1, p2 …）で渡す。返ってきた ID が候補に無ければ捨てるので、実在しない場所は混ざらない
  const byShortId = new Map(candidates.map((c, i) => [`p${i + 1}`, c] as const));
  const composeInput = JSON.stringify({
    request: prompt,
    output_language: OUTPUT_LANGUAGE[language],
    // 「今日・今から」と書かれたときだけ現在時刻を渡す（書かれていないのに、今の時刻から始まるプランにしない）
    current_local_time: WANTS_NOW.test(prompt) ? localTimeLabel(now) : null,
    conditions: {
      area: analysis.conditions.area,
      budget_yen: analysis.conditions.budgetYen,
      party_size: analysis.conditions.partySize,
      companions: analysis.conditions.companions,
      transport: analysis.conditions.transport,
      duration_minutes: analysis.conditions.durationMinutes,
      purpose: analysis.conditions.purpose,
    },
    candidates: [...byShortId].map(([id, c]) => ({
      id,
      name: c.name,
      kind: c.category,
      found_for: c.role,
      address: c.address.slice(0, 40),
      lat: Number(c.latitude.toFixed(3)),
      lng: Number(c.longitude.toFixed(3)),
      rating: c.rating,
      reviews: c.ratingCount,
      price_level: c.priceLevel,
    })),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const composed = await callWithRetry({
      schemaName: "mikke_trip_plan",
      schema: COMPOSE_SCHEMA,
      system: COMPOSE_SYSTEM_PROMPT,
      user: composeInput,
    });
    if (!composed.ok) return fail("ai_failed");
    const raw = parseJson(composed.text);
    const chosen = raw ? toChosenStops(raw, byShortId, limits.description) : [];
    if (!raw || chosen.length < 2) continue;
    // 時間に余裕があるのに立ち寄りが2か所だけなら、1回だけ作り直す
    const shortOuting = (analysis.conditions.durationMinutes ?? Infinity) <= 180;
    if (chosen.length < 3 && !shortOuting && attempt === 0) continue;

    const startTime = typeof raw.start_time === "string" && TIME_PATTERN.test(raw.start_time.trim()) ? raw.start_time.trim() : DEFAULT_START_TIME;
    const scheduled = schedule(chosen, startTime, analysis.conditions);
    const stops: PlanStop[] = scheduled.stops.map((stop, index) => ({
      placeId: stop.place.id,
      name: stop.place.name,
      category: stop.place.category,
      description: stop.description,
      address: stop.place.address,
      mapsUrl: stop.place.mapsUrl,
      photoUrl: stop.place.photoName ? `/api/place-photo?name=${encodeURIComponent(stop.place.photoName)}` : null,
      photoCredit: stop.place.photoCredit,
      arrival: toTime(scheduled.arrivals[index]),
      stayMinutes: stop.stayMinutes,
      estimatedCostYen: stop.costYen,
    }));
    const costs = scheduled.stops.map((s) => s.costYen);
    const plan: TripPlan = {
      language,
      title: cleanString(raw.title, limits.title) ?? FALLBACK_TITLE[language],
      summary: cleanString(raw.summary, limits.summary) ?? "",
      conditions: analysis.conditions,
      stops,
      legs: scheduled.legs,
      startTime: toTime(toMinutes(startTime)),
      endTime: toTime(scheduled.end),
      totalCostYen: costs.some((c) => c !== null) ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0) : null,
    };
    return { ok: true, plan };
  }
  return fail("ai_failed");
}
