/**
 * ホーム（2026-09-29 のデザイン参照 home）。
 * - 最上部は写真を画面幅いっぱいに（約305px）。中央に白い Mikke のロゴ、右上に地域。本文との境目は浅い曲線
 * - 「今日のルートをつくる」→ 実際のプラン作成（条件入力 → generate-plan-options）、「みんなのルートを見る」→ みつけるのルート
 * - 地域は固定値にせず、設定の「よく行く地域」を使う（未設定なら「地域を設定」）
 * - 写真の下: カテゴリ（→ みつける）、今日のおすすめ（公開ルートの実データ）、〇〇から探す（よく行く地域のルート）、SNS リンクの保存
 * - 未ログイン: ログイン / 新規登録
 */
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { Image } from 'expo-image';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthForm } from '@/auth/auth-form';
import { useAuthStatus } from '@/auth/session-store';
import { PublicPageLinks } from '@/components/public-page-links';
import { palettes } from '@/constants/theme';
import { useAccessToken, useApiResource } from '@/lib/use-api-resource';
import { useProfile } from '@/profile/use-profile';
import { DEFAULT_FEED_QUERY, listPublicRoutes } from '@/routes/route-posts-client';
import { RouteGrid, WideRouteCard } from '@/routes/route-views';
import { routeSync, useCardsWithOverrides } from '@/routes/use-route-sync';
import { TodayPlanCard } from '@/today/today-plan-card';
import { Icon } from '@/ui/icon';
import { V, V3_IMAGES } from '@/ui/kit';

// 開発者向けツールはリリースビルドのバンドルに含めない（__DEV__ が false なら require ごと除去される）
const DevTools: (() => React.JSX.Element) | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/dev/dev-tools').DevTools
  : null;

const HOME_GENRES = ['カフェ', 'グルメ', '自然', 'スイーツ'] as const;

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const token = useAccessToken();
  const authStatus = useAuthStatus();
  const signedIn = !!token;
  const { accountDeleted } = useLocalSearchParams<{ accountDeleted?: string }>();
  const { profile } = useProfile();
  const area = profile?.homeArea ?? null;

  // 写真の上では時計・電池の表示を白に。写真を過ぎて本文がステータスバーの下に来たら、
  // アイボリーの帯を敷いて表示を濃い色に切り替える（本文・ボタンと白い時刻が重ならないように）
  const [pastPhoto, setPastPhoto] = useState(false);
  const pastPhotoRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle(pastPhotoRef.current ? 'dark' : 'light');
      return () => setStatusBarStyle('dark');
    }, [])
  );
  const onScroll = (y: number) => {
    const past = y > 305 - 8;
    if (past === pastPhotoRef.current) return;
    pastPhotoRef.current = past;
    setPastPhoto(past);
    setStatusBarStyle(past ? 'dark' : 'light');
  };

  const openRoutes = (genre: string | null) => {
    routeSync.setDiscoverType('routes');
    routeSync.setFeedQuery({ ...DEFAULT_FEED_QUERY, genre });
    router.navigate('/feed');
  };

  return (
    <View style={styles.screen}>
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingBottom: 28 }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={32}
      onScroll={(e) => onScroll(e.nativeEvent.contentOffset.y)}>
      <View style={[styles.photo, { height: 305 + insets.top }]}>
        <Image source={V3_IMAGES.park} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition={{ top: '49%' }} accessible={false} />
        <View style={[StyleSheet.absoluteFill, styles.scrim]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={area ? `よく行く地域 ${area}（変更する）` : 'よく行く地域を設定'}
          onPress={() => router.push(signedIn ? '/settings/area' : '/profile')}
          style={[styles.location, { top: insets.top + 14 }]}>
          <Icon name="pin" size={13} color="#593C30" />
          <Text style={styles.locationText}>{area ?? '地域を設定'}</Text>
        </Pressable>
        <View style={[styles.brand, { paddingTop: insets.top }]}>
          <View style={styles.symbol}>
            <Text style={styles.symbolText}>✳</Text>
          </View>
          <Text style={styles.word} accessibilityRole="header">
            Mikke
          </Text>
          <Text style={styles.caption}>行きたいが、今日になる。</Text>
        </View>
      </View>
      <View style={styles.panel}>
        <Curve />
        <Text style={styles.h1}>{'保存した「行きたい」を、\n今日のお出かけに。'}</Text>
        <Text style={styles.lead}>{'SNSで見つけた場所から、\n時間と予算に合うルートをつくろう。'}</Text>
        {signedIn ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/plan', params: { source: 'saved' } })}
              style={({ pressed }) => [styles.main, { opacity: pressed ? 0.85 : 1 }]}>
              <Text style={styles.mainText}>今日のルートをつくる →</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => openRoutes(null)} style={styles.secondary}>
              <Text style={styles.secondaryText}>みんなのルートを見る →</Text>
            </Pressable>
          </>
        ) : null}
      </View>

      <View style={styles.rest}>
        {authStatus === 'restoring' ? (
          <View style={styles.row} accessibilityRole="progressbar" accessibilityLabel="ログイン状態を確認しています">
            <ActivityIndicator color={V.coral} />
            <Text style={{ color: V.sub }}>ログイン状態を確認しています…</Text>
          </View>
        ) : !signedIn ? (
          <View style={{ gap: 12 }}>
            {accountDeleted === '1' ? (
              <View accessibilityRole="alert" style={styles.deleted}>
                <Text style={styles.deletedText}>アカウントを削除しました。ご利用ありがとうございました。</Text>
              </View>
            ) : null}
            <Text style={{ color: V.sub, lineHeight: 20 }}>
              Instagram や TikTok で気になった場所を共有メニューから Mikke に保存すると、保存した場所からお出かけプランをつくれます。
            </Text>
            <AuthForm />
          </View>
        ) : (
          <SignedInContent area={area} onGenre={openRoutes} />
        )}
        {authStatus !== 'restoring' ? (
          <View style={{ marginTop: 24 }}>
            <PublicPageLinks c={palettes.light} pages={['terms', 'privacy', 'contact', 'accountDelete']} />
          </View>
        ) : null}
        {DevTools ? <DevTools /> : null}
      </View>
    </ScrollView>
      {pastPhoto ? <View pointerEvents="none" style={[styles.statusBand, { height: insets.top }]} /> : null}
    </View>
  );
}

