// identify-place のロジック本体（Deno / Node どちらでも動く純粋関数と、外部APIを注入する処理フロー）。
// index.ts は HTTP・認証・実際の fetch だけを担当し、判定ロジックはすべてここに置く。
// Node >= 23.6 の型ストリップで単体テストするため、enum 等の TypeScript 専用構文は使わない。
//
// 流れ: 共有データ（URL / text / source）→ 情報整理 → OpenAIで候補抽出 → Google Places (New) Text Search
//       → 候補照合・confidence 判定 → confirmed / needs_review / not_found / insufficient_information / error
//
// OpenAI には「共有データに書かれている情報の構造化」だけをさせる。Place ID・住所・緯度経度・営業時間は推測させない。
// 実在Placeの確定は Google Places の結果とサーバー側のスコアリングで行う。

export const SHARE_SOURCES = ["instagram", "tiktok", "youtube", "web", "unknown"] as const;
export type ShareSource = (typeof SHARE_SOURCES)[number];

export const CATEGORY_HINTS = [
  "cafe", "restaurant", "ramen", "bakery", "sweets", "bar", "lodging", "onsen",
  "sightseeing", "shopping", "activity", "other",
] as const;
export type CategoryHint = (typeof CATEGORY_HINTS)[number];

export type IdentifyStatus = "confirmed" | "needs_review" | "not_found" | "insufficient_information" | "error";

// ---------------------------------------------------------------------------------------------
// 定数（判定のしきい値・コスト制御）
// ---------------------------------------------------------------------------------------------

/** OpenAI に渡すテキストの最大長（コスト・プロンプト肥大化の防止） */
export const MAX_TEXT_LENGTH = 3000;
/** Google Text Search で取得する最大件数 */
export const PLACES_PAGE_SIZE = 5;
/** Google 検索を行う AI 候補の最大数（0件だった場合のみ次の候補で再検索） */
export const MAX_SEARCH_ATTEMPTS = 2;
/** Text Search (New) の Field Mask。今回必要な Pro SKU の項目だけに絞る（写真・営業時間等は取得しない） */
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryType",
  "places.types",
  "places.businessStatus",
].join(",");

export const THRESHOLDS = {
  /** AI候補の confidence がこれ未満なら Google 検索しない */
  minAiConfidence: 0.3,
  /** confirmed に必要な最終 confidence */
  confirmed: 0.75,
  /** confirmed に必要な店名一致度 */
  confirmedName: 0.8,
  /** 店名一致度がこれ未満の候補しか無ければ not_found */
  minName: 0.45,
  /** 1位と2位の差がこれ未満なら曖昧（同名店舗など）として needs_review */
  ambiguityMargin: 0.12,
} as const;

// ---------------------------------------------------------------------------------------------
// 入力の整理
// ---------------------------------------------------------------------------------------------

export type IdentifyInput = {
  url: string | null;
  text: string | null;
  source: ShareSource;
  /** 入力で問題があった点（開発用） */
  warnings: string[];
};

const SOURCE_DOMAINS: Record<"instagram" | "tiktok" | "youtube", string[]> = {
  instagram: ["instagram.com", "instagr.am"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
};

export function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return url;
  } catch {
    return null;
  }
}

