/**
 * 保存Placeの表示部品（/saved と /map で共有）。最終デザインではなく土台。
 */
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { AuthForm } from '@/auth/auth-form';
import { Button } from '@/components/ui/button';
import { palettes } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { appLog } from '@/lib/logger';

import { useAuthStatus } from '@/auth/session-store';
import { formatSavedAt, LOAD_ERROR_MESSAGE, type SavedPlaceItem } from './saved-places-client';

export function SavedPlaceCard({ item, style }: { item: SavedPlaceItem; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();

  const openSource = async () => {
    if (!item.sourceUrl) return;
    try {
      // Instagram / TikTok の URL は対応アプリがあればアプリで開く
      await Linking.openURL(item.sourceUrl);
    } catch (e) {
      appLog.warn('リンクを開けませんでした', e);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }, style]}>
      <View style={styles.cardTop}>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={2}>
          {item.name}
        </Text>
        <View style={[styles.chip, { backgroundColor: theme.backgroundSelected }]}>
          <Text style={[styles.chipText, { color: theme.text }]}>{item.categoryLabel}</Text>
        </View>
      </View>
      <Text style={{ color: theme.textSecondary }} numberOfLines={2}>
        {item.address ?? '住所情報なし'}
      </Text>
      <View style={styles.cardBottom}>
        <Text style={[styles.meta, { color: theme.textSecondary }]}>
          {formatSavedAt(item.savedAt)} 保存{item.sourcePlatformLabel ? ` ・ ${item.sourcePlatformLabel}` : ''}
        </Text>
        {item.sourceUrl ? (
          <Pressable onPress={openSource} hitSlop={8} accessibilityRole="link">
            {({ pressed }) => (
              <Text style={[styles.link, { opacity: pressed ? 0.6 : 1 }]}>{item.sourceLinkLabel}</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function SavedPlacesUnauthorized({ description }: { description: string }) {
  const theme = useTheme();
  const authStatus = useAuthStatus();
  // 起動直後は保存済みのログインを確認中（ログイン画面を一瞬出さない）
  if (authStatus === 'restoring') return <SavedPlacesLoading label="ログイン状態を確認しています…" />;
  return (
    <ScrollView style={[styles.flex, { backgroundColor: theme.background }]} contentContainerStyle={styles.authContent} keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, { color: theme.text }]}>ログインが必要です</Text>
      <Text style={{ color: theme.textSecondary, textAlign: 'center' }}>{description}</Text>
      <View style={styles.signIn}>
        <AuthForm />
      </View>
    </ScrollView>
  );
}

export function SavedPlacesLoading({ label = '読み込み中…' }: { label?: string } = {}) {
  const theme = useTheme();
  return (
    <View style={[styles.flex, styles.center, { backgroundColor: theme.background }]} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={palettes.light.accent} />
      <Text style={{ color: theme.textSecondary }}>{label}</Text>
    </View>
  );
}

export function SavedPlacesError({ devDetail, onRetry }: { devDetail: string | null; onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.flex, styles.center, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>{LOAD_ERROR_MESSAGE}</Text>
      <Text style={{ color: theme.textSecondary }}>通信環境を確認して、もう一度お試しください。</Text>
      <Button title="再読み込み" tone="primary" onPress={onRetry} />
      {__DEV__ && devDetail ? (
        <Text selectable style={[styles.devDetail, { color: theme.textSecondary }]}>
          {devDetail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  signIn: { alignSelf: 'stretch' },
  authContent: { flexGrow: 1, justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  devDetail: { fontSize: 11, textAlign: 'center' },
  card: { borderRadius: 14, padding: 14, gap: 6 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  name: { flex: 1, fontSize: 17, fontWeight: '700' },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '600' },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  meta: { fontSize: 12 },
  link: { fontSize: 13, fontWeight: '700', color: palettes.light.accentStrong },
});
