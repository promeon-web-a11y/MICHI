/**
 * v3「みんなのルート」・行った記録・投稿・反応・コメント・投稿写真の API（mikke-supabase-backend 202609280008 / 202609290009）。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * - 読み書きはすべて RPC（security definer / auth.uid()）。他人の非公開記録は RPC・RLS の両方で返らない
 * - route_posts の memory / plan_id / user_id は表から直接読めない（列単位の権限）。必ず RPC を使う
 * - 写真は非公開バケット route-photos。表示は署名付きURL（閲覧できる人だけが発行できる）
 */
import { resolveBackend, type FetchLike } from '../services/backend';
import { apiFail, bool, num, restRequest, rpc, str, type ApiOptions, type ApiResult } from '../services/rest';

export const ROUTE_PHOTO_BUCKET = 'route-photos';

export type RouteVisibility = 'private' | 'public';

/** 一覧カード・保存一覧・自分の投稿で使う形 */
export type RouteCard = {
  id: string;
  title: string;
  lead: string | null;
  area: string | null;
  genre: string | null;
  theme: string | null;
  budgetYen: number | null;
  durationMinutes: number | null;
  visibility: RouteVisibility;
  publishedAt: string | null;
  createdAt: string | null;
  visitedOn: string | null;
  /** 本人の記録のときだけ（記録時のひと言） */
  memory: string | null;
  coverPhotoPath: string | null;
  stopNames: string[];
  authorName: string;
  likeCount: number;
  wishCount: number;
  commentCount: number;
  liked: boolean;
  wished: boolean;
  isMine: boolean;
  /** 本人の投稿で、運営が非表示にしたもの */
  hiddenByModeration: boolean;
};

export type RouteStop = {
  sequence: number;
  placeId: string | null;
  name: string;
  category: string | null;
  /** HH:mm（本人が入力した時刻。無ければ null） */
  visitedTime: string | null;
  action: string | null;
  note: string | null;
  photoPath: string | null;
  /** その場所を自分の「行きたい」（保存した場所）にしているか */
  wished: boolean;
};

export type RouteComment = { id: string; body: string; createdAt: string; authorName: string; isMine: boolean };

export type RouteDetail = RouteCard & { planId: string | null; stops: RouteStop[]; comments: RouteComment[] };

export type RouteSort = 'recommended' | 'likes' | 'wishes';

export type RouteFeedQuery = {
  query: string;
  area: string | null;
  maxBudget: number | null;
  genre: string | null;
  theme: string | null;
  sort: RouteSort;
};

export const DEFAULT_FEED_QUERY: RouteFeedQuery = { query: '', area: null, maxBudget: null, genre: null, theme: null, sort: 'recommended' };

// ---------------------------------------------------------------------------------------------
// 応答 → 表示用
// ---------------------------------------------------------------------------------------------

export function toRouteCard(value: unknown): RouteCard | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = str(v.id);
  const title = str(v.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    lead: str(v.lead),
    area: str(v.area),
    genre: str(v.genre),
    theme: str(v.theme),
    budgetYen: num(v.budget_yen),
    durationMinutes: num(v.duration_minutes),
    visibility: v.visibility === 'public' ? 'public' : 'private',
    publishedAt: str(v.published_at),
    createdAt: str(v.created_at),
    visitedOn: str(v.visited_on),
    memory: str(v.memory),
    coverPhotoPath: str(v.cover_photo_path),
    stopNames: Array.isArray(v.stop_names) ? v.stop_names.filter((n): n is string => typeof n === 'string') : [],
    authorName: str(v.author_name) ?? 'Mikke ユーザー',
    likeCount: num(v.like_count) ?? 0,
    wishCount: num(v.wish_count) ?? 0,
    commentCount: num(v.comment_count) ?? 0,
    liked: bool(v.liked),
    wished: bool(v.wished),
    isMine: bool(v.is_mine),
    hiddenByModeration: bool(v.hidden_by_moderation),
  };
}

