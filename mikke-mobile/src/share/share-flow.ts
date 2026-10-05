/**
 * 共有 → 場所の特定 → 保存 の流れ（一般ユーザー向け）。React Native に依存しない（Node で単体テストする）。
 *
 *   confirmed        → そのまま自動保存
 *   needs_review     → 候補を表示し、ユーザーが選んだときだけ保存（自動保存しない）
 *   not_found / insufficient_information → 保存しない（理由を表示）
 *   ログイン切れ     → need_login。ログイン後に止まった手順（特定 or 保存）から再開する
 *
 * 1つの共有につき特定は1回だけ自動実行する（API コスト・二重保存の防止）。処理中の操作は無視する。
 */
import type {
  IdentifyCallResult,
  IdentifyPlaceRequest,
  IdentifyPlaceResponse,
  PlaceResult,
} from '../place/identify-place-client';
import type { SavePlaceRequest, SaveResult } from '../place/save-place-client';
import { buildSaveRequest } from '../place/save-place-client';

export type PlaceSummary = { googlePlaceId: string; name: string; address: string | null };

export type ShareFlowState =
  | { phase: 'waiting' }
  | { phase: 'identifying' }
  | { phase: 'saving'; place: PlaceSummary }
  | { phase: 'needs_review'; candidates: PlaceSummary[] }
  | { phase: 'saved'; place: PlaceSummary; alreadySaved: boolean }
  | { phase: 'skipped' }
  | { phase: 'no_place'; title: string; body: string }
  | { phase: 'need_login' }
  | { phase: 'failed'; title: string; body: string };

export type ShareFlowDeps = {
  identify: (request: IdentifyPlaceRequest) => Promise<IdentifyCallResult>;
  save: (request: SavePlaceRequest) => Promise<SaveResult>;
  /** 保存に成功した（保存一覧の再読み込みに使う） */
  onSaved?: () => void;
  /** サーバーがログイン切れを返した（トークン更新を試みる） */
  onUnauthorized?: () => void;
  /** 開発ログ用。トークン等は渡さない */
  onDevEvent?: (message: string, detail?: unknown) => void;
};

export const MAX_REVIEW_CANDIDATES = 5;
/** ログイン後の自動再開の上限（サーバーが認証を拒否し続けた場合の無限ループ防止） */
export const MAX_LOGIN_RESUMES = 2;

export const SHARE_MESSAGES = {
  noInput: { title: '場所の手がかりがありません', body: '共有された内容に URL や文章が含まれていませんでした。投稿の「共有」からもう一度お試しください。' },
  insufficient: { title: '場所を特定できませんでした', body: 'この投稿には、お店や場所を特定できる情報が見つかりませんでした。' },
  notFound: { title: '場所が見つかりませんでした', body: '投稿から読み取った名前に一致する場所が見つかりませんでした。' },
  identifyError: { title: '場所を調べられませんでした', body: '時間をおいて、もう一度お試しください。' },
  saveError: { title: '保存できませんでした', body: '通信環境を確認して、もう一度お試しください。' },
} as const;

export function toPlaceSummary(place: PlaceResult): PlaceSummary {
  return { googlePlaceId: place.google_place_id, name: place.name, address: place.formatted_address };
}

export type ShareFlow = ReturnType<typeof createShareFlow>;

