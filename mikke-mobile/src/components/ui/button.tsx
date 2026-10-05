/**
 * 共通ボタン（本番画面・開発ツールで共有）。
 * - tone: primary（主 CTA。高さ50以上）/ default（補助。高さ44以上）
 * - 高さは touchTargets を正本にし、画面ごとに決めない
 * - 読み込み中表示が必要になったら loading を追加する（今は使う画面がないため入れていない）
 */
import { Pressable, StyleSheet, Text } from 'react-native';

import { radii, touchTargets, typography } from '@/constants/theme';
import { usePalette } from '@/hooks/use-theme';

export type ButtonProps = {
  title: string;
  onPress: () => void;
  tone?: 'default' | 'primary';
  disabled?: boolean;
  /** 未指定なら title を読み上げる */
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export function Button({ title, onPress, tone = 'default', disabled = false, accessibilityLabel, accessibilityHint }: ButtonProps) {
  const c = usePalette();
  const primary = tone === 'primary';
  const background = disabled ? c.disabled : primary ? c.accent : c.accentSoft;
  const pressedBackground = primary ? c.accentPressed : background;
  const color = disabled ? c.textSecondary : primary ? c.onAccent : c.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : null,
        { backgroundColor: pressed && !disabled ? pressedBackground : background, opacity: pressed && !primary ? 0.7 : 1 },
      ]}>
      <Text style={[styles.text, { color }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // flexGrow: 1 は既存の横並びレイアウト（保存一覧のヘッダー等）との互換のため
  button: {
    flexGrow: 1,
    minHeight: touchTargets.minimum,
    minWidth: touchTargets.minimum,
    borderRadius: radii.chip,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { minHeight: touchTargets.primaryButtonHeight },
  text: { fontSize: typography.size.body, fontWeight: '600' },
});
