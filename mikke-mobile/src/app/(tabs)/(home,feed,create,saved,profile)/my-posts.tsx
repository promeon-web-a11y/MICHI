/**
 * v3.0 自分の投稿（公開した一日の記録）。2列のカード → 詳細。戻ると元の画面へ。
 * 開いたとき（アプリの起動ごとに1回）、どの投稿からも使われていない自分の写真を片付ける。
 */
import { router } from 'expo-router';
import { useEffect } from 'react';

import { apiOptions, useAccessToken, useApiResource } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { cleanupRoutePhotos, listMyRoutePosts } from '@/routes/route-posts-client';
import { RouteGrid } from '@/routes/route-views';
import { useCardsWithOverrides, useRouteSync } from '@/routes/use-route-sync';
import { BackLink, ErrorState, H1, Loading, Muted, Notice, SecondaryButton, Screen } from '@/ui/kit';

let sweptFor: string | null = null;

export default function MyPostsScreen() {
  const token = useAccessToken();
  useEffect(() => {
    if (!token || sweptFor === token) return;
    sweptFor = token;
    void cleanupRoutePhotos(null, apiOptions());
  }, [token]);
  const { versions } = useRouteSync();
  const posts = useApiResource('my-posts', listMyRoutePosts, { version: versions.myPosts });
  const cards = useCardsWithOverrides(posts.data).filter((c) => c.visibility === 'public');
  if (posts.phase === 'unauthorized') return <SavedPlacesUnauthorized description="自分の投稿を見るにはログインしてください。" />;
  const drafts = (posts.data ?? []).length - cards.length;
  return (
    <Screen>
      <BackLink label="戻る" fallback="/profile" />
      <H1>自分の投稿</H1>
      <Muted style={{ marginBottom: 17 }}>投稿した一日の記録を確認できます。</Muted>
      {posts.phase === 'loading' || posts.phase === 'idle' ? (
        <Loading />
      ) : !posts.data ? (
        <ErrorState message={posts.message} onRetry={posts.reload} />
      ) : cards.length > 0 ? (
        <RouteGrid cards={cards} />
      ) : (
        <Notice>まだ投稿がありません。お出かけを記録して、保存一覧の「行った記録」から投稿すると、ここに表示されます。</Notice>
      )}
      {drafts > 0 ? (
        <SecondaryButton
          label={`非公開の記録 ${drafts}件を見る →`}
          style={{ marginTop: 18 }}
          onPress={() => router.navigate({ pathname: '/saved', params: { tab: 'records' } })}
        />
      ) : null}
      <SecondaryButton label="ルートを作る →" style={{ marginTop: 12 }} onPress={() => router.navigate('/create')} />
    </Screen>
  );
}
