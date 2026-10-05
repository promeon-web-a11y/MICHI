/**
 * みつける（2026-09-29 のデザイン参照 discover）。
 * - 上部で「みんなのルート / お店・スポット」を切り替える。検索欄の文言とカテゴリは対象に合わせて変わる
 * - ルートは写真中心の2列グリッド。地域・予算・テーマ・並び順は「絞り込み」にまとめ、最初は閉じておく（先に一覧が見える）
 * - お店・スポットも写真中心の2列。いいね（写真右上）と 行きたい（下のボタン）は別の状態で、押しても詳細へは移らない
 * - 件数・いいね・保存はサーバーの実数。詳細から戻ると、対象・条件・スクロール位置はそのまま（このタブの Stack に残る）
 */
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { callApi, useApiResource } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { feedEmptyText, filterOptions, ROUTE_GENRES, SORT_OPTIONS } from '@/routes/route-format';
import { FEED_PAGE_SIZE, listPublicRouteAreas, listPublicRoutes, type RouteCard } from '@/routes/route-posts-client';
import { activeFilterCount, type DiscoverType } from '@/routes/route-sync';
import { RouteTile } from '@/routes/route-views';
import { routeSync, useCardsWithOverrides, useRouteSync } from '@/routes/use-route-sync';
import { SpotTile } from '@/spots/spot-views';
import { listPublicSpots, SPOT_CATEGORIES, SPOTS_PAGE_SIZE, type SpotCard } from '@/spots/spots-client';
import { useSpotList } from '@/spots/use-spot-sync';
import { Icon } from '@/ui/icon';
import { AppHeader, ErrorState, Loading, Notice, SelectField, Tiny, Toast, V } from '@/ui/kit';

const ROUTE_CHIPS: { value: string | null; label: string }[] = [{ value: null, label: 'おすすめ' }, ...ROUTE_GENRES.map((g) => ({ value: g, label: g }))];

type Paged<T> = { key: string; items: T[]; done: boolean; loading: boolean };

/** 1ページ目は useApiResource、続きは onEndReached で足す */
function usePaged<T>(key: string, first: T[] | null, ready: boolean, pageSize: number, load: (offset: number) => Promise<{ ok: true; data: T[] } | { ok: false }>) {
  const [more, setMore] = useState<Paged<T>>({ key, items: [], done: false, loading: false });
  const firstItems = first ?? [];
  const extra = more.key === key ? more.items : [];
  const hasMore = firstItems.length >= pageSize && !(more.key === key && more.done);
  const loadMore = async () => {
    if (!hasMore || (more.key === key && more.loading) || !ready) return;
    setMore({ key, items: extra, done: false, loading: true });
    const r = await load(firstItems.length + extra.length);
    setMore((prev) => (prev.key !== key ? prev : { key, items: r.ok ? [...extra, ...r.data] : extra, done: !r.ok || r.data.length < pageSize, loading: false }));
  };
  return { all: [...firstItems, ...extra], hasMore, loadMore, loadingMore: more.key === key && more.loading };
}

