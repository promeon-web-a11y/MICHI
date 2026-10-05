// TripRequest: Home の「文章」と「詳細設定」を1つにまとめた、プラン作成の依頼。
// ブラウザ（入力の状態・送信）とサーバー（/api/plan の検証・AI に渡す文章づくり）の両方から読むので、処理は純粋な関数だけにする。
// 選択肢の名前（日本語・英語）は、画面のチップと AI に渡す文章の両方で使うため、このファイルに置く。
// tests/tripRequest.test.mjs が Node から直接読むので、実行時の import は書かない（型の import だけ）。
import type { Locale } from "@/content/locale";

type Label = Record<Locale, string>;
type Option = { id: string; label: Label };
type IdOf<T extends readonly Option[]> = T[number]["id"];

// ---------------------------------------------------------------------------------------------
// 選択肢（項目を足すときは、ここの配列に1行足す。並び順が画面の並び順）
// ---------------------------------------------------------------------------------------------

/** 行き先の候補。ここに無い地域は自由入力（destinationOther）で受ける */
export const DESTINATION_OPTIONS = [
  { id: "sapporo", prefecture: "Hokkaido", city: "Sapporo", label: { en: "Sapporo", ja: "札幌" } },
  { id: "tokyo", prefecture: "Tokyo", city: null, label: { en: "Tokyo", ja: "東京" } },
  { id: "kyoto", prefecture: "Kyoto", city: null, label: { en: "Kyoto", ja: "京都" } },
  { id: "osaka", prefecture: "Osaka", city: null, label: { en: "Osaka", ja: "大阪" } },
  { id: "fukuoka", prefecture: "Fukuoka", city: null, label: { en: "Fukuoka", ja: "福岡" } },
] as const satisfies readonly (Option & { prefecture: string; city: string | null })[];

export const TRAVELER_TYPE_OPTIONS = [
  { id: "solo", label: { en: "Solo", ja: "ひとり" } },
  { id: "couple", label: { en: "Couple", ja: "カップル" } },
  { id: "friends", label: { en: "Friends", ja: "友人" } },
  { id: "family", label: { en: "Family", ja: "家族" } },
  { id: "business", label: { en: "Business", ja: "出張" } },
] as const satisfies readonly Option[];

export const INTEREST_OPTIONS = [
  { id: "food", label: { en: "Food", ja: "グルメ" } },
  { id: "culture", label: { en: "Culture", ja: "文化" } },
  { id: "history", label: { en: "History", ja: "歴史" } },
  { id: "anime", label: { en: "Anime", ja: "アニメ" } },
  { id: "nature", label: { en: "Nature", ja: "自然" } },
  { id: "shopping", label: { en: "Shopping", ja: "買い物" } },
  { id: "nightlife", label: { en: "Nightlife", ja: "夜の街" } },
  { id: "onsen", label: { en: "Onsen", ja: "温泉" } },
  { id: "art", label: { en: "Art", ja: "アート" } },
  { id: "photography", label: { en: "Photography", ja: "写真" } },
  { id: "local_experiences", label: { en: "Local experiences", ja: "地元の体験" } },
  { id: "theme_parks", label: { en: "Theme parks", ja: "テーマパーク" } },
] as const satisfies readonly Option[];

export const FOOD_OPTIONS = [
  { id: "sushi", label: { en: "Sushi", ja: "寿司" } },
  { id: "ramen", label: { en: "Ramen", ja: "ラーメン" } },
  { id: "wagyu", label: { en: "Wagyu", ja: "和牛" } },
  { id: "seafood", label: { en: "Seafood", ja: "海鮮" } },
  { id: "yakitori", label: { en: "Yakitori", ja: "焼き鳥" } },
  { id: "izakaya", label: { en: "Izakaya", ja: "居酒屋" } },
  { id: "cafe", label: { en: "Café", ja: "カフェ" } },
  { id: "sweets", label: { en: "Sweets", ja: "スイーツ" } },
  { id: "local_cuisine", label: { en: "Local cuisine", ja: "郷土料理" } },
] as const satisfies readonly Option[];

export const TRANSPORT_OPTIONS = [
  { id: "walking", label: { en: "Walking", ja: "徒歩" } },
  { id: "train", label: { en: "Train", ja: "電車" } },
  { id: "bus", label: { en: "Bus", ja: "バス" } },
  { id: "taxi", label: { en: "Taxi", ja: "タクシー" } },
  { id: "car", label: { en: "Car", ja: "車" } },
] as const satisfies readonly Option[];

