/**
 * アプリ全体のエラー画面・「ページが見つかりません」画面の共通レイアウト。
 * Expo Router 標準の英語画面や開発者向け画面を一般ユーザーに見せないために使う。
 * 技術的な内容（エラーメッセージ・stack trace 等）は受け取らない・表示しない。
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palettes } from '@/constants/theme';

// ルートのエラー画面でも確実に表示できるよう、フックを使わずライトの配色を固定で使う
const COLORS = palettes.light;

export type MessageAction = { label: string; onPress: () => void; primary?: boolean };

export function AppMessageScreen({ icon, title, body, actions, children }: {
  icon: string;
  title: string;
  body?: string;
  actions: MessageAction[];
  children?: ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">
          {icon}
        </Text>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
        <View style={styles.actions}>
          {actions.map((a) => (
            <Pressable
              key={a.label}
              accessibilityRole="button"
              onPress={a.onPress}
              style={({ pressed }) => [
                styles.button,
                a.primary ? { backgroundColor: COLORS.accent } : { backgroundColor: COLORS.card, borderColor: COLORS.border, borderWidth: 1 },
                { opacity: pressed ? 0.8 : 1 },
              ]}>
              <Text style={[styles.buttonText, { color: a.primary ? COLORS.onAccent : COLORS.text }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28 },
  icon: { fontSize: 44 },
  title: { fontSize: 20, fontWeight: '800', color: COLORS.text, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 22, color: COLORS.textSecondary, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 8 },
  button: { minHeight: 52, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  buttonText: { fontSize: 16, fontWeight: '800' },
});
