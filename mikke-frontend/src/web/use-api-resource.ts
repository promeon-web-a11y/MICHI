/**
 * 画面が API の結果を読むためのフック（モバイル版 lib/use-api-resource.ts の Web 版）。
 * - ログイン中のトークンで呼び、401 相当なら1回だけトークンを更新して取り直す
 * - 表示したとき・key が変わったとき・タブに戻ってきたときに、古い（staleMs 経過）か version が変わっていれば取り直す
 * - 取り直し中も前の結果を表示し続ける（通信エラーで一覧を消さない）
 */
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { backendConfig } from '@/core/services/backend';
import type { ApiOptions, ApiResult } from '@/core/services/rest';

import { reportUnauthorized, useAccessToken, useAuth } from './auth';

export type ResourcePhase = 'idle' | 'loading' | 'ready' | 'error' | 'unauthorized';

export type ResourceState<T> = { phase: ResourcePhase; data: T | null; message: string | null; refreshing: boolean };

export function useApiResource<T>(
  key: string | null,
  load: (opts: ApiOptions) => Promise<ApiResult<T>>,
  options: { staleMs?: number; version?: number } = {}
) {
  const token = useAccessToken();
  const { status } = useAuth();
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
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(
    async (force: boolean) => {
      const m = meta.current;
      if (status === 'restoring') return;
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
        // トークンが更新できれば token が変わって取り直される。できなければログアウト扱いになる
        void reportUnauthorized();
        setState((prev) => (prev.data !== null && same ? { ...prev, refreshing: false } : { phase: 'loading', data: null, message: null, refreshing: false }));
      } else {
        setState((prev) =>
          prev.data !== null && same
            ? { ...prev, refreshing: false, message: r.message }
            : { phase: 'error', data: null, message: r.message, refreshing: false }
        );
      }
    },
    [key, token, staleMs, version, status]
  );

  useEffect(() => {
    // 外部（API）から取得して state に反映する。表示時・条件の変更時に1回
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run(false);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [run]);

  const reload = useCallback(() => run(true), [run]);
  /** 楽観的な更新（いいね等）。サーバーの結果で上書きされる */
  const mutate = useCallback((fn: (data: T) => T) => {
    setState((prev) => (prev.data === null ? prev : { ...prev, data: fn(prev.data) }));
  }, []);

  return { ...state, phase: status === 'restoring' ? ('loading' as const) : state.phase, reload, mutate };
}
