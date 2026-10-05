/**
 * 保存Place一覧の共有ストア（/saved と /map で同じ取得結果を使う）。
 * React に依存しない（Node で単体テストするため）。React からは use-saved-places.ts 経由で使う。
 *
 * - 取得は fetchSavedPlaces（ユーザー JWT + RLS。user_id は指定しない）
 * - 画面間を移動しても、変更が無く新しいうちは再取得しない（shouldRefetchSavedPlaces）
 * - 同じトークンでの同時取得は1本にまとめる
 * - ログインユーザーが変わったら前のユーザーの一覧は即座に破棄する
 */
import {
  getSavedPlacesChangeVersion,
  shouldRefetchSavedPlaces,
  type FetchSavedPlacesResult,
  type SavedPlaceItem,
} from './saved-places-client';

export type SavedPlacesPhase = 'idle' | 'loading' | 'ready' | 'error' | 'unauthorized';

export type SavedPlacesState = {
  /** この状態を取得したセッション */
  token: string | null;
  phase: SavedPlacesPhase;
  items: SavedPlaceItem[];
  devDetail: string | null;
  refreshing: boolean;
  fetchedAt: number | null;
  fetchedVersion: number;
};

export type SavedPlacesStoreDeps = {
  fetch: (accessToken: string) => Promise<FetchSavedPlacesResult>;
  now?: () => number;
  getVersion?: () => number;
  onUnauthorized?: (devDetail: string) => void;
  onError?: (devDetail: string) => void;
};

export const INITIAL_SAVED_PLACES_STATE: SavedPlacesState = {
  token: null,
  phase: 'idle',
  items: [],
  devDetail: null,
  refreshing: false,
  fetchedAt: null,
  fetchedVersion: 0,
};

export function createSavedPlacesStore(deps: SavedPlacesStoreDeps) {
  const now = deps.now ?? Date.now;
  const getVersion = deps.getVersion ?? getSavedPlacesChangeVersion;
  let state: SavedPlacesState = INITIAL_SAVED_PLACES_STATE;
  let inFlight: { token: string; promise: Promise<void> } | null = null;
  const listeners = new Set<() => void>();

  const set = (next: SavedPlacesState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  /**
   * @param force true: 手動の再読み込み（新しさに関係なく取得）
   */
  function load(accessToken: string | null, options: { force?: boolean } = {}): Promise<void> {
    if (!accessToken) {
      if (state.phase !== 'unauthorized' || state.items.length > 0) {
        set({ ...INITIAL_SAVED_PLACES_STATE, phase: 'unauthorized' });
      }
      return Promise.resolve();
    }
    if (state.token !== accessToken) {
      // 別セッション（ログインし直し・別ユーザー）の結果は持ち越さない
      set({ ...INITIAL_SAVED_PLACES_STATE, token: accessToken, phase: 'loading' });
    } else if (
      !options.force &&
      state.phase === 'ready' &&
      !shouldRefetchSavedPlaces({
        lastFetchedAt: state.fetchedAt,
        fetchedVersion: state.fetchedVersion,
        currentVersion: getVersion(),
        now: now(),
      })
    ) {
      return Promise.resolve();
    }
    if (inFlight && inFlight.token === accessToken) return inFlight.promise;

    const version = getVersion();
    set({
      ...state,
      phase: state.phase === 'ready' ? 'ready' : 'loading',
      refreshing: state.phase === 'ready' && !!options.force,
    });

    const promise = (async () => {
      let res: FetchSavedPlacesResult;
      try {
        res = await deps.fetch(accessToken);
      } catch (e) {
        // fetchSavedPlaces は例外を投げない想定。念のため
        res = { status: 'error', message: '', devDetail: String(e) };
      }
      if (state.token !== accessToken) return; // 取得中にセッションが変わった
      if (res.status === 'ok') {
        set({ ...state, phase: 'ready', items: res.items, devDetail: null, refreshing: false, fetchedAt: now(), fetchedVersion: version });
      } else if (res.status === 'unauthorized') {
        set({ ...INITIAL_SAVED_PLACES_STATE, phase: 'unauthorized', devDetail: res.devDetail });
        deps.onUnauthorized?.(res.devDetail);
      } else {
        set({ ...state, phase: 'error', devDetail: res.devDetail, refreshing: false });
        deps.onError?.(res.devDetail);
      }
    })().finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { token: accessToken, promise };
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
    /** ログアウト・アカウント削除時（とテスト） */
    reset() {
      inFlight = null;
      set(INITIAL_SAVED_PLACES_STATE);
    },
  };
}

export type SavedPlacesStore = ReturnType<typeof createSavedPlacesStore>;

/** 画面に見せる状態。ログインしていない・別セッションの結果は見せない */
export function viewSavedPlaces(state: SavedPlacesState, accessToken: string | null): SavedPlacesState {
  if (!accessToken) return { ...INITIAL_SAVED_PLACES_STATE, phase: 'unauthorized' };
  if (state.token !== accessToken) return { ...INITIAL_SAVED_PLACES_STATE, token: accessToken, phase: 'loading' };
  if (state.phase === 'idle') return { ...state, phase: 'loading' };
  return state;
}
