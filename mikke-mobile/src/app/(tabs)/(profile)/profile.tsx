/**
 * v3.0 マイページ。プロフィール・今月のルート生成・あなたの記録・設定/ヘルプ。
 * 生成回数はサーバー（get_plan_generation_usage）の実数。無料枠の上限は未確定のため、
 * 上限が決まるまでは「残り◯回」を表示せず、今月の利用回数だけを表示する（固定の数字を出さない）。
 */
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AuthForm } from '@/auth/auth-form';
import { useAuthStatus, useDevSession } from '@/auth/session-store';
import { useAccessToken, useApiResource } from '@/lib/use-api-resource';
import { useSavedPlaces } from '@/place/use-saved-places';
import { fetchGenerationUsage } from '@/profile/profile-client';
import { useProfile } from '@/profile/use-profile';
import { listMyRoutePosts } from '@/routes/route-posts-client';
import { useRouteSync } from '@/routes/use-route-sync';
import { Avatar, H1, H2, Loading, Muted, Screen, SettingsGroup, SettingsList, Tiny, V } from '@/ui/kit';

export default function ProfileScreen() {
  const token = useAccessToken();
  const authStatus = useAuthStatus();
  if (authStatus === 'restoring') return <Screen><Loading label="ログイン状態を確認しています…" /></Screen>;
  if (!token) {
    return (
      <Screen>
        <H1>マイページ</H1>
        <Muted style={{ marginBottom: 12 }}>ログインすると、保存した場所・行った記録・自分の投稿を見られます。</Muted>
        <AuthForm />
      </Screen>
    );
  }
  return <SignedIn />;
}

function SignedIn() {
  const session = useDevSession();
  const { profile } = useProfile();
  const { versions } = useRouteSync();
  const usage = useApiResource('usage', fetchGenerationUsage, { staleMs: 15_000 });
  const posts = useApiResource('my-posts', listMyRoutePosts, { version: versions.myPosts });
  const { view: saved } = useSavedPlaces();
  const name = profile?.displayName ?? 'Mikke ユーザー';
  const records = posts.data ?? null;
  const published = records?.filter((p) => p.visibility === 'public').length ?? null;
  const count = (n: number | null) => (n === null ? '' : `${n}件`);

  return (
    <Screen>
      <H1>マイページ</H1>
      <View style={styles.hero}>
        <Avatar name={name} size={54} />
        <View style={{ flex: 1 }}>
          <H2>{name}</H2>
          <Muted>{[profile?.homeArea ?? 'よく行く地域は未設定', session?.email].filter(Boolean).join(' · ')}</Muted>
        </View>
      </View>

      <View style={styles.quota} accessibilityRole="summary">
        <Text style={styles.quotaLabel}>今月の無料ルート生成</Text>
        {usage.phase === 'ready' && usage.data ? (
          usage.data.remaining !== null ? (
            <View style={styles.quotaMain}>
              <Text style={styles.quotaText}>残り</Text>
              <Text style={styles.quotaNumber}>{usage.data.remaining}</Text>
              <Text style={styles.quotaText}>回（今月 {usage.data.used} 回利用）</Text>
            </View>
          ) : (
            <>
              <View style={styles.quotaMain}>
                <Text style={styles.quotaText}>今月</Text>
                <Text style={styles.quotaNumber}>{usage.data.used}</Text>
                <Text style={styles.quotaText}>回 利用</Text>
              </View>
              <Tiny>無料で使える回数の上限は準備中です。決まり次第、ここに残り回数を表示します。</Tiny>
            </>
          )
        ) : usage.phase === 'error' ? (
          <Tiny style={{ marginVertical: 8 }}>{usage.message ?? '利用回数を読み込めませんでした。'}</Tiny>
        ) : (
          <Tiny style={{ marginVertical: 8 }}>読み込み中…</Tiny>
        )}
        <Text style={styles.quotaButton} accessibilityRole="button" onPress={() => router.navigate('/create')}>
          ルートを作る →
        </Text>
      </View>

      <SettingsGroup>あなたの記録</SettingsGroup>
      <SettingsList
        items={[
          { label: '保存した場所', value: count(saved.phase === 'ready' ? saved.items.length : null), onPress: () => router.navigate({ pathname: '/saved', params: { tab: 'places' } }) },
          { label: '行った記録', value: count(records ? records.length : null), onPress: () => router.navigate({ pathname: '/saved', params: { tab: 'records' } }) },
          { label: '自分の投稿', value: count(published), onPress: () => router.push('/my-posts') },
        ]}
      />
      <SettingsGroup>アカウントとアプリ</SettingsGroup>
      <SettingsList
        items={[
          { label: '設定', onPress: () => router.push('/settings') },
          { label: 'ヘルプ・使い方', onPress: () => router.push({ pathname: '/settings/[item]', params: { item: 'help' } }) },
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 14, borderRadius: 16, backgroundColor: V.soft, marginTop: 13 },
  quota: { marginTop: 20, marginBottom: 5, paddingVertical: 19, paddingHorizontal: 20, borderRadius: 19, backgroundColor: '#FEF0E8', borderWidth: 1, borderColor: '#F6D8CD' },
  quotaLabel: { fontSize: 13, fontWeight: '800', color: V.deep },
  quotaMain: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4, marginBottom: 1 },
  quotaText: { fontSize: 13, color: V.ink },
  quotaNumber: { fontSize: 42, lineHeight: 48, color: V.deep, fontWeight: '800' },
  quotaButton: { marginTop: 10, alignSelf: 'flex-start', overflow: 'hidden', borderRadius: 10, backgroundColor: V.white, color: V.deep, fontSize: 12, fontWeight: '800', paddingHorizontal: 12, paddingVertical: 9 },
});
