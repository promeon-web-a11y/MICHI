// TripRequest（と、文章を読み取った結果）を、Route Planner が使う形に整理する。
// - 条件を「守る条件（hard）」「好み（soft）」「前提（context）」に分ける
// - 食い違い（設定同士、文章と設定）を見つけ、どちらを採ったかを記録する。守る条件は、好みより必ず優先する
// - 指定が無くて仮に決めたこと（日付・行き先など）を assumptions に残す
// AI は使わない。構造化済みの項目を、AI に解釈し直させない。
import type { Locale } from "@/content/locale";
import {
  ALLERGY_OPTIONS,
  AVOID_OPTIONS,
  DESTINATION_OPTIONS,
  DIETARY_OPTIONS,
  FOOD_OPTIONS,
  GROUP_NEED_OPTIONS,
  INTEREST_OPTIONS,
  PACE_OPTIONS,
  TRANSPORT_OPTIONS,
  labelOf,
  tripRequestLanguage,
  type AllergyId,
  type AvoidId,
  type DietaryId,
  type FoodId,
  type GroupNeedId,
  type InterestId,
  type Pace,
  type Setting,
  type SpotStyle,
  type TransportId,
  type TravelerType,
  type TripRequest,
  type WalkingTolerance,
} from "@/services/plan/trip-request";
import type { PlanNotice, TransportMode } from "@/services/plan/types";

import { plannerMessages } from "./messages";

export type PlaceKind = "meal" | "cafe" | "activity";
export type ChatKeyword = { keyword: string; kind: PlaceKind; label: string };

/** 入力欄の文章を読み取った結果（interpret-request の出力を、決まった形に直したもの） */
export type ChatReading = {
  plannable: boolean;
  /** 検索に使う地名（日本語の表記） */
  area: string | null;
  /** 画面に出す地名（プランの文章の言語） */
  areaLabel: string | null;
  durationMinutes: number | null;
  budgetYen: number | null;
  partySize: number | null;
  startTime: string | null;
  transport: TransportId[];
  pace: Pace | null;
  wantedFoods: FoodId[];
  rejectedFoods: FoodId[];
  wantedInterests: InterestId[];
  rejectedInterests: InterestId[];
  allergies: AllergyId[];
  dietary: DietaryId[];
  otherExclusions: string[];
  keywords: ChatKeyword[];
};

export type PlannerBrief = {
  language: Locale;
  /** 利用者が書いた文章（おでかけの相談として読めたときだけ）。AI にはそのまま参考として渡す */
  message: string | null;
  area: { search: string; label: string };
  date: string;
  /** 0 = 日曜 */
  weekday: number;
  /** 分（0:00 からの分数）。null は指定なし */
  window: { start: number | null; end: number | null; maxMinutes: number | null; earliestStart: number | null };
  partySize: number | null;
  transportMode: TransportMode | null;
  /** 徒歩の区間として許す長さ（分） */
  maxWalkLegMinutes: number;
  /** 守る条件。好みより必ず優先する */
  hard: {
    allergies: AllergyId[];
    allergiesOther: string[];
    dietary: DietaryId[];
    wheelchair: boolean;
    excludedFoods: FoodId[];
    excludedInterests: InterestId[];
    excludedTexts: string[];
    avoidNightlife: boolean;
    avoidExpensive: boolean;
    budgetYen: number | null;
  };
  /** 好み。できる範囲で反映する */
  soft: {
    foods: FoodId[];
    interests: InterestId[];
    pace: Pace | null;
    spotStyle: SpotStyle | null;
    setting: Setting | null;
    walking: WalkingTolerance | null;
    avoid: AvoidId[];
    mustVisit: string[];
    keywords: ChatKeyword[];
  };
  /** 前提 */
  context: {
    travelerType: TravelerType | null;
    groupNeeds: GroupNeedId[];
    startingPoint: string | null;
    endingPoint: string | null;
  };
  limits: { minStops: number; maxStops: number };
  /** アレルギー・食事の制限があるか（どのお店についても、適合は確認できない） */
  hasDietConstraints: boolean;
  assumptions: string[];
  warnings: PlanNotice[];
  conflicts: PlanNotice[];
  unresolved: string[];
};

