/**
 * 保存Place一覧を画面から使うためのフック（/saved と /map で共有）。
 * 画面フォーカス時に store.load() を呼ぶが、新しい結果があれば通信しない（saved-places-store.ts）。
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';

import { appLog } from '@/lib/logger';

import { backendConfig, registerUserCacheReset, reportUnauthorized, useDevSession } from '@/auth/session-store';
import { isSessionValid } from '@/auth/auth-session';
import { fetchSavedPlaces } from './saved-places-client';
import { createSavedPlacesStore, viewSavedPlaces } from './saved-places-store';

const store = createSavedPlacesStore({
  fetch: (accessToken) => fetchSavedPlaces({ config: backendConfig, accessToken }),
  onUnauthorized: (detail) => {
    appLog.warn('保存一覧: 認証エラー', detail);
    void reportUnauthorized();
  },
  onError: (detail) => appLog.error('保存一覧の取得に失敗', detail),
});

registerUserCacheReset(store.reset);

export function useSavedPlaces() {
  const session = useDevSession();
  const accessToken = isSessionValid(session) ? session.accessToken : null;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  // ログイン直後は accessToken が変わるので、フォーカス中でも再実行される
  useFocusEffect(
    useCallback(() => {
      store.load(accessToken);
    }, [accessToken])
  );

  const reload = useCallback(() => store.load(accessToken, { force: true }), [accessToken]);

  return { view: viewSavedPlaces(state, accessToken), reload };
}
