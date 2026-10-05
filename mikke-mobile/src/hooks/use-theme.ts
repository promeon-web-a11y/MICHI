/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, palettes, type AppPalette } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/** v0.2 の配色（constants/theme.ts の palettes）。新しいコードはこちらを使う */
export function usePalette(): AppPalette {
  return useColorScheme() === 'dark' ? palettes.dark : palettes.light;
}

/** 旧 API（テンプレート由来の Colors） */
export function useTheme() {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Colors[theme];
}
