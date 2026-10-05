/**
 * 存在しないパス・不明なディープリンク（mikke://… など）の画面。
 * Expo Router 標準の英語の「Unmatched Route」画面の代わりに表示する。
 */
import { router, Stack } from 'expo-router';

import { AppMessageScreen } from '@/components/app-message-screen';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'ページが見つかりません' }} />
      <AppMessageScreen
        icon="🧭"
        title="ページが見つかりません"
        body="お探しのページは移動したか、存在しない可能性があります。"
        actions={[{ label: 'ホームへ戻る', primary: true, onPress: () => router.replace('/') }]}
      />
    </>
  );
}
