/**
 * react-native-maps の読み込み（iOS / Android 専用。Web のファイルからは import しない）。
 * 保存マップ（Step 4-2）とプラン地図（Step 4-7）で共有する。
 *
 * react-native-maps は import した時点でネイティブモジュール（RNMapsAirModule）を必須とするため静的 import しない。
 * react-native-maps を含まない Development Build では全ルートの読み込みでアプリが落ちてしまうので、
 * ネイティブ側がある場合だけ遅延 require する。
 */
import Constants from 'expo-constants';
import { Platform, TurboModuleRegistry } from 'react-native';

export type MapsModule = typeof import('react-native-maps');
let mapsModule: MapsModule | null | undefined;

/** ネイティブ側に react-native-maps が含まれていれば読み込む。無ければ null */
export function loadMaps(): MapsModule | null {
  if (mapsModule !== undefined) return mapsModule;
  try {
    if (!TurboModuleRegistry.get('RNMapsAirModule')) {
      mapsModule = null;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mapsModule = require('react-native-maps') as MapsModule;
    }
  } catch {
    mapsModule = null;
  }
  return mapsModule;
}

/** Android の Google Maps は Maps SDK のキーが無いと落ちるため、キーを入れてビルドしたかを確認する */
export function isAndroidMapsConfigured(): boolean {
  if (Platform.OS !== 'android') return true;
  return Constants.expoConfig?.extra?.googleMapsAndroidConfigured === true;
}

// 利用者には技術的な理由を出さない（開発ビルドでだけ原因を表示する）
const MAPS_UNAVAILABLE_FOR_USER = 'この端末では地図を表示できません。下の一覧から場所を確認できます。';
export const MAPS_MISSING_REASON = __DEV__
  ? 'このアプリのビルドには地図機能（react-native-maps）が含まれていません。Development Build を作り直してください。'
  : MAPS_UNAVAILABLE_FOR_USER;
export const ANDROID_KEY_MISSING_REASON = __DEV__
  ? 'Android の地図表示には Google Maps（Maps SDK for Android）の API キー設定が必要です。GOOGLE_MAPS_ANDROID_API_KEY を設定して Development Build を作り直してください。'
  : MAPS_UNAVAILABLE_FOR_USER;