export const PACE_OPTIONS = [
  { id: "relaxed", label: { en: "Relaxed", ja: "ゆったり" } },
  { id: "balanced", label: { en: "Balanced", ja: "ほどほど" } },
  { id: "packed", label: { en: "Packed", ja: "たくさん回る" } },
] as const satisfies readonly Option[];

/** 食事の制限（宗教・主義・体質）。好み（FOOD_OPTIONS）とは別のデータとして持つ */
export const DIETARY_OPTIONS = [
  { id: "vegetarian", label: { en: "Vegetarian", ja: "ベジタリアン" } },
  { id: "vegan", label: { en: "Vegan", ja: "ヴィーガン" } },
  { id: "halal", label: { en: "Halal", ja: "ハラール" } },
  { id: "kosher", label: { en: "Kosher", ja: "コーシャ" } },
  { id: "no_pork", label: { en: "No pork", ja: "豚肉なし" } },
  { id: "no_alcohol", label: { en: "No alcohol", ja: "アルコールなし" } },
  { id: "gluten_free", label: { en: "Gluten-free", ja: "グルテンフリー" } },
] as const satisfies readonly Option[];

/** アレルギー。好き嫌いではないので、FOOD_OPTIONS とも「避けたいこと」とも混ぜない */
export const ALLERGY_OPTIONS = [
  { id: "shellfish", label: { en: "Shellfish", ja: "甲殻類・貝" } },
  { id: "fish", label: { en: "Fish", ja: "魚" } },
  { id: "peanuts", label: { en: "Peanuts", ja: "ピーナッツ" } },
  { id: "tree_nuts", label: { en: "Tree nuts", ja: "木の実" } },
  { id: "egg", label: { en: "Egg", ja: "卵" } },
  { id: "milk", label: { en: "Milk", ja: "乳" } },
  { id: "wheat", label: { en: "Wheat", ja: "小麦" } },
  { id: "soy", label: { en: "Soy", ja: "大豆" } },
  { id: "sesame", label: { en: "Sesame", ja: "ごま" } },
] as const satisfies readonly Option[];

export const AVOID_OPTIONS = [
  { id: "crowds", label: { en: "Avoid crowds", ja: "混雑を避ける" } },
  { id: "long_walks", label: { en: "Avoid long walks", ja: "長く歩くのを避ける" } },
  { id: "expensive_restaurants", label: { en: "Avoid expensive restaurants", ja: "高い店を避ける" } },
  { id: "tourist_traps", label: { en: "Avoid tourist traps", ja: "観光客向けの店を避ける" } },
  { id: "nightlife", label: { en: "Avoid nightlife", ja: "夜の街を避ける" } },
  { id: "stairs", label: { en: "Avoid stairs", ja: "階段を避ける" } },
] as const satisfies readonly Option[];

export const WALKING_OPTIONS = [
  { id: "low", label: { en: "Walk as little as possible", ja: "なるべく歩かない" } },
  { id: "medium", label: { en: "Some walking is fine", ja: "少しなら歩ける" } },
  { id: "high", label: { en: "Happy to walk a lot", ja: "たくさん歩ける" } },
] as const satisfies readonly Option[];

export const SETTING_OPTIONS = [
  { id: "indoor", label: { en: "Mostly indoor", ja: "屋内中心" } },
  { id: "outdoor", label: { en: "Mostly outdoor", ja: "屋外中心" } },
] as const satisfies readonly Option[];

export const SPOT_STYLE_OPTIONS = [
  { id: "local", label: { en: "Local spots", ja: "地元の人が行く場所" } },
  { id: "famous", label: { en: "Famous sights", ja: "有名な場所" } },
] as const satisfies readonly Option[];

export const GROUP_NEED_OPTIONS = [
  { id: "children", label: { en: "With children", ja: "子ども連れ" } },
  { id: "elderly", label: { en: "With elderly travelers", ja: "高齢の同行者" } },
  { id: "wheelchair", label: { en: "Wheelchair user", ja: "車いす利用" } },
  { id: "luggage", label: { en: "Large luggage", ja: "大きな荷物" } },
] as const satisfies readonly Option[];

