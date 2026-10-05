/**
 * Mikke v0.2 デザイントークンの正本（色・余白・角丸・文字・タップ領域）。
 * 画面・コンポーネントはここを参照し、色コードを直接書かない。
 *
 * - palettes.light が v0.2 Light Theme。dark は v0.2 未定義のため従来の配色を維持している
 * - 旧 API（Colors / Spacing / Fonts / plan-theme の PlanPalette）は互換のため残している
 * - React から使うときは hooks/use-theme.ts の usePalette()
 */

import '@/global.css';

import { Platform } from 'react-native';

// ---------------------------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------------------------

/** v0.2 のブランド色（仕様書の値そのもの） */
export const brand = {
  background: '#FBFAF5',
  paper: '#FFFFFF',
  paperSecondary: '#F5F4ED',
  text: '#252722',
  muted: '#6D7069',
  border: '#E8E7DF',
  // v3 デザイン実装仕様のコーラル（旧 #F47769）
  coral: '#EE6B50',
  orange: '#EFA15F',
  softCoral: '#FDE9E2',
  coralText: '#AD4E45',
} as const;

type PaletteKey =
  | keyof typeof brand
  | 'card'
  | 'textSecondary'
  | 'accent'
  | 'accentStrong'
  | 'accentPressed'
  | 'accentSoft'
  | 'onAccent'
  | 'disabled'
  | 'warningSoft'
  | 'warning'
  | 'danger'
  | 'dangerSoft';

export type AppPalette = Record<PaletteKey, string>;

const light: AppPalette = {
  // v0.2 の名前
  background: brand.background,
  paper: brand.paper,
  paperSecondary: brand.paperSecondary,
  text: brand.text,
  muted: brand.muted,
  border: brand.border,
  coral: brand.coral,
  orange: brand.orange,
  softCoral: brand.softCoral,
  coralText: brand.coralText,
  // 既存画面が使っている役割名（PlanPalette 互換）
  card: brand.paper,
  textSecondary: brand.muted,
  accent: brand.coral,
  /** 淡い背景の上の強調文字・押下中の主ボタン */
  accentStrong: brand.coralText,
  /** 押下中の主ボタンの背景（本文色の文字で 4.5:1 以上を保つため、濃くせず少し明るくする） */
  accentPressed: '#F28A73',
  accentSoft: brand.softCoral,
  /** コーラルの上の文字。白（3.1:1）では小さい文字が読みにくいため本文色（5.0:1） */
  onAccent: '#2B2320',
  disabled: brand.border,
  warningSoft: '#FFF4DE',
  warning: '#9A6A12',
  // 取り消せない操作（アカウント削除）専用。コーラルのアクセントと見分けられる赤
  danger: '#C62828',
  dangerSoft: '#FDECEC',
};

/** v0.2 ではダークテーマ未定義。従来のダーク配色を v0.2 の名前でも引けるようにしている */
const dark: AppPalette = {
  background: '#1C1815',
  paper: '#27211D',
  paperSecondary: '#221D1A',
  text: '#F6EEE7',
  muted: '#B9ABA1',
  border: '#3A302A',
  coral: '#FF8A6B',
  orange: '#EFA15F',
  softCoral: '#3D2A23',
  coralText: '#FF7A59',
  card: '#27211D',
  textSecondary: '#B9ABA1',
  accent: '#FF8A6B',
  accentStrong: '#FF7A59',
  accentPressed: '#FF9E85',
  accentSoft: '#3D2A23',
  onAccent: '#2B2320',
  disabled: '#3A322D',
  warningSoft: '#3A3020',
  warning: '#E8C27A',
  danger: '#FF8A80',
  dangerSoft: '#3A1F1F',
};

export const palettes = { light, dark } as const;

// ---------------------------------------------------------------------------------------------
// Spacing / radius / touch
// ---------------------------------------------------------------------------------------------

/** 余白の基本スケール（4 / 8 / 12 / 16 / 20 / 24 / 32 / 40） */
export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

export const radii = {
  hero: 28,
  largeCard: 24,
  card: 18,
  button: 17,
  chip: 999,
} as const;

export const touchTargets = {
  /** タップできる要素の最小サイズ（高さ・幅） */
  minimum: 44,
  /** 主 CTA の高さ */
  primaryButtonHeight: 50,
} as const;

// ---------------------------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------------------------

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/**
 * 文字。本文・操作はシステムフォント（日本語は OS 既定: iOS ヒラギノ角ゴ / Android Noto Sans CJK）。
 * ヒーロー見出しは明朝系を想定しているが、フォントを同梱するまでは fontFamily を指定しない
 * （heroFamily を差し替えるだけで全画面に反映できるようにしておく）。
 */
export const typography = {
  heroFamily: undefined as string | undefined,
  bodyFamily: undefined as string | undefined,
  weight: { regular: '400', medium: '500' } as const,
  size: {
    hero: 30,
    title: 22,
    sectionTitle: 18,
    body: 15,
    caption: 12,
  },
} as const;

// ---------------------------------------------------------------------------------------------
// 互換（テンプレート由来の旧 API）。新しいコードでは上の token を使う
// ---------------------------------------------------------------------------------------------

export const Colors = {
  light: {
    text: light.text,
    background: light.background,
    backgroundElement: light.paper,
    backgroundSelected: light.accentSoft,
    textSecondary: light.textSecondary,
  },
  dark: {
    text: dark.text,
    background: dark.background,
    backgroundElement: dark.paper,
    backgroundSelected: dark.accentSoft,
    textSecondary: dark.textSecondary,
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
