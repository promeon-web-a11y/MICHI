/**
 * 本人のプロフィール（表示名・よく行く地域・投稿の表示・通知）をアプリ全体で共有する。
 * ヘッダーの地域・ホーム・マイページ・設定が同じ値を表示し、保存するとすべてに反映される。
 * 正本は Supabase の public.users（再起動・別端末でも同じ値）。
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';

import { registerUserCacheReset, reportUnauthorized } from '@/auth/session-store';
import { apiOptions, useAccessToken } from '@/lib/use-api-resource';
import { appLog } from '@/lib/logger';

import { fetchProfile, updateProfile, type Profile, type ProfilePatch } from './profile-client';

type State = { token: string | null; profile: Profile | null; phase: 'idle' | 'loading' | 'ready' | 'error'; fetchedAt: number };
const INITIAL: State = { token: null, profile: null, phase: 'idle', fetchedAt: 0 };
let state: State = INITIAL;
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  listeners.forEach((l) => l());
};
registerUserCacheReset(() => set(INITIAL));

const STALE_MS = 5 * 60_000;
let inFlight: Promise<void> | null = null;

function load(token: string | null, force = false): Promise<void> {
  if (!token) {
    if (state.token !== null) set(INITIAL);
    return Promise.resolve();
  }
  if (!force && state.token === token && state.phase === 'ready' && Date.now() - state.fetchedAt < STALE_MS) return Promise.resolve();
  if (inFlight) return inFlight;
  if (state.token !== token) set({ ...INITIAL, token, phase: 'loading' });
  const p = fetchProfile({ ...apiOptions(), accessToken: token })
    .then((r) => {
      if (state.token !== token) return;
      if (r.ok) set({ token, profile: r.data, phase: 'ready', fetchedAt: Date.now() });
      else {
        if (r.kind === 'unauthorized') void reportUnauthorized();
        appLog.warn('プロフィールの取得に失敗', r.devDetail);
        set({ ...state, phase: state.profile ? 'ready' : 'error' });
      }
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = p;
  return p;
}

export function useProfile() {
  const token = useAccessToken();
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => state,
    () => state
  );
  useFocusEffect(
    useCallback(() => {
      void load(token);
    }, [token])
  );
  const visible = s.token === token ? s : INITIAL;
  return { profile: visible.profile, phase: token ? visible.phase : 'idle', reload: () => load(token, true) };
}

/** 保存（失敗したら利用者向けの文言を返す）。成功した値でアプリ全体の表示を更新する */
export async function saveProfile(patch: ProfilePatch): Promise<string | null> {
  const opts = apiOptions();
  const r = await updateProfile(patch, opts);
  if (!r.ok) {
    if (r.kind === 'unauthorized') void reportUnauthorized();
    appLog.warn('プロフィールの保存に失敗', r.devDetail);
    return r.message;
  }
  set({ token: opts.accessToken, profile: r.data, phase: 'ready', fetchedAt: Date.now() });
  return null;
}
