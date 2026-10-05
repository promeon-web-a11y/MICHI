/**
 * 現在地の取得元（Web）。Step 4-3 ではブラウザの Geolocation は使わず「この環境では未対応」とする。
 * （expo-location を Web バンドルに含めず、localhost:8081 の確認環境に影響を与えないため）
 */
import type { LocationProvider } from './current-location-types';

const unsupported = () => Promise.reject(new Error('location is not supported on web in this app'));

export const locationProvider: LocationProvider = {
  isAvailable: () => false,
  getPermission: unsupported,
  requestPermission: unsupported,
  hasServicesEnabled: unsupported,
  getLastKnown: unsupported,
  getCurrent: unsupported,
};
