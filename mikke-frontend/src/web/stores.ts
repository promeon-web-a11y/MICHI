/**
 * 画面をまたいで共有する状態（モバイル版の use-*.ts の Web 版）。
 * ストア本体は src/core（モバイル版と同じ実装）。ここはログイン中のトークンでつなぎ、React から使えるようにするだけ。
 * どのストアもログアウト・別アカウントでのログインで中身を消す（registerUserCacheReset）。
 */
'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { fetchSavedPlaces, markSavedPlacesChanged } from '@/core/place/saved-places-client';
import { createSavedPlacesStore, viewSavedPlaces } from '@/core/place/saved-places-store';
import { createPlanDraftStore } from '@/core/plan/plan-draft-store';
import { acceptPlanOption, callGeneratePlanOptions } from '@/core/plan/plan-options-client';
import { createPlanOptionsStore } from '@/core/plan/plan-options-store';
import { callRoutePlan } from '@/core/plan/plan-route-client';
import { createPlanRouteStore } from '@/core/plan/plan-route-store';
import { fetchProfile, updateProfile, type Profile, type ProfilePatch } from '@/core/profile/profile-client';
import { toggleRouteReaction, type RouteCard } from '@/core/routes/route-posts-client';
import { createRouteSync, optimisticToggle, withOverride, type ReactionOverride } from '@/core/routes/route-sync';
import { backendConfig } from '@/core/services/backend';
import { createSpotSync, toggleSpotReaction, withSpotOverride, type SpotState } from '@/core/spots/spot-sync';
import { setPlaceReaction } from '@/core/spots/spots-client';
import { fetchTodayPlan, recordVisit } from '@/core/today/today-plan-client';
import { createTodayPlanStore } from '@/core/today/today-plan-store';

import { apiOptions, callApi, getAccessToken, registerUserCacheReset, reportUnauthorized, useAccessToken } from './auth';
import { getOriginSnapshot, restoreOrigin } from './location';
import { readSession, writeSession } from './session-persist';

