/**
 * お店・スポットの表示部品（2026-09-29 のデザイン参照 .mk-spot-tile）。
 * 写真・名前を押すと詳細へ。いいね（写真右上）と 行きたい（下のボタン）は別のボタンで、押しても詳細へは移らない。
 */
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { RoutePhoto } from '@/routes/route-views';
import { Icon } from '@/ui/icon';
import { V } from '@/ui/kit';

import type { SpotCard } from './spots-client';
import { toggleSpot, useSpotState } from './use-spot-sync';

export function openSpot(placeId: string) {
  router.push({ pathname: '/spots/[id]', params: { id: placeId } });
}

export function spotMeta(spot: Pick<SpotCard, 'area' | 'categoryLabel'>): string {
  return [spot.area, spot.categoryLabel].filter(Boolean).join(' · ');
}

/** 行きたい ボタン（場所に保存）。compact はルート詳細の立ち寄り用 */
export function WishButton({
  placeId,
  name,
  state,
  onResult,
  size = 'small',
}: {
  placeId: string;
  name: string;
  state: { liked: boolean; wished: boolean; likeCount: number };
  onResult?: (message: string) => void;
  size?: 'small' | 'stop';
}) {
  const s = useSpotState(state, placeId);
  const on = s.wished;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={on ? `${name}を行きたいから外す` : `${name}を行きたいに追加`}
      accessibilityState={{ selected: on, busy: s.pendingWish }}
      disabled={s.pendingWish}
      hitSlop={4}
      onPress={async () => {
        const err = await toggleSpot(placeId, 'wish', s);
        onResult?.(err ?? (on ? '行きたいから外しました' : '行きたい場所に保存しました'));
      }}
      style={[size === 'stop' ? styles.stopWish : styles.wish, on ? (size === 'stop' ? styles.stopWishOn : styles.wishOn) : null]}>
      {s.pendingWish ? <ActivityIndicator size="small" color={size === 'stop' && on ? V.white : V.deep} /> : null}
      <Text style={[styles.wishText, size === 'stop' && on ? { color: V.onGradient } : null]}>{on ? '✓ 行きたい' : '＋ 行きたい'}</Text>
    </Pressable>
  );
}

export function LikePill({ spot, onError }: { spot: SpotCard; onError?: (m: string) => void }) {
  const s = useSpotState(spot, spot.id);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={s.liked ? `${spot.name}のいいねを取り消す（${s.likeCount}件）` : `${spot.name}にいいね（${s.likeCount}件）`}
      accessibilityState={{ selected: s.liked, busy: s.pendingLike }}
      disabled={s.pendingLike}
      hitSlop={4}
      onPress={async () => {
        const err = await toggleSpot(spot.id, 'like', s);
        if (err) onError?.(err);
      }}
      style={styles.likePill}>
      <Icon name="heart" size={16} color={s.liked ? '#DC554D' : '#6B5246'} filled={s.liked} />
      <Text style={[styles.likeText, s.liked ? { color: '#B83E37' } : null]}>{s.likeCount}</Text>
    </Pressable>
  );
}

export function SpotTile({ spot, onMessage }: { spot: SpotCard; onMessage?: (m: string) => void }) {
  const meta = spotMeta(spot);
  return (
    <View style={styles.tile}>
      <View>
        <Pressable accessibilityRole="button" accessibilityLabel={`${spot.name}を見る`} onPress={() => openSpot(spot.id)}>
          <RoutePhoto path={spot.photoPath} style={styles.photo} />
        </Pressable>
        <LikePill spot={spot} onError={onMessage} />
      </View>
      <Pressable accessibilityRole="button" onPress={() => openSpot(spot.id)} style={styles.titleButton}>
        <Text style={styles.title} numberOfLines={2}>
          {spot.name}
        </Text>
      </Pressable>
      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
      <View style={{ alignItems: 'flex-start' }}>
        <WishButton placeId={spot.id} name={spot.name} state={spot} onResult={onMessage} />
      </View>
    </View>
  );
}

export function SpotGrid({ spots, onMessage }: { spots: SpotCard[]; onMessage?: (m: string) => void }) {
  const rows: SpotCard[][] = [];
  for (let i = 0; i < spots.length; i += 2) rows.push(spots.slice(i, i + 2));
  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row[0].id} style={styles.row}>
          {row.map((s) => (
            <View key={s.id} style={styles.cell}>
              <SpotTile spot={s} onMessage={onMessage} />
            </View>
          ))}
          {row.length === 1 ? <View style={styles.cell} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 18 },
  row: { flexDirection: 'row', gap: 12 },
  cell: { flex: 1, minWidth: 0 },
  tile: { flex: 1, minWidth: 0 },
  photo: { height: 147, borderRadius: 15 },
  likePill: {
    position: 'absolute',
    right: 8,
    top: 8,
    minWidth: 44,
    height: 34,
    paddingHorizontal: 9,
    borderRadius: 18,
    backgroundColor: '#FFFDF3ED',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  likeText: { fontSize: 11, fontWeight: '800', color: '#6B5246' },
  titleButton: { paddingTop: 8, paddingBottom: 1, minHeight: 30 },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '800', color: V.ink },
  meta: { fontSize: 11, color: V.sub, marginTop: 2 },
  wish: { marginTop: 7, minHeight: 34, flexDirection: 'row', gap: 4, alignItems: 'center', borderWidth: 1, borderColor: V.coral, borderRadius: 9, backgroundColor: V.white, paddingHorizontal: 10 },
  wishOn: { backgroundColor: V.soft },
  wishText: { fontSize: 11, fontWeight: '800', color: V.deep },
  stopWish: { minHeight: 38, flexDirection: 'row', gap: 4, alignItems: 'center', borderRadius: 9, backgroundColor: V.soft, paddingHorizontal: 12 },
  stopWishOn: { backgroundColor: V.coral },
});
