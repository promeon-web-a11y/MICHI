/**
 * 保存（2026-09-29 のデザイン参照 saved）。「場所」「ルート」「いいね」「行った」を切り替える（タブを移動しても選択は保持）。
 * - 場所: 保存した場所（saved_places）。SNS から保存した場所と、お店・スポットやルートの立ち寄りで「行きたい」を押した場所
 * - ルート: みんなのルートで「保存」したルート（route_wishes）と、自分が選んだ（採用した）プラン
 * - いいね: お店・スポットで「いいね」を押した場所（place_likes）。行きたい とは別の状態
 * - 行った: 自分の行った記録・投稿（非公開 → 投稿、公開中 → 見る）
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApiResource } from '@/lib/use-api-resource';
import { appLog } from '@/lib/logger';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { formatSavedAt } from '@/place/saved-places-client';
import { useSavedPlaces } from '@/place/use-saved-places';
import { dateText } from '@/routes/route-format';
import { listMyRoutePosts, listMyRouteWishes } from '@/routes/route-posts-client';
import { openRoute, RouteGrid } from '@/routes/route-views';
import { routeSync, useCardsWithOverrides, useRouteSync } from '@/routes/use-route-sync';
import { openSpot, SpotGrid } from '@/spots/spot-views';
import { listMyPlaceLikes } from '@/spots/spots-client';
import { useSpotList, useSpotSync } from '@/spots/use-spot-sync';
import { apiFail, type ApiResult } from '@/services/rest';
import { fetchAcceptedPlans, type AcceptedPlanSummary } from '@/today/today-plan-client';
import { ErrorState, ListRow, Loading, Notice, PrimaryButton, Screen, SecondaryButton, TextButton, Toast, V } from '@/ui/kit';

type SavedTab = 'places' | 'routes' | 'likes' | 'records';
const TABS: { value: SavedTab; label: string }[] = [
  { value: 'places', label: '場所' },
  { value: 'routes', label: 'ルート' },
  { value: 'likes', label: 'いいね' },
  { value: 'records', label: '行った' },
];
// 以前のリンク（?tab=wishes）は「ルート」に読み替える
const TAB_ALIASES: Record<string, SavedTab> = { wishes: 'routes' };

export default function SavedScreen() {
  const params = useLocalSearchParams<{ tab?: string; notice?: string }>();
  const [tab, setTab] = useState<SavedTab>('places');
  const [toast, setToast] = useState<string | null>(null);
  const [handled, setHandled] = useState<string | null>(null);

  // 記録の保存後などに ?tab= で開かれたら、その一覧に切り替える（同じ指定は1回だけ反映）
  const request = params.tab || params.notice ? `${params.tab ?? ''}|${params.notice ?? ''}` : null;
  if (request !== handled) {
    setHandled(request);
    const wanted = params.tab ? (TAB_ALIASES[params.tab] ?? params.tab) : null;
    if (wanted && TABS.some((t) => t.value === wanted)) setTab(wanted as SavedTab);
    if (params.notice === 'recorded') setToast('非公開の記録として保存しました');
    if (params.notice === 'place') setToast('行きたい場所に追加しました');
  }
  useEffect(() => {
    if (request) router.setParams({ tab: undefined, notice: undefined });
  }, [request]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2700);
    return () => clearTimeout(t);
  }, [toast]);

  const { view: saved, reload } = useSavedPlaces();
  if (saved.phase === 'unauthorized') return <SavedPlacesUnauthorized description="保存一覧を見るにはログインしてください。" />;

  return (
    <Screen refreshControl={tab === 'places' ? <RefreshControl refreshing={saved.refreshing} onRefresh={reload} tintColor={V.coral} /> : undefined}>
      <View style={styles.intro}>
        <Text style={styles.h1} accessibilityRole="header">
          行きたいを、ここに。
        </Text>
        <Text style={styles.sub}>お店とルートを、次のお出かけにつなげよう。</Text>
      </View>
      <Toast message={toast} />
      <View style={styles.tabline} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable
            key={t.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.value }}
            onPress={() => setTab(t.value)}
            style={[styles.tab, tab === t.value ? styles.tabOn : null]}>
            <Text style={[styles.tabText, tab === t.value ? styles.tabTextOn : null]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'places' ? <PlacesList /> : tab === 'routes' ? <RoutesList onMessage={setToast} /> : tab === 'likes' ? <LikesList onMessage={setToast} /> : <RecordsList />}
    </Screen>
  );
}

function openSpotsTab() {
  routeSync.setDiscoverType('spots');
  router.navigate('/feed');
}

function PlacesList() {
  const { view, reload } = useSavedPlaces();
  if (view.phase === 'loading' || view.phase === 'idle') return <Loading label="保存した場所を読み込んでいます…" />;
  if (view.phase === 'error') return <ErrorState message="保存した場所を読み込めませんでした。" onRetry={reload} />;
  return (
    <>
      {view.items.length === 0 ? (
        <Notice>まだ保存した場所がありません。SNS で見つけた場所を保存したり、お店・スポットで「行きたい」を押したりすると、ここに並びます。</Notice>
      ) : (
        <>
          <View style={styles.listHead}>
            <Text style={styles.count}>行きたい場所 {view.items.length}件</Text>
            <TextButton label="地図で見る →" onPress={() => router.push('/map')} />
          </View>
          {view.items.map((item) => (
            <ListRow
              key={item.savedPlaceId}
              title={item.name}
              sub={`${item.categoryLabel} · ${formatSavedAt(item.savedAt)} 保存${item.sourcePlatformLabel ? ` · ${item.sourcePlatformLabel}` : ''}`}
              action="見る"
              onPress={() => (item.placeId ? openSpot(item.placeId) : router.push({ pathname: '/plan', params: { source: 'saved' } }))}
              footer={
                item.sourceUrl && /^https?:/i.test(item.sourceUrl) ? (
                  <View style={styles.sourceLink}>
                    <TextButton
                      label={item.sourceLinkLabel ?? '元の投稿を見る'}
                      color={V.sub}
                      onPress={() => void Linking.openURL(item.sourceUrl!).catch((e) => appLog.warn('リンクを開けませんでした', e))}
                    />
                  </View>
                ) : null
              }
            />
          ))}
        </>
      )}
      <Pressable accessibilityRole="button" onPress={() => router.push('/add-place')} style={({ pressed }) => [styles.addLink, { opacity: pressed ? 0.75 : 1 }]}>
        <Text style={styles.addLinkText}>＋ SNSのリンクから場所を保存</Text>
      </Pressable>
      <SecondaryButton label="お店・スポットを探す →" onPress={openSpotsTab} style={{ marginTop: 10 }} />
      {view.items.length > 0 ? (
        <PrimaryButton label="保存した場所でルートをつくる →" onPress={() => router.push({ pathname: '/plan', params: { source: 'saved' } })} style={{ marginTop: 10 }} />
      ) : null}
    </>
  );
}

function RoutesList({ onMessage }: { onMessage: (m: string) => void }) {
  const { versions } = useRouteSync();
  const wishes = useApiResource('my-wishes', listMyRouteWishes, { version: versions.wishes });
  const cards = useCardsWithOverrides(wishes.data).filter((c) => c.wished);
  const plans = useApiResource('accepted-plans', async (opts): Promise<ApiResult<AcceptedPlanSummary[]>> => {
    const r = await fetchAcceptedPlans(opts);
    if (r.status === 'ok') return { ok: true, data: r.plans };
    return apiFail(r.status === 'unauthorized' ? 'unauthorized' : 'server', r.devDetail, r.message);
  });
  return (
    <>
      <Text style={styles.groupTitle}>保存したルート</Text>
      {wishes.phase === 'loading' || wishes.phase === 'idle' ? (
        <Loading />
      ) : !wishes.data ? (
        <ErrorState message={wishes.message} onRetry={wishes.reload} />
      ) : cards.length === 0 ? (
        <Notice>まだルートを保存していません。みんなのルートで ♡ を押すと、ここに並びます。</Notice>
      ) : (
        <RouteGrid cards={cards} onReactionError={onMessage} />
      )}
      <SecondaryButton label="ほかのルートも探す →" onPress={() => router.navigate('/feed')} style={{ marginTop: 16 }} />

      <Text style={styles.groupTitle}>選んだプラン</Text>
      {plans.phase === 'loading' || plans.phase === 'idle' ? (
        <Loading />
      ) : !plans.data ? (
        <ErrorState message={plans.message} onRetry={plans.reload} />
      ) : plans.data.length === 0 ? (
        <Notice>まだ選んだプランがありません。＋プランから提案を選ぶと、ここに残ります。</Notice>
      ) : (
        plans.data.map((p) => (
          <ListRow
            key={p.plan_id}
            title={p.title}
            sub={`${dateText(p.accepted_at)} · ${p.source === 'mobile_route_copy' ? 'みんなのルートから' : '選んだプラン'} · 非公開`}
            action="見る"
            onPress={() => router.push({ pathname: '/plans/[id]', params: { id: p.plan_id } })}
          />
        ))
      )}
    </>
  );
}

function LikesList({ onMessage }: { onMessage: (m: string) => void }) {
  const { versions } = useSpotSync();
  const likes = useApiResource('my-place-likes', listMyPlaceLikes, { version: versions.likes });
  // 保存一覧を開いたまま いいね を外したら、その場で消す
  const spots = useSpotList(likes.data).filter((s) => s.liked);
  if (likes.phase === 'loading' || likes.phase === 'idle') return <Loading />;
  if (!likes.data) return <ErrorState message={likes.message} onRetry={likes.reload} />;
  if (spots.length === 0) {
    return (
      <>
        <Notice>いいねしたお店・スポットはまだありません。</Notice>
        <SecondaryButton label="お店・スポットを探す →" onPress={openSpotsTab} style={{ marginTop: 14 }} />
      </>
    );
  }
  return (
    <>
      <Text style={[styles.count, { marginBottom: 12 }]}>いいねしたお店・スポット {spots.length}件</Text>
      <SpotGrid spots={spots} onMessage={onMessage} />
    </>
  );
}

function RecordsList() {
  const { versions } = useRouteSync();
  const posts = useApiResource('my-posts', listMyRoutePosts, { version: versions.myPosts });
  const cards = useCardsWithOverrides(posts.data);
  if (posts.phase === 'loading' || posts.phase === 'idle') return <Loading />;
  if (!posts.data) return <ErrorState message={posts.message} onRetry={posts.reload} />;
  if (cards.length === 0) return <Notice>行った記録はまだありません。ルートでお出かけしたら、今日のルートの「お出かけを記録」から残せます。</Notice>;
  return (
    <>
      {cards.map((c) => (
        <ListRow
          key={c.id}
          title={c.title}
          sub={`${c.stopNames.length}か所 · ${c.visibility === 'public' ? 'みんなに公開中' : '非公開'}${c.visitedOn ? ` · ${dateText(c.visitedOn)}` : ''}`}
          action={c.visibility === 'public' ? '見る' : '投稿'}
          onPress={() => (c.visibility === 'public' ? openRoute(c.id) : router.push({ pathname: '/compose/[id]', params: { id: c.id } }))}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 8, marginBottom: 14 },
  h1: { fontSize: 22, lineHeight: 30, fontWeight: '800', color: V.ink, letterSpacing: -0.6 },
  sub: { fontSize: 12, color: V.sub, marginTop: 4 },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { fontSize: 12, color: V.sub },
  groupTitle: { fontSize: 13, fontWeight: '800', color: V.ink, marginTop: 20, marginBottom: 10 },
  sourceLink: { marginTop: 2, alignItems: 'flex-start' },
  // 参照の .mk-tabline（下線の文字タブ）
  tabline: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderBottomColor: V.line, marginTop: 4, marginBottom: 16 },
  tab: { paddingHorizontal: 3, paddingBottom: 11, paddingTop: 6, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1, minHeight: 40, justifyContent: 'flex-end' },
  tabOn: { borderBottomColor: V.coral },
  tabText: { fontSize: 14, fontWeight: '800', color: V.sub },
  tabTextOn: { color: V.deep },
  // 参照の .mk-add-link（点線のコーラル枠）
  addLink: { marginTop: 18, minHeight: 48, borderWidth: 1, borderStyle: 'dashed', borderColor: V.coral, borderRadius: 14, backgroundColor: V.soft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  addLinkText: { fontSize: 14, fontWeight: '800', color: V.deep },
});