export function createShareFlow(deps: ShareFlowDeps) {
  let state: ShareFlowState = { phase: 'waiting' };
  const listeners = new Set<() => void>();
  let request: IdentifyPlaceRequest | null = null;
  let started = false;
  let identifyResult: IdentifyPlaceResponse | null = null;
  /** ログイン切れ・失敗のときに再開する手順 */
  let resumeStep: 'identify' | { save: SavePlaceRequest; place: PlaceSummary } | null = null;
  let loginResumes = 0;
  let busy = false;

  const set = (next: ShareFlowState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  const dev = (message: string, detail?: unknown) => deps.onDevEvent?.(message, detail);

  async function runIdentify() {
    if (!request) return;
    busy = true;
    resumeStep = 'identify';
    set({ phase: 'identifying' });
    let res: IdentifyCallResult;
    try {
      res = await deps.identify(request);
    } catch (e) {
      res = { ok: false, kind: 'network', httpStatus: null, userMessage: SHARE_MESSAGES.identifyError.body, devDetail: String(e) };
    } finally {
      busy = false;
    }

    if (!res.ok) {
      dev('場所の特定に失敗', { kind: res.kind, detail: res.devDetail });
      if (res.kind === 'auth') {
        set({ phase: 'need_login' });
        deps.onUnauthorized?.();
        return;
      }
      set({ phase: 'failed', title: SHARE_MESSAGES.identifyError.title, body: res.userMessage });
      return;
    }

    const data = res.data;
    identifyResult = data;
    dev('場所の特定結果', { status: data.status, reason: data.reason, candidates: data.candidates.length });
    switch (data.status) {
      case 'confirmed': {
        const save = buildSaveRequest(data, request);
        if (!save || !data.place) {
          set({ phase: 'failed', ...SHARE_MESSAGES.identifyError });
          return;
        }
        await runSave(save, toPlaceSummary(data.place));
        return;
      }
      case 'needs_review': {
        const candidates = data.candidates.slice(0, MAX_REVIEW_CANDIDATES).map(toPlaceSummary);
        if (candidates.length === 0) {
          resumeStep = null;
          set({ phase: 'no_place', ...SHARE_MESSAGES.notFound });
          return;
        }
        resumeStep = null;
        set({ phase: 'needs_review', candidates });
        return;
      }
      case 'not_found':
        resumeStep = null;
        set({ phase: 'no_place', ...SHARE_MESSAGES.notFound });
        return;
      case 'insufficient_information':
        resumeStep = null;
        set({ phase: 'no_place', ...SHARE_MESSAGES.insufficient });
        return;
      default:
        set({ phase: 'failed', ...SHARE_MESSAGES.identifyError });
    }
  }

  async function runSave(save: SavePlaceRequest, place: PlaceSummary) {
    busy = true;
    resumeStep = { save, place };
    set({ phase: 'saving', place });
    let res: SaveResult;
    try {
      res = await deps.save(save);
    } catch (e) {
      res = { status: 'error', message: '', httpStatus: null, data: null, devDetail: String(e) };
    } finally {
      busy = false;
    }
    dev('保存結果', { status: res.status, detail: res.devDetail });
    if (res.status === 'saved' || res.status === 'already_saved') {
      resumeStep = null;
      deps.onSaved?.();
      set({ phase: 'saved', place, alreadySaved: res.status === 'already_saved' });
      return;
    }
    if (res.status === 'unauthorized') {
      set({ phase: 'need_login' });
      deps.onUnauthorized?.();
      return;
    }
    set({ phase: 'failed', ...SHARE_MESSAGES.saveError });
  }

  function resume() {
    if (resumeStep === 'identify') return runIdentify();
    if (resumeStep) return runSave(resumeStep.save, resumeStep.place);
    return Promise.resolve();
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** 共有内容の特定を開始する。1つの flow につき1回だけ（2回目以降は無視） */
    start(next: IdentifyPlaceRequest | null): Promise<void> {
      if (started) return Promise.resolve();
      started = true;
      request = next;
      if (!next) {
        set({ phase: 'no_place', ...SHARE_MESSAGES.noInput });
        return Promise.resolve();
      }
      return runIdentify();
    },
    /** needs_review の候補を選んで保存する */
    choose(googlePlaceId: string): Promise<void> {
      if (busy || state.phase !== 'needs_review' || !identifyResult) return Promise.resolve();
      const save = buildSaveRequest(identifyResult, request, googlePlaceId);
      const candidate = state.candidates.find((c) => c.googlePlaceId === googlePlaceId);
      if (!save || !candidate) return Promise.resolve();
      return runSave(save, candidate);
    },
    /** 候補を保存しない */
    skip() {
      if (busy || state.phase !== 'needs_review') return;
      set({ phase: 'skipped' });
    },
    /** 失敗した手順をやり直す */
    retry(): Promise<void> {
      if (busy || state.phase !== 'failed') return Promise.resolve();
      return resume();
    },
    /** ログインできたら、止まった手順から再開する（上限あり） */
    resumeAfterLogin(): Promise<void> {
      if (busy || state.phase !== 'need_login') return Promise.resolve();
      if (loginResumes >= MAX_LOGIN_RESUMES) {
        set({ phase: 'failed', ...SHARE_MESSAGES.identifyError });
        return Promise.resolve();
      }
      loginResumes += 1;
      return resume();
    },
  };
}

/** 処理が終わった（共有データを端末から消してよい）状態か */
export function isShareFlowFinished(state: ShareFlowState): boolean {
  return state.phase === 'saved' || state.phase === 'skipped' || state.phase === 'no_place';
}