/** 写真と本文の境目の浅い曲線（参照の .mk-welcome-panel::before: 画面より少し広い楕円の上辺。中央が約18px高い） */
function Curve() {
  const { width } = useWindowDimensions();
  const h = 20;
  return (
    <Svg width={width} height={h} style={styles.curve} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={`M0 ${h} Q ${width / 2} ${-h + 4} ${width} ${h} Z`} fill={V.paper} />
    </Svg>
  );
}

function SignedInContent({ area, onGenre }: { area: string | null; onGenre: (genre: string | null) => void }) {
  const popular = useApiResource('home-popular', (opts) => listPublicRoutes({ ...DEFAULT_FEED_QUERY, sort: 'recommended' }, 0, opts), { staleMs: 60_000 });
  const local = useApiResource(area ? `home-area:${area}` : null, (opts) => listPublicRoutes({ ...DEFAULT_FEED_QUERY, query: area ?? '' }, 0, opts), { staleMs: 60_000 });
  const picks = useCardsWithOverrides(popular.data).slice(0, 5);
  const nearby = useCardsWithOverrides(local.data).slice(0, 4);

  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
        {HOME_GENRES.map((g) => (
          <Pressable key={g} accessibilityRole="button" accessibilityLabel={`${g}のルートを見る`} onPress={() => onGenre(g)} style={styles.chip}>
            <Text style={styles.chipText}>{g}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <TodayPlanCard />

      <Section title="今日のおすすめ" action="もっと見る →" onAction={() => onGenre(null)} />
      {popular.phase === 'loading' || popular.phase === 'idle' ? (
        <View style={styles.placeholder} />
      ) : picks.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.hscroll} contentContainerStyle={styles.hscrollContent} decelerationRate="fast" snapToInterval={246}>
          {picks.map((c) => (
            <WideRouteCard key={c.id} card={c} />
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.empty}>
          {popular.phase === 'error' ? (popular.message ?? 'ルートを読み込めませんでした。') : 'まだ公開されたルートがありません。お出かけを記録して投稿すると、ここに並びます。'}
        </Text>
      )}

      {area ? (
        <>
          <Section title={`${area}から探す`} />
          {local.phase === 'loading' || local.phase === 'idle' ? (
            <View style={styles.placeholder} />
          ) : nearby.length > 0 ? (
            <RouteGrid cards={nearby} />
          ) : (
            <Text style={styles.empty}>{`${area}のルートはまだありません。みつけるでほかの地域も探せます。`}</Text>
          )}
        </>
      ) : null}

      <View style={styles.strip}>
        <View style={{ flex: 1 }}>
          <Text style={styles.stripTitle}>SNSで見つけた場所は？</Text>
          <Text style={styles.stripSub}>リンクを残して、お出かけに使おう</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="SNSのリンクから場所を保存する" onPress={() => router.push('/add-place')} style={styles.stripButton}>
          <Text style={styles.stripButtonText}>保存する →</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>Instagram や TikTok の投稿の「共有」から Mikke を選んでも保存できます。</Text>
    </>
  );
}

function Section({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionHead}>
      <Text style={styles.h2} accessibilityRole="header">
        {title}
      </Text>
      {action ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onAction}>
          <Text style={styles.link}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: V.paper },
  statusBand: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: V.paper, borderBottomWidth: 1, borderBottomColor: V.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  photo: { backgroundColor: '#6B5A4E', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // 写真の上の文字のコントラストを確保する暗幕（上下を濃く）
  scrim: { backgroundColor: '#1C160F66' },
  location: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 34,
    paddingHorizontal: 11,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: '#FFFFFFA3',
    backgroundColor: '#FFFEF1E5',
  },
  locationText: { fontSize: 12, fontWeight: '800', color: '#593C30' },
  brand: { alignItems: 'center', marginTop: -4 },
  symbol: { width: 51, height: 51, borderRadius: 26, backgroundColor: V.white, alignItems: 'center', justifyContent: 'center', marginBottom: 7 },
  symbolText: { fontSize: 29, fontWeight: '800', color: V.coral, lineHeight: 34 },
  word: { fontSize: 31, lineHeight: 34, fontWeight: '800', color: V.white, letterSpacing: -1.5, textShadowColor: '#0008', textShadowRadius: 12, textShadowOffset: { width: 0, height: 2 } },
  caption: { fontSize: 11, fontWeight: '700', color: V.white, marginTop: 6, letterSpacing: 0.5, textShadowColor: '#0009', textShadowRadius: 6 },
  panel: { backgroundColor: V.paper, alignItems: 'center', paddingTop: 22, paddingHorizontal: 25, paddingBottom: 14, marginTop: -16 },
  // 写真との境目の浅い曲線（横に広い楕円の上半分を重ねる）
  curve: { position: 'absolute', left: 0, top: -19 },
  h1: { fontSize: 22, lineHeight: 31, fontWeight: '800', color: V.ink, textAlign: 'center' },
  lead: { fontSize: 12, lineHeight: 20, color: V.sub, textAlign: 'center', marginTop: 7, marginBottom: 16 },
  main: { width: '100%', maxWidth: 275, minHeight: 46, borderRadius: 14, backgroundColor: V.coral, alignItems: 'center', justifyContent: 'center', shadowColor: V.coral, shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 6 } },
  mainText: { fontSize: 14, fontWeight: '800', color: V.onGradient },
  secondary: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', marginTop: 4 },
  secondaryText: { fontSize: 12, fontWeight: '800', color: V.deep },
  rest: { paddingHorizontal: 20 },
  chipScroll: { marginHorizontal: -20, marginTop: 4, marginBottom: 16 },
  chips: { gap: 8, paddingHorizontal: 20 },
  chip: { minHeight: 36, borderRadius: 24, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, paddingHorizontal: 14, justifyContent: 'center' },
  chipText: { fontSize: 12, fontWeight: '700', color: V.ink },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 12 },
  h2: { fontSize: 19, fontWeight: '800', color: V.ink, letterSpacing: -0.5 },
  link: { fontSize: 12, fontWeight: '700', color: V.deep, paddingVertical: 8 },
  hscroll: { marginHorizontal: -20 },
  hscrollContent: { gap: 12, paddingHorizontal: 20, paddingBottom: 6 },
  placeholder: { height: 200, borderRadius: 16, backgroundColor: V.soft },
  empty: { fontSize: 12, lineHeight: 18, color: V.sub, backgroundColor: V.white, borderRadius: 16, padding: 16 },
  strip: { marginTop: 24, padding: 15, borderRadius: 17, backgroundColor: V.soft, flexDirection: 'row', alignItems: 'center', gap: 10 },
  stripTitle: { fontSize: 13, fontWeight: '800', color: V.ink },
  stripSub: { fontSize: 11, color: V.sub, marginTop: 2 },
  stripButton: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10, backgroundColor: V.white, justifyContent: 'center' },
  stripButtonText: { fontSize: 12, fontWeight: '800', color: V.deep },
  hint: { fontSize: 11, color: V.sub, marginTop: 8, lineHeight: 16 },
  deleted: { borderRadius: 18, borderWidth: 1, borderColor: V.line, padding: 14 },
  deletedText: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: V.ink },
});
