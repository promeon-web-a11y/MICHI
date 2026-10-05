// save-place のロジック本体（Deno / Node どちらでも動く純粋関数と、DBアクセスを注入する処理フロー）。
// index.ts は HTTP・認証・Supabase クライアント生成だけを担当する。
// Node >= 23.6 の型ストリップで単体テストするため、enum 等の TypeScript 専用構文は使わない。
//
// 保存は既存の save_place RPC（security definer / auth.uid() で本人を確定）に任せる。
// - places:       unique (provider, provider_place_id) + ON CONFLICT DO NOTHING → Google Place ID で重複しない
// - saved_places: unique (user_id, place_id) + ON CONFLICT → 同じユーザーの重複保存はDBレベルで起きない
// save_place は再保存時に共有元情報を上書きしてエラーにしないため、この関数では
//   1. 事前に「保存済みか」を確認し、保存済みなら RPC を呼ばず already_saved（既存の保存内容を上書きしない）
//   2. 同時実行で 1 をすり抜けた場合も、RPC の返却行から「今回INSERTされたか」を判定して already_saved にする
// user_id はクライアントから一切受け取らない（JWT → auth.uid() のみ）。

export const SHARE_SOURCES = ["instagram", "tiktok", "youtube", "web", "unknown"] as const;
export type ShareSource = (typeof SHARE_SOURCES)[number];

export type SaveStatus = "saved" | "already_saved" | "unauthorized" | "invalid_request" | "error";

export const MAX_CAPTION_LENGTH = 2000;
const MAX_URL_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
/** Google Place ID の形式（英数字・_・-。長さは余裕を持たせる） */
const GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

// ---------------------------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------------------------

export type SaveRequest = {
  place: {
    google_place_id: string;
    name: string;
    formatted_address: string | null;
    latitude: number | null;
    longitude: number | null;
    primary_type: string | null;
    types: string[];
  };
  share: { source: ShareSource; url: string | null; text: string | null };
  identification: { status: "confirmed" | "needs_review"; confidence: number | null; selected_by_user: boolean };
  /** 開発用: 無視した入力など */
  warnings: string[];
};

export type ValidationResult = { ok: true; value: SaveRequest } | { ok: false; code: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined; // 型不正
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function coordinate(value: unknown, limit: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) return undefined;
  return value;
}

