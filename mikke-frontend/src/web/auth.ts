/**
 * Web β版のログイン状態。Supabase Auth は既存の supabase-js クライアント（src/lib/supabase/client.ts）を使う。
 *
 * - セッションは supabase-js がブラウザ（localStorage）に保存し、期限前に自動更新する（リロードしてもログインしたまま）
 * - 画面から API を呼ぶときは、その時点のアクセストークンを src/core の API クライアントへ渡す（モバイル版と同じ呼び出し方）
 * - API が「ログインが必要」を返したら、1回だけトークンの更新を試す（だめならログアウト扱い）
 * - ログアウト・アカウント削除・ログイン切れでは、ユーザー固有のキャッシュ（保存一覧・プラン候補など）を消す
 * - service role は使わない。ブラウザに置くのは Supabase の URL と anon key（公開前提の値）だけ
 */
'use client';

import type { Session } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';

import { backendConfig } from '@/core/services/backend';
import type { ApiOptions, ApiResult } from '@/core/services/rest';
import { getSupabaseClient } from '@/lib/supabase/client';

export type AuthStatus = 'restoring' | 'ready';
export type AuthState = { status: AuthStatus; session: Session | null; linkError: string | null };

let state: AuthState = { status: 'restoring', session: null, linkError: null };
const listeners = new Set<() => void>();
const set = (next: Partial<AuthState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

// ---------------------------------------------------------------------------------------------
// ユーザー固有のキャッシュ（別のアカウントに前の人のデータを見せない）
// ---------------------------------------------------------------------------------------------
const userCacheResets = new Set<() => void>();

export function registerUserCacheReset(reset: () => void) {
  userCacheResets.add(reset);
}

function resetUserCaches() {
  userCacheResets.forEach((reset) => {
    try {
      reset();
    } catch {
      // 1つの失敗でほかの消去を止めない
    }
  });
}

// ---------------------------------------------------------------------------------------------
// 初期化（ブラウザで1回だけ）
// ---------------------------------------------------------------------------------------------

/** メール確認リンクの期限切れなど、戻ってきた URL のエラー（#error_code=...）を利用者向けの文言にする */
function readLinkError(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search.replace(/^\?/, ''));
  const code = params.get('error_code') ?? params.get('error');
  if (!code) return null;
  if (code === 'otp_expired') return '確認メールのリンクの有効期限が切れています。もう一度ログインするか、新規登録をやり直してください。';
  return 'メールのリンクを確認できませんでした。もう一度お試しください。';
}

let started = false;

export function startAuth() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const supabase = getSupabaseClient();
  const linkError = readLinkError();
  if (linkError) {
    set({ linkError });
    // エラー付きの URL を履歴に残さない
    window.history.replaceState(null, '', window.location.pathname);
  }
  supabase.auth
    .getSession()
    .then(({ data }) => set({ status: 'ready', session: data.session }))
    .catch(() => set({ status: 'ready', session: null }));
  supabase.auth.onAuthStateChange((_event, session) => {
    const had = state.session !== null;
    const changedUser = had && session !== null && state.session?.user.id !== session.user.id;
    if ((had && !session) || changedUser) resetUserCaches();
    set({ status: 'ready', session });
  });
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function getAccessToken(): string | null {
  return state.session?.access_token ?? null;
}

export function useAccessToken(): string | null {
  return useAuth().session?.access_token ?? null;
}

export function clearLinkError() {
  set({ linkError: null });
}

// ---------------------------------------------------------------------------------------------
// API 呼び出し
// ---------------------------------------------------------------------------------------------

/** 今のセッションで API を呼ぶためのオプション（押した時点のトークンを使う） */
export function apiOptions(): ApiOptions {
  return { config: backendConfig, accessToken: getAccessToken() };
}

let refreshing: Promise<boolean> | null = null;

/** API が 401 相当を返したとき。1回だけトークンを更新する。更新できなければログアウト扱い */
export function reportUnauthorized(): Promise<boolean> {
  if (refreshing) return refreshing;
  const supabase = getSupabaseClient();
  refreshing = supabase.auth
    .refreshSession()
    .then(async ({ data, error }) => {
      if (error || !data.session) {
        // 期限切れ・無効なリフレッシュトークン: ブラウザのログイン情報を消す（サーバーには送らない）
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        return false;
      }
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** 画面の操作（いいね・保存など）から呼ぶ。401 相当なら1回だけ更新して再試行する */
export async function callApi<T>(fn: (opts: ApiOptions) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const r = await fn(apiOptions());
  if (!r.ok && r.kind === 'unauthorized' && getAccessToken()) {
    if (await reportUnauthorized()) return fn(apiOptions());
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// ログイン・新規登録・ログアウト
// ---------------------------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 6;

export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'メールアドレスを正しく入力してください。';
  if (password.length < MIN_PASSWORD_LENGTH) return `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください。`;
  return null;
}

type AuthErrorLike = { code?: string; message?: string; status?: number } | null;

function signInMessage(error: AuthErrorLike): string {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'メールアドレスの確認が完了していません。届いた確認メールのリンクを開いてから、ログインしてください。';
  }
  if (code === 'invalid_credentials' || error?.status === 400) return 'メールアドレスまたはパスワードが違います。';
  if (error?.status === 429) return '短い時間に何度も試されたため、少し時間をおいてからお試しください。';
  return 'ログインできませんでした。通信環境を確認して、時間をおいてもう一度お試しください。';
}

function signUpMessage(error: AuthErrorLike): string {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === 'user_already_exists' || /already registered/i.test(message)) return 'このメールアドレスはすでに登録されています。ログインしてください。';
  if (code === 'weak_password' || /password/i.test(message)) return 'パスワードが短いか、推測されやすいものです。別のパスワードにしてください。';
  if (error?.status === 429) return '短い時間に何度も試されたため、少し時間をおいてからお試しください。';
  return '登録できませんでした。時間をおいてもう一度お試しください。';
}

export async function signIn(email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await getSupabaseClient().auth.signInWithPassword({ email: email.trim(), password });
  return error ? { ok: false, message: signInMessage(error) } : { ok: true };
}

/** confirmation_required: 確認メールを送った（メール確認が必須の設定） */
export async function signUp(email: string, password: string): Promise<{ status: 'signed_in' } | { status: 'confirmation_required' } | { status: 'error'; message: string }> {
  const { data, error } = await getSupabaseClient().auth.signUp({
    email: email.trim(),
    password,
    // 確認メールのリンクは、登録した Web のトップに戻す（Supabase の Redirect URLs に登録が必要）
    options: { emailRedirectTo: `${window.location.origin}/` },
  });
  if (error) return { status: 'error', message: signUpMessage(error) };
  // 既に登録済みのメールアドレスでは、確認済みでも identities が空で返る（存在を明かさない仕様）
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { status: 'error', message: 'このメールアドレスはすでに登録されている可能性があります。ログインをお試しください。' };
  }
  return data.session ? { status: 'signed_in' } : { status: 'confirmation_required' };
}

export async function signOut(): Promise<void> {
  await getSupabaseClient().auth.signOut().catch(() => {});
  // サーバーへの通知に失敗してもブラウザ側はログアウトする
  if (state.session) {
    await getSupabaseClient().auth.signOut({ scope: 'local' }).catch(() => {});
  }
  resetUserCaches();
}

/** アカウント削除の成功後（サーバー側のセッションは削除済みなので、ブラウザの情報だけを消す） */
export async function completeAccountDeletion(): Promise<void> {
  await getSupabaseClient().auth.signOut({ scope: 'local' }).catch(() => {});
  resetUserCaches();
}