function useStore<S>(store: { subscribe: (l: () => void) => () => void; getState: () => S }): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** 表示したとき・タブに戻ってきたときに呼ぶ（モバイル版の useFocusEffect の代わり） */
function useOnShow(fn: () => void) {
  useEffect(() => {
    fn();
    const onVisible = () => {
      if (document.visibilityState === 'visible') fn();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fn]);
}

// ---------------------------------------------------------------------------------------------
// 保存した場所
// ---------------------------------------------------------------------------------------------
const savedPlaces = createSavedPlacesStore({
  fetch: (accessToken) => fetchSavedPlaces({ config: backendConfig, accessToken }),
  onUnauthorized: () => void reportUnauthorized(),
});
registerUserCacheReset(savedPlaces.reset);

export function useSavedPlaces() {
  const token = useAccessToken();
  const state = useStore(savedPlaces);
  const load = useCallback(() => void savedPlaces.load(token), [token]);
  useOnShow(load);
  const reload = useCallback(() => savedPlaces.load(token, { force: true }), [token]);
  return { view: viewSavedPlaces(state, token), reload };
}

export { markSavedPlacesChanged };

// ---------------------------------------------------------------------------------------------
// プロフィール（表示名・よく行く地域）
// ---------------------------------------------------------------------------------------------
type ProfileState = { token: string | null; profile: Profile | null; phase: 'idle' | 'loading' | 'ready' | 'error'; fetchedAt: number };
const PROFILE_INITIAL: ProfileState = { token: null, profile: null, phase: 'idle', fetchedAt: 0 };
let profileState: ProfileState = PROFILE_INITIAL;
const profileListeners = new Set<() => void>();
const setProfile = (next: ProfileState) => {
  profileState = next;
  profileListeners.forEach((l) => l());
};
const profileStore = {
  getState: () => profileState,
  subscribe(l: () => void) {
    profileListeners.add(l);
    return () => {
      profileListeners.delete(l);
    };
  },
};
registerUserCacheReset(() => setProfile(PROFILE_INITIAL));
let profileInFlight: Promise<void> | null = null;

function loadProfile(token: string | null, force = false): Promise<void> {
  if (!token) {
    if (profileState.token !== null) setProfile(PROFILE_INITIAL);
    return Promise.resolve();
  }
  if (!force && profileState.token === token && profileState.phase === 'ready' && Date.now() - profileState.fetchedAt < 5 * 60_000) return Promise.resolve();
  if (profileInFlight) return profileInFlight;
  if (profileState.token !== token) setProfile({ ...PROFILE_INITIAL, token, phase: 'loading' });
  const p = fetchProfile({ config: backendConfig, accessToken: token })
    .then((r) => {
      if (profileState.token !== token) return;
      if (r.ok) setProfile({ token, profile: r.data, phase: 'ready', fetchedAt: Date.now() });
      else {
        if (r.kind === 'unauthorized') void reportUnauthorized();
        setProfile({ ...profileState, phase: profileState.profile ? 'ready' : 'error' });
      }
    })
    .finally(() => {
      profileInFlight = null;
    });
  profileInFlight = p;
  return p;
}

export function useProfile() {
  const token = useAccessToken();
  const s = useStore(profileStore);
  const load = useCallback(() => void loadProfile(token), [token]);
  useOnShow(load);
  const visible = s.token === token ? s : PROFILE_INITIAL;
  return { profile: visible.profile, phase: token ? visible.phase : 'idle', reload: () => loadProfile(token, true) };
}

/** 保存（失敗したら利用者向けの文言を返す）。成功した値でアプリ全体の表示を更新する */
export async function saveProfile(patch: ProfilePatch): Promise<string | null> {
  const r = await callApi((opts) => updateProfile(patch, opts));
  if (!r.ok) return r.message;
  setProfile({ token: getAccessToken(), profile: r.data, phase: 'ready', fetchedAt: Date.now() });
  return null;
}

// ---------------------------------------------------------------------------------------------
// プランの条件（入力中の下書き）
// ---------------------------------------------------------------------------------------------
const planDraft = createPlanDraftStore();
registerUserCacheReset(planDraft.reset);

export const planDraftActions = {
  setDuration: planDraft.setDuration,
  setBudget: planDraft.setBudget,
  toggleTransport: planDraft.toggleTransport,
  togglePreference: planDraft.togglePreference,
  submit: planDraft.submit,
  clearSubmitted: planDraft.clearSubmitted,
};

export function usePlanDraft() {
  return useStore(planDraft);
}

// ---------------------------------------------------------------------------------------------
// 今日のプラン（採用済みプラン・訪問記録）
// ---------------------------------------------------------------------------------------------
const today = createTodayPlanStore({
  fetch: (token) => fetchTodayPlan({ config: backendConfig, accessToken: token }),
  visit: (token, planId, placeId, planPlaceIds) => recordVisit(planId, placeId, planPlaceIds, { config: backendConfig, accessToken: token }),
  onUnauthorized: () => void reportUnauthorized(),
});
registerUserCacheReset(today.reset);

/** プランを選んだ直後などに呼ぶ。次に画面を開いたとき取り直す */
export const invalidateTodayPlan = today.invalidate;

export function useTodayPlan() {
  const token = useAccessToken();
  const state = useStore(today);
  const load = useCallback(() => void today.load(token), [token]);
  useOnShow(load);
  const view = !token
    ? { ...state, phase: 'unauthorized' as const, plan: null }
    : state.token !== token
      ? { ...state, phase: 'loading' as const, plan: null }
      : state;
  return {
    state: view,
    reload: () => today.load(token, { force: true }),
    markVisited: (placeId: string) => today.markVisited(token, placeId),
  };
}

// ---------------------------------------------------------------------------------------------
// A/B/C プランの生成・選択（generate-plan-options / accept_plan）
// ---------------------------------------------------------------------------------------------
const planOptions = createPlanOptionsStore({
  generate: async (conditions, generationSequence, extra) => {
    const run = () => callGeneratePlanOptions(conditions, { ...apiOptions(), generationSequence, extra });
    let result = await run();
    if (!result.ok && result.kind === 'unauthorized' && getAccessToken() && (await reportUnauthorized())) result = await run();
    return result;
  },
  accept: async (planId) => {
    const run = () => acceptPlanOption(planId, apiOptions());
    let result = await run();
    if (!result.ok && result.kind === 'unauthorized' && (await reportUnauthorized())) result = await run();
    if (result.ok) invalidateTodayPlan();
    return result;
  },
});
registerUserCacheReset(planOptions.reset);

export const planOptionsActions = {
  generate: planOptions.generate,
  retry: planOptions.retry,
  regenerate: planOptions.regenerate,
  accept: planOptions.accept,
  getState: planOptions.getState,
};

export function usePlanOptions() {
  return useStore(planOptions);
}

// 再読み込み後も提案を見られるように、このタブの sessionStorage に保存しておく（本人の分だけ戻す）
const PLAN_OPTIONS_KEY = 'mikke:plan-options';
type SavedPlanOptions = { userId: string; state: ReturnType<typeof planOptions.getState> };
let persistUserId: string | null = null;
planOptions.subscribe(() => {
  const st = planOptions.getState();
  if (!persistUserId) return;
  writeSession(PLAN_OPTIONS_KEY, st.status === 'ready' && st.response ? ({ userId: persistUserId, state: st } satisfies SavedPlanOptions) : null);
});
registerUserCacheReset(() => writeSession(PLAN_OPTIONS_KEY, null));

/** ログイン状態が分かったときに1回呼ぶ（画面の表示後。サーバーの HTML とずれないように） */
export function restoreSessionState(userId: string | null) {
  persistUserId = userId;
  if (!userId) return;
  const saved = readSession<SavedPlanOptions>(PLAN_OPTIONS_KEY);
  if (saved && saved.userId === userId) planOptions.hydrate(saved.state);
  restoreOrigin();
}

// ---------------------------------------------------------------------------------------------
// 選んだプランの実ルート（route-plan / Google Routes）
// ---------------------------------------------------------------------------------------------
const planRoutes = createPlanRouteStore({
  fetch: async (planId, origin) => {
    const run = () => callRoutePlan(planId, origin, apiOptions());
    let result = await run();
    if (!result.ok && result.kind === 'unauthorized' && (await reportUnauthorized())) result = await run();
    return result;
  },
});
registerUserCacheReset(planRoutes.reset);

/** ルート計算に使う出発地点（選んだ出発地 → プラン作成時の出発地の順）。無ければ null */
export function routeOrigin(): { latitude: number; longitude: number } | null {
  const chosen = getOriginSnapshot().location;
  if (chosen) return { latitude: chosen.latitude, longitude: chosen.longitude };
  const submitted = planDraft.getState().submitted?.origin;
  return submitted ? { latitude: submitted.latitude, longitude: submitted.longitude } : null;
}

export const planRouteActions = {
  load: (planId: string, options: { force?: boolean } = {}) => {
    const origin = routeOrigin();
    if (!origin) return Promise.resolve(false);
    return planRoutes.load(planId, origin, options).then(() => true);
  },
};

export function usePlanRoutes() {
  return useStore(planRoutes);
}

// ---------------------------------------------------------------------------------------------
// みんなのルート: 画面をまたいだ いいね・保存の反映、一覧の世代、検索条件
// ---------------------------------------------------------------------------------------------
export const routeSync = createRouteSync();
registerUserCacheReset(routeSync.reset);

export function useRouteSync() {
  return useStore(routeSync);
}

export function useCardsWithOverrides<T extends RouteCard>(cards: T[] | null): T[] {
  const { overrides } = useRouteSync();
  return (cards ?? []).map((c) => withOverride(c, overrides));
}

const pendingReactions = new Set<string>();

/** いいね / 保存 を切り替える。すぐに表示を変え、サーバーの件数で確定する。失敗したら元に戻す */
export async function toggleReaction(card: ReactionOverride & { id: string }, kind: 'like' | 'wish'): Promise<string | null> {
  const key = `${card.id}:${kind}`;
  if (pendingReactions.has(key)) return null;
  pendingReactions.add(key);
  const before: ReactionOverride = { liked: card.liked, likeCount: card.likeCount, wished: card.wished, wishCount: card.wishCount };
  routeSync.setReaction(card.id, optimisticToggle(before, kind));
  try {
    const target = kind === 'like' ? !before.liked : !before.wished;
    const r = await callApi((opts) => toggleRouteReaction(card.id, kind, opts, target));
    if (!r.ok) {
      routeSync.setReaction(card.id, before);
      return r.message;
    }
    const current = routeSync.getState().overrides[card.id] ?? before;
    routeSync.setReaction(card.id, {
      ...current,
      likeCount: r.data.likeCount,
      wishCount: r.data.wishCount,
      ...(kind === 'like' ? { liked: r.data.active } : { wished: r.data.active }),
    });
    if (kind === 'wish') routeSync.bump('wishes');
    return null;
  } finally {
    pendingReactions.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// お店・スポット: いいね / 行きたい（行きたい = 保存した場所）
// ---------------------------------------------------------------------------------------------
export const spotSync = createSpotSync();
registerUserCacheReset(spotSync.reset);

export function useSpotSync() {
  return useStore(spotSync);
}

export function useSpotState<T extends Partial<SpotState>>(item: T, placeId: string | null | undefined): T & { pendingLike: boolean; pendingWish: boolean } {
  const s = useSpotSync();
  const merged = withSpotOverride(item, placeId, s.overrides);
  return { ...merged, pendingLike: !!(placeId && s.pending[`${placeId}:like`]), pendingWish: !!(placeId && s.pending[`${placeId}:wish`]) };
}

export function useSpotList<T extends SpotState & { id: string }>(items: T[] | null): T[] {
  const s = useSpotSync();
  return (items ?? []).map((i) => withSpotOverride(i, i.id, s.overrides));
}

export async function toggleSpot(placeId: string, kind: 'like' | 'wish', current: SpotState): Promise<string | null> {
  return toggleSpotReaction(spotSync, placeId, kind, current, async (active) => {
    const r = await callApi((opts) => setPlaceReaction(placeId, kind, active, opts));
    if (r.ok && kind === 'wish') markSavedPlacesChanged();
    return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message };
  });
}
