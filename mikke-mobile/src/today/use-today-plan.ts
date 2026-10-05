/**
 * 「今日のプラン」を画面から使うフック（ホームのカードと /today で共有）。
 * 画面に戻るたびに Supabase から取得し直す（60秒以内なら通信しない）。アプリ再起動後も復元できる。
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';

import { backendConfig, registerUserCacheReset, reportUnauthorized, useDevSession } from '@/auth/session-store';
import { isSessionValid } from '@/auth/auth-session';
import { appLog } from '@/lib/logger';

import { fetchTodayPlan, recordVisit } from './today-plan-client';
import { createTodayPlanStore } from './today-plan-store';

const store = createTodayPlanStore({
  fetch: (token) => fetchTodayPlan({ config: backendConfig, accessToken: token }),
  visit: async (token, planId, placeId, planPlaceIds) => {
    const r = await recordVisit(planId, placeId, planPlaceIds, { config: backendConfig, accessToken: token });
    if (r.status === 'visited') appLog.info('訪問を記録しました', { visited: r.visited_place_ids.length, of: planPlaceIds.length });
    return r;
  },
  onUnauthorized: () => void reportUnauthorized(),
  onError: (detail) => appLog.warn('今日のプラン: エラー', detail),
});

/** プランを選んだ直後などに呼ぶ。次に画面を開いたとき Supabase から取り直す */
export const invalidateTodayPlan = store.invalidate;
registerUserCacheReset(store.reset);

export function useTodayPlan() {
  const session = useDevSession();
  const token = isSessionValid(session) ? session.accessToken : null;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useFocusEffect(
    useCallback(() => {
      store.load(token);
    }, [token])
  );

  const view = !token ? { ...state, phase: 'unauthorized' as const, plan: null } : state.token !== token ? { ...state, phase: 'loading' as const, plan: null } : state;
  return {
    state: view,
    reload: () => store.load(token, { force: true }),
    markVisited: (placeId: string) => store.markVisited(token, placeId),
  };
}
