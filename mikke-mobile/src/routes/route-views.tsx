/**
 * みんなのルートの表示部品（写真中心の2列タイル・横スクロールの大きめカード・写真）。
 * 2026-09-29 のデザイン参照（.mk-tile / .mk-wide-card / .mk-stop-visual）を基準にしている。
 */
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { V } from '@/ui/kit';
import { Icon } from '@/ui/icon';

import type { RouteCard } from './route-posts-client';
import { durationText, budgetText } from './route-format';
import { usePhotoUrl } from './use-photo-url';
import { toggleReaction } from './use-route-sync';

export function openRoute(id: string) {
  router.push({ pathname: '/routes/[id]', params: { id } });
}

/** 署名付きURLの写真。無い・見られない場合は「写真なし」 */
export function RoutePhoto({ path, style, label = '写真なし' }: { path: string | null; style?: StyleProp<ViewStyle>; label?: string }) {
  const url = usePhotoUrl(path);
  return (
    <View style={[styles.photo, style]}>
      {url ? (
        <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} accessible={false} />
      ) : (
        <Text style={styles.noPhoto}>{path ? '' : label}</Text>
      )}
    </View>
  );
}

/** 写真の縦横に合わせて 縦 4:5 / 横 16:10 で見せる（歪ませず中央で切り抜く） */
export function photoAspect(width: number | undefined, height: number | undefined): number {
  if (!width || !height) return 16 / 10;
  return height > width ? 4 / 5 : 16 / 10;
}

/** ルート詳細の立ち寄り写真（本文の幅いっぱい） */
export function StopPhoto({ path, accessibilityLabel }: { path: string; accessibilityLabel: string }) {
  const url = usePhotoUrl(path);
  const [aspect, setAspect] = useState(16 / 10);
  return (
    <View style={[styles.photo, styles.stopPhoto, { aspectRatio: aspect }]} accessibilityLabel={accessibilityLabel} accessibilityRole="image">
      {url ? (
        <Image
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          onLoad={(e) => setAspect(photoAspect(e.source?.width, e.source?.height))}
          accessible={false}
        />
      ) : null}
    </View>
  );
}

/** ルートの保存（行きたい）。写真の右上の丸いボタン。押しても詳細へは移らない */
function SaveBadge({ card, onError }: { card: RouteCard; onError?: (m: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.wished ? `${card.title}の保存を外す` : `${card.title}を保存`}
      accessibilityState={{ selected: card.wished }}
      hitSlop={6}
      onPress={async () => {
        const err = await toggleReaction(card, 'wish');
        if (err) onError?.(err);
      }}
      style={styles.saveBadge}>
      <Icon name="heart" size={17} color={card.wished ? V.coral : '#5E4C43'} filled={card.wished} />
    </Pressable>
  );
}

/** 2列の写真タイル（みつける・ホーム・保存一覧・自分の投稿） */
export function RouteTile({ card, onReactionError }: { card: RouteCard; onReactionError?: (message: string) => void }) {
  const meta = [card.area ?? '地域未設定', durationText(card.durationMinutes), card.budgetYen !== null ? budgetText(card.budgetYen) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.tile}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${card.title}。${meta}`} onPress={() => openRoute(card.id)}>
        <RoutePhoto path={card.coverPhotoPath} style={styles.tilePhoto} />
        <Text style={styles.tileTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <Text style={styles.meta} numberOfLines={2}>
          {meta}
        </Text>
        {card.visibility !== 'public' ? <Text style={styles.meta}>非公開の記録</Text> : null}
      </Pressable>
      {card.visibility === 'public' && !card.isMine ? <SaveBadge card={card} onError={onReactionError} /> : null}
    </View>
  );
}

/** 2列固定のグリッド（幅が狭くても1列にしない） */
export function RouteGrid({ cards, onReactionError }: { cards: RouteCard[]; onReactionError?: (message: string) => void }) {
  const rows: RouteCard[][] = [];
  for (let i = 0; i < cards.length; i += 2) rows.push(cards.slice(i, i + 2));
  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row[0].id} style={styles.gridRow}>
          {row.map((c) => (
            <View key={c.id} style={styles.gridCell}>
              <RouteTile card={c} onReactionError={onReactionError} />
            </View>
          ))}
          {row.length === 1 ? <View style={styles.gridCell} /> : null}
        </View>
      ))}
    </View>
  );
}

/** 横スクロールの大きめカード（ホームの「今日のおすすめ」・スポット詳細の「この場所を含むルート」） */
export function WideRouteCard({ card, width = 234 }: { card: RouteCard; width?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${card.title}の詳細を見る`} onPress={() => openRoute(card.id)} style={{ width }}>
      <View>
        <RoutePhoto path={card.coverPhotoPath} style={styles.widePhoto} />
        {card.area ? (
          <Text style={styles.photoLabel} numberOfLines={1}>
            {card.area}
          </Text>
        ) : null}
      </View>
      <Text style={styles.wideTitle} numberOfLines={2}>
        {card.title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {durationText(card.durationMinutes)} · {budgetText(card.budgetYen)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  photo: { backgroundColor: V.soft, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  noPhoto: { color: V.sub, fontSize: 11 },
  stopPhoto: { width: '100%', borderRadius: 14 },
  grid: { gap: 16 },
  gridRow: { flexDirection: 'row', gap: 12 },
  gridCell: { flex: 1, minWidth: 0 },
  tile: { flex: 1, minWidth: 0 },
  tilePhoto: { height: 146, borderRadius: 15, marginBottom: 7 },
  tileTitle: { fontSize: 13, lineHeight: 18, fontWeight: '800', color: V.ink },
  meta: { fontSize: 11, lineHeight: 15, color: V.sub, marginTop: 3 },
  saveBadge: { position: 'absolute', right: 8, top: 8, width: 36, height: 36, borderRadius: 18, backgroundColor: '#FFFEF4ED', alignItems: 'center', justifyContent: 'center' },
  widePhoto: { height: 156, borderRadius: 16, marginBottom: 8 },
  photoLabel: { position: 'absolute', left: 8, bottom: 16, maxWidth: '80%', backgroundColor: '#FFFDF8EB', color: '#573C31', borderRadius: 30, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: '800', overflow: 'hidden' },
  wideTitle: { fontSize: 14, lineHeight: 19, fontWeight: '800', color: V.ink },
});
