/**
 * v3.0 の下部5タブ。各タブは自分の Stack を持つ（(home,feed,create,saved,profile)/_layout.tsx）ので、
 * 詳細画面に進んでも下部メニューは残り、「戻る」でそのタブの元の画面（検索条件・スクロール位置もそのまま）に戻る。
 */
import { Tabs } from 'expo-router';

import { MikkeTabBar } from '@/ui/tab-bar';

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <MikkeTabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="(home)" options={{ title: 'ホーム' }} />
      <Tabs.Screen name="(feed)" options={{ title: 'みつける' }} />
      <Tabs.Screen name="(create)" options={{ title: 'プラン' }} />
      <Tabs.Screen name="(saved)" options={{ title: '保存' }} />
      <Tabs.Screen name="(profile)" options={{ title: 'マイページ' }} />
    </Tabs>
  );
}
