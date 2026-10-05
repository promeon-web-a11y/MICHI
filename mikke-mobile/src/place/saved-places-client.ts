/**
 * Step 4-1: ログイン中ユーザーの保存Place一覧（saved_places + places）の取得と表示用への変換。
 * React Native / expo に依存しない（fetch を注入して Node で単体テストするため）。
 *
 * - Supabase REST（PostgREST）をユーザーの JWT で呼ぶ。RLS（saved_places_all_own: user_id = auth.uid()）により
 *   本人の保存だけが返るため、クエリに user_id は一切含めない。
 * - places は saved_places.place_id の外部キーで埋め込み取得する（mikke-frontend と同じ形）。
 * - Service Role Key は使わない。
 */
import { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from '../services/backend';

/** 取得する列（表示に必要なものだけ）。places は place という名前で埋め込む */
export const SAVED_PLACES_SELECT =
  'id,saved_at,source_platform,source_url,place:places(id,name,category,address,latitude,longitude)';
/** 1回に取得する最大件数（ページングは Step 4-1 の範囲外） */
export const SAVED_PLACES_LIMIT = 200;
const FETCH_TIMEOUT_MS = 15_000;

export type SavedPlaceRowResponse = {
  id: string;
  saved_at: string;
  source_platform: string | null;
  source_url: string | null;
  place: {
    id: string;
    name: string | null;
    category: string | null;
    address: string | null;
    latitude: number | string | null;
    longitude: number | string | null;
  } | null;
};

export type SavedPlaceItem = {
  savedPlaceId: string;
  placeId: string | null;
  name: string;
  category: string | null;
  categoryLabel: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  savedAt: string;
  sourcePlatform: string | null;
  sourcePlatformLabel: string | null;
  /** 開いてよい http(s) URL のみ。無い・不正なら null */
  sourceUrl: string | null;
  /** リンクの文言（Google Maps の代替URLかどうかで変える） */
  sourceLinkLabel: string | null;
};

export type FetchSavedPlacesResult =
  | { status: 'ok'; items: SavedPlaceItem[]; skipped: number }
  | { status: 'unauthorized' | 'error'; message: string; devDetail: string };

// mikke-frontend と同じ表示名（place_category enum）
export const CATEGORY_LABELS: Record<string, string> = {
  cafe: 'カフェ',
  lunch: 'ランチ',
  dinner: 'ディナー',
  sweets: 'スイーツ',
  bakery: 'ベーカリー',
  shopping: 'ショッピング',
  sightseeing: '観光',
  onsen: '温泉',
  activity: 'アクティビティ',
  other: 'その他',
};

// source_platform enum
export const SOURCE_PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  google_maps: 'Google マップ',
  web: 'Web',
  other: 'その他',
};

export const LOAD_ERROR_MESSAGE = '保存した場所を読み込めませんでした';
export const UNAUTHORIZED_MESSAGE = 'ログインが必要です';

// ---------------------------------------------------------------------------------------------

export function buildSavedPlacesUrl(baseUrl: string, limit: number = SAVED_PLACES_LIMIT): string {
  const params = [
    `select=${encodeURIComponent(SAVED_PLACES_SELECT)}`,
    'order=saved_at.desc',
    `limit=${limit}`,
  ];
  return `${baseUrl}/rest/v1/saved_places?${params.join('&')}`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** save-place がテキストのみの共有で入れる Google Maps URL かどうか */
function isGoogleMapsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith('/maps');
  } catch {
    return false;
  }
}

/** DB の1行を表示用に変換する。id / saved_at が無い壊れた行は null（表示しない） */
export function toSavedPlaceItem(row: unknown): SavedPlaceItem | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Partial<SavedPlaceRowResponse>;
  if (typeof r.id !== 'string' || typeof r.saved_at !== 'string') return null;
  const place = r.place && typeof r.place === 'object' ? r.place : null;
  const category = typeof place?.category === 'string' ? place.category : null;
  const platform = typeof r.source_platform === 'string' ? r.source_platform : null;
  const sourceUrl = safeHttpUrl(r.source_url);
  const address = typeof place?.address === 'string' && place.address.trim() ? place.address : null;
  return {
    savedPlaceId: r.id,
    placeId: typeof place?.id === 'string' ? place.id : null,
    name: typeof place?.name === 'string' && place.name.trim() ? place.name : '（名称不明の場所）',
    category,
    categoryLabel: category ? CATEGORY_LABELS[category] ?? category : 'その他',
    address,
    latitude: toNumber(place?.latitude),
    longitude: toNumber(place?.longitude),
    savedAt: r.saved_at,
    sourcePlatform: platform,
    sourcePlatformLabel: platform ? SOURCE_PLATFORM_LABELS[platform] ?? platform : null,
    sourceUrl,
    sourceLinkLabel: sourceUrl ? (isGoogleMapsUrl(sourceUrl) ? 'Google マップで見る' : '元の投稿・リンクを見る') : null,
  };
}

