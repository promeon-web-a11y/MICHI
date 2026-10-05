/**
 * 各タブの Stack（共有ルート）。ルート詳細・プラン・記録・投稿・設定などはどのタブからでも開け、
 * 開いたタブの中に積まれる（下部メニューは残る・戻るで呼び出し元へ）。
 * 画面の上部（Mikke と地域・戻る）は各画面が描く（参照画面と同じく本文の先頭に「戻る」）。
 */
import { Stack } from 'expo-router';

import { V } from '@/ui/kit';

// ディープリンクで直接詳細を開いた場合も、下にタブの最初の画面を置く
export const unstable_settings = {
  home: { anchor: 'index' },
  feed: { anchor: 'feed' },
  create: { anchor: 'create' },
  saved: { anchor: 'saved' },
  profile: { anchor: 'profile' },
};

export default function TabStackLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: V.paper } }} />;
}