export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url;
  } catch {
    return null;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`「」『』【】（）＜＞、。，．！？　]+/gi;

/** 共有テキストから URL（トラッキングパラメータ付きの可能性がある）を除いたキャプション */
export function captionFromText(text: string | null): string | null {
  if (!text) return null;
  const caption = text.replace(URL_IN_TEXT, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return caption ? caption.slice(0, MAX_CAPTION_LENGTH) : null;
}

/**
 * リクエスト本文を検証する。どんな入力でも例外を投げない。
 * user_id 等、受け付けない項目は読まずに warnings に記録するだけ。
 */
export function validateSaveRequest(body: unknown): ValidationResult {
  if (!isObject(body)) return { ok: false, code: "invalid_body" };
  const warnings: string[] = [];
  if ("user_id" in body || (isObject(body.place) && "user_id" in body.place) || (isObject(body.share) && "user_id" in body.share)) {
    warnings.push("client_user_id_ignored");
  }

  const place = body.place;
  if (!isObject(place)) return { ok: false, code: "place_required" };
  const id = place.google_place_id;
  if (typeof id !== "string" || !id.trim()) return { ok: false, code: "google_place_id_required" };
  if (!GOOGLE_PLACE_ID.test(id.trim())) return { ok: false, code: "google_place_id_invalid" };
  const name = optionalString(place.name, MAX_NAME_LENGTH);
  if (!name) return { ok: false, code: "place_name_required" };
  const address = optionalString(place.formatted_address, MAX_ADDRESS_LENGTH);
  if (address === undefined) return { ok: false, code: "formatted_address_invalid" };
  const latitude = coordinate(place.latitude, 90);
  const longitude = coordinate(place.longitude, 180);
  if (latitude === undefined || longitude === undefined || (latitude === null) !== (longitude === null)) {
    return { ok: false, code: "location_invalid" };
  }
  const primaryType = optionalString(place.primary_type, 100);
  const types = Array.isArray(place.types)
    ? place.types.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 100).slice(0, 50)
    : [];

  const share = isObject(body.share) ? body.share : {};
  const source: ShareSource = SHARE_SOURCES.includes(share.source as ShareSource) ? (share.source as ShareSource) : "unknown";
  let url: string | null = null;
  if (typeof share.url === "string" && share.url.trim()) {
    const parsed = share.url.length <= MAX_URL_LENGTH ? parseHttpUrl(share.url.trim()) : null;
    if (parsed) url = parsed.href;
    else warnings.push("share_url_invalid_ignored");
  }
  const text = typeof share.text === "string" ? share.text : null;

  const identification = isObject(body.identification) ? body.identification : {};
  const status = identification.status;
  if (status !== "confirmed" && status !== "needs_review") return { ok: false, code: "not_saveable_status" };
  const selectedByUser = identification.selected_by_user === true;
  // needs_review はユーザーが候補を選んだ場合だけ保存できる（自動保存しない）
  if (status === "needs_review" && !selectedByUser) return { ok: false, code: "user_selection_required" };
  const rawConfidence = identification.confidence;
  const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
    ? Math.round(Math.min(1, Math.max(0, rawConfidence)) * 1000) / 1000
    : null;

  return {
    ok: true,
    value: {
      place: {
        google_place_id: id.trim(),
        name,
        formatted_address: address,
        latitude,
        longitude,
        primary_type: primaryType ?? null,
        types,
      },
      share: { source, url, text },
      identification: { status, confidence, selected_by_user: selectedByUser },
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 既存テーブルへのマッピング（既存カラムだけを使う）
// ---------------------------------------------------------------------------------------------

// resolve-place と同じ変換規則（Google types → place_category enum）。sweets 等の不足分だけ補う。
const CATEGORY_RULES: Array<{ types: string[]; category: string }> = [
  { types: ["bakery"], category: "bakery" },
  { types: ["cafe", "coffee_shop", "tea_house"], category: "cafe" },
  { types: ["dessert_shop", "confectionery", "ice_cream_shop", "cake_shop", "dessert_restaurant"], category: "sweets" },
  { types: ["spa", "public_bath"], category: "onsen" },
  {
    types: ["tourist_attraction", "museum", "art_gallery", "park", "zoo", "aquarium"],
    category: "sightseeing",
  },
  {
    types: ["amusement_park", "bowling_alley", "movie_theater", "gym", "stadium"],
    category: "activity",
  },
  {
    types: [
      "shopping_mall", "department_store", "clothing_store", "store",
      "supermarket", "convenience_store",
    ],
    category: "shopping",
  },
  { types: ["restaurant", "meal_takeaway", "meal_delivery", "bar", "night_club"], category: "dinner" },
];

/** primary_type を最優先し、無ければ types 全体から place_category を決める */
export function mapCategory(primaryType: string | null, types: string[]): string {
  const ordered = primaryType ? [primaryType, ...types] : types;
  for (const type of ordered) {
    const rule = CATEGORY_RULES.find((r) => r.types.includes(type));
    if (rule) return rule.category;
    if (type.endsWith("_restaurant")) return "dinner";
  }
  return "other";
}

/** source_platform enum ('instagram','tiktok','google_maps','web','other') への変換。youtube は enum に無いため other */
export function mapSourcePlatform(source: ShareSource): string {
  if (source === "instagram" || source === "tiktok" || source === "web") return source;
  return "other";
}

/** Google Maps URLs（公式の URL 形式）。共有URLが無い（テキストのみ共有）ときの source_url に使う */
export function googleMapsUrl(name: string, googlePlaceId: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(googlePlaceId)}`;
}