export function toRouteCards(value: unknown): RouteCard[] {
  return Array.isArray(value) ? value.map(toRouteCard).filter((c): c is RouteCard => c !== null) : [];
}

function toStop(value: unknown): RouteStop | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const sequence = num(v.sequence);
  const name = str(v.name);
  if (sequence === null || !name) return null;
  const time = str(v.visited_time);
  return {
    sequence,
    placeId: str(v.place_id),
    name,
    category: str(v.category),
    visitedTime: time && /^\d{2}:\d{2}$/.test(time) ? time : null,
    action: str(v.action),
    note: str(v.note),
    photoPath: str(v.photo_path),
    wished: bool(v.wished),
  };
}

function toComment(value: unknown): RouteComment | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = str(v.id);
  const body = str(v.body);
  if (!id || !body) return null;
  return { id, body, createdAt: str(v.created_at) ?? '', authorName: str(v.author_name) ?? 'Mikke ユーザー', isMine: bool(v.is_mine) };
}

export function toRouteDetail(value: unknown): RouteDetail | null {
  const card = toRouteCard(value);
  if (!card) return null;
  const v = value as Record<string, unknown>;
  const stops = (Array.isArray(v.stops) ? v.stops : []).map(toStop).filter((s): s is RouteStop => s !== null);
  stops.sort((a, b) => a.sequence - b.sequence);
  const comments = (Array.isArray(v.comments) ? v.comments : []).map(toComment).filter((c): c is RouteComment => c !== null);
  return { ...card, planId: str(v.plan_id), stops, comments };
}

// ---------------------------------------------------------------------------------------------
// 一覧・詳細
// ---------------------------------------------------------------------------------------------

export const FEED_PAGE_SIZE = 40;

export function feedRpcArgs(q: RouteFeedQuery, offset = 0, limit = FEED_PAGE_SIZE) {
  return {
    p_query: q.query.trim() || null,
    p_area: q.area,
    p_max_budget: q.maxBudget,
    p_genre: q.genre,
    p_theme: q.theme,
    p_sort: q.sort,
    p_limit: limit,
    p_offset: offset,
  };
}

async function list(name: string, args: Record<string, unknown>, opts: ApiOptions): Promise<ApiResult<RouteCard[]>> {
  const r = await rpc(name, args, opts);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return apiFail('server', `想定外の応答: ${name}`);
  return { ok: true, data: toRouteCards(r.data) };
}

export const listPublicRoutes = (q: RouteFeedQuery, offset: number, opts: ApiOptions) =>
  list('list_public_routes', feedRpcArgs(q, offset), opts);
export const listMyRoutePosts = (opts: ApiOptions) => list('list_my_route_posts', {}, opts);
export const listMyRouteWishes = (opts: ApiOptions) => list('list_my_route_wishes', {}, opts);

export async function listPublicRouteAreas(opts: ApiOptions): Promise<ApiResult<string[]>> {
  const r = await rpc('list_public_route_areas', {}, opts);
  if (!r.ok) return r;
  return { ok: true, data: Array.isArray(r.data) ? r.data.filter((a): a is string => typeof a === 'string') : [] };
}

/** 見られない（非公開・削除・非表示）投稿は not_found */
export async function getRoutePost(id: string, opts: ApiOptions): Promise<ApiResult<RouteDetail>> {
  const r = await rpc('get_route_post', { p_post_id: id }, opts);
  if (!r.ok) return r;
  if (r.data === null) return apiFail('not_found', 'get_route_post returned null');
  const detail = toRouteDetail(r.data);
  return detail ? { ok: true, data: detail } : apiFail('server', '想定外の応答: get_route_post');
}

// ---------------------------------------------------------------------------------------------
// 反応・コメント
// ---------------------------------------------------------------------------------------------

export type ReactionKind = 'like' | 'wish';
export type ReactionResult = { kind: ReactionKind; active: boolean; likeCount: number; wishCount: number };

