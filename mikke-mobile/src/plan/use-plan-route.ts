/**
 * 選択したプランの実ルートを画面から使うフック。
 * 出発地点は「新しい現在地」→ なければ「プラン作成時の現在地（PlanConditions.origin）」の順に使う。
 */
import { useSyncExternalStore } from 'react';

import { LOCATION_REUSE_MS } from '@/location/current-location-service';
import { getCurrentLocationSnapshot } from '@/location/use-current-location';
import { backendConfig, getDevSession, registerUserCacheReset, reportUnauthorized } from '@/auth/session-store';
import { isSessionValid } from '@/auth/auth-session';
import { appLog } from '@/lib/logger';

import { callRoutePlan } from './plan-route-client';
import { createPlanRouteStore } from './plan-route-store';
import { getSubmittedPlanConditions } from './use-plan-draft';

const store = createPlanRouteStore({
  fetch: async (planId, origin) => {
    const session = getDevSession();
    const result = await callRoutePlan(planId, origin, {
      config: backendConfig,
      accessToken: isSessionValid(session) ? session.accessToken : null,
    });
    if (!result.ok && result.kind === 'unauthorized') void reportUnauthorized();
    // 座標は記録しない
    if (result.ok) {
      appLog.info('ルートを取得しました', {
        legs: result.data.legs.map((l) => l.mode ?? l.failure_reason),
        fit: result.data.fit_status,
        fares: result.data.fares.status,
      });
    }
    return result;
  },
  onError: (detail) => appLog.warn('ルート取得でエラー', detail),
});

/** ルート計算に使う出発地点。無ければ null */
export function routeOrigin(): { latitude: number; longitude: number } | null {
  const current = getCurrentLocationSnapshot().location;
  if (current && Date.now() - current.timestamp <= LOCATION_REUSE_MS) {
    return { latitude: current.latitude, longitude: current.longitude };
  }
  const origin = getSubmittedPlanConditions()?.origin;
  if (origin) return { latitude: origin.latitude, longitude: origin.longitude };
  return current ? { latitude: current.latitude, longitude: current.longitude } : null;
}

registerUserCacheReset(store.reset);

export const planRouteActions = {
  load: (planId: string, options: { force?: boolean } = {}) => {
    const origin = routeOrigin();
    if (!origin) return Promise.resolve(false);
    return store.load(planId, origin, options).then(() => true);
  },
};

export function usePlanRoutes() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
