/**
 * v3.0 設定。アカウント（プロフィール・よく行く地域・ログインとアカウント）とアプリ（通知・投稿の表示・ヘルプ）。
 * 値は public.users に保存され、再起動・別端末でも同じ。
 */
import Constants from 'expo-constants';
import { router } from 'expo-router';

import { useAccessToken } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { useProfile } from '@/profile/use-profile';
import { BackLink, H1, Muted, Screen, SettingsGroup, SettingsList, Tiny } from '@/ui/kit';

const open = (item: string) => router.push({ pathname: '/settings/[item]', params: { item } });

export default function SettingsScreen() {
  const token = useAccessToken();
  const { profile } = useProfile();
  if (!token) return <SavedPlacesUnauthorized description="設定を変えるにはログインしてください。" />;
  return (
    <Screen>
      <BackLink label="マイページ" fallback="/profile" />
      <H1>設定</H1>
      <Muted>Mikkeを使いやすくカスタマイズ</Muted>
      <SettingsGroup>アカウント</SettingsGroup>
      <SettingsList
        items={[
          { label: 'プロフィール', value: profile?.displayName ?? '未設定', onPress: () => open('account') },
          { label: 'よく行く地域', value: profile?.homeArea ?? '未設定', onPress: () => open('area') },
          { label: 'ログイン・アカウント', onPress: () => router.push('/account') },
        ]}
      />
      <SettingsGroup>アプリ</SettingsGroup>
      <SettingsList
        items={[
          { label: '通知', onPress: () => open('notifications') },
          { label: '投稿の表示', value: profile ? (profile.showPostsInFeed ? 'みんなに表示' : '一覧に出さない') : undefined, onPress: () => open('privacy') },
          { label: 'ブロックしたユーザー', onPress: () => open('blocked') },
          { label: 'ヘルプ・使い方', onPress: () => open('help') },
        ]}
      />
      <Tiny style={{ marginTop: 15 }}>Mikke · バージョン {Constants.expoConfig?.version ?? ''}</Tiny>
    </Screen>
  );
}
