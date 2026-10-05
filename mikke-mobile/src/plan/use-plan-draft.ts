/**
 * 「今日どこ行く？」の条件を画面から使うフック。アプリ内で1つのストアを共有する（画面遷移で消えない）。
 * Step 4-5 からは getSubmittedPlanConditions() で確定済みの条件を受け取れる。
 */
import { useSyncExternalStore } from 'react';

import { registerUserCacheReset } from '@/auth/session-store';

import { createPlanDraftStore } from './plan-draft-store';

const store = createPlanDraftStore();

// 条件の下書きには出発地（現在地）も入るため、ログアウト・削除時に消す
registerUserCacheReset(store.reset);

export const planDraftActions = {
  setDuration: store.setDuration,
  setBudget: store.setBudget,
  toggleTransport: store.toggleTransport,
  togglePreference: store.togglePreference,
  submit: store.submit,
  clearSubmitted: store.clearSubmitted,
  reset: store.reset,
};

export function usePlanDraft() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** 確定済みの PlanConditions（未確定なら null） */
export function getSubmittedPlanConditions() {
  return store.getState().submitted;
}
