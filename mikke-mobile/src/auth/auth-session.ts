/**
 * Supabase Auth（GoTrue REST）: ログイン・トークン更新・新規登録・ログアウトと、セッションの型。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * - アクセストークンは約1時間で切れるので、リフレッシュトークンで更新する（更新のたびにリフレッシュトークンも新しくなる）
 * - 端末に保存するのはリフレッシュトークンとメールアドレスだけ（session-storage）
 * - ログイン状態（アプリ全体で共有するストア）は session-store.ts
 */
import { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from '../services/backend';

/** refreshToken: アクセストークンの更新と、端末への保存（session-storage）に使う */
export type DevSession = { accessToken: string; refreshToken?: string; email: string | null; expiresAt: number };
/** DevSession の新しい名前（中身は同じ。新しいコードではこちらを使う） */
export type AuthSession = DevSession;

/** 期限切れ（余裕を30秒持つ）のセッションは使わない */
export function isSessionValid(session: DevSession | null, now: number = Date.now()): session is DevSession {
  return !!session && session.expiresAt - 30_000 > now;
}

export type StoredAuth = { refreshToken: string; email: string | null };

const TIMEOUT_MS = 15_000;

type Opts = { config: BackendConfig; fetchImpl?: FetchLike; now?: () => number };

function toSession(body: Record<string, any>, now: number, fallbackEmail: string | null): DevSession | null {
  if (typeof body?.access_token !== 'string') return null;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    email: typeof body.user?.email === 'string' ? body.user.email : fallbackEmail,
    expiresAt: now + expiresIn * 1000,
  };
}

async function post(path: string, body: unknown, opts: Opts, bearer?: string) {
  const backend = resolveBackend(opts.config);
  if (!backend) return { kind: 'config' as const };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/auth/v1/${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      },
      TIMEOUT_MS
    );
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { kind: 'http' as const, status: res.status, ok: res.ok, json };
  } catch (e) {
    return { kind: 'network' as const, detail: isAbortError(e) ? 'timeout' : String(e) };
  }
}

export type RefreshResult =
  | { ok: true; session: DevSession }
  | { ok: false; kind: 'invalid' | 'network' | 'server' | 'config'; devDetail: string };

/** リフレッシュトークンで新しいセッションを得る。invalid: トークンが使えない（ログアウト扱い） */
export async function refreshSession(refreshToken: string, email: string | null, opts: Opts): Promise<RefreshResult> {
  const r = await post('token?grant_type=refresh_token', { refresh_token: refreshToken }, opts);
  if (r.kind === 'config') return { ok: false, kind: 'config', devDetail: 'config' };
  if (r.kind === 'network') return { ok: false, kind: 'network', devDetail: r.detail };
  if (r.ok) {
    const session = toSession(r.json, (opts.now ?? Date.now)(), email);
    return session ? { ok: true, session } : { ok: false, kind: 'server', devDetail: 'no access_token' };
  }
  const code = String(r.json.error_code ?? r.json.error ?? r.json.code ?? '');
  // 400/401: 無効・期限切れ・再利用されたリフレッシュトークン
  if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, kind: 'invalid', devDetail: `HTTP ${r.status} ${code}` };
  return { ok: false, kind: 'server', devDetail: `HTTP ${r.status} ${code}` };
}

export type SignUpResult =
  | { status: 'signed_in'; session: DevSession }
  | { status: 'confirmation_required' }
  | { status: 'error'; userMessage: string; devDetail: string };

export const MIN_PASSWORD_LENGTH = 6;

/** 入力チェック（送信前）。問題なければ null */
export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'メールアドレスを正しく入力してください。';
  if (password.length < MIN_PASSWORD_LENGTH) return `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください。`;
  return null;
}