const DEFAULT_AREA = { ja: "札幌", en: "Sapporo" };
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WANTS_NOW = /今日|今から|これから|いまから|今すぐ|今夜|今晩|このあと|\b(?:today|tonight|right now|from now|this (?:morning|afternoon|evening))\b/i;
/** 日付の指定が無いとき、この時刻（日本時間）より前なら今日、過ぎていたら明日のプランにする */
const SAME_DAY_CUTOFF_MINUTES = 9 * 60;
const MAX_STOPS_BY_PACE: Record<Pace, number> = { relaxed: 3, balanced: 4, packed: 5 };
const DEFAULT_MAX_STOPS = 4;

export const toMinutes = (time: string): number | null => {
  const m = TIME_PATTERN.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const toTime = (minutes: number): string => {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

/** 食べたいもののうち、守る条件と明らかにぶつかる組み合わせ（ぶつかるときは、その食べ物を探さない） */
const FOOD_CONFLICTS: Record<FoodId, { allergies: AllergyId[]; dietary: DietaryId[] }> = {
  sushi: { allergies: ["fish", "shellfish"], dietary: ["vegetarian", "vegan"] },
  seafood: { allergies: ["fish", "shellfish"], dietary: ["vegetarian", "vegan", "kosher"] },
  ramen: { allergies: ["wheat"], dietary: ["gluten_free"] },
  wagyu: { allergies: [], dietary: ["vegetarian", "vegan"] },
  yakitori: { allergies: [], dietary: ["vegetarian", "vegan"] },
  izakaya: { allergies: [], dietary: ["no_alcohol", "halal"] },
  cafe: { allergies: [], dietary: [] },
  sweets: { allergies: [], dietary: [] },
  local_cuisine: { allergies: [], dietary: [] },
};

const idsIn = <T extends string>(value: unknown, options: readonly { id: T }[]): T[] =>
  Array.isArray(value) ? options.filter((o) => value.includes(o.id)).map((o) => o.id) : [];
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
};
const positive = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(max, Math.round(value)) : null;

/** interpret-request の出力（JSON）を、決まった形に直す。形が違う値は捨てる */
export function toChatReading(raw: Record<string, unknown>): ChatReading {
  const rejectedFoods = idsIn(raw.rejected_foods, FOOD_OPTIONS);
  const rejectedInterests = idsIn(raw.rejected_interests, INTEREST_OPTIONS);
  const keywords: ChatKeyword[] = [];
  for (const item of Array.isArray(raw.search_keywords) ? raw.search_keywords : []) {
    const record = (item ?? {}) as Record<string, unknown>;
    const keyword = text(record.keyword, 30);
    const kind = record.kind === "meal" || record.kind === "cafe" || record.kind === "activity" ? record.kind : null;
    if (!keyword || !kind || keywords.some((k) => k.keyword === keyword)) continue;
    keywords.push({ keyword, kind, label: text(record.label, 30) ?? keyword });
    if (keywords.length >= 3) break;
  }
  const exclusions: string[] = [];
  for (const item of Array.isArray(raw.other_exclusions) ? raw.other_exclusions : []) {
    const value = text(item, 40);
    if (value && !exclusions.includes(value)) exclusions.push(value);
    if (exclusions.length >= 3) break;
  }
  const startTime = text(raw.start_time, 5);
  const pace = PACE_OPTIONS.find((o) => o.id === raw.pace)?.id ?? null;
  return {
    plannable: raw.plannable === true,
    area: text(raw.area, 30),
    areaLabel: text(raw.area_label, 30),
    durationMinutes: positive(raw.duration_minutes, 24 * 60),
    budgetYen: positive(raw.budget_yen, 10_000_000),
    partySize: positive(raw.party_size, 50),
    startTime: startTime && TIME_PATTERN.test(startTime) ? startTime : null,
    transport: idsIn(raw.transport, TRANSPORT_OPTIONS),
    pace,
    // 「欲しい」と「欲しくない」の両方に入っていたら、欲しくない方を採る
    wantedFoods: idsIn(raw.wanted_foods, FOOD_OPTIONS).filter((id) => !rejectedFoods.includes(id)),
    rejectedFoods,
    wantedInterests: idsIn(raw.wanted_interests, INTEREST_OPTIONS).filter((id) => !rejectedInterests.includes(id)),
    rejectedInterests,
    allergies: idsIn(raw.allergies, ALLERGY_OPTIONS),
    dietary: idsIn(raw.dietary_restrictions, DIETARY_OPTIONS),
    otherExclusions: exclusions,
    keywords,
  };
}

/** 日本時間での「今日の日付」と「いまの分」 */
function jstNow(now: Date): { date: string; minutes: number; tomorrow: string } {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { date: iso(jst), minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes(), tomorrow: iso(new Date(jst.getTime() + 24 * 3600_000)) };
}

const union = <T>(a: readonly T[], b: readonly T[]): T[] => [...a, ...b.filter((item) => !a.includes(item))];

/**
 * 依頼を整理する。chat は、文章を読み取った結果（文章が無い・読み取れなかったときは null）。
 * 文章がおでかけの相談として読めなかったときは、文章を使わず、詳細設定だけで整理する。
 */
export function buildBrief(request: TripRequest, chat: ChatReading | null, now: Date): PlannerBrief {
  const language = tripRequestLanguage(request);
  const m = plannerMessages(language);
  const label = (options: readonly { id: string; label: Record<Locale, string> }[], id: string) => labelOf(options, id, language);
  const reading = chat?.plannable ? chat : null;
  const assumptions: string[] = [];
  const warnings: PlanNotice[] = [];
  const conflicts: PlanNotice[] = [];
  const unresolved: string[] = [];

  if (request.natural_language_request && !reading) warnings.push({ code: "message_not_used", message: m.messageNotUsed });

  // ---- 守る条件（文章に書かれたアレルギー・制限も足す。安全側に倒すため、どちらかにあれば有効）
  const allergies = union(request.allergies, reading?.allergies ?? []);
  const dietary = union(request.dietary_restrictions, reading?.dietary ?? []);
  const hasDietConstraints = allergies.length + request.allergies_other.length + dietary.length > 0;
  const restrictionFor = (food: FoodId): string | null => {
    const rule = FOOD_CONFLICTS[food];
    const allergy = rule.allergies.find((id) => allergies.includes(id));
    if (allergy) return `${language === "en" ? "the allergy" : "アレルギー"}: ${label(ALLERGY_OPTIONS, allergy)}`;
    const diet = rule.dietary.find((id) => dietary.includes(id));
    return diet ? label(DIETARY_OPTIONS, diet) : null;
  };

  // ---- 食べたいもの: 文章の「欲しくない」と守る条件を先に見て、ぶつかるものは外す（外したことは記録する）
  const rejectedFoods = reading?.rejectedFoods ?? [];
  const foods: FoodId[] = [];
  for (const id of union(request.food_preferences, reading?.wantedFoods ?? [])) {
    const fromDetails = request.food_preferences.includes(id);
    const name = label(FOOD_OPTIONS, id);
    if (rejectedFoods.includes(id)) {
      conflicts.push({ code: "message_rejects_selected", message: m.messageRejectsSelected(name) });
      continue;
    }
    const restriction = restrictionFor(id);
    if (restriction) {
      conflicts.push(
        fromDetails
          ? { code: "preference_vs_restriction", message: m.preferenceVsRestriction(name, restriction) }
          : { code: "message_vs_restriction", message: m.messageVsRestriction(name, restriction) },
      );
      continue;
    }
    foods.push(id);
  }

  // ---- 興味
  const avoidNightlife = request.avoid.includes("nightlife");
  const rejectedInterests = union(reading?.rejectedInterests ?? [], avoidNightlife ? (["nightlife"] as InterestId[]) : []);
  const interests: InterestId[] = [];
  for (const id of union(request.interests, reading?.wantedInterests ?? [])) {
    if (rejectedInterests.includes(id)) {
      if (request.interests.includes(id)) {
        const name = label(INTEREST_OPTIONS, id);
        conflicts.push(
          id === "nightlife" && avoidNightlife
            ? { code: "avoid_vs_interest", message: m.avoidVsInterest(name) }
            : { code: "message_rejects_selected", message: m.messageRejectsSelected(name) },
        );
      }
      continue;
    }
    interests.push(id);
  }

  // ---- 行き先（1日のプランなので、使うのは1つ）
  let area: PlannerBrief["area"];
  const [first, ...others] = request.destinations;
  if (first) {
    const option = DESTINATION_OPTIONS.find((o) => o.id === first.id);
    area = option ? { search: option.label.ja, label: option.label[language] } : { search: first.name, label: first.name };
    if (others.length > 0) {
      const names = others.map((d) => (d.id ? label(DESTINATION_OPTIONS, d.id) : d.name)).join(m.listSeparator);
      assumptions.push(m.extraDestinations(area.label, names));
    }
    const mentioned = reading?.area;
    const same = mentioned && [area.search, area.label, option?.label.en, option?.label.ja].some((n) => n && mentioned.toLowerCase().includes(n.toLowerCase()));
    if (mentioned && !same) conflicts.push({ code: "destination_differs", message: m.destinationDiffers(mentioned, area.label) });
  } else if (reading?.area) {
    area = { search: reading.area, label: reading.areaLabel ?? reading.area };
  } else {
    area = { search: DEFAULT_AREA.ja, label: DEFAULT_AREA[language] };
    assumptions.push(m.areaDefault(area.label));
  }

  // ---- 日付（営業時間を確かめる曜日）
  const today = jstNow(now);
  const wantsNow = WANTS_NOW.test(request.natural_language_request);
  let date = request.dates.start;
  if (!date || date < today.date) {
    date = wantsNow || today.minutes < SAME_DAY_CUTOFF_MINUTES ? today.date : today.tomorrow;
    const weekdayName = m.weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()];
    assumptions.push(m.dateAssumed(date, weekdayName));
  }
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

  // ---- 使える時間
  const start = (request.available_time.start ? toMinutes(request.available_time.start) : null) ?? (reading?.startTime ? toMinutes(reading.startTime) : null);
  let end = request.available_time.end ? toMinutes(request.available_time.end) : null;
  if (start !== null && end !== null && end <= start) {
    end = null;
    warnings.push({ code: "window_ignored", message: m.windowIgnored });
  }
  const maxMinutes = start !== null && end !== null ? end - start : (reading?.durationMinutes ?? null);
  // 「今日・今から」と書かれたときは、いまの時刻（30分単位に切り上げ）より前には始めない
  const earliestStart = wantsNow && date === today.date ? Math.min(23 * 60, Math.ceil((today.minutes + 1) / 30) * 30) : null;

  // ---- 予算（文章と設定で違うときは、低い方を上限にする）
  const detailBudget = request.budget.currency === "JPY" ? request.budget.amount : null;
  const chatBudget = reading?.budgetYen ?? null;
  const budgetYen = detailBudget !== null && chatBudget !== null ? Math.min(detailBudget, chatBudget) : (detailBudget ?? chatBudget);
  if (detailBudget !== null && chatBudget !== null && detailBudget !== chatBudget) {
    conflicts.push({ code: "budget_differs", message: m.budgetDiffers(`¥${budgetYen!.toLocaleString("en-US")}`) });
  }

  // ---- 人数
  const partySize =
    request.travelers.count ?? (request.travelers.type === "solo" ? 1 : request.travelers.type === "couple" ? 2 : null) ?? reading?.partySize ?? null;
  if (partySize === null) assumptions.push(m.partyAssumed);

  // ---- 移動手段
  const transport = request.transportation.length > 0 ? request.transportation : (reading?.transport ?? []);
  let transportMode: TransportMode | null = null;
  if (transport.includes("car") || transport.includes("taxi")) transportMode = "car";
  else if (transport.includes("train") || transport.includes("bus")) transportMode = "public_transit";
  else if (transport.includes("walking")) transportMode = "walk";
  else assumptions.push(m.transportAssumed);
  const shortWalks = request.avoid.includes("long_walks") || request.walking_tolerance === "low";
  const maxWalkLegMinutes = shortWalks ? 15 : 30;

  // ---- ペース
  const pace = request.pace ?? reading?.pace ?? null;
  if (request.pace && reading?.pace && request.pace !== reading.pace) {
    conflicts.push({ code: "pace_differs", message: m.paceDiffers(label(PACE_OPTIONS, request.pace)) });
  }
  let maxStops = pace ? MAX_STOPS_BY_PACE[pace] : DEFAULT_MAX_STOPS;
  if (maxMinutes !== null) maxStops = Math.min(maxStops, Math.max(1, Math.floor(maxMinutes / (pace === "relaxed" ? 100 : 70))));
  const minStops = Math.min(maxStops, maxMinutes !== null && maxMinutes <= 150 ? 1 : 2);

  // ---- 確かめる手段が無い条件（受け取ったことと、確かめられないことを隠さない）
  const softAvoid = request.avoid.filter((id) => id === "crowds" || id === "tourist_traps" || id === "stairs" || id === "long_walks");
  for (const id of softAvoid) if (id !== "long_walks") unresolved.push(m.cannotCheck(label(AVOID_OPTIONS, id)));
  if (request.spot_style === "local") unresolved.push(m.localSpots);
  for (const id of request.group_needs) if (id !== "wheelchair") unresolved.push(m.cannotCheck(label(GROUP_NEED_OPTIONS, id)));
  if (request.starting_point || request.ending_point) unresolved.push(m.pointsNotIncluded);

  if (hasDietConstraints) {
    const list = [
      ...dietary.map((id) => label(DIETARY_OPTIONS, id)),
      ...[...allergies.map((id) => label(ALLERGY_OPTIONS, id)), ...request.allergies_other].map((name) => `${language === "en" ? "allergy" : "アレルギー"}: ${name}`),
    ].join(m.listSeparator);
    warnings.push({ code: "hard_constraints_unverified", message: m.hardUnverified(list) });
  }

  return {
    language,
    message: reading ? request.natural_language_request : null,
    area,
    date,
    weekday,
    window: { start, end, maxMinutes, earliestStart },
    partySize,
    transportMode,
    maxWalkLegMinutes,
    hard: {
      allergies,
      allergiesOther: request.allergies_other,
      dietary,
      wheelchair: request.group_needs.includes("wheelchair"),
      excludedFoods: rejectedFoods,
      excludedInterests: rejectedInterests,
      excludedTexts: union(request.avoid_other, reading?.otherExclusions ?? []),
      avoidNightlife,
      avoidExpensive: request.avoid.includes("expensive_restaurants"),
      budgetYen,
    },
    soft: {
      foods,
      interests,
      pace,
      spotStyle: request.spot_style,
      setting: request.setting,
      walking: request.walking_tolerance,
      avoid: softAvoid,
      mustVisit: request.must_visit,
      keywords: reading?.keywords ?? [],
    },
    context: {
      travelerType: request.travelers.type,
      groupNeeds: request.group_needs,
      startingPoint: request.starting_point,
      endingPoint: request.ending_point,
    },
    limits: { minStops, maxStops },
    hasDietConstraints,
    assumptions,
    warnings,
    conflicts,
    unresolved,
  };
}
