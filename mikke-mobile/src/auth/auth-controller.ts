/**
 * ログイン状態のコントローラ（復元・自動更新・ログアウト）。React / expo に依存しない（Node で単体テスト）。
 *
 * - 起動時: 端末に保存したリフレッシュトークンでセッションを復元（restoring → ready）
 * - 期限の5分前に自動更新。アプリが前面に戻った時も必要なら更新
 * - API が 401 を返した時は1回だけ更新を試し、だめならログアウト
 * - トークンが無効（invalid）ならログアウト。通信エラーなら保存したトークンは消さず、後で再試行
 */
import type { DevSession, RefreshResult, StoredAuth } from './auth-session';

export type AuthStatus = 'restoring' | 'ready';

export type AuthStorage = {
  read: () => Promise<StoredAuth | null>;
  write: (value: StoredAuth) => Promise<void>;
  clear: () => Promise<void>;
};

export const REFRESH_BEFORE_MS = 5 * 60_000;
const RETRY_MS = 60_000;

export function createAuthController(deps: {
  storage: AuthStorage;
  refresh: (refreshToken: string, email: string | null) => Promise<RefreshResult>;
  logoutRemote?: (accessToken: string) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onEvent?: (event: string, detail?: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let session: DevSession | null = null;
  let status: AuthStatus = 'restoring';
  let timer: unknown = null;
  let refreshing: Promise<boolean> | null = null;
  /** 起動時に通信エラーで復元できなかった保存済みトークン（前面復帰時に再試行） */
  let pendingStored: StoredAuth | null = null;
  /** ログイン・ログアウト・アカウント削除のたびに増やす。古いトークン更新の結果で状態を上書きしないため */
  let epoch = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const persist = (s: DevSession | null) => {
    const p = s?.refreshToken ? deps.storage.write({ refreshToken: s.refreshToken, email: s.email }) : deps.storage.clear();
    p.catch((e) => deps.onEvent?.('storage_failed', String(e)));
  };

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!session?.refreshToken) return;
    const wait = Math.max(0, session.expiresAt - REFRESH_BEFORE_MS - now());
    timer = setTimer(() => {
      timer = null;
      void refreshNow();
    }, wait);
  }

  function setSession(next: DevSession | null, options: { persist?: boolean } = {}) {
    session = next;
    if (options.persist !== false) persist(next);
    schedule();
    emit();
  }

  /** ログイン状態の区切り（進行中の更新・予約した更新を無効にする） */
  function nextEpoch() {
    epoch += 1;
    refreshing = null;
    pendingStored = null;
  }

  /** リフレッシュトークンで更新する。成功なら true。同時の更新は1本にまとめる */
  function refreshNow(): Promise<boolean> {
    if (refreshing) return refreshing;
    const token = session?.refreshToken;
    if (!token) return Promise.resolve(false);
    const email = session?.email ?? null;
    const startedEpoch = epoch;
    const p: Promise<boolean> = deps
      .refresh(token, email)
      .then((r) => {
        if (startedEpoch !== epoch) return false; // 途中でログアウト・削除・別ログインがあった
        if (r.ok) {
          setSession(r.session);
          return true;
        }
        deps.onEvent?.('refresh_failed', `${r.kind} ${r.devDetail}`);
        if (r.kind === 'invalid') {
          setSession(null); // 無効なトークンは端末からも消す
        } else if (session) {
          // 通信エラー等: 保存したトークンは残し、少し後で再試行
          if (timer !== null) clearTimer(timer);
          timer = setTimer(() => {
            timer = null;
            void refreshNow();
          }, RETRY_MS);
        }
        return false;
      })
      .finally(() => {
        if (refreshing === p) refreshing = null;
      });
    refreshing = p;
    return p;
  }

  return {
    getSession: () => session,
    getStatus: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** 起動時に1回呼ぶ */
    async restore(): Promise<void> {
      if (status === 'ready' && session) return;
      let stored: StoredAuth | null = null;
      try {
        stored = await deps.storage.read();
      } catch (e) {
        deps.onEvent?.('storage_failed', String(e));
      }
      if (stored) {
        const startedEpoch = epoch;
        const r = await deps.refresh(stored.refreshToken, stored.email);
        if (startedEpoch !== epoch) {
          // 復元中にログイン・削除などがあった: そちらを優先する
        } else if (r.ok) {
          session = r.session;
          persist(r.session); // 更新でリフレッシュトークンが新しくなる
          schedule();
        } else {
          deps.onEvent?.('restore_failed', `${r.kind} ${r.devDetail}`);
          // 無効なら消す。通信エラーなら残して次回の起動・前面復帰で再試行
          if (r.kind === 'invalid') deps.storage.clear().catch(() => {});
          else pendingStored = stored;
        }
      }
      status = 'ready';
      emit();
    },

    /** ログイン・新規登録の成功時 */
    signedIn(next: DevSession) {
      nextEpoch();
      setSession(next);
    },

    async signOut(): Promise<void> {
      const current = session;
      nextEpoch();
      setSession(null);
      if (current && deps.logoutRemote) await deps.logoutRemote(current.accessToken).catch(() => {});
    },

    /**
     * アカウント削除の成功時。端末の保存（リフレッシュトークン・メール）とメモリ上のセッションを消す。
     * サーバー側のセッションは削除済みなので logout は呼ばない（削除済みアカウントのトークンを使わない）
     */
    async accountDeleted(): Promise<void> {
      nextEpoch();
      session = null;
      schedule();
      try {
        await deps.storage.clear();
      } catch (e) {
        deps.onEvent?.('storage_failed', String(e));
      }
      emit();
    },

    /** API が 401 を返した時。1回だけ更新を試し、だめならログアウト */
    async handleUnauthorized(): Promise<boolean> {
      if (!session?.refreshToken) {
        if (session) setSession(null);
        return false;
      }
      const current = session;
      const ok = await refreshNow();
      if (!ok && session) {
        // 通信エラー等（無効ではない）: 画面上はログアウト扱いにするが、保存したトークンは消さず前面復帰時に再試行
        pendingStored = current.refreshToken ? { refreshToken: current.refreshToken, email: current.email } : null;
        setSession(null, { persist: false });
      }
      return ok;
    },

    /** アプリが前面に戻った時。期限が近ければ更新、起動時に通信できなかった場合は復元を再試行 */
    async onForeground(): Promise<void> {
      if (session && session.expiresAt - REFRESH_BEFORE_MS <= now()) await refreshNow();
      else if (!session && pendingStored) {
        const stored = pendingStored;
        const startedEpoch = epoch;
        const r = await deps.refresh(stored.refreshToken, stored.email);
        if (startedEpoch !== epoch) return;
        if (r.ok) {
          pendingStored = null;
          setSession(r.session);
        } else if (r.kind === 'invalid') {
          pendingStored = null;
          deps.storage.clear().catch(() => {});
        }
      }
    },
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