export async function signUp(email: string, password: string, opts: Opts): Promise<SignUpResult> {
  const invalid = validateCredentials(email, password);
  if (invalid) return { status: 'error', userMessage: invalid, devDetail: 'validation' };
  const r = await post('signup', { email: email.trim(), password }, opts);
  if (r.kind === 'config') return { status: 'error', userMessage: 'アプリの接続設定が不足しています。', devDetail: 'config' };
  if (r.kind === 'network') {
    return { status: 'error', userMessage: 'ネットワークに接続できませんでした。通信環境を確認してもう一度お試しください。', devDetail: r.detail };
  }
  if (r.ok) {
    const session = toSession(r.json, (opts.now ?? Date.now)(), email.trim());
    // メール確認が必要な設定では session が返らない
    return session ? { status: 'signed_in', session } : { status: 'confirmation_required' };
  }
  const code = String(r.json.error_code ?? r.json.code ?? r.json.error ?? '');
  const msg = String(r.json.msg ?? r.json.message ?? '');
  if (code === 'user_already_exists' || /already registered/i.test(msg)) {
    return { status: 'error', userMessage: 'このメールアドレスはすでに登録されています。ログインしてください。', devDetail: `HTTP ${r.status} ${code}` };
  }
  if (code === 'weak_password' || /password/i.test(msg)) {
    return { status: 'error', userMessage: 'パスワードが短いか、推測されやすいものです。別のパスワードにしてください。', devDetail: `HTTP ${r.status} ${code}` };
  }
  if (r.status === 429) {
    return { status: 'error', userMessage: '短い時間に何度も試されたため、少し時間をおいてからお試しください。', devDetail: `HTTP 429 ${code}` };
  }
  return { status: 'error', userMessage: '登録できませんでした。時間をおいてもう一度お試しください。', devDetail: `HTTP ${r.status} ${code}` };
}

/** サーバー側のセッションを無効にする（失敗しても端末側のログアウトは続ける） */
export async function signOutRemote(accessToken: string, opts: Opts): Promise<void> {
  await post('logout', {}, opts, accessToken);
}

// ---------------------------------------------------------------------------------------------
// ログイン（メール/パスワード）
// ---------------------------------------------------------------------------------------------

const SIGN_IN_TIMEOUT_MS = 15_000;

const SIGN_IN_MESSAGES = {
  config: 'アプリの接続設定に問題があります。しばらくしてからもう一度お試しください。',
  network: 'ネットワークに接続できませんでした。通信環境を確認して再度お試しください。',
  timeout: '時間内に応答がありませんでした。時間をおいて再度お試しください。',
  http: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。',
} as const;

export const EMAIL_NOT_CONFIRMED_MESSAGE =
  'メールアドレスの確認が完了していません。届いた確認メールのリンクを開いてから、ログインしてください。';

export type SignInResult =
  | { ok: true; session: DevSession }
  | { ok: false; userMessage: string; devDetail: string };

export async function signInWithPassword(
  email: string,
  password: string,
  options: { config: BackendConfig; fetchImpl?: FetchLike; now?: () => number }
): Promise<SignInResult> {
  const backend = resolveBackend(options.config);
  if (!backend) return { ok: false, userMessage: SIGN_IN_MESSAGES.config, devDetail: 'Supabase の設定がありません' };
  if (!email.trim() || !password) {
    return { ok: false, userMessage: 'メールアドレスとパスワードを入力してください。', devDetail: 'empty credentials' };
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? Date.now;

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: backend.anonKey },
        body: JSON.stringify({ email: email.trim(), password }),
      },
      SIGN_IN_TIMEOUT_MS
    );
    const text = await response.text();
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(text);
    } catch {
      // 非JSON
    }
    if (!response.ok || typeof body.access_token !== 'string') {
      const code = body.error_code ?? body.error ?? body.code ?? 'unknown';
      // パスワードが正しくても、メール確認前のアカウントは 400 email_not_confirmed になる
      const emailNotConfirmed = code === 'email_not_confirmed' || /email not confirmed/i.test(String(body.msg ?? body.message ?? ''));
      return {
        ok: false,
        userMessage: emailNotConfirmed
          ? EMAIL_NOT_CONFIRMED_MESSAGE
          : response.status === 400
            ? 'メールアドレスまたはパスワードが違います。'
            : SIGN_IN_MESSAGES.http,
        devDetail: `HTTP ${response.status} ${code}`,
      };
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    return {
      ok: true,
      session: {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        email: typeof body.user?.email === 'string' ? body.user.email : email.trim(),
        expiresAt: now() + expiresIn * 1000,
      },
    };
  } catch (e) {
    if (isAbortError(e)) return { ok: false, userMessage: SIGN_IN_MESSAGES.timeout, devDetail: 'auth timeout' };
    return { ok: false, userMessage: SIGN_IN_MESSAGES.network, devDetail: e instanceof Error ? e.message : String(e) };
  }
}
