/**
 * 「今日のプラン」の状態（ホームのカードと /today で共有）。React に依存しない（Node で単体テスト）。
 *
 * - 取得: 同じセッションで60秒以内なら再取得しない。同時の取得は1本にまとめる
 * - 「行った」: 1件ずつ順番に処理（連打・二重タップで重ならない）。結果はサーバーの visited_place_ids で上書き
 */
import type { FetchTodayResult, TodayPlan, VisitResult } from './today-plan-client';

export const TODAY_STALE_MS = 60_000;

export type TodayPhase = 'idle' | 'loading' | 'ready' | 'none' | 'error' | 'unauthorized';

export type TodayState = {
  token: string | null;
  phase: TodayPhase;
  plan: TodayPlan | null;
  devDetail: string | null;
  fetchedAt: number | null;
  /** 記録中の場所 */
  visiting: string | null;
  /** 場所ごとの記録エラー（利用者向け文言） */
  visitErrors: Record<string, string>;
};

export const INITIAL_TODAY_STATE: TodayState = {
  token: null,
  phase: 'idle',
  plan: null,
  devDetail: null,
  fetchedAt: null,
  visiting: null,
  visitErrors: {},
};

/** サーバーの visited_place_ids を反映した表示用プラン */
export function applyVisitedIds(plan: TodayPlan, ids: readonly string[]): TodayPlan {
  const stops = plan.stops.map((s) => ({ ...s, visited: ids.includes(s.place_id) }));
  const visitedCount = stops.filter((s) => s.visited).length;
  return { ...plan, stops, visited_place_ids: [...ids], visited_count: visitedCount, completed: visitedCount === stops.length };
}

export function createTodayPlanStore(deps: {
  fetch: (token: string) => Promise<FetchTodayResult>;
  visit: (token: string, planId: string, placeId: string, planPlaceIds: string[]) => Promise<VisitResult>;
  now?: () => number;
  onUnauthorized?: () => void;
  onError?: (devDetail: string) => void;
}) {
  const now = deps.now ?? Date.now;
  let state: TodayState = INITIAL_TODAY_STATE;
  let inFlight: { token: string; promise: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  const set = (next: TodayState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  function load(token: string | null, options: { force?: boolean } = {}): Promise<void> {
    if (!token) {
      if (state.phase !== 'unauthorized') set({ ...INITIAL_TODAY_STATE, phase: 'unauthorized' });
      return Promise.resolve();
    }
    if (state.token !== token) set({ ...INITIAL_TODAY_STATE, token, phase: 'loading' });
    else if (!options.force && state.fetchedAt !== null && now() - state.fetchedAt < TODAY_STALE_MS && (state.phase === 'ready' || state.phase === 'none')) {
      return Promise.resolve();
    }
    if (inFlight && inFlight.token === token) return inFlight.promise;
    if (state.phase !== 'ready') set({ ...state, phase: 'loading' });
    const promise = deps
      .fetch(token)
      .then((r) => {
        if (state.token !== token) return; // 取得中にセッションが変わった
        if (r.status === 'ok') set({ ...state, phase: 'ready', plan: r.plan, devDetail: null, fetchedAt: now() });
        else if (r.status === 'none') set({ ...state, phase: 'none', plan: null, devDetail: null, fetchedAt: now() });
        else if (r.status === 'unauthorized') {
          set({ ...INITIAL_TODAY_STATE, phase: 'unauthorized' });
          deps.onUnauthorized?.();
        } else {
          deps.onError?.(r.devDetail);
          // 以前のプランがあれば残す（通信エラーで今日のプランを消さない）
          set({ ...state, phase: state.plan ? 'ready' : 'error', devDetail: r.devDetail });
        }
      })
      .catch((e) => {
        deps.onError?.(String(e));
        set({ ...state, phase: state.plan ? 'ready' : 'error', devDetail: String(e) });
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { token, promise };
    return promise;
  }

  async function markVisited(token: string | null, placeId: string): Promise<void> {
    const plan = state.plan;
    if (!token || !plan || state.visiting) return; // 記録中は次を受け付けない
    const stop = plan.stops.find((s) => s.place_id === placeId);
    if (!stop || stop.visited) return;
    const { [placeId]: _cleared, ...otherErrors } = state.visitErrors;
    set({ ...state, visiting: placeId, visitErrors: otherErrors });
    let result: VisitResult;
    try {
      result = await deps.visit(token, plan.plan_id, placeId, plan.stops.map((s) => s.place_id));
    } catch (e) {
      result = { status: 'error', message: '記録できませんでした。通信環境を確認してもう一度お試しください。', devDetail: String(e) };
    }
    const current = state.plan;
    if (!current || current.plan_id !== plan.plan_id) {
      set({ ...state, visiting: null });
      return;
    }
    if (result.status === 'visited' || result.status === 'already_visited') {
      set({ ...state, visiting: null, plan: applyVisitedIds(current, result.visited_place_ids) });
      return;
    }
    deps.onError?.(result.devDetail);
    if (result.status === 'unauthorized') {
      set({ ...INITIAL_TODAY_STATE, phase: 'unauthorized' });
      deps.onUnauthorized?.();
      return;
    }
    set({ ...state, visiting: null, visitErrors: { ...state.visitErrors, [placeId]: result.message } });
    // プランの状態が変わっていた（accepted でなくなった等）場合は取り直す
    if (result.status === 'plan_not_accepted') await load(token, { force: true });
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
    markVisited,
    /** ログアウト・アカウント削除時に前のユーザーの内容を消す */
    reset() {
      set({ ...INITIAL_TODAY_STATE });
    },
    /** 次の load で必ず取り直す（「このプランにする」の直後など） */
    invalidate() {
      if (state.fetchedAt !== null) set({ ...state, fetchedAt: null });
    },
  };
}

export type TodayPlanStore = ReturnType<typeof createTodayPlanStore>;