/**
 * いいね / 行きたい。active を渡すとその状態にする（二重送信しても結果が同じ）。省略すると切り替え
 */
export async function toggleRouteReaction(
  id: string,
  kind: ReactionKind,
  opts: ApiOptions,
  active?: boolean
): Promise<ApiResult<ReactionResult>> {
  const r = await rpc('toggle_route_reaction', { p_post_id: id, p_kind: kind, ...(active === undefined ? {} : { p_active: active }) }, opts);
  if (!r.ok) return r;
  const v = (r.data ?? {}) as Record<string, unknown>;
  if (typeof v.active !== 'boolean') return apiFail('server', '想定外の応答: toggle_route_reaction');
  return { ok: true, data: { kind, active: v.active, likeCount: num(v.like_count) ?? 0, wishCount: num(v.wish_count) ?? 0 } };
}

export const MAX_COMMENT_LENGTH = 100;

export async function addRouteComment(id: string, body: string, opts: ApiOptions): Promise<ApiResult<RouteComment>> {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_COMMENT_LENGTH) return apiFail('invalid', 'comment length', `コメントは1〜${MAX_COMMENT_LENGTH}文字で入力してください。`);
  const r = await rpc('add_route_comment', { p_post_id: id, p_body: trimmed }, opts);
  if (!r.ok) return r;
  const c = toComment(r.data);
  return c ? { ok: true, data: c } : apiFail('server', '想定外の応答: add_route_comment');
}

export async function deleteRouteComment(commentId: string, opts: ApiOptions): Promise<ApiResult<null>> {
  const r = await restRequest(`route_comments?id=eq.${encodeURIComponent(commentId)}`, { ...opts, method: 'DELETE' });
  return r.ok ? { ok: true, data: null } : r;
}

// ---------------------------------------------------------------------------------------------
// 行った記録・投稿
// ---------------------------------------------------------------------------------------------

export const MAX_MEMORY_LENGTH = 200;

/** 採用済みプランから、行った場所だけの非公開の記録を作る（既存 answer_visit にも反映される） */
export async function createVisitRecord(
  planId: string,
  placeIds: string[],
  memory: string,
  opts: ApiOptions
): Promise<ApiResult<{ id: string }>> {
  if (placeIds.length === 0) return apiFail('invalid', 'no places', '行った場所を一つ以上選んでください。');
  if (memory.trim().length > MAX_MEMORY_LENGTH) return apiFail('invalid', 'memory', `ひと言は${MAX_MEMORY_LENGTH}文字以内にしてください。`);
  const r = await rpc('create_visit_record', { p_plan_id: planId, p_place_ids: placeIds, p_memory: memory.trim() || null }, opts);
  if (!r.ok) {
    if (r.devDetail.includes('record_already_published')) {
      return apiFail('invalid', r.devDetail, 'この日の記録はすでに公開されています。公開をやめてから記録し直してください。');
    }
    return r;
  }
  const id = str((r.data as Record<string, unknown> | null)?.id);
  return id ? { ok: true, data: { id } } : apiFail('server', '想定外の応答: create_visit_record');
}

export type RoutePostDraftStop = { sequence: number; visitedTime: string | null; action: string; note: string; photoPath: string | null };

export type RoutePostDraft = {
  title: string;
  lead: string;
  area: string;
  genre: string | null;
  theme: string | null;
  budgetYen: number | null;
  stops: RoutePostDraftStop[];
};

export const POST_LIMITS = { title: 40, lead: 160, area: 30, action: 40, note: 300 } as const;

