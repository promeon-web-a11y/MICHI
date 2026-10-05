/**
 * 互換レイヤー。配色の正本は constants/theme.ts（palettes）、フックは hooks/use-theme.ts（usePalette）。
 * 既存の plan 画面などが使う名前（usePlanPalette / PlanPalette）をそのまま残している。
 */
export { usePalette as usePlanPalette } from '@/hooks/use-theme';
export type { AppPalette as PlanPalette } from '@/constants/theme';
