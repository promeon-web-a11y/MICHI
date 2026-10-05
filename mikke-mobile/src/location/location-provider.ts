/**
 * 現在地の取得元（iOS / Android）: expo-location。
 * Web では location-provider.web.ts が代わりに読み込まれる。
 *
 * expo-location は import した時点でネイティブモジュール（ExpoLocation）を必須とするため静的 import しない。
 * expo-location を含まない古い Development Build でもアプリが落ちないよう、ネイティブ側がある場合だけ遅延 require する。
 */
import { requireOptionalNativeModule } from 'expo';

import type { LocationPermission, LocationProvider, RawPosition } from './current-location-types';

type ExpoLocationModule = typeof import('expo-location');
let cached: ExpoLocationModule | null | undefined;

function loadExpoLocation(): ExpoLocationModule | null {
  if (cached !== undefined) return cached;
  try {
    if (!requireOptionalNativeModule('ExpoLocation')) {
      cached = null;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('expo-location') as ExpoLocationModule;
    }
  } catch {
    cached = null;
  }
  return cached;
}

function required(): ExpoLocationModule {
  const mod = loadExpoLocation();
  if (!mod) throw new Error('expo-location is not available in this build');
  return mod;
}

const toPermission = (p: { granted: boolean; canAskAgain: boolean }): LocationPermission => ({
  granted: p.granted,
  canAskAgain: p.canAskAgain,
});

export const locationProvider: LocationProvider = {
  isAvailable: () => loadExpoLocation() !== null,
  // アプリ使用中（foreground）の権限だけを扱う。バックグラウンド権限は要求しない
  getPermission: async () => toPermission(await required().getForegroundPermissionsAsync()),
  requestPermission: async () => toPermission(await required().requestForegroundPermissionsAsync()),
  hasServicesEnabled: () => required().hasServicesEnabledAsync(),
  getLastKnown: async ({ maxAgeMs, requiredAccuracyM }) =>
    (await required().getLastKnownPositionAsync({ maxAge: maxAgeMs, requiredAccuracy: requiredAccuracyM })) as RawPosition | null,
  getCurrent: async () => {
    const Location = required();
    // Balanced: 街区レベルの精度。お出かけプランの出発地には十分で、高精度GPSを常時要求しない
    return (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })) as RawPosition;
  },
};
