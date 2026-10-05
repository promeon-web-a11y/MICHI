/**
 * A/B/C プランの生成・選択を画面から使うフック（/plan・/plan/results・/plan/results/[variant] で共有）。
 */
import { useSyncExternalStore } from 'react';

import { backendConfig, getDevSession, registerUserCacheReset, reportUnauthorized } from '@/auth/session-store';
import { isSessionValid } from '@/auth/auth-session';
import { appLog } from '@/lib/logger';
import { invalidateTodayPlan } from '@/today/use-today-plan';

import { acceptPlanOption, callGeneratePlanOptions } from './plan-options-client';
import { createPlanOptionsStore } from './plan-options-store';

const accessToken = () => {
  const session = getDevSession();
  return isSessionValid(session) ? session.accessToken : null;
};

const store = createPlanOptionsStore({
  generate: async (conditions, generationSequence, extra) => {
    const result = await callGeneratePlanOptions(conditions, { config: backendConfig, accessToken: accessToken(), generationSequence, extra });
    if (!result.ok && result.kind === 'unauthorized') void reportUnauthorized();
    // 座標は記録しない
    if (result.ok) appLog.info('プランを生成しました', { plans: result.data.plan_count, candidates: result.data.candidate_count, notice: result.data.notice });
    return result;
  },
  accept: async (planId) => {
    const result = await acceptPlanOption(planId, { config: backendConfig, accessToken: accessToken() });
    if (result.ok) {
      appLog.info('プランを選択しました');
      // 選んだプランが「今日のプラン」になるので、次に開いたとき Supabase から取り直す
      invalidateTodayPlan();
    }
    return result;
  },
  onError: (detail) => appLog.warn('プラン生成/選択でエラー', detail),
});

registerUserCacheReset(store.reset);

export const planOptionsActions = {
  generate: store.generate,
  retry: store.retry,
  regenerate: store.regenerate,
  accept: store.accept,
  reset: store.reset,
  getState: store.getState,
};

export function usePlanOptions() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
