/**
 * app.json を土台に、ビルド時の環境変数が必要な設定だけを足す動的設定。
 *
 * GOOGLE_MAPS_ANDROID_API_KEY（Step 4-2 保存マップ）
 * - Android の地図（react-native-maps / Google Maps）に必要な「Maps SDK for Android」用のキー。
 *   AndroidManifest に埋め込まれるため、アプリ内に含まれる前提のキー。サーバー用の GOOGLE_PLACES_API_KEY とは必ず別にし、
 *   Google Cloud でアプリ制限（パッケージ名 com.promeon.mikke + 署名証明書 SHA-1）と API 制限（Maps SDK for Android のみ）をかける。
 * - EXPO_PUBLIC_ ではない（JS のコードからは参照しない）。ローカルは .env.local、EAS Build は EAS の環境変数で渡す。
 *   ただし config plugin の引数として Expo の公開設定（manifest）にも含まれ、APK からも取り出せる。
 *   秘密にはできないキーなので、上記のアプリ制限・API 制限が安全性の前提になる。
 * - 未設定でもビルドは通る。その場合 Android の /map は地図の代わりに代替表示になる（キー無しの Google Maps SDK によるクラッシュを避ける）。
 * - iOS は Apple Maps を使うのでキー不要。
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const androidMapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY?.trim() || null;
  return {
    ...(config as ExpoConfig),
    plugins: [
      ...(config.plugins ?? []),
      ['react-native-maps', androidMapsKey ? { androidGoogleMapsApiKey: androidMapsKey } : {}],
    ],
    extra: {
      ...config.extra,
      // 実行時にキーの有無だけを知るためのフラグ（キーそのものは入れない）
      googleMapsAndroidConfigured: androidMapsKey !== null,
    },
  };
};
