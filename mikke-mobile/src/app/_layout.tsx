import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState, Text, useColorScheme } from 'react-native';

import { authOnForeground, restoreAuth } from '@/auth/session-store';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AppMessageScreen } from '@/components/app-message-screen';
import { palettes, type AppPalette } from '@/constants/theme';
import { appLog } from '@/lib/logger';

SplashScreen.preventAutoHideAsync();

// ヘッダー・画面背景も Mikke の配色（constants/theme.ts の palettes）に揃える
const navColors = (p: AppPalette) => ({
  primary: p.accentStrong,
  background: p.background,
  card: p.background,
  text: p.text,
  border: p.border,
});
const LightTheme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, ...navColors(palettes.light) } };
const MikkeDarkTheme = { ...DarkTheme, colors: { ...DarkTheme.colors, ...navColors(palettes.dark) } };

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // 保存済みのログインを復元し、前面に戻った時はトークンの期限を確認して更新する
  useEffect(() => {
    void restoreAuth();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void authOnForeground();
    });
    return () => sub.remove();
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? MikkeDarkTheme : LightTheme}>
      <AnimatedSplashOverlay />
      <Stack>
        {/* v3.0: 下部5タブ（ホーム / みんな / ＋プラン / 保存 / マイページ）。ルート詳細・プラン・記録・設定はタブの中に積む */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Mikke' }} />
        {/* 共有受信・地図・アカウント削除は従来どおり全画面で開く */}
        <Stack.Screen name="handle-share" options={{ title: 'Mikke に保存' }} />
        <Stack.Screen name="map" options={{ title: '保存マップ' }} />
        <Stack.Screen name="plan/results/[variant]/map" options={{ title: 'ルートマップ' }} />
        <Stack.Screen name="today/map" options={{ title: '今日のプランの地図' }} />
        <Stack.Screen name="account/delete" options={{ title: 'アカウントを削除' }} />
      </Stack>
    </ThemeProvider>
  );
}

/**
 * アプリ全体のエラー画面（子の画面で想定外の例外が起きたとき）。
 * 利用者には技術的な内容を表示しない（開発ビルドでだけ原因を表示する）。
 * この画面の表示中は Stack が外れているため、ホームへの移動は失敗しても再試行で復帰できるようにする。
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    appLog.error('想定外のエラー', error);
  }, [error]);

  const goHome = () => {
    try {
      router.replace('/');
    } catch {
      // ナビゲーションの準備ができていない場合は再試行だけ行う
    }
    void retry();
  };

  return (
    <AppMessageScreen
      icon="⚠️"
      title="問題が発生しました"
      body="もう一度お試しください。"
      actions={[
        { label: 'もう一度試す', primary: true, onPress: () => void retry() },
        { label: 'ホームへ戻る', onPress: goHome },
      ]}>
      {__DEV__ ? (
        <Text selectable style={{ color: palettes.light.textSecondary, fontSize: 11, textAlign: 'center' }}>
          {error.name}: {error.message}
        </Text>
      ) : null}
    </AppMessageScreen>
  );
}
