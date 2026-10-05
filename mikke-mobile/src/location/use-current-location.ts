/**
 * 現在地を画面から使うフック（/map と次工程の「今日どこ行く？」で共有）。
 *
 * 使い方:
 *   const { location, status, error, locate } = useCurrentLocation();
 *   const result = await locate({ prompt: true }); // 未許可なら権限ダイアログ → 取得
 *   if (result.ok) toPlanOrigin(result.location)   // → { latitude, longitude, accuracy_m, captured_at }
 *
 * React の外（プラン生成の送信処理など）からは getCurrentLocationSnapshot() / locateCurrentLocation() を使う。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { Linking } from 'react-native';

import { registerUserCacheReset } from '@/auth/session-store';
import { appLog } from '@/lib/logger';

import { createCurrentLocationStore, LOCATION_MESSAGES } from './current-location-service';
import type { CurrentLocationState } from './current-location-types';
import { locationProvider } from './location-provider';

const store = createCurrentLocationStore({
  provider: locationProvider,
  // 座標は記録しない（取得元・精度・失敗理由だけ）
  onResult: (summary) => {
    if (summary.ok) appLog.info('現在地を取得しました', { source: summary.source, accuracyM: summary.accuracy === null ? null : Math.round(summary.accuracy ?? 0) });
    else appLog.warn(`現在地を取得できませんでした (${summary.reason})`, summary.devDetail);
  },
});

export const locateCurrentLocation = store.locate;
export const clearCurrentLocation = store.clear;
// ログアウト・アカウント削除時は端末メモリ上の現在地も消す
registerUserCacheReset(store.clear);
export function getCurrentLocationSnapshot(): CurrentLocationState {
  return store.getState();
}

export function useCurrentLocation() {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const locate = useCallback((options: { prompt: boolean; force?: boolean }) => store.locate(options), []);
  return {
    ...state,
    /** 利用者向けの説明（失敗時のみ） */
    message: state.error ? LOCATION_MESSAGES[state.error] : null,
    locate,
    openSettings: () => {
      Linking.openSettings().catch((e) => appLog.warn('設定を開けませんでした', e));
    },
  };
}