/** 予算の通貨。画面で選べるのは ENABLED_CURRENCIES だけ（いまは円だけ。USD などを足すときは配列に足す） */
export const CURRENCIES = ["JPY", "USD"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];
export const ENABLED_CURRENCIES: readonly CurrencyCode[] = ["JPY"];

export type DestinationId = IdOf<typeof DESTINATION_OPTIONS>;
export type TravelerType = IdOf<typeof TRAVELER_TYPE_OPTIONS>;
export type InterestId = IdOf<typeof INTEREST_OPTIONS>;
export type FoodId = IdOf<typeof FOOD_OPTIONS>;
export type TransportId = IdOf<typeof TRANSPORT_OPTIONS>;
export type Pace = IdOf<typeof PACE_OPTIONS>;
export type DietaryId = IdOf<typeof DIETARY_OPTIONS>;
export type AllergyId = IdOf<typeof ALLERGY_OPTIONS>;
export type AvoidId = IdOf<typeof AVOID_OPTIONS>;
export type WalkingTolerance = IdOf<typeof WALKING_OPTIONS>;
export type Setting = IdOf<typeof SETTING_OPTIONS>;
export type SpotStyle = IdOf<typeof SPOT_STYLE_OPTIONS>;
export type GroupNeedId = IdOf<typeof GROUP_NEED_OPTIONS>;

// ---------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------

/** 詳細設定の入力の状態（画面用）。自由入力と数字は、入力途中の文字列のまま持つ */
export type TripDetails = {
  destinations: DestinationId[];
  destinationOther: string;
  /** "YYYY-MM-DD"。未入力は "" */
  date: string;
  /** "HH:MM"。未入力は "" */
  timeStart: string;
  timeEnd: string;
  budgetAmount: string;
  currency: CurrencyCode;
  travelerCount: number | null;
  travelerType: TravelerType | null;
  interests: InterestId[];
  foods: FoodId[];
  transportation: TransportId[];
  pace: Pace | null;
  dietary: DietaryId[];
  allergies: AllergyId[];
  allergiesOther: string;
  avoid: AvoidId[];
  avoidOther: string;
  walking: WalkingTolerance | null;
  setting: Setting | null;
  spotStyle: SpotStyle | null;
  groupNeeds: GroupNeedId[];
  startingPoint: string;
  endingPoint: string;
  mustVisit: string;
};

export type TripDestination = {
  /** 候補から選んだときはその ID。自由入力のときは null */
  id: DestinationId | null;
  country: "Japan";
  prefecture: string | null;
  city: string | null;
  /** 画面に出した名前、または入力された文字 */
  name: string;
};

/**
 * /api/plan に送る依頼。文章と詳細設定を、どちらも失わずにそのまま持つ（食い違っていても、ここでは片方に寄せない）。
 * キーは AI に渡す JSON と同じ snake_case。
 */
export type TripRequest = {
  version: 1;
  /** 画面の表示言語。文章が空のとき、プランの文章をこの言語で作る */
  language: Locale;
  /** 入力欄に書かれた文章（そのまま）。書かれていなければ "" */
  natural_language_request: string;
  destinations: TripDestination[];
  /** いまの画面は1日だけ（start と end は同じ日）。複数日に広げるときは end を別の日にする */
  dates: { start: string | null; end: string | null };
  available_time: { start: string | null; end: string | null };
  budget: { amount: number | null; currency: CurrencyCode };
  travelers: { count: number | null; type: TravelerType | null };
  interests: InterestId[];
  /** 食べたいもの（好み） */
  food_preferences: FoodId[];
  /** 食事の制限。好みではなく、守る条件（HARD_CONSTRAINT_FIELDS） */
  dietary_restrictions: DietaryId[];
  /** アレルギー。好みではなく、守る条件（HARD_CONSTRAINT_FIELDS） */
  allergies: AllergyId[];
  allergies_other: string[];
  transportation: TransportId[];
  pace: Pace | null;
  avoid: AvoidId[];
  avoid_other: string[];
  must_visit: string[];
  starting_point: string | null;
  ending_point: string | null;
  walking_tolerance: WalkingTolerance | null;
  setting: Setting | null;
  spot_style: SpotStyle | null;
  group_needs: GroupNeedId[];
};

/** 好みではなく「守る条件」として扱う項目。次の工程（Route Planner）で、優先順位の設計に使う */
export const HARD_CONSTRAINT_FIELDS = ["dietary_restrictions", "allergies", "allergies_other"] as const satisfies readonly (keyof TripRequest)[];

