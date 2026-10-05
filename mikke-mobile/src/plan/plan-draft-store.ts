/**
 * 「今日どこ行く？」の入力中の条件と、確定した PlanConditions を保持するアプリ内ストア。
 * 画面を離れても（地図や一覧を見に行って戻っても）選んだ条件が消えないようにする。DB には保存しない。
 * React に依存しない（Node で単体テスト）。React からは use-plan-draft.ts 経由で使う。
 */
import {
  DEFAULT_PLAN_DRAFT,
  sanitizeDraft,
  setBudget,
  setDuration,
  togglePreference,
  toggleTransport,
  type PlanConditions,
  type PlanDraft,
} from './plan-conditions';

export type PlanDraftState = {
  draft: PlanDraft;
  /** 最後に「この条件でプランをつくる」で確定した条件（Step 4-5 が受け取る） */
  submitted: PlanConditions | null;
};

export function createPlanDraftStore(initial: PlanDraft = DEFAULT_PLAN_DRAFT) {
  let state: PlanDraftState = { draft: sanitizeDraft(initial), submitted: null };
  const listeners = new Set<() => void>();
  const set = (next: PlanDraftState) => {
    if (next.draft === state.draft && next.submitted === state.submitted) return;
    state = next;
    listeners.forEach((listener) => listener());
  };
  const update = (fn: (d: PlanDraft) => PlanDraft) => {
    const draft = fn(state.draft);
    if (draft === state.draft) return; // 不正な値・解除できない操作は何もしない
    // 条件を変えたら確定済みの条件は古くなるので破棄する
    set({ draft, submitted: null });
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDuration: (minutes: unknown) => update((d) => setDuration(d, minutes)),
    setBudget: (yen: unknown) => update((d) => setBudget(d, yen)),
    toggleTransport: (mode: unknown) => update((d) => toggleTransport(d, mode)),
    togglePreference: (pref: unknown) => update((d) => togglePreference(d, pref)),
    submit: (conditions: PlanConditions) => set({ ...state, submitted: conditions }),
    /** 条件を変えたら確定済みの条件は古くなるので破棄する */
    clearSubmitted: () => set({ ...state, submitted: null }),
    reset: () => set({ draft: sanitizeDraft(DEFAULT_PLAN_DRAFT), submitted: null }),
  };
}

export type PlanDraftStore = ReturnType<typeof createPlanDraftStore>;
