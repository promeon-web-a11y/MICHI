/**
 * 公開ページ（利用規約など）へのリンク。アプリ内ブラウザ（expo-web-browser）で開く。
 * アプリ内ブラウザを開けない場合は、端末のブラウザで開く。
 */
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { PUBLIC_PAGES, publicPageUrl, type PublicPageKey } from '@/constants/public-pages';
import type { PlanPalette } from '@/plan/plan-theme';
import { appLog } from '@/lib/logger';

export async function openPublicPage(key: PublicPageKey): Promise<void> {
  const url = publicPageUrl(key);
  try {
    if (process.env.EXPO_OS === 'web') {
      await Linking.openURL(url);
      return;
    }
    await openBrowserAsync(url, { presentationStyle: WebBrowserPresentationStyle.AUTOMATIC });
  } catch (e) {
    appLog.warn('アプリ内ブラウザで開けませんでした', e);
    await Linking.openURL(url).catch((err) => appLog.warn('ページを開けませんでした', err));
  }
}

/** 画面下部の小さなリンク列 */
export function PublicPageLinks({ c, pages }: { c: PlanPalette; pages: readonly PublicPageKey[] }) {
  return (
    <View style={styles.row} accessibilityLabel="サービス情報">
      {pages.map((key) => (
        <Pressable key={key} accessibilityRole="link" hitSlop={6} onPress={() => void openPublicPage(key)} style={styles.link}>
          {({ pressed }) => (
            <Text style={[styles.linkText, { color: c.textSecondary, opacity: pressed ? 0.6 : 1 }]}>{PUBLIC_PAGES[key].label}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

/** 設定画面用の一覧（1行ずつ） */
export function PublicPageList({ c, pages }: { c: PlanPalette; pages: readonly PublicPageKey[] }) {
  return (
    <View style={[styles.list, { backgroundColor: c.card, borderColor: c.border }]}>
      {pages.map((key, i) => (
        <Pressable
          key={key}
          accessibilityRole="link"
          accessibilityHint="Webページを開きます"
          onPress={() => void openPublicPage(key)}
          style={({ pressed }) => [styles.item, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[styles.itemText, { color: c.text }]}>{PUBLIC_PAGES[key].label}</Text>
          <Text style={{ color: c.textSecondary }}>›</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 16, rowGap: 4, paddingVertical: 8 },
  link: { paddingVertical: 6 },
  linkText: { fontSize: 12, textDecorationLine: 'underline' },
  list: { borderRadius: 22, borderWidth: 1, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 18, minHeight: 52 },
  itemText: { fontSize: 15, fontWeight: '600' },
});
