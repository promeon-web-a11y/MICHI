import type { SupabaseClient } from "@supabase/supabase-js";

// mikke-supabase-backend の src/mikke-backend.ts と同じ薄いRPCクライアント。
// バックエンド側の型・関数定義が正なので、変更する場合は両方に反映すること。

export type PlaceInput = {
  provider?: string;
  provider_place_id: string;
  name: string;
  category: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  opening_hours?: unknown;
  price_band?: string;
  maps_url?: string | null;
  official_url?: string | null;
  data_checked_at?: string | null;
};

export type SourceInput = {
  source_platform: string;
  source_url: string;
  source_caption?: string | null;
  user_note?: string | null;
  extraction_confidence?: number | null;
  confirmed_at?: string;
  last_refreshed_at?: string | null;
};

export async function savePlace(client: SupabaseClient, place: PlaceInput, source: SourceInput) {
  const { data, error } = await client.rpc("save_place", { p_place: place, p_source: source });
  if (error) throw error;
  return data;
}

export async function removeSavedPlace(client: SupabaseClient, savedPlaceId: string) {
  const { error } = await client.from("saved_places").delete().eq("id", savedPlaceId);
  if (error) throw error;
}

export async function acceptPlan(client: SupabaseClient, planId: string) {
  const { data, error } = await client.rpc("accept_plan", { p_plan_id: planId });
  if (error) throw error;
  return data;
}

export async function answerVisit(
  client: SupabaseClient,
  input: {
    planId: string;
    went: boolean;
    rating?: "good" | "normal" | "poor" | null;
    reasonNotWent?: string | null;
    visitedPlaceIds?: string[];
  },
) {
  const { data, error } = await client.rpc("answer_visit", {
    p_plan_id: input.planId,
    p_went: input.went,
    p_rating: input.rating ?? null,
    p_reason_not_went: input.reasonNotWent ?? null,
    p_visited_place_ids: input.visitedPlaceIds ?? [],
  });
  if (error) throw error;
  return data;
}

// eventId を渡すと、同じIDの再送はサーバー側で1件にまとめられる（二重計上防止）。
export async function trackEvent(
  client: SupabaseClient,
  name: string,
  properties: Record<string, unknown> = {},
  eventId?: string,
) {
  const { data, error } = await client.rpc("track_event", {
    p_name: name,
    p_properties: properties,
    ...(eventId ? { p_event_id: eventId } : {}),
  });
  if (error) throw error;
  return data;
}

// --- ここから下はフロントエンド固有の追加ヘルパー ---

export type PlanConditions = {
  current_location?: { latitude: number; longitude: number; label?: string };
  // 必ずタイムゾーンオフセット付き（例: 2026-09-23T14:00:00+09:00）で渡すこと。
  // UTC("Z"終わり)で渡すと、AIが営業時間との時差判定を誤りやすいことが確認されている。
  start_at: string;
  end_at: string;
  budget_max?: number | null;
  travel_mode: "walk" | "public_transit" | "bicycle" | "car";
  companion: "alone" | "friends" | "partner" | "family";
  moods?: string[];
};

export type GeneratePlanResult = {
  plan: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  candidate_count: number;
};

// supabase-js は non-2xx を FunctionsHttpError として返す。
// Edge Function が返したJSONボディ（{error: "..."}）を取り出して分かりやすくする。
async function unwrapFunctionError(error: unknown): Promise<Error> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === "function") {
    try {
      const body = await context.json();
      return new Error(body?.error ? String(body.error) : (error as Error).message);
    } catch {
      return error as Error;
    }
  }
  return error as Error;
}

export async function generatePlan(
  client: SupabaseClient,
  conditions: PlanConditions,
  generationSequence = 1,
): Promise<GeneratePlanResult> {
  const { data, error } = await client.functions.invoke("generate-plan", {
    body: { conditions, generation_sequence: generationSequence },
  });
  if (error) throw await unwrapFunctionError(error);
  return data as GeneratePlanResult;
}

export type PlaceCandidate = {
  provider: "google";
  provider_place_id: string;
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  price_band: string;
  opening_hours: unknown;
  maps_url: string | null;
  official_url: string | null;
  business_status: string | null;
};

// Google Places API (New) で店名/住所を検索し、Mikkeのplacesスキーマに
// 変換済みの候補を返す。ここでは保存は行わない（保存は引き続き savePlace() が担当）。
export async function resolvePlace(
  client: SupabaseClient,
  query: string,
  locationBias?: { latitude: number; longitude: number; radius_meters?: number },
): Promise<PlaceCandidate[]> {
  const { data, error } = await client.functions.invoke("resolve-place", {
    body: { query, location_bias: locationBias },
  });
  if (error) throw await unwrapFunctionError(error);
  return (data as { candidates: PlaceCandidate[] }).candidates;
}

export type ExtractPlaceCandidatesResult = {
  store_name_candidates: string[];
  area_candidates: string[];
  category_candidates: string[];
};

// Instagram投稿のURL＋キャプション文（どちらもユーザーが貼り付けたテキスト）から、
// 店名/エリア/カテゴリの候補をOpenAIで抽出する。Instagram APIは使わない。
// ここでは候補を複数返すだけで、店舗を1件に確定する処理は行わない。
export async function extractPlaceCandidates(
  client: SupabaseClient,
  url: string,
  caption: string,
): Promise<ExtractPlaceCandidatesResult> {
  const { data, error } = await client.functions.invoke("extract-place-candidates", {
    body: { url, caption },
  });
  if (error) throw await unwrapFunctionError(error);
  return data as ExtractPlaceCandidatesResult;
}

// JSTなどローカルのdatetime-local入力値を、オフセット付きISO文字列に変換する。
// 例: toOffsetIso("2026-09-23T14:00", 9) => "2026-09-23T14:00:00+09:00"
export function toOffsetIso(datetimeLocal: string, offsetHours = 9): string {
  const sign = offsetHours >= 0 ? "+" : "-";
  const abs = Math.abs(offsetHours);
  const hh = String(Math.trunc(abs)).padStart(2, "0");
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  const withSeconds = datetimeLocal.length === 16 ? `${datetimeLocal}:00` : datetimeLocal;
  return `${withSeconds}${sign}${hh}:${mm}`;
}