/** HH:mm（00:00〜23:59）。空は null。不正は undefined */
export function normalizeTime(input: string): string | null | undefined {
  const t = input.trim().replace('：', ':');
  if (!t) return null;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** 立ち寄りの時刻（2つ以上）から、最初〜最後の分数。求められなければ null（推測しない） */
export function durationFromTimes(times: (string | null)[]): number | null {
  const mins = times.filter((t): t is string => !!t).map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
  if (mins.length < 2) return null;
  const d = mins[mins.length - 1] - mins[0];
  return d > 0 ? d : null;
}

export function validateDraft(d: RoutePostDraft): string | null {
  if (!d.title.trim()) return 'ルートの名前を入力してください。';
  if (d.title.trim().length > POST_LIMITS.title) return `ルートの名前は${POST_LIMITS.title}文字以内にしてください。`;
  if (d.lead.trim().length > POST_LIMITS.lead) return `一日の紹介は${POST_LIMITS.lead}文字以内にしてください。`;
  if (d.area.trim().length > POST_LIMITS.area) return `地域は${POST_LIMITS.area}文字以内にしてください。`;
  for (const s of d.stops) {
    if (s.action.trim().length > POST_LIMITS.action) return `「何をした？」は${POST_LIMITS.action}文字以内にしてください。`;
    if (s.note.trim().length > POST_LIMITS.note) return `ひと言は${POST_LIMITS.note}文字以内にしてください。`;
  }
  return null;
}

/** update_route_post の p_post */
export function draftToPayload(d: RoutePostDraft, coverPhotoPath: string | null) {
  return {
    title: d.title.trim(),
    lead: d.lead.trim(),
    area: d.area.trim(),
    genre: d.genre,
    theme: d.theme,
    budget_yen: d.budgetYen,
    duration_minutes: durationFromTimes([...d.stops].sort((a, b) => a.sequence - b.sequence).map((s) => s.visitedTime)),
    cover_photo_path: coverPhotoPath,
    stops: d.stops.map((s) => ({
      sequence: s.sequence,
      visited_time: s.visitedTime,
      action: s.action.trim(),
      note: s.note.trim(),
      photo_path: s.photoPath,
    })),
  };
}

export async function updateRoutePost(
  id: string,
  draft: RoutePostDraft,
  publish: boolean,
  opts: ApiOptions
): Promise<ApiResult<{ id: string; visibility: RouteVisibility }>> {
  const invalid = validateDraft(draft);
  if (invalid) return apiFail('invalid', 'validation', invalid);
  const cover = [...draft.stops].sort((a, b) => a.sequence - b.sequence).find((s) => s.photoPath)?.photoPath ?? null;
  const r = await rpc('update_route_post', { p_post_id: id, p_post: draftToPayload(draft, cover), p_publish: publish }, opts);
  if (!r.ok) return r;
  const v = (r.data ?? {}) as Record<string, unknown>;
  return { ok: true, data: { id, visibility: v.visibility === 'public' ? 'public' : 'private' } };
}

export async function unpublishRoutePost(id: string, opts: ApiOptions): Promise<ApiResult<null>> {
  const r = await rpc('unpublish_route_post', { p_post_id: id }, opts);
  return r.ok ? { ok: true, data: null } : r;
}

// ---------------------------------------------------------------------------------------------
// 公開ルート → プラン
// ---------------------------------------------------------------------------------------------

/** 「同じ順番で行く」: 採用済みプランを作る（今日のプランになる） */
export async function startRouteFromPost(id: string, opts: ApiOptions): Promise<ApiResult<{ planId: string }>> {
  const r = await rpc('start_route_from_post', { p_post_id: id }, opts);
  if (!r.ok) return r;
  const planId = str((r.data as Record<string, unknown> | null)?.id);
  return planId ? { ok: true, data: { planId } } : apiFail('server', '想定外の応答: start_route_from_post');
}

/** 「今日向けに調整」: ルートの場所を自分の保存場所に加え、その place id を返す */
export async function saveRoutePlaces(id: string, opts: ApiOptions): Promise<ApiResult<string[]>> {
  const r = await rpc('save_route_places', { p_post_id: id }, opts);
  if (!r.ok) return r;
  const ids = Array.isArray(r.data) ? r.data.filter((x): x is string => typeof x === 'string') : [];
  return ids.length > 0 ? { ok: true, data: ids } : apiFail('invalid', 'no places');
}

// ---------------------------------------------------------------------------------------------
// 写真（Storage）
// ---------------------------------------------------------------------------------------------

/** <user_id>/<post_id>/<file>.jpg（RLS: 1段目が本人・2段目が本人の投稿のときだけアップロードできる） */
export function routePhotoPath(userId: string, postId: string, fileId: string): string {
  return `${userId}/${postId}/${fileId}.jpg`;
}

export type SignedUrl = { path: string; url: string };

/** 署名付きURLをまとめて発行する（見られない写真は含まれない） */
export async function signRoutePhotoUrls(
  paths: string[],
  opts: ApiOptions & { expiresIn?: number }
): Promise<ApiResult<SignedUrl[]>> {
  const backend = resolveBackend(opts.config);
  if (!backend) return apiFail('config', 'config');
  if (!opts.accessToken) return apiFail('unauthorized', 'no token');
  if (paths.length === 0) return { ok: true, data: [] };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await fetchImpl(`${backend.baseUrl}/storage/v1/object/sign/${ROUTE_PHOTO_BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: backend.anonKey, Authorization: `Bearer ${opts.accessToken}` },
      body: JSON.stringify({ expiresIn: opts.expiresIn ?? 3600, paths }),
    });
    const text = await res.text();
    if (!res.ok) return apiFail(res.status === 401 ? 'unauthorized' : 'server', `HTTP ${res.status} ${text.slice(0, 80)}`);
    const rows = JSON.parse(text) as unknown;
    const out: SignedUrl[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const r = row as Record<string, unknown>;
      const signed = str(r.signedURL) ?? str(r.signedUrl);
      const path = str(r.path);
      if (!signed || !path || r.error) continue;
      out.push({ path, url: signed.startsWith('http') ? signed : `${backend.baseUrl}/storage/v1${signed}` });
    }
    return { ok: true, data: out };
  } catch (e) {
    return apiFail('network', String(e));
  }
}

const REMOVE_CHUNK = 100;

/**
 * 使わなくなった自分の写真を消す（Storage API・本人の JWT。RLS で本人のフォルダーだけ消せる）。
 * 失敗しても投稿は続ける（残っても非公開バケットのため他人からは見えず、次の cleanupRoutePhotos で消える）。
 * 戻り値: すべて消せたか
 */
export async function removeRoutePhotos(paths: string[], opts: ApiOptions): Promise<boolean> {
  const backend = resolveBackend(opts.config);
  if (!backend || !opts.accessToken) return false;
  if (paths.length === 0) return true;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  let ok = true;
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    try {
      const res = await fetchImpl(`${backend.baseUrl}/storage/v1/object/${ROUTE_PHOTO_BUCKET}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', apikey: backend.anonKey, Authorization: `Bearer ${opts.accessToken}` },
        body: JSON.stringify({ prefixes: paths.slice(i, i + REMOVE_CHUNK) }),
      });
      if (!res.ok) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * どの投稿からも使われていない自分の写真（保存に失敗したアップロード・差し替え前・付け直しで外した場所・消した投稿）を片付ける。
 * サーバーは10分以上前のものだけを返すので、ほかの端末で編集中の写真は消さない。postId を省略すると自分の全投稿が対象
 */
export async function cleanupRoutePhotos(postId: string | null, opts: ApiOptions): Promise<number> {
  const r = await rpc('list_unused_route_photos', postId ? { p_post_id: postId } : {}, opts);
  if (!r.ok || !Array.isArray(r.data)) return 0;
  const paths = r.data.filter((p): p is string => typeof p === 'string');
  if (paths.length === 0) return 0;
  return (await removeRoutePhotos(paths, opts)) ? paths.length : 0;
}
