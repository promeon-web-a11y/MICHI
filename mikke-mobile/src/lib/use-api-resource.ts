/**
 * v3 の画面が API の結果を読むためのフック。
 * - ログイン中のトークンで呼び、401 相当なら既存の reportUnauthorized（1回だけ更新→だめならログアウト）
 * - 画面に戻るたびに、古い（staleMs 経過）か version が変わっていれば取り直す
 * - 取り直し中も前の結果を表示し続ける（通信エラーで一覧を消さない）
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { isSessionValid } from '@/auth/auth-session';
import { backendConfig, getDevSession, reportUnauthorized, useDevSession } from '@/auth/session-store';
import { appLog } from '@/lib/logger';
import type { ApiOptions, ApiResult } from '@/services/rest';

export type ResourcePhase = 'idle' | 'loading' | 'ready' | 'error' | 'unauthorized';

export type ResourceState<T> = { phase: ResourcePhase; data: T | null; message: string | null; refreshing: boolean };

/** 今のセッションで API を呼ぶためのオプション（押した時点のトークンを使う） */
export function apiOptions(): ApiOptions {
  const s = getDevSession();
  return { config: backendConfig, accessToken: isSessionValid(s) ? s.accessToken : null };
}

/** 画面の操作（いいね・保存など）から呼ぶ。401 相当なら再認証を試す */
export async function callApi<T>(fn: (opts: ApiOptions) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const r = await fn(apiOptions());
  if (!r.ok) {
    if (r.kind === 'unauthorized') void reportUnauthorized();
    appLog.warn('API エラー', r.devDetail);
  }
  return r;
}

export function useAccessToken(): string | null {
  const session = useDevSession();
  return isSessionValid(session) ? session.accessToken : null;
}

export function useApiResource<T>(
  key: string | null,
  load: (opts: ApiOptions) => Promise<ApiResult<T>>,
  options: { staleMs?: number; version?: number } = {}
) {
  const token = useAccessToken();
  const staleMs = options.staleMs ?? 30_000;
  const version = options.version ?? 0;
  const [state, setState] = useState<ResourceState<T>>({ phase: 'idle', data: null, message: null, refreshing: false });
  const meta = useRef<{ key: string | null; token: string | null; at: number; version: number; seq: number }>({
    key: null,
    token: null,
    at: 0,
    version: -1,
    seq: 0,
  });
  // load は key（検索条件など）と対応している前提。最新の関数を使う
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(
    async (force: boolean) => {
      const m = meta.current;
      if (!token) {
        setState({ phase: 'unauthorized', data: null, message: null, refreshing: false });
        return;
      }
      if (key === null) return;
      const same = m.key === key && m.token === token;
      if (!force && same && m.version === version && Date.now() - m.at < staleMs) return;
      const seq = ++m.seq;
      m.key = key;
      m.token = token;
      setState((prev) =>
        same && prev.data !== null ? { ...prev, refreshing: force } : { phase: 'loading', data: null, message: null, refreshing: false }
      );
      const r = await loadRef.current({ config: backendConfig, accessToken: token });
      if (seq !== meta.current.seq) return; // 新しい取得が始まっていた
      if (r.ok) {
        meta.current.at = Date.now();
        meta.current.version = version;
        setState({ phase: 'ready', data: r.data, message: null, refreshing: false });
      } else if (r.kind === 'unauthorized') {
        void reportUnauthorized();
        setState({ phase: 'unauthorized', data: null, message: r.message, refreshing: false });
      } else {
        appLog.warn('読み込みエラー', r.devDetail);
        setState((prev) =>
          prev.data !== null && same
            ? { ...prev, refreshing: false, message: r.message }
            : { phase: 'error', data: null, message: r.message, refreshing: false }
        );
      }
    },
    [key, token, staleMs, version]
  );

  // 画面に戻ったとき・フォーカス中に key（検索条件など）が変わったとき（run が変わると呼び直される）
  useFocusEffect(
    useCallback(() => {
      void run(false);
    }, [run])
  );

  const reload = useCallback(() => run(true), [run]);
  /** 楽観的な更新（いいね等）。サーバーの結果で上書きされる */
  const mutate = useCallback((fn: (data: T) => T) => {
    setState((prev) => (prev.data === null ? prev : { ...prev, data: fn(prev.data) }));
  }, []);

  return { ...state, reload, mutate };
}
