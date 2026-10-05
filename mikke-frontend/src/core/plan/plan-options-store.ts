/**
 * A/B/C プランの生成状態と選択状態のアプリ内ストア（結果画面・詳細画面で共有）。
 * React に依存しない（Node で単体テスト）。React からは use-plan-options.ts 経由で使う。
 *
 * - 生成中に再度押されても2本目のリクエストは送らない（二重送信防止）
 * - 生成結果は画面を移動しても残る。DB（plans）への保存はサーバー側で済んでいる
 */
import type { PlanConditions } from './plan-conditions';
import type { AcceptResult, PlanGenerationExtra, PlanOptionsErrorKind, PlanOptionsResponse, PlanOptionsResult } from './plan-options-client';

export type PlanOptionsStatus = 'idle' | 'generating' | 'ready' | 'error';

export type PlanSelection =
  | { status: 'none' }
  | { status: 'accepting'; planId: string }
  | { status: 'accepted'; planId: string }
  | { status: 'error'; planId: string; message: string };

export type PlanOptionsState = {
  status: PlanOptionsStatus;
  conditions: PlanConditions | null;
  response: PlanOptionsResponse | null;
  error: { kind: PlanOptionsErrorKind; message: string; retryable: boolean } | null;
  /** 1〜3（既存 plans.generation_sequence の範囲） */
  generationSequence: number;
  selection: PlanSelection;
  /** v3: 公開ルートを元にした提案（候補の場所・元ルート）。null は保存した場所すべて */
  extra: PlanGenerationExtra | null;
};

export const INITIAL_PLAN_OPTIONS_STATE: PlanOptionsState = {
  status: 'idle',
  conditions: null,
  response: null,
  error: null,
  generationSequence: 1,
  selection: { status: 'none' },
  extra: null,
};

export const MAX_GENERATION_SEQUENCE = 3;

export function createPlanOptionsStore(deps: {
  generate: (conditions: PlanConditions, generationSequence: number, extra: PlanGenerationExtra | null) => Promise<PlanOptionsResult>;
  accept: (planId: string) => Promise<AcceptResult>;
  onError?: (devDetail: string) => void;
}) {
  let state: PlanOptionsState = INITIAL_PLAN_OPTIONS_STATE;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: PlanOptionsState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  function run(conditions: PlanConditions, generationSequence: number, extra: PlanGenerationExtra | null): Promise<void> {
    if (inFlight) return inFlight; // 二重送信防止
    set({ ...state, status: 'generating', conditions, error: null, generationSequence, selection: { status: 'none' }, extra });
    const promise = deps
      .generate(conditions, generationSequence, extra)
      .then((result) => {
        if (result.ok) {
          set({ ...state, status: 'ready', response: result.data, error: null });
        } else {
          deps.onError?.(result.devDetail);
          set({
            ...state,
            status: 'error',
            response: null,
            error: { kind: result.kind, message: result.message, retryable: result.retryable },
          });
        }
      })
      .catch((e) => {
        // generate は例外を投げない想定。念のため画面を落とさない
        deps.onError?.(String(e));
        set({
          ...state,
          status: 'error',
          response: null,
          error: { kind: 'invalid_response', message: 'うまくプランを作れませんでした。もう一度お試しください。', retryable: true },
        });
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = promise;
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
    /** 新しい条件で生成（1回目） */
    generate: (conditions: PlanConditions, extra: PlanGenerationExtra | null = null) => run(conditions, 1, extra),
    /** 同じ条件でもう一度（失敗時の再試行） */
    retry: () => (state.conditions ? run(state.conditions, state.generationSequence, state.extra) : Promise.resolve()),
    /** 同じ条件で作り直す（最大3回目まで） */
    regenerate: () =>
      state.conditions && state.generationSequence < MAX_GENERATION_SEQUENCE
        ? run(state.conditions, state.generationSequence + 1, state.extra)
        : Promise.resolve(),
    /** プランを選ぶ。1セットにつき1つ（選択済みなら何もしない） */
    async accept(planId: string): Promise<void> {
      const plans = state.response?.plans ?? [];
      if (!plans.some((p) => p.plan_id === planId)) return;
      if (state.selection.status === 'accepting' || state.selection.status === 'accepted') return;
      set({ ...state, selection: { status: 'accepting', planId } });
      const result = await deps.accept(planId);
      if (state.response?.plans.some((p) => p.plan_id === planId) !== true) return; // 途中で作り直された
      if (result.ok) set({ ...state, selection: { status: 'accepted', planId } });
      else {
        deps.onError?.(result.devDetail);
        set({ ...state, selection: { status: 'error', planId, message: result.message } });
      }
    },
    reset: () => {
      inFlight = null;
      set(INITIAL_PLAN_OPTIONS_STATE);
    },
    /**
     * Web 版のみ: ページの再読み込み後に、前の生成結果を戻す（まだ何もしていないときだけ）。
     * 選択中（accepting）は途中の状態なので、選ぶ前（none）に戻す
     */
    hydrate: (saved: PlanOptionsState) => {
      if (state.status !== 'idle' || inFlight || saved.status !== 'ready' || !saved.response) return;
      set({ ...saved, selection: saved.selection.status === 'accepting' ? { status: 'none' } : saved.selection });
    },
  };
}

export type PlanOptionsStore = ReturnType<typeof createPlanOptionsStore>;
