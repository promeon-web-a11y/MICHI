/**
 * お店・スポットの詳細（2026-09-29 のデザイン参照 spotDetail）。
 * - 写真（立ち寄りに投稿された写真。無ければ写真なし）・名前・エリア・住所・いいね数
 * - 「いいね」と「行きたいに追加」は別の状態。行きたい = 保存した場所（保存一覧の「場所」・プラン作成に使われる）
 * - この場所を含む公開ルートへの導線、この場所からプランをつくる
 * - 営業時間・価格は確認できていないので表示しない（架空の値を出さない）
 * - 戻ると開いた元の画面（ルート詳細なら同じ閲覧位置）へ。同じタブの Stack に積まれるため
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApiResource } from '@/lib/use-api-resource';
import { appLog } from '@/lib/logger';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { RoutePhoto, WideRouteCard } from '@/routes/route-views';
import { useCardsWithOverrides } from '@/routes/use-route-sync';
import { spotMeta } from '@/spots/spot-views';
import { getSpot, type SpotDetail } from '@/spots/spots-client';
import { toggleSpot, useSpotState } from '@/spots/use-spot-sync';
import { Icon } from '@/ui/icon';
import { ErrorState, goBack, Loading, Notice, PrimaryButton, SecondaryButton, Toast, V } from '@/ui/kit';

export default function SpotDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const spot = useApiResource(id ? `spot:${id}` : null, (opts) => getSpot(String(id), opts), { staleMs: 15_000 });
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 2700);
  };
  if (spot.phase === 'unauthorized') return <SavedPlacesUnauthorized description="お店・スポットを見るにはログインしてください。" />;

  if (!spot.data) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.plainTop}>
          <BackButton />
        </View>
        <View style={{ paddingHorizontal: 20 }}>
          {spot.phase === 'loading' || spot.phase === 'idle' ? <Loading label="読み込んでいます…" /> : <ErrorState message={spot.message} onRetry={spot.reload} />}
        </View>
      </SafeAreaView>
    );
  }
  return <SpotBody spot={spot.data} flash={flash} toast={toast} />;
}

function BackButton({ overlay }: { overlay?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="戻る" hitSlop={6} onPress={() => goBack('/feed')} style={[styles.back, overlay ? styles.backOverlay : null]}>
      <Icon name="arrowLeft" size={20} color="#35251F" />
    </Pressable>
  );
}

function SpotBody({ spot, flash, toast }: { spot: SpotDetail; flash: (m: string) => void; toast: string | null }) {
  const s = useSpotState(spot, spot.id);
  const routes = useCardsWithOverrides(spot.routes);
  const [planning, setPlanning] = useState(false);
  const meta = spotMeta(spot);

  const planFromHere = async () => {
    if (planning) return;
    setPlanning(true);
    // プラン作成は保存した場所から作るので、まだなら行きたい（保存した場所）に入れてから条件入力へ
    if (!s.wished) {
      const err = await toggleSpot(spot.id, 'wish', s);
      if (err) {
        setPlanning(false);
        return flash(err);
      }
    }
    setPlanning(false);
    router.push({ pathname: '/plan', params: { source: 'saved' } });
  };

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={styles.hero}>
          <RoutePhoto path={spot.photoPath} style={StyleSheet.absoluteFill} label="写真はまだありません" />
          <BackButton overlay />
          {meta ? (
            <Text style={styles.badge} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        <View style={styles.body}>
          <Text style={styles.title} accessibilityRole="header">
            {spot.name}
          </Text>
          {spot.address ? <Text style={styles.copy}>{spot.address}</Text> : null}
          <View style={styles.facts}>
            <View style={styles.fact}>
              <Icon name="pin" size={14} color={V.sub} />
              <Text style={styles.factText}>
                <Text style={styles.factStrong}>{spot.area ?? '地域未設定'}</Text>
              </Text>
            </View>
            <View style={styles.fact}>
              <Icon name="heart" size={14} color={s.liked ? '#DC554D' : V.sub} filled={s.liked} />
              <Text style={styles.factText}>
                <Text style={styles.factStrong}>{s.likeCount}</Text> いいね
              </Text>
            </View>
            {spot.routeCount > 0 ? (
              <Text style={styles.factText}>
                <Text style={styles.factStrong}>{spot.routeCount}</Text> ルートに登場
              </Text>
            ) : null}
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: s.liked, busy: s.pendingLike }}
              accessibilityLabel={s.liked ? 'いいねを取り消す' : 'いいね'}
              disabled={s.pendingLike}
              onPress={async () => {
                const err = await toggleSpot(spot.id, 'like', s);
                if (err) flash(err);
              }}
              style={[styles.outline, { flex: 1 }]}>
              <Icon name="heart" size={17} color={s.liked ? '#DC554D' : V.ink} filled={s.liked} />
              <Text style={styles.outlineText}>{s.liked ? 'いいね済み' : 'いいね'}</Text>
            </Pressable>
            <PrimaryButton
              label={s.wished ? '✓ 行きたいに保存済み' : '＋ 行きたいに追加'}
              busy={s.pendingWish}
              onPress={async () => {
                const err = await toggleSpot(spot.id, 'wish', s);
                flash(err ?? (s.wished ? '行きたいから外しました' : '行きたい場所に保存しました。「保存」の場所から確認できます'));
              }}
              style={{ flex: 1.5 }}
            />
          </View>
          {spot.mapsUrl ? (
            <SecondaryButton
              label="地図で見る →"
              onPress={() => void Linking.openURL(spot.mapsUrl!).catch((e) => appLog.warn('地図を開けませんでした', e))}
              style={{ marginBottom: 6 }}
            />
          ) : null}
          <Text style={styles.note}>営業時間・料金は確認できていません。出かける前にお店の情報をご確認ください。</Text>

          <Text style={styles.h2} accessibilityRole="header">
            この場所を含むルート
          </Text>
          {routes.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.hscroll} contentContainerStyle={styles.hscrollContent}>
              {routes.map((r) => (
                <WideRouteCard key={r.id} card={r} />
              ))}
            </ScrollView>
          ) : (
            <Notice>いま見られる公開ルートはありません。</Notice>
          )}
          <SecondaryButton label={planning ? '準備しています…' : 'この場所からプランをつくる →'} disabled={planning} onPress={() => void planFromHere()} style={{ marginTop: 21 }} />
        </View>
      </ScrollView>
      <Toast message={toast} floating />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: V.paper },
  plainTop: { paddingHorizontal: 12, paddingVertical: 6 },
  hero: { height: 233, backgroundColor: V.soft },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  backOverlay: { position: 'absolute', top: 12, left: 15, backgroundColor: '#FFFEFAED' },
  badge: { position: 'absolute', bottom: 14, left: 18, maxWidth: '75%', backgroundColor: '#FFFAF5ED', color: '#6F493A', borderRadius: 30, paddingHorizontal: 10, paddingVertical: 5, fontSize: 11, fontWeight: '800', overflow: 'hidden' },
  body: { paddingHorizontal: 20, paddingTop: 17 },
  title: { fontSize: 23, lineHeight: 30, fontWeight: '800', color: V.ink, letterSpacing: -0.6, marginTop: 3, marginBottom: 6 },
  copy: { fontSize: 13, lineHeight: 22, color: V.sub },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, paddingVertical: 11, marginVertical: 14, borderTopWidth: 1, borderBottomWidth: 1, borderColor: V.line },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  factText: { fontSize: 12, color: V.sub },
  factStrong: { color: V.ink, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 9, marginVertical: 12 },
  outline: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  outlineText: { fontSize: 14, fontWeight: '800', color: V.ink },
  note: { fontSize: 11, lineHeight: 17, color: V.sub, marginTop: 4 },
  h2: { fontSize: 19, fontWeight: '800', color: V.ink, letterSpacing: -0.5, marginTop: 26, marginBottom: 12 },
  hscroll: { marginHorizontal: -20 },
  hscrollContent: { gap: 12, paddingHorizontal: 20, paddingBottom: 6 },
});
