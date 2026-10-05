/**
 * みつける「お店・スポット」の API（mikke-supabase-backend 202609290010）。React / expo に依存しない（Node で単体テスト）。
 *
 * - スポット = 既存の places。一覧には、見られる公開ルートの立ち寄り先になっている場所だけが並ぶ
 * - 「行きたい」= 既存の保存した場所（saved_places）。保存一覧の「場所」とプラン作成にそのまま使われる
 * - 「いいね」= place_likes（ルートのいいねとは別の状態）
 * - 写真は立ち寄りに投稿された写真（非公開バケット・署名付きURL）。無ければ写真なしの表示にする（架空の写真を出さない）
 */
import { CATEGORY_LABELS } from '../place/saved-places-client';
import { apiFail, bool, num, rpc, str, type ApiOptions, type ApiResult } from '../services/rest';
import { toRouteCards, type RouteCard } from '../routes/route-posts-client';

export type SpotCard = {
  id: string;
  name: string;
  category: string | null;
  categoryLabel: string;
  address: string | null;
  mapsUrl: string | null;
  /** その場所を含むルートに投稿者が付けた地域（無ければ null） */
  area: string | null;
  photoPath: string | null;
  likeCount: number;
  routeCount: number;
  liked: boolean;
  wished: boolean;
};

export type SpotDetail = SpotCard & { photos: string[]; routes: RouteCard[] };

/** 「お店・スポット」の絞り込み（places.category の値） */
export const SPOT_CATEGORIES: readonly { value: string | null; label: string }[] = [
  { value: null, label: 'すべて' },
  ...['cafe', 'lunch', 'dinner', 'sweets', 'bakery', 'shopping', 'sightseeing', 'onsen', 'activity'].map((v) => ({ value: v, label: CATEGORY_LABELS[v] ?? v })),
];

export function toSpotCard(value: unknown): SpotCard | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = str(v.id);
  const name = str(v.name);
  if (!id || !name) return null;
  const category = str(v.category);
  return {
    id,
    name,
    category,
    categoryLabel: category ? (CATEGORY_LABELS[category] ?? category) : 'その他',
    address: str(v.address),
    mapsUrl: str(v.maps_url),
    area: str(v.area),
    photoPath: str(v.photo_path),
    likeCount: num(v.like_count) ?? 0,
    routeCount: num(v.route_count) ?? 0,
    liked: bool(v.liked),
    wished: bool(v.wished),
  };
}

export function toSpotCards(value: unknown): SpotCard[] {
  return Array.isArray(value) ? value.map(toSpotCard).filter((c): c is SpotCard => c !== null) : [];
}

export const SPOTS_PAGE_SIZE = 40;

export async function listPublicSpots(
  q: { query: string; category: string | null },
  offset: number,
  opts: ApiOptions
): Promise<ApiResult<SpotCard[]>> {
  const r = await rpc('list_public_spots', { p_query: q.query.trim() || null, p_category: q.category, p_limit: SPOTS_PAGE_SIZE, p_offset: offset }, opts);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return apiFail('server', '想定外の応答: list_public_spots');
  return { ok: true, data: toSpotCards(r.data) };
}

export async function listMyPlaceLikes(opts: ApiOptions): Promise<ApiResult<SpotCard[]>> {
  const r = await rpc('list_my_place_likes', {}, opts);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return apiFail('server', '想定外の応答: list_my_place_likes');
  return { ok: true, data: toSpotCards(r.data) };
}

/** 見られない場所は not_found */
export async function getSpot(placeId: string, opts: ApiOptions): Promise<ApiResult<SpotDetail>> {
  const r = await rpc('get_spot', { p_place_id: placeId }, opts);
  if (!r.ok) return r;
  if (r.data === null) return apiFail('not_found', 'get_spot returned null', 'この場所は表示できません。公開が終わったルートの場所かもしれません。');
  const card = toSpotCard(r.data);
  if (!card) return apiFail('server', '想定外の応答: get_spot');
  const v = r.data as Record<string, unknown>;
  const photos = Array.isArray(v.photos) ? v.photos.filter((p): p is string => typeof p === 'string') : [];
  return { ok: true, data: { ...card, photos, routes: toRouteCards(v.routes) } };
}

export type PlaceReactionKind = 'like' | 'wish';
export type PlaceReactionResult = { liked: boolean; wished: boolean; likeCount: number };

/** 状態を指定して送る（二重送信しても結果が同じ） */
export async function setPlaceReaction(
  placeId: string,
  kind: PlaceReactionKind,
  active: boolean,
  opts: ApiOptions
): Promise<ApiResult<PlaceReactionResult>> {
  const r = await rpc('set_place_reaction', { p_place_id: placeId, p_kind: kind, p_active: active }, opts);
  if (!r.ok) return r;
  const v = (r.data ?? {}) as Record<string, unknown>;
  if (typeof v.liked !== 'boolean' || typeof v.wished !== 'boolean') return apiFail('server', '想定外の応答: set_place_reaction');
  return { ok: true, data: { liked: v.liked, wished: v.wished, likeCount: num(v.like_count) ?? 0 } };
}
