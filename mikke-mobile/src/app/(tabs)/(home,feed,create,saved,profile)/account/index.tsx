/**
 * 設定 / アカウント。ログイン中のメールアドレス、ログアウト、アカウント削除への導線。
 * 削除は取り消せないため、画面の一番下に赤い文字で分けて置く（主要な操作とは見た目を変える）。
 */
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AuthForm } from '@/auth/auth-form';
import { PublicPageLinks, PublicPageList } from '@/components/public-page-links';
import { isSessionValid } from '@/auth/auth-session';
import { signOut, useAuthStatus, useDevSession } from '@/auth/session-store';
import { SavedPlacesLoading } from '@/place/saved-place-views';
import { usePlanPalette } from '@/plan/plan-theme';
import { AppHeader, BackLink } from '@/ui/kit';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function AccountScreen() {
  const c = usePlanPalette();
  const session = useDevSession();
  const authStatus = useAuthStatus();

  if (authStatus === 'restoring') return <SavedPlacesLoading label="ログイン状態を確認しています…" />;
  if (!isSessionValid(session)) {
    return (
      <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <BackLink />
        <AuthForm />
        <PublicPageLinks c={c} pages={['terms', 'privacy', 'contact', 'accountDelete']} />
      </ScrollView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.card }}>
    <AppHeader />
    <ScrollView style={{ backgroundColor: c.card }} contentContainerStyle={styles.container}>
      <BackLink />
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.label, { color: c.textSecondary }]}>ログイン中のアカウント</Text>
        <Text style={[styles.value, { color: c.text }]} numberOfLines={1}>
          {session.email ?? '—'}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void signOut();
          router.replace('/');
        }}
        style={({ pressed }) => [styles.row, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}>
        <Text style={[styles.rowText, { color: c.text }]}>ログアウト</Text>
      </Pressable>

      <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Mikkeについて</Text>
      <PublicPageList c={c} pages={['terms', 'privacy', 'contact', 'accountDelete']} />

      <View style={styles.dangerZone}>
        <Pressable
          accessibilityRole="button"
          accessibilityHint="削除の説明と確認の画面に進みます"
          onPress={() => router.push('/account/delete')}
          hitSlop={8}
          style={({ pressed }) => [styles.dangerLink, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[styles.dangerText, { color: c.danger }]}>アカウントを削除</Text>
        </Pressable>
        <Text style={[styles.note, { color: c.textSecondary }]}>保存した場所・プラン・行った記録・投稿（写真を含む）もすべて削除されます。</Text>
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, gap: 14, paddingBottom: 48 },
  card: { borderRadius: 22, borderWidth: 1, padding: 18, gap: 4 },
  label: { fontSize: 13 },
  value: { fontSize: 17, fontWeight: '700' },
  row: { borderRadius: 22, borderWidth: 1, paddingVertical: 16, paddingHorizontal: 18 },
  rowText: { fontSize: 16, fontWeight: '700' },
  sectionTitle: { fontSize: 13, fontWeight: '700', marginTop: 12, marginLeft: 4 },
  dangerZone: { marginTop: 32, alignItems: 'center', gap: 6 },
  dangerLink: { paddingVertical: 8, paddingHorizontal: 12 },
  dangerText: { fontSize: 15, fontWeight: '700', textDecorationLine: 'underline' },
  note: { fontSize: 12 },
});
