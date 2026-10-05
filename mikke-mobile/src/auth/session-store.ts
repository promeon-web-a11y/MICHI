/**
 * ログイン状態（Supabase Auth のセッション）。アプリ全体で共有する。
 *
 * - 端末には Keychain / Keystore（expo-secure-store）でリフレッシュトークンだけを保存し、起動時に復元する
 *   （src/auth/auth-controller.ts / session-storage.ts）。expo-secure-store を含まないビルド・Web では保存しない
 * - アクセストークンは期限の5分前・前面復帰時に自動更新。API の 401 では1回だけ更新を試す
 * - service role は使わない。モバイルに置くのは Supabase の URL と anon key（公開前提の値）だけ
 */
import { useSyncExternalStore } from 'react';

import { appLog } from '@/lib/logger';
import { backendConfig } from '@/services/backend';

import { createAuthController } from './auth-controller';
import { refreshSession, signOutRemote, type DevSession } from './auth-session';
import { sessionStorage } from './session-storage';

// 互換: 接続設定の正本は services/backend.ts（既存コードがここから import しているため残す）
export { backendConfig };

const auth = createAuthController({
  storage: sessionStorage,
  refresh: (refreshToken, email) => refreshSession(refreshToken, email, { config: backendConfig }),
  logoutRemote: (accessToken) => signOutRemote(accessToken, { config: backendConfig }),
  // トークンは記録しない（イベント名と種類だけ。logger 側でも伏せる）
  onEvent: (event, detail) => appLog.warn(`認証: ${event}`, detail?.replace(/eyJ[\w.-]+/g, '[jwt]')),
});

// ---------------------------------------------------------------------------------------------
// ユーザー固有のキャッシュ（今日のプラン・保存一覧・プラン候補・ルート・条件の下書きなど）
// ログアウト・アカウント削除・ログイン切れでセッションが無くなったら消す（別のアカウントに前の人のデータを見せない）
// ---------------------------------------------------------------------------------------------
const userCacheResets = new Set<() => void>();

/** 各ストアのモジュールから登録する */
export function registerUserCacheReset(reset: () => void) {
  userCacheResets.add(reset);
}

export function resetUserCaches() {
  userCacheResets.forEach((reset) => {
    try {
      reset();
    } catch (e) {
      appLog.warn('キャッシュの消去に失敗しました', e);
    }
  });
}

let hadSession = false;
auth.subscribe(() => {
  const has = auth.getSession() !== null;
  if (hadSession && !has) resetUserCaches();
  hadSession = has;
});

/** アカウント削除の成功後: 端末のログイン情報・メモリ上のセッション・ユーザー固有キャッシュを消す */
export async function completeAccountDeletion(): Promise<void> {
  await auth.accountDeleted();
  resetUserCaches(); // セッションが既に無かった場合も確実に消す
}

export function getDevSession(): DevSession | null {
  return auth.getSession();
}

/** ログイン・新規登録の成功時は session、明示的なログアウトは null */
export function setDevSession(session: DevSession | null) {
  if (session) auth.signedIn(session);
  else void auth.signOut();
}

/** API が 401 を返した時に呼ぶ（1回だけトークン更新を試し、だめならログアウト） */
export function reportUnauthorized(): Promise<boolean> {
  return auth.handleUnauthorized();
}

export const restoreAuth = auth.restore;
export const authOnForeground = auth.onForeground;
export const signOut = auth.signOut;
export const isSessionPersistenceAvailable = sessionStorage.isAvailable;

export function useDevSession(): DevSession | null {
  return useSyncExternalStore(auth.subscribe, auth.getSession, auth.getSession);
}

/** restoring: 起動直後に保存済みのログインを確認中 / ready: 確認済み */
export function useAuthStatus() {
  return useSyncExternalStore(auth.subscribe, auth.getStatus, auth.getStatus);
}
