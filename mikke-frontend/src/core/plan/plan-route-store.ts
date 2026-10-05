/**
 * 選択したプランの実ルートの取得状態（プランごと）と短期キャッシュ。React に依存しない（Node で単体テスト）。
 *
 * Routes API のコストを抑えるため:
 * - 同じプラン・ほぼ同じ出発地点（約100m）・10分以内なら再取得しない
 * - 同じプランの取得中に再度呼ばれても2本目は送らない
 * キャッシュは端末のメモリ上だけ（DB には保存しない）。
 */
import type { RouteErrorKind, RoutedPlan, RouteResult } from './plan-route-client';

export const ROUTE_CACHE_TTL_MS = 10 * 60_000;

type LatLng = { latitude: number; longitude: number };

export type PlanRouteEntry =
  | { status: 'loading'; key: string; data: RoutedPlan | null }
  | { status: 'ready'; key: string; data: RoutedPlan; fetchedAt: number }
  | { status: 'error'; key: string; error: { kind: RouteErrorKind; message: string; retryable: boolean } };

/** 出発地点は約100m単位に丸めてキーにする（少しの GPS の揺れで再取得しない） */
export function routeCacheKey(planId: string, origin: LatLng): string {
  return `${planId}|${origin.latitude.toFixed(3)}|${origin.longitude.toFixed(3)}`;
}

export function createPlanRouteStore(deps: {
  fetch: (planId: string, origin: LatLng) => Promise<RouteResult>;
  now?: () => number;
  ttlMs?: number;
  onError?: (devDetail: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? ROUTE_CACHE_TTL_MS;
  let state: Record<string, PlanRouteEntry> = {};
  const inFlight = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const set = (planId: string, entry: PlanRouteEntry) => {
    state = { ...state, [planId]: entry };
    listeners.forEach((l) => l());
  };

  function load(planId: string, origin: LatLng, options: { force?: boolean } = {}): Promise<void> {
    const key = routeCacheKey(planId, origin);
    const current = state[planId];
    if (!options.force && current?.status === 'ready' && current.key === key && now() - current.fetchedAt < ttl) {
      return Promise.resolve();
    }
    const running = inFlight.get(planId);
    if (running) return running; // 二重リクエスト防止
    set(planId, { status: 'loading', key, data: current?.status === 'ready' ? current.data : null });
    const promise = deps
      .fetch(planId, origin)
      .then((result) => {
        if (result.ok) set(planId, { status: 'ready', key, data: result.data, fetchedAt: now() });
        else {
          deps.onError?.(result.devDetail);
          set(planId, { status: 'error', key, error: { kind: result.kind, message: result.message, retryable: result.retryable } });
        }
      })
      .catch((e) => {
        deps.onError?.(String(e));
        set(planId, {
          status: 'error',
          key,
          error: { kind: 'invalid_response', message: '移動ルートを取得できませんでした。もう一度お試しください。', retryable: true },
        });
      })
      .finally(() => inFlight.delete(planId));
    inFlight.set(planId, promise);
    return promise;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    /** ログアウト・アカウント削除時に前のユーザーのルートを消す */
    reset() {
      state = {};
      inFlight.clear();
      listeners.forEach((l) => l());
    },
    clear() {
      state = {};
      inFlight.clear();
      listeners.forEach((l) => l());
    },
  };
}
