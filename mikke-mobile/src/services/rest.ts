/**
 * v3 で追加した API クライアントが共有する、Supabase REST（PostgREST RPC / テーブル）呼び出しの土台。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * - ユーザーの JWT を付けて呼ぶ。RLS と security definer の RPC（auth.uid()）が本人を確定するので user_id は送らない
 * - 例外は投げず、画面で分岐しやすい種類（unauthorized / not_found / invalid / network / server / config）に変換する
 */
import { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from './backend';

export type ApiErrorKind = 'config' | 'unauthorized' | 'not_found' | 'invalid' | 'network' | 'server';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; kind: ApiErrorKind; message: string; devDetail: string };

export type ApiOptions = { config: BackendConfig; accessToken: string | null; fetchImpl?: FetchLike; timeoutMs?: number };

export const API_MESSAGES: Record<ApiErrorKind, string> = {
  config: 'アプリの接続設定が不足しています。',
  unauthorized: 'ログインが必要です。',
  not_found: '見つかりませんでした。削除されたか、公開が終わった可能性があります。',
  invalid: '入力内容を確認して、もう一度お試しください。',
  network: 'ネットワークに接続できませんでした。通信環境を確認してもう一度お試しください。',
  server: 'うまく処理できませんでした。少し時間をおいてもう一度お試しください。',
};

/** サーバー側の更新（migration）がまだ反映されていないときの文言 */
export const NOT_READY_MESSAGE = 'この機能はまだ準備中です。アプリとサーバーの更新が終わるまでお待ちください。';

/** 画面にそのまま出せる業務エラー（RPC の raise exception の文言 → 文言） */
export const CODE_MESSAGES: Record<string, string> = {
  account_restricted: 'このアカウントは現在、投稿・コメントを制限されています。詳しくはお問い合わせください。',
  route_content_not_found: '対象の投稿・コメントが見つかりませんでした。削除されたか、表示されなくなった可能性があります。',
  invalid_report_own_content: '自分の投稿・コメントは通報できません。',
  invalid_report_too_many: '通報の回数が多すぎます。時間をおいてもう一度お試しください。',
  invalid_block_self: '自分はブロックできません。',
};

const TIMEOUT_MS = 15_000;

export function apiFail<T>(kind: ApiErrorKind, devDetail: string, message?: string): ApiResult<T> {
  return { ok: false, kind, message: message ?? API_MESSAGES[kind], devDetail };
}

/** 業務エラー（RPC の raise exception の文言）→ 種類。認証エラーより先に判定する（42501 は HTTP 403 になるため） */
const NOT_FOUND_CODES = ['route_post_not_found', 'route_content_not_found', 'accepted_plan_not_found', 'plan_not_found', 'P0002'];
const INVALID_CODES = [
  'invalid_',
  'title_required',
  'visited_places_required',
  'visited_place_not_in_plan',
  'record_already_published',
  'route_has_no_places',
  'memory_too_long',
  'stop_not_found',
  '22023',
  '23514',
];

export function classifyHttpError(status: number, json: unknown, text: string): { kind: ApiErrorKind; code: string } {
  const body = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const code = String(body.code ?? '');
  const message = String(body.message ?? '');
  const hay = `${code} ${message}`;
  // RPC・列が無い（202609280008 が未適用）: 見つからない・入力ミスと取り違えない
  if (code === 'PGRST202' || code === '42883' || code === '42703' || code === '42P01') return { kind: 'server', code: `not_ready:${code}` };
  // 投稿停止中（42501 = HTTP 403）。権限エラー（server）と取り違えない
  if (hay.includes('account_restricted')) return { kind: 'invalid', code: 'account_restricted' };
  if (NOT_FOUND_CODES.some((c) => hay.includes(c))) return { kind: 'not_found', code: message || code };
  if (INVALID_CODES.some((c) => hay.includes(c))) return { kind: 'invalid', code: message || code };
  if (status === 401 || code.startsWith('PGRST30') || message.includes('authentication_required') || /jwt/i.test(message)) {
    return { kind: 'unauthorized', code: code || String(status) };
  }
  if (status === 404) return { kind: 'not_found', code: code || text.slice(0, 80) };
  if (status === 400 || status === 422) return { kind: 'invalid', code: code || text.slice(0, 80) };
  return { kind: 'server', code: code || text.slice(0, 80) };
}

/** /rest/v1/ 以下を呼ぶ。成功時は JSON（空なら null） */
export async function restRequest(
  path: string,
  opts: ApiOptions & { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; prefer?: string }
): Promise<ApiResult<unknown>> {
  const backend = resolveBackend(opts.config);
  if (!backend) return apiFail('config', 'EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY が未設定または不正');
  if (!opts.accessToken) return apiFail('unauthorized', 'access token がありません（未ログイン）');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/rest/v1/${path}`,
      {
        method: opts.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${opts.accessToken}`,
          ...(opts.prefer ? { Prefer: opts.prefer } : {}),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      },
      opts.timeoutMs ?? TIMEOUT_MS
    );
  } catch (e) {
    return apiFail('network', isAbortError(e) ? 'timeout' : e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    return apiFail('network', `本文の読み取りに失敗: ${String(e)}`);
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const { kind, code } = classifyHttpError(res.status, json, text);
    const known = Object.keys(CODE_MESSAGES).find((c) => code.includes(c));
    return apiFail(kind, `HTTP ${res.status} ${code}`, code.startsWith('not_ready:') ? NOT_READY_MESSAGE : known ? CODE_MESSAGES[known] : undefined);
  }
  return { ok: true, data: json };
}

/** PostgREST の RPC（POST /rest/v1/rpc/<name>） */
export function rpc(name: string, args: Record<string, unknown>, opts: ApiOptions): Promise<ApiResult<unknown>> {
  return restRequest(`rpc/${name}`, { ...opts, method: 'POST', body: args });
}

// ---------------------------------------------------------------------------------------------
// 値の読み取り（壊れた応答で画面を落とさない）
// ---------------------------------------------------------------------------------------------

export const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
export const bool = (v: unknown): boolean => v === true;