export function buildRpcArgs(req: SaveRequest, now: Date): { p_place: Record<string, unknown>; p_source: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  let sourceUrl = req.share.url;
  if (!sourceUrl) {
    // saved_places.source_url は NOT NULL（save_place も必須チェック）。テキストのみの共有では Place の Google Maps URL を入れる
    sourceUrl = googleMapsUrl(req.place.name, req.place.google_place_id);
    warnings.push("source_url_fallback_google_maps");
  }
  return {
    p_place: {
      provider: "google",
      provider_place_id: req.place.google_place_id,
      name: req.place.name,
      category: mapCategory(req.place.primary_type, req.place.types),
      address: req.place.formatted_address ?? "",
      latitude: req.place.latitude,
      longitude: req.place.longitude,
      // Google Places から取得した直後の値なので確認日時として記録する
      data_checked_at: now.toISOString(),
    },
    p_source: {
      source_platform: mapSourcePlatform(req.share.source),
      source_url: sourceUrl,
      source_caption: captionFromText(req.share.text),
      extraction_confidence: req.identification.confidence,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// 処理フロー（DBは注入）
// ---------------------------------------------------------------------------------------------

export type PlaceRow = {
  id: string;
  provider: string;
  provider_place_id: string;
  name: string;
  category: string;
  address: string;
  latitude: number | string | null;
  longitude: number | string | null;
};

export type SavedPlaceRow = {
  id: string;
  user_id: string;
  place_id: string;
  source_platform: string;
  source_url: string;
  extraction_confidence: number | string | null;
  saved_at: string;
  updated_at: string;
};

/** DB 呼び出しの失敗。code は Postgres SQLSTATE / PostgREST のコード */
export class DbError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "DbError";
    this.code = code;
  }
}

export type SaveDeps = {
  /** 共有 places から Google Place ID（provider='google'）で検索 */
  findPlace: (googlePlaceId: string) => Promise<PlaceRow | null>;
  /** 本人の保存済みレコード。RLS により本人の行しか見えない（念のため user_id でも絞る） */
  findSaved: (placeId: string) => Promise<SavedPlaceRow | null>;
  /** 既存 save_place RPC（auth.uid() で本人を確定） */
  savePlaceRpc: (args: { p_place: Record<string, unknown>; p_source: Record<string, unknown> }) => Promise<SavedPlaceRow>;
  loadPlace: (placeId: string) => Promise<PlaceRow | null>;
  now?: () => Date;
  log?: (event: string, detail: Record<string, unknown>) => void;
};

export type SaveResponse = {
  status: SaveStatus;
  message: string;
  /** 開発用の理由コード */
  reason: string;
  place: {
    place_id: string;
    google_place_id: string;
    name: string;
    address: string;
    latitude: number | null;
    longitude: number | null;
    category: string;
  } | null;
  saved_place: { id: string; saved_at: string; source_platform: string; source_url: string } | null;
  /** places に既存の行を再利用したか（開発用。同時実行時は目安） */
  place_reused: boolean | null;
  warnings: string[];
  error: { code: string } | null;
};

const MESSAGES: Record<SaveStatus, string> = {
  saved: "保存しました",
  already_saved: "すでに保存されています",
  unauthorized: "ログインが必要です",
  invalid_request: "保存できませんでした",
  error: "保存できませんでした",
};

export function httpStatusFor(status: SaveStatus): number {
  switch (status) {
    case "saved":
    case "already_saved":
      return 200;
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    default:
      return 500;
  }
}

export function makeResponse(status: SaveStatus, reason: string, extra: Partial<SaveResponse> = {}): SaveResponse {
  return {
    status,
    message: MESSAGES[status],
    reason,
    place: null,
    saved_place: null,
    place_reused: null,
    warnings: [],
    error: status === "error" || status === "invalid_request" || status === "unauthorized" ? { code: reason } : null,
    ...extra,
  };
}

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function publicPlace(row: PlaceRow): NonNullable<SaveResponse["place"]> {
  return {
    place_id: row.id,
    google_place_id: row.provider_place_id,
    name: row.name,
    address: row.address,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    category: row.category,
  };
}

function publicSaved(row: SavedPlaceRow): NonNullable<SaveResponse["saved_place"]> {
  return { id: row.id, saved_at: row.saved_at, source_platform: row.source_platform, source_url: row.source_url };
}

/**
 * save_place の返却行が今回の INSERT によるものか。
 * INSERT 時は saved_at / updated_at がともに同一トランザクションの now()。
 * ON CONFLICT DO UPDATE 時は saved_at が元の値のまま、updated_at だけ touch_updated_at トリガーで更新される。
 */
export function wasInserted(row: SavedPlaceRow): boolean {
  const saved = Date.parse(row.saved_at);
  const updated = Date.parse(row.updated_at);
  if (Number.isFinite(saved) && Number.isFinite(updated)) return saved === updated;
  return row.saved_at === row.updated_at;
}

/** Postgres / PostgREST のエラーを保存ステータスへ変換（詳細はログのみ） */
export function classifyDbError(error: unknown): { status: SaveStatus; reason: string } {
  const code = error instanceof DbError ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "28000" || message.includes("authentication_required") || code === "PGRST301" || code === "PGRST302") {
    return { status: "unauthorized", reason: "authentication_required" };
  }
  if (code === "22023" || code === "22P02" || code === "23514") return { status: "invalid_request", reason: "db_rejected_input" };
  if (code === "23503") return { status: "error", reason: "user_profile_missing" };
  return { status: "error", reason: "db_error" };
}

