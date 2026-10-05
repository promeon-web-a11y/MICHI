/**
 * アカウント削除（delete-account Edge Function の呼び出し）。React / expo に依存しない（Node で単体テスト）。
 *
 * - 削除対象はサーバーが JWT から確定する本人だけ。user_id やメールアドレスは送らない
 * - service role はモバイルに置かない（削除の権限はサーバー側だけが持つ）
 * - 成功時だけ端末のログイン情報を消す。失敗時はログイン状態を保ったままにする
 */
import { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from '../services/backend';

/** 誤呼び出し防止の固定値（サーバー側と同じ値） */
export const DELETE_ACCOUNT_CONFIRM = 'delete_my_account';
export const DELETE_ACCOUNT_TIMEOUT_MS = 30_000;

export const DELETE_ACCOUNT_MESSAGES = {
  failed: 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。',
  needLogin: 'ログインの有効期限が切れました。もう一度ログインしてからお試しください。',
} as const;

export type DeleteAccountCallResult =
  | { ok: true }
  | { ok: false; kind: 'config' | 'unauthorized' | 'network' | 'timeout' | 'error'; devDetail: string };

export async function requestAccountDeletion(options: {
  config: BackendConfig;
  accessToken: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<DeleteAccountCallResult> {
  const backend = resolveBackend(options.config);
  if (!backend) return { ok: false, kind: 'config', devDetail: 'Supabase の設定がありません' };
  if (!options.accessToken) return { ok: false, kind: 'unauthorized', devDetail: '未ログイン' };
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DELETE_ACCOUNT_TIMEOUT_MS;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/functions/v1/delete-account`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${options.accessToken}`,
        },
        // 本文は確認用の固定値だけ（削除対象はサーバーが JWT から決める）
        body: JSON.stringify({ confirm: DELETE_ACCOUNT_CONFIRM }),
      },
      timeoutMs
    );
  } catch (e) {
    if (isAbortError(e)) return { ok: false, kind: 'timeout', devDetail: `delete-account が ${timeoutMs}ms 以内に応答しませんでした` };
    return { ok: false, kind: 'network', devDetail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let status: unknown = null;
  try {
    status = text ? (JSON.parse(text) as { status?: unknown }).status : null;
  } catch {
    status = null;
  }
  if (response.ok && status === 'deleted') return { ok: true };
  const detail = `HTTP ${response.status} ${text.slice(0, 200)}`;
  if (response.status === 401 || response.status === 403) return { ok: false, kind: 'unauthorized', devDetail: detail };
  return { ok: false, kind: 'error', devDetail: detail };
}

export type AccountDeletionOutcome =
  | { status: 'deleted' }
  | { status: 'failed'; message: string; devDetail: string }
  /** 処理中の2回目以降の呼び出し（何もしない） */
  | { status: 'busy' };

/**
 * 削除の実行役。二重タップでも削除リクエストは1本だけ。
 * ログイン切れ（401）のときは1回だけトークンを更新して再試行する。
 */
export function createAccountDeleter(deps: {
  getAccessToken: () => string | null;
  request: (accessToken: string) => Promise<DeleteAccountCallResult>;
  /** 401 のときにトークン更新を試す。成功なら true */
  refreshAfterUnauthorized: () => Promise<boolean>;
  /** 成功後の端末の後始末（ログイン情報・キャッシュの消去） */
  onDeleted: () => Promise<void>;
}) {
  let running: Promise<AccountDeletionOutcome> | null = null;

  async function run(): Promise<AccountDeletionOutcome> {
    const token = deps.getAccessToken();
    if (!token) return { status: 'failed', message: DELETE_ACCOUNT_MESSAGES.needLogin, devDetail: 'no session' };
    let result = await deps.request(token);
    if (!result.ok && result.kind === 'unauthorized') {
      const refreshed = await deps.refreshAfterUnauthorized();
      const next = refreshed ? deps.getAccessToken() : null;
      if (!next) return { status: 'failed', message: DELETE_ACCOUNT_MESSAGES.needLogin, devDetail: result.devDetail };
      result = await deps.request(next);
    }
    if (!result.ok) return { status: 'failed', message: DELETE_ACCOUNT_MESSAGES.failed, devDetail: `${result.kind} ${result.devDetail}` };
    await deps.onDeleted();
    return { status: 'deleted' };
  }

  return {
    isRunning: () => running !== null,
    delete(): Promise<AccountDeletionOutcome> {
      if (running) return Promise.resolve({ status: 'busy' });
      running = run()
        .catch((e): AccountDeletionOutcome => ({ status: 'failed', message: DELETE_ACCOUNT_MESSAGES.failed, devDetail: String(e) }))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