/** URL から共有元を判定する（クライアントの申告は信用せず、URL があればサーバーでも判定する） */
export function detectSource(url: URL): ShareSource {
  const hostname = url.hostname.toLowerCase();
  for (const [source, domains] of Object.entries(SOURCE_DOMAINS)) {
    if (domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) return source as ShareSource;
  }
  return "web";
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`「」『』【】（）＜＞、。，．！？　]+/gi;

/** テキストから URL を除いた本文（URL はテキスト情報としては扱わない） */
export function stripUrls(text: string): string {
  return text.replace(URL_IN_TEXT, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * リクエスト本文を検証・整理する。どんな入力でも例外を投げない。
 * body がオブジェクトでない場合のみ null（→ 400）。
 */
export function normalizeInput(body: unknown): IdentifyInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const warnings: string[] = [];

  let url: string | null = null;
  let urlObject: URL | null = null;
  if (record.url !== undefined && record.url !== null && record.url !== "") {
    urlObject = parseHttpUrl(record.url);
    if (urlObject) url = urlObject.href;
    else warnings.push("malformed_url_ignored");
  }

  let text: string | null = null;
  if (typeof record.text === "string") {
    const stripped = stripUrls(record.text);
    if (stripped.length > MAX_TEXT_LENGTH) warnings.push("text_truncated");
    text = stripped.slice(0, MAX_TEXT_LENGTH) || null;
  } else if (record.text !== undefined && record.text !== null) {
    warnings.push("text_not_string_ignored");
  }

  const claimed = SHARE_SOURCES.includes(record.source as ShareSource) ? (record.source as ShareSource) : null;
  if (record.source !== undefined && record.source !== null && !claimed) warnings.push("unknown_source_value");
  const detected = urlObject ? detectSource(urlObject) : null;
  if (claimed && detected && claimed !== detected && claimed !== "unknown") warnings.push("source_mismatch_used_url");
  const source: ShareSource = detected ?? claimed ?? "unknown";

  return { url, text, source, warnings };
}

// SNS の URL パス上の構造的な語（店名の手がかりにならない）
const STRUCTURAL_SEGMENTS = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "tags", "video", "photo", "watch", "shorts", "live",
  "embed", "channel", "c", "user", "t", "v", "share", "s", "amp",
]);

/**
 * URL 文字列そのものに含まれる手がかり（アカウント名・日本語スラッグ・Webサイトのドメイン等）。
 * URL 先のページは取得しない（スクレイピングしない）。
 */
export function urlHints(url: string | null, source: ShareSource): string[] {
  const parsed = parseHttpUrl(url);
  if (!parsed) return [];
  const hints: string[] = [];
  if (source === "web") hints.push(parsed.hostname.replace(/^www\./, ""));
  for (const raw of parsed.pathname.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).trim();
    } catch {
      segment = raw.trim();
    }
    if (!segment || STRUCTURAL_SEGMENTS.has(segment.toLowerCase())) continue;
    const isHandle = segment.startsWith("@");
    const hasNonAscii = /[^\x00-\x7F]/.test(segment);
    const hasWordSeparators = /[a-z]{2,}[-_.][a-z]{2,}/i.test(segment);
    if (isHandle || hasNonAscii || hasWordSeparators) hints.push(segment);
  }
  return hints.slice(0, 5);
}

/** OpenAI を呼ぶ前の情報不足判定（呼んでも店名が出ようのない入力でコストを使わない） */
export function hasEnoughInformation(input: IdentifyInput): boolean {
  if (input.text && input.text.replace(/[\s#@!！?？。、.,]/g, "").length >= 2) return true;
  return urlHints(input.url, input.source).length > 0;
}

// ---------------------------------------------------------------------------------------------
// OpenAI（候補抽出）
// ---------------------------------------------------------------------------------------------

export type AiCandidate = {
  candidate_name: string | null;
  area_hint: string | null;
  prefecture: string | null;
  city: string | null;
  category_hint: CategoryHint | null;
  search_query: string | null;
  evidence: string[];
  confidence: number;
};

export type AiExtraction = {
  candidates: AiCandidate[];
  insufficient_reason: string | null;
};

// 文字列長・件数は strict モードの対応状況に依存しないよう、スキーマではなく parseExtraction で切り詰める
const nullableString = { type: ["string", "null"] };

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "insufficient_reason"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "candidate_name", "area_hint", "prefecture", "city", "category_hint",
          "search_query", "evidence", "confidence",
        ],
        properties: {
          candidate_name: nullableString,
          area_hint: nullableString,
          prefecture: nullableString,
          city: nullableString,
          category_hint: { type: ["string", "null"], enum: [...CATEGORY_HINTS, null] },
          search_query: nullableString,
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
      },
    },
    insufficient_reason: nullableString,
  },
} as const;

export const EXTRACTION_SYSTEM_PROMPT = [
  "You extract clues about ONE real-world place (shop, restaurant, cafe, facility, sightseeing spot) from data a user shared from a social network or website. The text is mostly Japanese.",
  "Use ONLY the given text and the given URL string. You cannot open the URL. Never use outside knowledge to fill in facts.",
  "candidate_name: a specific proper noun (brand / shop / facility name) that is written in the input. Generic words alone such as 'カフェ', 'お店', 'ラーメン屋', '焼き鳥屋さん' are NOT names -> use null and put the category in category_hint. Strip particles that are not part of the name (e.g. 'の', 'で', 'にある', 'という', 'さん'). Hashtags (#店名) and @accounts may contain the name; remove the '#'/'@' and romanized account decorations only when the actual name is clear.",
  "area_hint / prefecture / city: only when written in the input (station names, neighborhoods, city names, hashtags like #札幌カフェ). Do not guess a location from the shop name.",
  "category_hint: choose from the enum only when the input suggests it, else null.",
  "search_query: a short query for a map text search, normally '<candidate_name> <area or city>'. null when candidate_name is null.",
  "evidence: short quotes copied from the input that support the candidate.",
  "confidence (0 to 1): how sure you are that the input is about this specific named place. Use <= 0.3 when the name is only weakly implied.",
  "Never output place IDs, street addresses, postal codes, coordinates, phone numbers or opening hours.",
  "Return up to 3 candidates ordered by confidence. If the input does not mention any specific place, return an empty candidates array and explain briefly in insufficient_reason (Japanese). Keep strings in the original language.",
].join("\n");

export function buildExtractionUserContent(input: IdentifyInput): string {
  return JSON.stringify({
    source: input.source,
    url: input.url,
    url_hints: urlHints(input.url, input.source),
    text: input.text,
  });
}

export function buildOpenAiRequestBody(input: IdentifyInput, model: string): Record<string, unknown> {
  return {
    model,
    store: false,
    input: [
      { role: "system", content: [{ type: "input_text", text: EXTRACTION_SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "input_text", text: buildExtractionUserContent(input) }] },
    ],
    text: {
      format: { type: "json_schema", name: "mikke_identify_place", strict: true, schema: EXTRACTION_SCHEMA },
    },
  };
}

/** Responses API のレスポンスから出力テキストを取り出す（拒否・未完了は理由コード） */
export function getOpenAiOutputText(payload: unknown): { text: string } | { error: string } {
  if (!payload || typeof payload !== "object") return { error: "ai_response_invalid" };
  const p = payload as Record<string, any>;
  if (p.status && p.status !== "completed") return { error: "ai_response_incomplete" };
  if (typeof p.output_text === "string" && p.output_text) return { text: p.output_text };
  for (const item of Array.isArray(p.output) ? p.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "refusal") return { error: "ai_refused" };
      if (typeof content?.text === "string" && content.text) return { text: content.text };
    }
  }
  return { error: "ai_output_missing" };
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * OpenAI の出力 JSON を検証する。Structured Outputs でも念のためサーバー側で型を確かめ、
 * 値の範囲外（confidence 等）は丸める。
 */
export function parseExtraction(outputText: string): { ok: true; value: AiExtraction } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(outputText);
  } catch {
    return { ok: false, error: "ai_output_invalid_json" };
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).candidates)) {
    return { ok: false, error: "ai_output_invalid_schema" };
  }
  const candidates: AiCandidate[] = [];
  for (const item of (raw as any).candidates.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const category = CATEGORY_HINTS.includes(item.category_hint) ? (item.category_hint as CategoryHint) : null;
    candidates.push({
      candidate_name: cleanString(item.candidate_name, 80),
      area_hint: cleanString(item.area_hint, 80),
      prefecture: cleanString(item.prefecture, 20),
      city: cleanString(item.city, 40),
      category_hint: category,
      search_query: cleanString(item.search_query, 120),
      evidence: Array.isArray(item.evidence)
        ? item.evidence.map((e: unknown) => cleanString(e, 120)).filter((e: string | null): e is string => !!e).slice(0, 4)
        : [],
      confidence: clamp01(item.confidence),
    });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  return {
    ok: true,
    value: { candidates, insufficient_reason: cleanString((raw as any).insufficient_reason, 200) },
  };
}

/** Google 検索に使える AI 候補（店名があり、confidence が最低ライン以上） */
export function searchableCandidates(extraction: AiExtraction): AiCandidate[] {
  return extraction.candidates.filter(
    (c) => c.candidate_name && normalizeName(c.candidate_name).length >= 2 && c.confidence >= THRESHOLDS.minAiConfidence,
  );
}

/** 検索クエリ。AI の search_query に店名が含まれていなければ、店名＋エリアから組み立て直す */
export function buildSearchQuery(candidate: AiCandidate): string | null {
  if (!candidate.candidate_name) return null;
  const query = candidate.search_query;
  if (query && normalizeName(query).includes(normalizeName(candidate.candidate_name))) return query;
  const area = candidate.area_hint ?? candidate.city ?? candidate.prefecture;
  return [candidate.candidate_name, area].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------------------------
// Google Places（候補の照合）
// ---------------------------------------------------------------------------------------------

export type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  businessStatus?: string;
};

export type PlaceResult = {
  google_place_id: string;
  name: string;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  primary_type: string | null;
  types: string[];
  business_status: string | null;
};

export type ScoredPlace = PlaceResult & {
  score: number;
  score_detail: { name: number; area: number | null; category: number | null; closed_penalty: boolean };
};

export function buildPlacesRequestBody(query: string): Record<string, unknown> {
  return { textQuery: query, languageCode: "ja", regionCode: "JP", pageSize: PLACES_PAGE_SIZE };
}

export function toPlaceResult(place: GooglePlace): PlaceResult | null {
  if (!place || typeof place.id !== "string" || !place.id) return null;
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  return {
    google_place_id: place.id,
    name: place.displayName?.text ?? "",
    formatted_address: place.formattedAddress ?? null,
    latitude: typeof lat === "number" && Number.isFinite(lat) ? lat : null,
    longitude: typeof lng === "number" && Number.isFinite(lng) ? lng : null,
    primary_type: place.primaryType ?? null,
    types: Array.isArray(place.types) ? place.types.filter((t) => typeof t === "string") : [],
    business_status: place.businessStatus ?? null,
  };
}

/** 比較用に正規化（全角/半角・大小文字・空白・記号の揺れを吸収） */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　・･\-‐―ー_.,、。'’"“”!！?？&＆#＃@()（）\[\]「」『』【】〜~:：/／|]/g, "");
}

function bigrams(value: string): string[] {
  if (value.length < 2) return [value];
  const result: string[] = [];
  for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
  return result;
}

/** 店名の一致度 0〜1（完全一致 > 包含 > 2-gram Dice 係数） */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  // 「きのとや」と「きのとや 大通公園店」のような支店名付きは高めに評価
  if (shorter.length >= 2 && longer.includes(shorter)) return 0.8 + 0.2 * (shorter.length / longer.length);
  const ax = bigrams(x);
  const by = bigrams(y);
  const pool = [...by];
  let overlap = 0;
  for (const g of ax) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      overlap++;
      pool.splice(i, 1);
    }
  }
  return (2 * overlap) / (ax.length + by.length);
}

/** エリアの一致度（AI が挙げたエリアヒントが住所に含まれる割合）。ヒントが無ければ null */
export function areaScore(candidate: AiCandidate, address: string | null): number | null {
  const hints = [candidate.prefecture, candidate.city, candidate.area_hint]
    .filter((h): h is string => !!h)
    .flatMap((h) => h.split(/[\s、,・/]+/))
    .map((h) => normalizeName(h).replace(/(駅周辺|駅前|周辺|エリア|付近)$/, ""))
    .filter((h) => h.length >= 2);
  const unique = [...new Set(hints)];
  if (unique.length === 0) return null;
  if (!address) return 0;
  const addr = normalizeName(address);
  const matched = unique.filter((h) => addr.includes(h) || addr.includes(h.replace(/[都道府県市区町村]$/, ""))).length;
  return matched / unique.length;
}

const CATEGORY_TYPES: Record<CategoryHint, string[]> = {
  cafe: ["cafe", "coffee_shop", "tea_house", "cat_cafe", "dog_cafe"],
  restaurant: ["restaurant", "food", "meal_takeaway"],
  ramen: ["ramen_restaurant", "noodle_shop", "japanese_restaurant", "restaurant"],
  bakery: ["bakery"],
  sweets: ["dessert_shop", "confectionery", "ice_cream_shop", "cake_shop", "bakery", "cafe", "dessert_restaurant"],
  bar: ["bar", "pub", "wine_bar", "night_club", "izakaya_restaurant"],
  lodging: ["lodging", "hotel", "ryokan", "hostel", "inn", "resort_hotel"],
  onsen: ["spa", "public_bath", "sauna", "lodging"],
  sightseeing: ["tourist_attraction", "museum", "art_gallery", "park", "zoo", "aquarium", "shrine", "temple", "place_of_worship", "historical_landmark"],
  shopping: ["store", "shopping_mall", "department_store", "clothing_store", "gift_shop", "book_store"],
  activity: ["amusement_park", "bowling_alley", "movie_theater", "gym", "stadium", "amusement_center"],
  other: [],
};

/** カテゴリ一致度（1=一致, 0=不一致）。判定材料が無ければ null */
export function categoryScore(hint: CategoryHint | null, types: string[]): number | null {
  if (!hint || hint === "other" || types.length === 0) return null;
  const expected = CATEGORY_TYPES[hint];
  if (types.some((t) => expected.includes(t))) return 1;
  // restaurant 系の細分類（xxx_restaurant）はひとまとめに扱う
  if ((hint === "restaurant" || hint === "ramen") && types.some((t) => t.endsWith("_restaurant"))) return 1;
  return 0;
}

const WEIGHTS = { name: 0.6, area: 0.25, category: 0.15 };

export function scorePlace(candidate: AiCandidate, place: PlaceResult): ScoredPlace {
  const name = candidate.candidate_name ? nameSimilarity(candidate.candidate_name, place.name) : 0;
  const area = areaScore(candidate, place.formatted_address);
  const category = categoryScore(candidate.category_hint, place.types);

  let weighted = WEIGHTS.name * name;
  let total = WEIGHTS.name;
  if (area !== null) {
    weighted += WEIGHTS.area * area;
    total += WEIGHTS.area;
  }
  if (category !== null) {
    weighted += WEIGHTS.category * category;
    total += WEIGHTS.category;
  }
  let score = weighted / total;
  // エリア情報が無い場合は同名別店舗の可能性を否定できないので控えめにする
  if (area === null) score *= 0.9;
  const closed = place.business_status === "CLOSED_PERMANENTLY";
  if (closed) score *= 0.6;

  return {
    ...place,
    score: round2(score),
    score_detail: { name: round2(name), area: area === null ? null : round2(area), category, closed_penalty: closed },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type MatchDecision = {
  status: "confirmed" | "needs_review" | "not_found";
  confidence: number;
  reason: string;
  place: ScoredPlace | null;
  candidates: ScoredPlace[];
};

/** Google の候補を採点し、確定できるか判定する。無理に1件へ確定しない */
export function decideMatch(candidate: AiCandidate, places: PlaceResult[]): MatchDecision {
  if (places.length === 0) {
    return { status: "not_found", confidence: 0, reason: "places_zero_results", place: null, candidates: [] };
  }
  const scored = places.map((p) => scorePlace(candidate, p)).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  // 最終 confidence は照合スコアに AI の確からしさを掛け合わせる（AI だけで確定はしない）
  const confidence = round2(best.score * (0.7 + 0.3 * candidate.confidence));

  if (best.score_detail.name < THRESHOLDS.minName) {
    return { status: "not_found", confidence, reason: "no_name_match", place: null, candidates: scored };
  }
  const ambiguous = !!second &&
    best.score - second.score < THRESHOLDS.ambiguityMargin &&
    second.score_detail.name >= THRESHOLDS.minName;
  if (ambiguous) {
    return { status: "needs_review", confidence, reason: "multiple_similar_places", place: null, candidates: scored };
  }
  if (best.score_detail.closed_penalty) {
    return { status: "needs_review", confidence, reason: "place_closed_permanently", place: null, candidates: scored };
  }
  if (confidence >= THRESHOLDS.confirmed && best.score_detail.name >= THRESHOLDS.confirmedName) {
    return { status: "confirmed", confidence, reason: "matched", place: best, candidates: scored };
  }
  return { status: "needs_review", confidence, reason: "low_confidence", place: null, candidates: scored };
}

// ---------------------------------------------------------------------------------------------
// 処理フロー（外部APIは注入）
// ---------------------------------------------------------------------------------------------

/** 外部API呼び出しの失敗。code はクライアントへ返してよい固定値、detail はサーバーログ専用 */
export class UpstreamError extends Error {
  code: string;
  detail: string | null;
  constructor(code: string, detail: string | null = null) {
    super(code);
    this.name = "UpstreamError";
    this.code = code;
    this.detail = detail;
  }
}

export type IdentifyDeps = {
  /** OpenAI の出力テキストを返す。失敗時は UpstreamError を投げる */
  extract: (input: IdentifyInput) => Promise<string>;
  /** Google Text Search の places 配列を返す。失敗時は UpstreamError を投げる */
  searchPlaces: (query: string) => Promise<GooglePlace[]>;
  log?: (event: string, detail: Record<string, unknown>) => void;
};

export type IdentifyResponse = {
  status: IdentifyStatus;
  confidence: number;
  reason: string;
  /** 利用者向けの日本語メッセージ */
  message: string;
  input: { source: ShareSource; url: string | null; has_text: boolean; warnings: string[] };
  extraction: AiCandidate | null;
  extraction_candidates: AiCandidate[];
  insufficient_reason: string | null;
  searches: { query: string; result_count: number }[];
  place: PlaceResult | null;
  candidates: ScoredPlace[];
  error: { stage: "openai" | "google_places" | "internal"; code: string } | null;
};

const MESSAGES: Record<IdentifyStatus, string> = {
  confirmed: "場所を特定しました。",
  needs_review: "候補が見つかりました。正しい場所か確認してください。",
  not_found: "該当する場所が見つかりませんでした。",
  insufficient_information: "共有された情報だけでは場所を特定できませんでした。店名や地域が分かるテキストと一緒に共有してください。",
  error: "場所の特定中にエラーが発生しました。時間をおいて再度お試しください。",
};

function publicPlace(place: ScoredPlace | null): PlaceResult | null {
  if (!place) return null;
  const { score: _score, score_detail: _detail, ...rest } = place;
  return rest;
}

export async function identifyPlace(input: IdentifyInput, deps: IdentifyDeps): Promise<IdentifyResponse> {
  const log = deps.log ?? (() => {});
  const base: IdentifyResponse = {
    status: "insufficient_information",
    confidence: 0,
    reason: "",
    message: "",
    input: { source: input.source, url: input.url, has_text: !!input.text, warnings: input.warnings },
    extraction: null,
    extraction_candidates: [],
    insufficient_reason: null,
    searches: [],
    place: null,
    candidates: [],
    error: null,
  };
  const finish = (status: IdentifyStatus, reason: string, extra: Partial<IdentifyResponse> = {}): IdentifyResponse => {
    const result = { ...base, ...extra, status, reason, message: MESSAGES[status] };
    log("identify_place_result", {
      status, reason, confidence: result.confidence, source: input.source,
      has_url: !!input.url, has_text: !!input.text, searches: result.searches.length,
    });
    return result;
  };

  // 1. 情報整理：URL/テキストどちらにも手がかりが無ければ AI を呼ばない
  if (!hasEnoughInformation(input)) return finish("insufficient_information", "no_usable_input");

  // 2. OpenAI で候補抽出
  let extraction: AiExtraction;
  try {
    const parsed = parseExtraction(await deps.extract(input));
    if (!parsed.ok) {
      return finish("error", parsed.error, { error: { stage: "openai", code: parsed.error } });
    }
    extraction = parsed.value;
  } catch (e) {
    const code = e instanceof UpstreamError ? e.code : "ai_request_failed";
    log("identify_place_upstream_error", { stage: "openai", code, detail: e instanceof UpstreamError ? e.detail : String(e) });
    return finish("error", code, { error: { stage: "openai", code } });
  }
  base.extraction_candidates = extraction.candidates;
  base.extraction = extraction.candidates[0] ?? null;
  base.insufficient_reason = extraction.insufficient_reason;

  const searchable = searchableCandidates(extraction);
  if (searchable.length === 0) return finish("insufficient_information", "no_place_name_extracted");

  // 3. Google Places で検索（0件のときだけ次の候補で再検索し、API 呼び出しを最小限にする）
  for (const candidate of searchable.slice(0, MAX_SEARCH_ATTEMPTS)) {
    const query = buildSearchQuery(candidate);
    if (!query) continue;
    let places: PlaceResult[];
    try {
      const raw = await deps.searchPlaces(query);
      places = (Array.isArray(raw) ? raw : []).map(toPlaceResult).filter((p): p is PlaceResult => !!p);
    } catch (e) {
      const code = e instanceof UpstreamError ? e.code : "places_request_failed";
      log("identify_place_upstream_error", { stage: "google_places", code, detail: e instanceof UpstreamError ? e.detail : String(e) });
      return finish("error", code, { extraction: candidate, error: { stage: "google_places", code } });
    }
    base.searches.push({ query, result_count: places.length });
    if (places.length === 0) continue;

    // 4. 照合・判定
    const decision = decideMatch(candidate, places);
    return finish(decision.status, decision.reason, {
      extraction: candidate,
      confidence: decision.confidence,
      place: publicPlace(decision.place),
      candidates: decision.candidates,
    });
  }
  return finish("not_found", "places_zero_results");
}

// ---------------------------------------------------------------------------------------------
// ログ
// ---------------------------------------------------------------------------------------------

/** 外部APIのエラー本文をログへ出す前に、キーらしき文字列を伏せる */
export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_\-*]{6,}/g, "sk-[redacted]")
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "AIza[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}
