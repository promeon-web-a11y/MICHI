/**
 * 共有受信の開発確認用UI部品。完成版 Mikke では表示しない。
 */
import { type ReactNode, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { getShareLogEntries, subscribeShareLog, type LogLevel } from './logger';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
      <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>{title}</Text>
      {children}
    </View>
  );
}

export function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  const theme = useTheme();
  const empty = value === null || value === undefined || value === '';
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
      <Text
        selectable
        style={[
          styles.value,
          { color: empty ? theme.textSecondary : theme.text },
          mono && { fontFamily: Fonts?.mono },
        ]}>
        {empty ? '（なし）' : value}
      </Text>
    </View>
  );
}

export function Json({ value }: { value: unknown }) {
  const theme = useTheme();
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <Text selectable style={[styles.json, { color: theme.text, fontFamily: Fonts?.mono }]}>
      {text}
    </Text>
  );
}

export function Messages({ items, level }: { items: string[]; level: 'warn' | 'error' }) {
  if (items.length === 0) return null;
  return (
    <View style={styles.messages}>
      {items.map((message, index) => (
        <Text key={index} selectable style={[styles.message, { color: LEVEL_COLORS[level] }]}>
          {level === 'error' ? '✕ ' : '⚠ '}
          {message}
        </Text>
      ))}
    </View>
  );
}

/** 互換: ボタンの実体は components/ui/button.tsx（本番画面はそちらを直接使う） */
export { Button } from '@/components/ui/button';

export function ShareLogList() {
  const theme = useTheme();
  const entries = useSyncExternalStore(subscribeShareLog, getShareLogEntries, getShareLogEntries);
  if (entries.length === 0) {
    return <Text style={{ color: theme.textSecondary }}>ログはまだありません</Text>;
  }
  return (
    <View style={styles.messages}>
      {entries
        .slice()
        .reverse()
        .map((entry) => (
          <View key={entry.id}>
            <Text selectable style={[styles.message, { color: LEVEL_COLORS[entry.level] ?? theme.text }]}>
              {entry.at.slice(11, 19)} [{entry.level}] {entry.message}
            </Text>
            {entry.detail ? (
              <Text selectable style={[styles.logDetail, { color: theme.textSecondary, fontFamily: Fonts?.mono }]}>
                {entry.detail}
              </Text>
            ) : null}
          </View>
        ))}
    </View>
  );
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: '#208AEF',
  warn: '#C77700',
  error: '#D93025',
};

const styles = StyleSheet.create({
  section: { borderRadius: 12, padding: 12, gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  field: { gap: 2 },
  label: { fontSize: 12 },
  value: { fontSize: 15 },
  json: { fontSize: 11, lineHeight: 15 },
  messages: { gap: 4 },
  message: { fontSize: 13 },
  logDetail: { fontSize: 11, marginLeft: 8 },
});