export const TRAVELER_COUNT_MAX = 20;
const BUDGET_MAX = 10_000_000;
const TEXT_MAX = 60;
const LIST_MAX = 5;

// ---------------------------------------------------------------------------------------------
// 画面用
// ---------------------------------------------------------------------------------------------

export function emptyTripDetails(): TripDetails {
  return {
    destinations: [],
    destinationOther: "",
    date: "",
    timeStart: "",
    timeEnd: "",
    budgetAmount: "",
    currency: ENABLED_CURRENCIES[0],
    travelerCount: null,
    travelerType: null,
    interests: [],
    foods: [],
    transportation: [],
    pace: null,
    dietary: [],
    allergies: [],
    allergiesOther: "",
    avoid: [],
    avoidOther: "",
    walking: null,
    setting: null,
    spotStyle: null,
    groupNeeds: [],
    startingPoint: "",
    endingPoint: "",
    mustVisit: "",
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanText(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** 「、」「,」改行で区切られた自由入力を、項目の一覧にする */
function splitList(text: string): string[] {
  const items: string[] = [];
  for (const part of text.split(/[,、，\n]/)) {
    const item = cleanText(part);
    if (item && !items.includes(item)) items.push(item);
    if (items.length >= LIST_MAX) break;
  }
  return items;
}

function parseAmount(text: string): number | null {
  const amount = Number(text.replace(/[,，\s]/g, ""));
  return text.trim() !== "" && Number.isFinite(amount) && amount > 0 ? Math.min(BUDGET_MAX, Math.round(amount)) : null;
}

/** 文章と詳細設定を1つの依頼にまとめる。どちらの内容も書き換えない */
export function buildTripRequest(text: string, details: TripDetails, language: Locale): TripRequest {
  const other = cleanText(details.destinationOther);
  const date = DATE_PATTERN.test(details.date) ? details.date : null;
  return {
    version: 1,
    language,
    natural_language_request: text.trim(),
    destinations: [
      ...DESTINATION_OPTIONS.filter((o) => details.destinations.includes(o.id)).map(
        (o): TripDestination => ({ id: o.id, country: "Japan", prefecture: o.prefecture, city: o.city, name: o.label.en }),
      ),
      ...(other ? [{ id: null, country: "Japan", prefecture: null, city: null, name: other } satisfies TripDestination] : []),
    ],
    dates: { start: date, end: date },
    available_time: {
      start: TIME_PATTERN.test(details.timeStart) ? details.timeStart : null,
      end: TIME_PATTERN.test(details.timeEnd) ? details.timeEnd : null,
    },
    budget: { amount: parseAmount(details.budgetAmount), currency: details.currency },
    travelers: { count: details.travelerCount, type: details.travelerType },
    interests: [...details.interests],
    food_preferences: [...details.foods],
    dietary_restrictions: [...details.dietary],
    allergies: [...details.allergies],
    allergies_other: splitList(details.allergiesOther),
    transportation: [...details.transportation],
    pace: details.pace,
    avoid: [...details.avoid],
    avoid_other: splitList(details.avoidOther),
    must_visit: splitList(details.mustVisit),
    starting_point: cleanText(details.startingPoint),
    ending_point: cleanText(details.endingPoint),
    walking_tolerance: details.walking,
    setting: details.setting,
    spot_style: details.spotStyle,
    group_needs: [...details.groupNeeds],
  };
}

/** 選択肢の名前（その言語の表記）。知らない ID はそのまま返す */
export const labelOf = (options: readonly Option[], id: string, locale: Locale): string => options.find((o) => o.id === id)?.label[locale] ?? id;
const labelsOf = (options: readonly Option[], ids: readonly string[], locale: Locale): string[] =>
  options.filter((o) => ids.includes(o.id)).map((o) => o.label[locale]);

function formatBudget(amount: number, currency: CurrencyCode): string {
  return currency === "JPY" ? `¥${amount.toLocaleString("en-US")}` : `${amount.toLocaleString("en-US")} ${currency}`;
}

const SUMMARY_WORDS: Record<Locale, { travelers: (n: number) => string; allergy: string; avoid: string; mustVisit: string; from: string; to: string }> = {
  en: { travelers: (n) => (n === 1 ? "1 traveler" : `${n} travelers`), allergy: "Allergy", avoid: "Avoid", mustVisit: "Must visit", from: "From", to: "To" },
  ja: { travelers: (n) => `${n}人`, allergy: "アレルギー", avoid: "避ける", mustVisit: "必ず行く", from: "出発", to: "終点" },
};

/**
 * 設定されている条件を、短い名前の一覧にする（入力欄の下の表示と、件数の表示に使う）。
 * 1つも設定されていなければ空の配列。
 */
export function summarizeTripRequest(request: TripRequest, locale: Locale): string[] {
  const words = SUMMARY_WORDS[locale];
  const items: string[] = [];
  for (const d of request.destinations) items.push(d.id ? labelOf(DESTINATION_OPTIONS, d.id, locale) : d.name);
  if (request.dates.start) items.push(request.dates.start);
  const { start, end } = request.available_time;
  if (start || end) items.push(`${start ?? ""}–${end ?? ""}`);
  if (request.budget.amount !== null) items.push(formatBudget(request.budget.amount, request.budget.currency));
  if (request.travelers.count !== null) items.push(words.travelers(request.travelers.count));
  if (request.travelers.type) items.push(labelOf(TRAVELER_TYPE_OPTIONS, request.travelers.type, locale));
  items.push(...labelsOf(INTEREST_OPTIONS, request.interests, locale));
  items.push(...labelsOf(FOOD_OPTIONS, request.food_preferences, locale));
  items.push(...labelsOf(TRANSPORT_OPTIONS, request.transportation, locale));
  if (request.pace) items.push(labelOf(PACE_OPTIONS, request.pace, locale));
  items.push(...labelsOf(DIETARY_OPTIONS, request.dietary_restrictions, locale));
  for (const name of [...labelsOf(ALLERGY_OPTIONS, request.allergies, locale), ...request.allergies_other]) items.push(`${words.allergy}: ${name}`);
  items.push(...labelsOf(AVOID_OPTIONS, request.avoid, locale));
  for (const name of request.avoid_other) items.push(`${words.avoid}: ${name}`);
  if (request.walking_tolerance) items.push(labelOf(WALKING_OPTIONS, request.walking_tolerance, locale));
  if (request.setting) items.push(labelOf(SETTING_OPTIONS, request.setting, locale));
  if (request.spot_style) items.push(labelOf(SPOT_STYLE_OPTIONS, request.spot_style, locale));
  items.push(...labelsOf(GROUP_NEED_OPTIONS, request.group_needs, locale));
  if (request.starting_point) items.push(`${words.from}: ${request.starting_point}`);
  if (request.ending_point) items.push(`${words.to}: ${request.ending_point}`);
  for (const name of request.must_visit) items.push(`${words.mustVisit}: ${name}`);
  return items;
}

/** 送信できるか。文章があるか、詳細設定に条件が1つでもあれば true（動詞のある文章は求めない） */
export function hasTripRequestContent(request: TripRequest): boolean {
  return request.natural_language_request.length > 0 || summarizeTripRequest(request, "en").length > 0;
}

/** アレルギー・食事の制限が設定されているか（結果に注意書きを出すかどうかの判断に使う） */
export function hasHardConstraints(request: TripRequest): boolean {
  return request.dietary_restrictions.length > 0 || request.allergies.length > 0 || request.allergies_other.length > 0;
}

// ---------------------------------------------------------------------------------------------
// サーバー用
// ---------------------------------------------------------------------------------------------

const pickIds = <T extends string>(value: unknown, options: readonly { id: T }[]): T[] =>
  Array.isArray(value) ? options.filter((o) => value.includes(o.id)).map((o) => o.id) : [];
const pickId = <T extends string>(value: unknown, options: readonly { id: T }[]): T | null => options.find((o) => o.id === value)?.id ?? null;
const pickPattern = (value: unknown, pattern: RegExp): string | null => (typeof value === "string" && pattern.test(value) ? value : null);

function pickTexts(value: unknown): string[] {
  const items: string[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = cleanText(raw);
    if (item && !items.includes(item)) items.push(item);
    if (items.length >= LIST_MAX) break;
  }
  return items;
}

/**
 * ブラウザから届いた値を、決まった形の TripRequest に直す（知らない選択肢・長すぎる文字・形の違う値は捨てる）。
 * 形そのものが違う、または文章が長すぎるときは null。
 */
export function sanitizeTripRequest(value: unknown, maxTextLength: number): TripRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const object = (key: string) => (raw[key] && typeof raw[key] === "object" ? (raw[key] as Record<string, unknown>) : {});

  const text = typeof raw.natural_language_request === "string" ? raw.natural_language_request.replace(/\s+/g, " ").trim() : "";
  if (text.length > maxTextLength) return null;

  const destinations: TripDestination[] = [];
  for (const item of Array.isArray(raw.destinations) ? raw.destinations : []) {
    const record = (item ?? {}) as Record<string, unknown>;
    const option = DESTINATION_OPTIONS.find((o) => o.id === record.id);
    if (option) {
      if (!destinations.some((d) => d.id === option.id)) {
        destinations.push({ id: option.id, country: "Japan", prefecture: option.prefecture, city: option.city, name: option.label.en });
      }
      continue;
    }
    const name = cleanText(record.name);
    if (name && !destinations.some((d) => d.id === null)) destinations.push({ id: null, country: "Japan", prefecture: null, city: null, name });
  }

  const amount = object("budget").amount;
  const count = object("travelers").count;
  return {
    version: 1,
    language: raw.language === "en" ? "en" : "ja",
    natural_language_request: text,
    destinations,
    dates: { start: pickPattern(object("dates").start, DATE_PATTERN), end: pickPattern(object("dates").end, DATE_PATTERN) },
    available_time: {
      start: pickPattern(object("available_time").start, TIME_PATTERN),
      end: pickPattern(object("available_time").end, TIME_PATTERN),
    },
    budget: {
      amount: typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? Math.min(BUDGET_MAX, Math.round(amount)) : null,
      currency: CURRENCIES.find((c) => c === object("budget").currency) ?? "JPY",
    },
    travelers: {
      count: typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= TRAVELER_COUNT_MAX ? count : null,
      type: pickId(object("travelers").type, TRAVELER_TYPE_OPTIONS),
    },
    interests: pickIds(raw.interests, INTEREST_OPTIONS),
    food_preferences: pickIds(raw.food_preferences, FOOD_OPTIONS),
    dietary_restrictions: pickIds(raw.dietary_restrictions, DIETARY_OPTIONS),
    allergies: pickIds(raw.allergies, ALLERGY_OPTIONS),
    allergies_other: pickTexts(raw.allergies_other),
    transportation: pickIds(raw.transportation, TRANSPORT_OPTIONS),
    pace: pickId(raw.pace, PACE_OPTIONS),
    avoid: pickIds(raw.avoid, AVOID_OPTIONS),
    avoid_other: pickTexts(raw.avoid_other),
    must_visit: pickTexts(raw.must_visit),
    starting_point: cleanText(raw.starting_point),
    ending_point: cleanText(raw.ending_point),
    walking_tolerance: pickId(raw.walking_tolerance, WALKING_OPTIONS),
    setting: pickId(raw.setting, SETTING_OPTIONS),
    spot_style: pickId(raw.spot_style, SPOT_STYLE_OPTIONS),
    group_needs: pickIds(raw.group_needs, GROUP_NEED_OPTIONS),
  };
}

// content/locale.ts の detectTextLocale と同じ判定（このファイルは実行時の import を持てないため、ここにも書く）
const hasJapanese = (text: string) => /[぀-ヿ㐀-鿿]/.test(text);

/** プランの文章の言語。文章があればその言語、無ければ画面の表示言語 */
export function tripRequestLanguage(request: TripRequest): Locale {
  if (!request.natural_language_request) return request.language;
  return hasJapanese(request.natural_language_request) ? "ja" : "en";
}

type PromptWords = {
  lead: string;
  heading: string;
  destination: string;
  date: string;
  time: string;
  budget: string;
  travelers: string;
  interests: string;
  food: string;
  transportation: string;
  pace: string;
  dietary: string;
  allergies: string;
  avoid: string;
  walking: string;
  setting: string;
  spotStyle: string;
  groupNeeds: string;
  start: string;
  end: string;
  mustVisit: string;
  separator: string;
};

const PROMPT_WORDS: Record<Locale, PromptWords> = {
  en: {
    lead: "Please plan an outing in Japan with the following conditions.",
    heading: "Trip details selected by the traveler:",
    destination: "Destination",
    date: "Date",
    time: "Available time",
    budget: "Budget (total)",
    travelers: "Travelers",
    interests: "Interests",
    food: "Food they would like",
    transportation: "Transportation",
    pace: "Pace",
    dietary: "Dietary restrictions (hard constraint, not a preference)",
    allergies: "Allergies (hard constraint, must avoid)",
    avoid: "Things to avoid",
    walking: "Walking",
    setting: "Indoor / outdoor",
    spotStyle: "Kind of places",
    groupNeeds: "Group needs",
    start: "Starting point",
    end: "Ending point",
    mustVisit: "Must visit",
    separator: ", ",
  },
  ja: {
    lead: "次の条件で、日本でのおでかけプランを作ってください。",
    heading: "旅行者が選んだ条件:",
    destination: "行き先",
    date: "日付",
    time: "使える時間",
    budget: "予算（合計）",
    travelers: "人数・同行者",
    interests: "興味",
    food: "食べたいもの",
    transportation: "移動手段",
    pace: "ペース",
    dietary: "食事の制限（好みではなく、守る条件）",
    allergies: "アレルギー（必ず避ける）",
    avoid: "避けたいこと",
    walking: "歩く量",
    setting: "屋内・屋外",
    spotStyle: "場所の種類",
    groupNeeds: "同行者への配慮",
    start: "出発地点",
    end: "終了地点",
    mustVisit: "必ず行きたい場所",
    separator: "、",
  },
};

/**
 * いまのプラン生成（generate-plan.ts）に渡す文章を作る。
 * 文章だけの依頼は、書かれた文章をそのまま返す（これまでの動きと同じ）。
 * 詳細設定があるときは、文章のあとに「項目: 値」の行を足す。文章と設定が食い違っていても、両方をそのまま並べる。
 */
export function tripRequestToPrompt(request: TripRequest): string {
  const locale = tripRequestLanguage(request);
  const words = PROMPT_WORDS[locale];
  const join = (items: string[]) => items.join(words.separator);
  const lines: string[] = [];
  const add = (label: string, value: string | null) => {
    if (value) lines.push(`- ${label}: ${value}`);
  };

  add(words.destination, join(request.destinations.map((d) => (d.id ? labelOf(DESTINATION_OPTIONS, d.id, locale) : d.name))));
  add(words.date, request.dates.start);
  const { start, end } = request.available_time;
  add(words.time, start || end ? `${start ?? "?"}-${end ?? "?"}` : null);
  add(words.budget, request.budget.amount !== null ? `${request.budget.amount} ${request.budget.currency === "JPY" ? "yen" : request.budget.currency}` : null);
  add(
    words.travelers,
    join([
      ...(request.travelers.count !== null ? [SUMMARY_WORDS[locale].travelers(request.travelers.count)] : []),
      ...(request.travelers.type ? [labelOf(TRAVELER_TYPE_OPTIONS, request.travelers.type, locale)] : []),
    ]),
  );
  add(words.interests, join(labelsOf(INTEREST_OPTIONS, request.interests, locale)));
  add(words.food, join(labelsOf(FOOD_OPTIONS, request.food_preferences, locale)));
  add(words.transportation, join(labelsOf(TRANSPORT_OPTIONS, request.transportation, locale)));
  add(words.pace, request.pace ? labelOf(PACE_OPTIONS, request.pace, locale) : null);
  add(words.dietary, join(labelsOf(DIETARY_OPTIONS, request.dietary_restrictions, locale)));
  add(words.allergies, join([...labelsOf(ALLERGY_OPTIONS, request.allergies, locale), ...request.allergies_other]));
  add(words.avoid, join([...labelsOf(AVOID_OPTIONS, request.avoid, locale), ...request.avoid_other]));
  add(words.walking, request.walking_tolerance ? labelOf(WALKING_OPTIONS, request.walking_tolerance, locale) : null);
  add(words.setting, request.setting ? labelOf(SETTING_OPTIONS, request.setting, locale) : null);
  add(words.spotStyle, request.spot_style ? labelOf(SPOT_STYLE_OPTIONS, request.spot_style, locale) : null);
  add(words.groupNeeds, join(labelsOf(GROUP_NEED_OPTIONS, request.group_needs, locale)));
  add(words.start, request.starting_point);
  add(words.end, request.ending_point);
  add(words.mustVisit, join(request.must_visit));

  if (lines.length === 0) return request.natural_language_request;
  return [request.natural_language_request || words.lead, words.heading, ...lines].join("\n");
}
