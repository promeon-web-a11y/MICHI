/**
 * A/B/C プランの結果・詳細画面で共有する表示部品。
 */
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PlanPalette } from './plan-theme';

/** 生成中に順番に表示する、Mikke らしい軽いメッセージ */
export const LOADING_MESSAGES = [
  '保存した場所を見ています',
  '行きやすい組み合わせを考えています',
  '3つのプランを作っています',
  'もうすぐできあがります',
];

export function PlanLoading({ c }: { c: PlanPalette }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => Math.min(i + 1, LOADING_MESSAGES.length - 1)), 2200);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <View style={[styles.loadingBubble, { backgroundColor: c.accentSoft }]}>
        <Text style={styles.loadingIcon}>🗺️</Text>
      </View>
      <ActivityIndicator color={c.accent} size="large" />
      <Text style={[styles.loadingText, { color: c.text }]}>{LOADING_MESSAGES[index]}…</Text>
      <Text style={{ color: c.textSecondary }}>数秒〜数十秒かかることがあります</Text>
    </View>
  );
}

export function PlanMessage({
  c,
  icon,
  title,
  body,
  children,
}: {
  c: PlanPalette;
  icon: string;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <Text style={styles.messageIcon}>{icon}</Text>
      <Text style={[styles.messageTitle, { color: c.text }]}>{title}</Text>
      {body ? <Text style={[styles.messageBody, { color: c.textSecondary }]}>{body}</Text> : null}
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

export function PillButton({
  c,
  label,
  onPress,
  primary,
  disabled,
}: {
  c: PlanPalette;
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        primary
          ? { backgroundColor: disabled ? c.disabled : pressed ? c.accentPressed : c.accent, borderColor: 'transparent' }
          : { backgroundColor: c.card, borderColor: c.accent, opacity: pressed ? 0.7 : 1 },
      ]}>
      <Text style={[styles.pillText, { color: primary ? (disabled ? c.textSecondary : c.onAccent) : c.accentStrong }]}>{label}</Text>
    </Pressable>
  );
}

export function VariantBadge({ c, variant, size = 36 }: { c: PlanPalette; variant: string; size?: number }) {
  return (
    <View style={[styles.badge, { backgroundColor: c.accent, width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.badgeText, { color: c.onAccent, fontSize: size * 0.5 }]}>{variant}</Text>
    </View>
  );
}

export function goToConditions() {
  if (router.canGoBack()) router.back();
  else router.replace('/plan');
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 },
  loadingBubble: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  loadingIcon: { fontSize: 40 },
  loadingText: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  messageIcon: { fontSize: 44 },
  messageTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  messageBody: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  actions: { gap: 10, alignSelf: 'stretch', marginTop: 8 },
  pill: { borderRadius: 999, borderWidth: 1.5, paddingVertical: 15, paddingHorizontal: 20, alignItems: 'center' },
  pillText: { fontSize: 16, fontWeight: '800' },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontWeight: '900' },
});