/** 新しく保存したものを上に（サーバーでも order=saved_at.desc しているが念のため） */
export function sortBySavedAtDesc(items: SavedPlaceItem[]): SavedPlaceItem[] {
  const time = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  return [...items].sort((a, b) => time(b.savedAt) - time(a.savedAt));
}

export function toSavedPlaceItems(rows: unknown): { items: SavedPlaceItem[]; skipped: number } {
  const list = Array.isArray(rows) ? rows : [];
  const items: SavedPlaceItem[] = [];
  for (const row of list) {
    const item = toSavedPlaceItem(row);
    if (item) items.push(item);
  }
  return { items: sortBySavedAtDesc(items), skipped: list.length - items.length };
}

/** 保存日時の表示（端末のタイムゾーン）。例: 2026/09/26 09:05 */
export function formatSavedAt(iso: string, offsetMinutes?: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const offset = offsetMinutes ?? -new Date(t).getTimezoneOffset();
  const d = new Date(t + offset * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** ログイン中ユーザーの保存Placeを取得する。例外は投げない */
export async function fetchSavedPlaces(options: {
  config: BackendConfig;
  accessToken: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<FetchSavedPlacesResult> {
  const backend = resolveBackend(options.config);
  if (!backend) {
    return { status: 'error', message: LOAD_ERROR_MESSAGE, devDetail: 'EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY が未設定または不正' };
  }
  if (!options.accessToken) {
    return { status: 'unauthorized', message: UNAUTHORIZED_MESSAGE, devDetail: 'access token がありません（未ログイン）' };
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      buildSavedPlacesUrl(backend.baseUrl),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          apikey: backend.anonKey,
          // anon key ではなくユーザーの JWT。RLS で本人の行だけになる
          Authorization: `Bearer ${options.accessToken}`,
        },
      },
      options.timeoutMs ?? FETCH_TIMEOUT_MS
    );
  } catch (e) {
    const detail = isAbortError(e) ? 'timeout' : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { status: 'error', message: LOAD_ERROR_MESSAGE, devDetail: detail };
  }

  let text = '';
  try {
    text = await response.text();
  } catch (e) {
    return { status: 'error', message: LOAD_ERROR_MESSAGE, devDetail: `本文の読み取りに失敗: ${String(e)}` };
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 下で扱う
  }

  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body ? String((body as { code: unknown }).code) : '';
    const detail = `HTTP ${response.status} ${code || text.slice(0, 200)}`;
    // 期限切れ・不正な JWT（PostgREST は 401 / PGRST301・PGRST303 など）
    if (response.status === 401 || response.status === 403 || code.startsWith('PGRST30')) {
      return { status: 'unauthorized', message: UNAUTHORIZED_MESSAGE, devDetail: detail };
    }
    return { status: 'error', message: LOAD_ERROR_MESSAGE, devDetail: detail };
  }
  if (!Array.isArray(body)) {
    return { status: 'error', message: LOAD_ERROR_MESSAGE, devDetail: `想定外の応答: ${text.slice(0, 200)}` };
  }
  return { status: 'ok', ...toSavedPlaceItems(body) };
}

// ---------------------------------------------------------------------------------------------
// 一覧の再取得タイミング（無駄なリクエストを避ける）
// ---------------------------------------------------------------------------------------------

/** 画面に戻ってきたとき、前回取得からこれ以上経っていれば再取得する */
export const SAVED_PLACES_STALE_MS = 60_000;

let changeVersion = 0;

/** 保存が成功したら呼ぶ。次に一覧画面へ戻った時に必ず再取得される */
export function markSavedPlacesChanged() {
  changeVersion += 1;
}

export function getSavedPlacesChangeVersion(): number {
  return changeVersion;
}

/** フォーカス時に再取得すべきか（未取得・保存が発生・古くなった のいずれか） */
export function shouldRefetchSavedPlaces(args: {
  lastFetchedAt: number | null;
  fetchedVersion: number;
  currentVersion: number;
  now: number;
  staleMs?: number;
}): boolean {
  if (args.lastFetchedAt === null) return true;
  if (args.currentVersion !== args.fetchedVersion) return true;
  return args.now - args.lastFetchedAt >= (args.staleMs ?? SAVED_PLACES_STALE_MS);
}