export async function savePlace(req: SaveRequest, deps: SaveDeps): Promise<SaveResponse> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const googlePlaceId = req.place.google_place_id;
  const warnings = [...req.warnings];

  const finish = (response: SaveResponse): SaveResponse => {
    log("save_place_result", {
      status: response.status,
      reason: response.reason,
      source: req.share.source,
      identification: req.identification.status,
      selected_by_user: req.identification.selected_by_user,
      place_reused: response.place_reused,
    });
    return { ...response, warnings: [...warnings, ...response.warnings] };
  };
  const fail = (e: unknown, stage: string): SaveResponse => {
    const { status, reason } = classifyDbError(e);
    log("save_place_db_error", {
      stage,
      code: e instanceof DbError ? e.code : null,
      // メッセージはDBのエラーコード名程度。共有本文やトークンは含まれない
      message: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return finish(makeResponse(status, reason));
  };

  // 1. places に既にあるか → 2. あれば本人が保存済みか。
  //    保存済みなら何も書き込まない（既存の共有元情報を上書きしない）
  let existingPlace: PlaceRow | null;
  try {
    existingPlace = await deps.findPlace(googlePlaceId);
    if (existingPlace) {
      const existingSaved = await deps.findSaved(existingPlace.id);
      if (existingSaved) {
        return finish(makeResponse("already_saved", "already_saved", {
          place: publicPlace(existingPlace),
          saved_place: publicSaved(existingSaved),
          place_reused: true,
        }));
      }
    }
  } catch (e) {
    return fail(e, "precheck");
  }
  // 開発用の情報。重複防止自体は unique 制約 + ON CONFLICT が担う
  const placeReused = existingPlace !== null;

  // 3. 既存 RPC で places 作成/再利用 → saved_places 作成（DBレベルで重複しない）
  const args = buildRpcArgs(req, now());
  warnings.push(...args.warnings);
  let saved: SavedPlaceRow;
  try {
    saved = await deps.savePlaceRpc({ p_place: args.p_place, p_source: args.p_source });
  } catch (e) {
    return fail(e, "save_place_rpc");
  }
  if (!saved || typeof saved.id !== "string") {
    return finish(makeResponse("error", "rpc_returned_no_row"));
  }

  let placeRow: PlaceRow | null = null;
  try {
    placeRow = await deps.loadPlace(saved.place_id);
  } catch {
    placeRow = null;
  }
  const place = placeRow
    ? publicPlace(placeRow)
    : {
      place_id: saved.place_id,
      google_place_id: googlePlaceId,
      name: req.place.name,
      address: req.place.formatted_address ?? "",
      latitude: req.place.latitude,
      longitude: req.place.longitude,
      category: String(args.p_place.category),
    };

  // 4. 同時実行で 1 をすり抜け、別リクエストが先に INSERT していた場合は already_saved
  const inserted = wasInserted(saved);
  if (!inserted) warnings.push("concurrent_save_detected");
  return finish(makeResponse(inserted ? "saved" : "already_saved", inserted ? "saved" : "already_saved_concurrently", {
    place,
    saved_place: publicSaved(saved),
    place_reused: inserted ? placeReused : true,
  }));
}
