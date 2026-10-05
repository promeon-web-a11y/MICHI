/**
 * Step 3-3: 共有データ → identify-place Edge Function（OpenAI + Google Places はサーバー側）の呼び出し。
 * React Native / expo に依存しない（fetch を注入して Node で単体テストするため）。
 *
 * モバイルが持つのは Supabase の URL と anon key（公開前提の値）だけ。
 * OpenAI / Google Places のAPIキーは Supabase Secrets にあり、アプリには含めない。
 */
import { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from '../services/backend';
/** モバイルの共有受信（process-share-payloads）の解析結果のうち、ここで使う部分 */
export type ShareAnalysis = { normalizedUrl?: string | null; receivedText?: string | null; source?: IdentifySource };

// 互換: 共通の HTTP 処理は services/backend.ts、ログイン・セッションは auth/auth-session.ts が正本
export { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from '../services/backend';
export {
  EMAIL_NOT_CONFIRMED_MESSAGE,
  isSessionValid,
  signInWithPassword,
  type DevSession,
  type SignInResult,
} from '../auth/auth-session';

export type IdentifySource = 'instagram' | 'tiktok' | 'youtube' | 'web' | 'unknown';
export type IdentifyStatus = 'confirmed' | 'needs_review' | 'not_found' | 'insufficient_information' | 'error';

export type IdentifyPlaceRequest = {
  url: string | null;
  text: string | null;
  source: IdentifySource;
};

export type AiCandidate = {
  candidate_name: string | null;
  area_hint: string | null;
  prefecture: string | null;
  city: string | null;
  category_hint: string | null;
  search_query: string | null;
  evidence: string[];
  confidence: number;
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

export type IdentifyPlaceResponse = {
  status: IdentifyStatus;
  confidence: number;
  reason: string;
  message: string;
  input: { source: IdentifySource; url: string | null; has_text: boolean; warnings: string[] };
  extraction: AiCandidate | null;
  extraction_candidates: AiCandidate[];
  insufficient_reason: string | null;
  searches: { query: string; result_count: number }[];
  place: PlaceResult | null;
  candidates: ScoredPlace[];
  error: { stage: string; code: string } | null;
};

export type ClientFailureKind = 'config' | 'auth' | 'network' | 'timeout' | 'http' | 'invalid_response';

export type IdentifyCallResult =
  | { ok: true; httpStatus: number; data: IdentifyPlaceResponse }
  | { ok: false; kind: ClientFailureKind; httpStatus: number | null; userMessage: string; devDetail: string };

export const IDENTIFY_TIMEOUT_MS = 45_000;

const STATUSES: IdentifyStatus[] = ['confirmed', 'needs_review', 'not_found', 'insufficient_information', 'error'];

const USER_MESSAGES: Record<ClientFailureKind, string> = {
  config: 'アプリの接続設定に問題があります。しばらくしてからもう一度お試しください。',
  auth: 'ログインが必要です。ログインし直してから再度お試しください。',
  network: 'ネットワークに接続できませんでした。通信環境を確認して再度お試しください。',
  timeout: '時間内に応答がありませんでした。時間をおいて再度お試しください。',
  http: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。',
  invalid_response: 'サーバーから想定外の応答がありました。',
};

// ---------------------------------------------------------------------------------------------

/** Step 3-2 の解析結果から identify-place への入力を作る。URL も text も無ければ null */
export function buildIdentifyRequest(analysis: ShareAnalysis | null | undefined): IdentifyPlaceRequest | null {
  if (!analysis) return null;
  const url = analysis.normalizedUrl?.trim() || null;
  const text = analysis.receivedText?.trim() || null;
  if (!url && !text) return null;
  return { url, text, source: analysis.source ?? 'unknown' };
}

function fail(kind: ClientFailureKind, devDetail: string, httpStatus: number | null = null): IdentifyCallResult {
  return { ok: false, kind, httpStatus, userMessage: USER_MESSAGES[kind], devDetail };
}

export function isIdentifyPlaceResponse(value: unknown): value is IdentifyPlaceResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    STATUSES.includes(v.status as IdentifyStatus) &&
    typeof v.confidence === 'number' &&
    Array.isArray(v.candidates) &&
    Array.isArray(v.searches)
  );
}

/**
 * identify-place を呼ぶ。例外は投げず、失敗は種類別（ユーザー向け文言 / 開発用詳細）に返す。
 * サーバーが status=error を返した場合（HTTP 502）も本文が正しければ ok=true として返す。
 */
export async function callIdentifyPlace(
  request: IdentifyPlaceRequest,
  options: { config: BackendConfig; accessToken: string | null; fetchImpl?: FetchLike; timeoutMs?: number }
): Promise<IdentifyCallResult> {
  const backend = resolveBackend(options.config);
  if (!backend) return fail('config', 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定または不正');
  if (!options.accessToken) return fail('auth', 'access token がありません（未ログイン）');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/functions/v1/identify-place`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify(request),
      },
      options.timeoutMs ?? IDENTIFY_TIMEOUT_MS
    );
  } catch (e) {
    if (isAbortError(e)) return fail('timeout', `identify-place が ${options.timeoutMs ?? IDENTIFY_TIMEOUT_MS}ms 以内に応答しませんでした`);
    return fail('network', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (e) {
    return fail('network', `レスポンス本文の読み取りに失敗: ${String(e)}`, response.status);
  }
  let body: unknown = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // 下で HTTP ステータス別に扱う
  }

  if (isIdentifyPlaceResponse(body)) return { ok: true, httpStatus: response.status, data: body };

  const errorCode = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null;
  const detail = `HTTP ${response.status} ${errorCode ?? bodyText.slice(0, 200)}`;
  if (response.status === 401 || response.status === 403) return fail('auth', detail, response.status);
  if (!response.ok) return fail('http', detail, response.status);
  return fail('invalid_response', detail, response.status);
}