export default function DiscoverScreen() {
  const { feedQuery: q, spotQuery: sq, filtersOpen, versions, discoverType } = useRouteSync();
  const routes = discoverType === 'routes';
  const narrow = useWindowDimensions().width < 380;
  const [text, setText] = useState(routes ? q.query : sq.query);
  const [syncedText, setSyncedText] = useState(`${discoverType}|${routes ? q.query : sq.query}`);
  const [toast, setToast] = useState<string | null>(null);

  // 対象を切り替えたとき・ホームのジャンルから開いたときなど、外から条件が変わったら入力欄も合わせる
  const external = `${discoverType}|${routes ? q.query : sq.query}`;
  if (syncedText !== external) {
    setSyncedText(external);
    setText(routes ? q.query : sq.query);
  }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2700);
    return () => clearTimeout(t);
  }, [toast]);

  const routeKey = JSON.stringify(q);
  const spotKey = JSON.stringify(sq);
  const routeFirst = useApiResource(routes ? `feed:${routeKey}` : null, (opts) => listPublicRoutes(q, 0, opts), { staleMs: 60_000, version: versions.feed });
  const spotFirst = useApiResource(!routes ? `spots:${spotKey}` : null, (opts) => listPublicSpots(sq, 0, opts), { staleMs: 60_000, version: versions.feed });
  const areas = useApiResource(routes ? 'feed-areas' : null, listPublicRouteAreas, { staleMs: 5 * 60_000, version: versions.feed });
  const routePages = usePaged<RouteCard>(routeKey, routeFirst.data, routeFirst.phase === 'ready', FEED_PAGE_SIZE, (offset) => callApi((opts) => listPublicRoutes(q, offset, opts)));
  const spotPages = usePaged<SpotCard>(spotKey, spotFirst.data, spotFirst.phase === 'ready', SPOTS_PAGE_SIZE, (offset) => callApi((opts) => listPublicSpots(sq, offset, opts)));
  const routeCards = useCardsWithOverrides(routePages.all);
  const spotCards = useSpotList(spotPages.all);
  const options = useMemo(() => filterOptions(areas.data ?? []), [areas.data]);

  const res = routes ? routeFirst : spotFirst;
  if (res.phase === 'unauthorized') return <SavedPlacesUnauthorized description="みつけるを使うにはログインしてください。" />;

  const submit = () => (routes ? routeSync.setFeedQuery({ query: text.trim() }) : routeSync.setSpotQuery({ query: text.trim() }));
  const switchTo = (t: DiscoverType) => {
    if (t !== discoverType) routeSync.setDiscoverType(t);
  };
  const count = routes ? routeCards.length : spotCards.length;
  const hasMore = routes ? routePages.hasMore : spotPages.hasMore;
  const filters = activeFilterCount(q) + (q.sort !== 'recommended' ? 1 : 0);
  const heading = routes
    ? q.genre
      ? `${q.genre}のルート`
      : '行きたくなるルート'
    : sq.category
      ? `${SPOT_CATEGORIES.find((c) => c.value === sq.category)?.label ?? ''}を探す`
      : '気になるお店・スポット';
  const filtered = routes ? !!q.query || activeFilterCount(q) > 0 : !!sq.query || !!sq.category;

  // 2列固定: 奇数件のときは右側を空けて幅をそろえる
  const items: (RouteCard | SpotCard | null)[] = routes ? routeCards : spotCards;
  const data = items.length % 2 === 1 ? [...items, null] : items;

  const header = (
    <View>
      <View style={styles.intro}>
        <Text style={styles.h1} accessibilityRole="header">
          {/* 狭い画面では「みつける。」の途中で折り返さないよう、読点の後で改行する */}
          {narrow ? '次の「行きたい」を、\nみつける。' : '次の「行きたい」を、みつける。'}
        </Text>
        <Text style={styles.sub}>ルートもお店も、気になるものから探そう。</Text>
      </View>
      <View style={styles.switch} accessibilityRole="tablist" accessibilityLabel="探す対象">
        {(
          [
            ['routes', 'みんなのルート'],
            ['spots', 'お店・スポット'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: discoverType === value }}
            onPress={() => switchTo(value)}
            style={[styles.switchItem, discoverType === value ? styles.switchOn : null]}>
            <Text style={[styles.switchText, discoverType === value ? styles.switchTextOn : null]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Icon name="search" size={18} color={V.sub} />
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            onBlur={() => {
              if (text.trim() !== (routes ? q.query : sq.query)) submit();
            }}
            returnKeyType="search"
            placeholder={routes ? 'ルート・場所を検索' : 'お店・スポットを検索'}
            placeholderTextColor={V.placeholder}
            accessibilityLabel={routes ? 'ルートを検索' : 'お店・スポットを検索'}
            style={styles.searchInput}
          />
        </View>
        {routes ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: filtersOpen }}
            accessibilityLabel={`絞り込み${filters ? `（${filters}件指定中）` : ''}`}
            onPress={() => routeSync.setFiltersOpen(!filtersOpen)}
            style={[styles.filterButton, filtersOpen || filters > 0 ? styles.filterOn : null]}>
            <Icon name="sliders" size={18} color={filtersOpen || filters > 0 ? V.deep : V.ink} />
            {filters > 0 ? <Text style={styles.filterCount}>{filters}</Text> : null}
          </Pressable>
        ) : null}
      </View>
      {routes && filtersOpen ? (
        <View style={styles.filterGrid}>
          <FilterCell label="地域">
            <SelectField label="地域" value={q.area} options={options.area} onChange={(v) => routeSync.setFeedQuery({ area: v })} />
          </FilterCell>
          <FilterCell label="予算">
            <SelectField label="予算" value={q.maxBudget} options={options.budget} onChange={(v) => routeSync.setFeedQuery({ maxBudget: v })} />
          </FilterCell>
          <FilterCell label="テーマ">
            <SelectField label="テーマ" value={q.theme} options={options.theme} onChange={(v) => routeSync.setFeedQuery({ theme: v })} />
          </FilterCell>
          <FilterCell label="並び順">
            <SelectField label="並び順" value={q.sort} options={SORT_OPTIONS} onChange={(v) => routeSync.setFeedQuery({ sort: v })} />
          </FilterCell>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipScroll}>
        {(routes ? ROUTE_CHIPS : SPOT_CATEGORIES).map((c) => {
          const on = routes ? q.genre === c.value : sq.category === c.value;
          return (
            <Pressable
              key={c.label}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => (routes ? routeSync.setFeedQuery({ genre: c.value }) : routeSync.setSpotQuery({ category: c.value }))}
              style={[styles.chip, on ? styles.chipOn : null]}>
              <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{c.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.head}>
        <Text style={styles.h2} accessibilityRole="header">
          {heading}
        </Text>
        <Text style={styles.count}>{res.phase === 'ready' ? `${count}${hasMore ? '件以上' : '件'}` : ''}</Text>
      </View>
      {res.message && res.data ? <Tiny style={{ marginBottom: 8 }}>{res.message}</Tiny> : null}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <AppHeader />
      <FlatList
        key={discoverType}
        data={res.phase === 'ready' ? data : []}
        keyExtractor={(item, i) => (item ? `${discoverType}:${item.id}` : `spacer-${i}`)}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => (
          <View style={styles.cell}>
            {item === null ? null : routes ? <RouteTile card={item as RouteCard} onReactionError={setToast} /> : <SpotTile spot={item as SpotCard} onMessage={setToast} />}
          </View>
        )}
        ListEmptyComponent={
          res.phase === 'loading' || res.phase === 'idle' ? (
            <Loading label={routes ? 'ルートを読み込んでいます…' : 'お店・スポットを読み込んでいます…'} />
          ) : res.phase === 'error' ? (
            <ErrorState message={res.message} onRetry={res.reload} />
          ) : (
            <Notice>
              {routes
                ? feedEmptyText(filtered)
                : filtered
                  ? '条件に合うお店・スポットはありません。別の条件で探してみてください。'
                  : 'まだお店・スポットがありません。公開されたルートの立ち寄り先が、ここに並びます。'}
            </Notice>
          )
        }
        ListFooterComponent={(routes ? routePages.loadingMore : spotPages.loadingMore) ? <Loading label="続きを読み込んでいます…" /> : null}
        onEndReached={routes ? routePages.loadMore : spotPages.loadMore}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={res.refreshing} onRefresh={res.reload} tintColor={V.coral} />}
      />
      <Toast message={toast} floating />
    </SafeAreaView>
  );
}

function FilterCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.filterCell}>
      <Text style={styles.filterLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: V.paper },
  content: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 32 },
  column: { gap: 12, marginBottom: 18 },
  cell: { flex: 1, minWidth: 0 },
  intro: { marginTop: 4, marginBottom: 2 },
  h1: { fontSize: 22, lineHeight: 30, fontWeight: '800', color: V.ink, letterSpacing: -0.6 },
  sub: { fontSize: 12, color: V.sub, marginTop: 4 },
  switch: { flexDirection: 'row', backgroundColor: V.soft, borderRadius: 13, padding: 4, gap: 3, marginTop: 15, marginBottom: 14 },
  switchItem: { flex: 1, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  switchOn: { backgroundColor: V.white, shadowColor: '#462817', shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  switchText: { fontSize: 13, fontWeight: '800', color: V.sub },
  switchTextOn: { color: V.deep },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  search: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, borderRadius: 14, paddingHorizontal: 12, minHeight: 46 },
  searchInput: { flex: 1, minWidth: 0, fontSize: 14, color: V.ink, paddingVertical: 10 },
  filterButton: { width: 46, height: 46, borderRadius: 14, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, alignItems: 'center', justifyContent: 'center' },
  filterOn: { borderColor: V.coral, backgroundColor: V.soft },
  filterCount: { position: 'absolute', top: 4, right: 6, fontSize: 9, fontWeight: '800', color: V.deep },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, padding: 10, borderRadius: 14, backgroundColor: V.white, borderWidth: 1, borderColor: V.line, marginTop: 10 },
  filterCell: { width: '47.5%', flexGrow: 1, minWidth: 0 },
  filterLabel: { fontSize: 11, color: V.sub, marginBottom: 4 },
  chipScroll: { marginHorizontal: -20, marginTop: 14 },
  chips: { gap: 8, paddingHorizontal: 20, paddingBottom: 2 },
  chip: { minHeight: 36, borderRadius: 24, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, paddingHorizontal: 14, justifyContent: 'center' },
  chipOn: { borderColor: V.coral, backgroundColor: V.soft },
  chipText: { fontSize: 12, fontWeight: '700', color: V.ink },
  chipTextOn: { color: V.deep },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 19, marginBottom: 13 },
  h2: { fontSize: 18, fontWeight: '800', color: V.ink, letterSpacing: -0.5 },
  count: { fontSize: 12, color: V.sub },
});
