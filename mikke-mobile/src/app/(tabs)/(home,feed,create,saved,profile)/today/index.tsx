/**
 * Step 4-8「今日のプラン」。本人の accepted プラン（直近24時間）を Supabase から取得して表示し、
 * お出かけ中にスポットごとに「行った」を記録する（既存 answer_visit RPC）。アプリ再起動後も復元できる。
 *
 * - 実ルート・地図・Google マップへの導線は Step 4-6 / 4-7 の仕組みをそのまま使う（route-plan の10分キャッシュ）
 * - 公共交通は Google マップへ誘導し、路線・時刻・運賃は Mikke 内で作らない
 * v3.0: 「今日のルート」。下部タブの中に表示し、「お出かけを記録」から行った場所を選んで非公開の記録を残す（/record）。
 *   みんなのルートの「同じ順番で行く」で作ったプランは滞在時間が未設定のため表示しない
 */
import { router } from 'expo-router';
import { Fragment, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader, BackLink, PrimaryButton, V } from '@/ui/kit';

import { useCurrentLocation } from '@/location/use-current-location';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { budgetText, categoryLabel, formatClock } from '@/plan/plan-option-format';
import { PillButton, PlanMessage, VariantBadge } from '@/plan/plan-option-views';
import type { RoutedPlan } from '@/plan/plan-route-client';
import { faresSummaryText, fitMessage, legMapsLinks, legModeLabel, TRANSIT_HANDOFF_TEXT, walkReferenceText } from '@/plan/plan-route-format';
import { MapsLinkButton } from '@/plan/plan-route-view';
import { usePlanPalette, type PlanPalette } from '@/plan/plan-theme';
import { planRouteActions, routeOrigin, usePlanRoutes } from '@/plan/use-plan-route';
import type { TodayPlan, TodayStop } from '@/today/today-plan-client';
import { useTodayPlan } from '@/today/use-today-plan';

export default function TodayPlanScreen() {
  const c = usePlanPalette();
  const { state, reload, markVisited } = useTodayPlan();
  const routes = usePlanRoutes();
  const location = useCurrentLocation();

  if (state.phase === 'unauthorized') {
    return <SavedPlacesUnauthorized description="今日のプランを見るにはログインしてください。" />;
  }
  if ((state.phase === 'loading' || state.phase === 'idle') && !state.plan) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.accent} size="large" />
        <Text style={{ color: c.text }}>今日のプランを読み込んでいます…</Text>
      </View>
    );
  }
  if (state.phase === 'error' && !state.plan) {
    return (
      <PlanMessage c={c} icon="🙏" title="今日のプランを読み込めませんでした" body="通信環境を確認して、もう一度お試しください。">
        <PillButton c={c} primary label="もう一度試す" onPress={reload} />
      </PlanMessage>
    );
  }
  if (state.phase === 'none' || !state.plan) {
    return (
      <PlanMessage c={c} icon="✨" title="今日のプランはまだありません" body="「今日どこ行く？」でプランをつくり、「このプランにする」を選ぶとここに表示されます。">
        <PillButton c={c} primary label="今日どこ行く？" onPress={() => router.push('/plan')} />
      </PlanMessage>
    );
  }

  const plan = state.plan;
  const entry = routes[plan.plan_id];
  const route = entry && entry.status !== 'error' ? entry.data : null;
  const routeIndex = new Map((route?.stops ?? []).map((s, i) => [s.place_id, i]));
  const origin = routeOrigin();

  const loadRoute = async (force: boolean) => {
    if (!routeOrigin()) {
      const r = await location.locate({ prompt: true });
      if (!r.ok) return;
    }
    await planRouteActions.load(plan.plan_id, { force });
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: V.white }}>
    <AppHeader />
    <ScrollView style={{ backgroundColor: V.white }} contentContainerStyle={[styles.content, { paddingBottom: 40 }]}>
      <BackLink />
      <Header c={c} plan={plan} />
      <PrimaryButton label="お出かけを記録" onPress={() => router.push({ pathname: '/record', params: { planId: plan.plan_id } })} />

      {plan.completed ? (
        <View style={[styles.done, { backgroundColor: c.accentSoft, borderColor: c.accent }]}>
          <Text style={[styles.doneTitle, { color: c.text }]}>今日のプラン完了</Text>
          <Text style={{ color: c.text }}>すべての場所を訪れました。おつかれさまでした。</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {!entry ? (
          <PillButton c={c} primary label="🧭 実際のルートを確認する" onPress={() => loadRoute(false)} />
        ) : entry.status === 'loading' ? (
          <View style={styles.row}>
            <ActivityIndicator color={c.accent} />
            <Text style={{ color: c.text }}>ルートを確認しています…</Text>
          </View>
        ) : entry.status === 'error' ? (
          <View style={[styles.notice, { backgroundColor: c.warningSoft }]}>
            <Text style={{ color: c.text }}>{entry.error.message}</Text>
            {entry.error.retryable ? <PillButton c={c} label="もう一度試す" onPress={() => loadRoute(true)} /> : null}
          </View>
        ) : null}
        {location.error && !routeOrigin() && !entry ? <Text style={[styles.meta, { color: c.textSecondary }]}>{location.message}</Text> : null}
        <PillButton c={c} label="🗺️ 地図でルートを見る" onPress={() => router.push('/today/map')} />
      </View>

      {route ? <RouteNotes c={c} route={route} /> : null}

      <View style={[styles.timeline, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.startLine, { color: c.textSecondary }]}>
          {route ? `${formatClock(route.departure_at)} 現在地を出発` : '現在地から出発'}
        </Text>
        {plan.stops.map((stop) => {
          const i = routeIndex.get(stop.place_id);
          return (
            <Fragment key={stop.place_id}>
              <MoveLine c={c} route={route} index={i} origin={origin} />
              <StopRow
                c={c}
                showStay={plan.source !== 'mobile_route_copy'}
                stop={stop}
                routeArrival={route && i !== undefined ? route.stops[i].arrival_at : undefined}
                droppedByRoute={!!route && i === undefined}
                visiting={state.visiting === stop.place_id}
                busy={state.visiting !== null}
                error={state.visitErrors[stop.place_id] ?? null}
                onVisited={() => markVisited(stop.place_id)}
              />
            </Fragment>
          );
        })}
      </View>

      <PrimaryButton label="お出かけを記録" onPress={() => router.push({ pathname: '/record', params: { planId: plan.plan_id } })} />
      <Text style={[styles.footnote, { color: c.textSecondary }]}>
        {TRANSIT_HANDOFF_TEXT}。Mikke は公共交通の路線・時刻・運賃を表示しません。行った場所の記録は非公開で保存され、公開するには別の操作が必要です。
      </Text>
    </ScrollView>
    </SafeAreaView>
  );
}

function Header({ c, plan }: { c: PlanPalette; plan: TodayPlan }) {
  const total = plan.stops.length;
  return (
    <View style={[styles.header, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.row}>
        {plan.variant ? <VariantBadge c={c} variant={plan.variant} size={36} /> : null}
        <View style={styles.flex}>
          <Text style={[styles.title, { color: c.text }]}>{plan.title}</Text>
          {plan.concept ? <Text style={{ color: c.accentStrong, fontWeight: '700' }}>{plan.concept}</Text> : null}
        </View>
      </View>
      <View style={[styles.progressTrack, { backgroundColor: c.accentSoft }]}>
        <View style={[styles.progressFill, { backgroundColor: c.accent, width: `${Math.round((plan.visited_count / total) * 100)}%` }]} />
      </View>
      <Text style={{ color: c.text, fontWeight: '700' }}>
        訪問 {plan.visited_count} / {total} スポット
      </Text>
      <Text style={[styles.meta, { color: c.textSecondary }]}>
        💴 場所の目安: {budgetText({ estimated_budget_yen: plan.places_budget_yen, budget_status: plan.budget_status })}
        {plan.budget_yen !== null ? `（予算 〜${plan.budget_yen.toLocaleString('ja-JP')}円）` : ''}
      </Text>
    </View>
  );
}

function RouteNotes({ c, route }: { c: PlanPalette; route: RoutedPlan }) {
  const fit = fitMessage(route);
  const dropped = route.adjustments.filter((a) => a.type === 'dropped_place');
  return (
    <View style={[styles.notice, { backgroundColor: c.accentSoft }]}>
      {fit ? <Text style={{ color: c.text, fontWeight: '700' }}>{fit}</Text> : null}
      <Text style={{ color: c.text }}>🚉 {faresSummaryText(route.fares)}</Text>
      {dropped.length > 0 ? (
        <Text style={[styles.meta, { color: c.textSecondary }]}>
          時間内に収めるため、ルートでは {dropped.map((d) => d.place_name).join('、')} を外しています
        </Text>
      ) : null}
    </View>
  );
}

function MoveLine({
  c,
  route,
  index,
  origin,
}: {
  c: PlanPalette;
  route: RoutedPlan | null;
  index: number | undefined;
  origin: { latitude: number; longitude: number } | null;
}) {
  if (!route || index === undefined) {
    return (
      <Text style={[styles.move, { color: c.textSecondary }]}>↓ 移動（「実際のルートを確認する」で表示されます）</Text>
    );
  }
  const leg = route.legs[index];
  const label = legModeLabel(leg);
  const links = legMapsLinks(route, index, origin);
  const walkRef = walkReferenceText(leg);
  return (
    <View style={[styles.moveBox, { backgroundColor: c.background }]}>
      <Text style={[styles.moveHead, { color: c.text }]}>
        ↓ {label.icon} {label.label}
        {leg.status === 'ok' && leg.duration_minutes !== null ? ` ${leg.duration_minutes}分` : ''}
      </Text>
      {walkRef ? <Text style={[styles.meta, { color: c.textSecondary }]}>{walkRef}</Text> : null}
      {links.primary ? <MapsLinkButton c={c} link={links.primary} strong={leg.status === 'external_transit'} /> : null}
      {links.transit ? <MapsLinkButton c={c} link={links.transit} /> : null}
    </View>
  );
}

function StopRow({
  c,
  showStay,
  stop,
  routeArrival,
  droppedByRoute,
  visiting,
  busy,
  error,
  onVisited,
}: {
  c: PlanPalette;
  showStay: boolean;
  stop: TodayStop;
  /** undefined: 実ルート未取得 / null: 実ルートでは到着時刻未確定 */
  routeArrival: string | null | undefined;
  droppedByRoute: boolean;
  visiting: boolean;
  busy: boolean;
  error: string | null;
  onVisited: () => void;
}) {
  const arrival =
    routeArrival !== undefined
      ? routeArrival
        ? `${formatClock(routeArrival)} ごろ到着`
        : '到着時刻は未確定'
      : stop.planned_arrival_at
        ? `予定 ${formatClock(stop.planned_arrival_at)}（目安）`
        : null;
  return (
    <View style={[styles.stop, stop.visited ? { opacity: 0.85 } : null]}>
      <View style={[styles.order, { backgroundColor: stop.visited ? c.textSecondary : c.accent }]}>
        <Text style={styles.orderText}>{stop.visited ? '✓' : stop.order}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={[styles.name, { color: c.text }, stop.visited ? styles.nameVisited : null]}>{stop.name}</Text>
        <Text style={[styles.meta, { color: c.textSecondary }]}>
          {categoryLabel(stop.category)}
          {showStay ? `・滞在 約${stop.stay_minutes}分` : ''}
          {arrival ? `・${arrival}` : ''}
        </Text>
        {droppedByRoute ? (
          <Text style={[styles.meta, { color: c.warning }]}>実際の移動時間では時間内に入らないため、ルートからは外れています</Text>
        ) : null}
        {stop.address ? <Text style={[styles.meta, { color: c.textSecondary }]}>{stop.address}</Text> : null}
        <View style={styles.visitRow}>
          {stop.visited ? (
            <Tag c={c}>✓ 行った</Tag>
          ) : visiting ? (
            <ActivityIndicator color={c.accent} />
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onVisited}
              style={({ pressed }) => [styles.visitButton, { backgroundColor: busy ? c.disabled : pressed ? c.accentPressed : c.accent }]}>
              <Text style={[styles.visitText, { color: busy ? c.textSecondary : c.onAccent }]}>行った</Text>
            </Pressable>
          )}
        </View>
        {error ? <Text style={[styles.meta, { color: c.warning }]}>{error}</Text> : null}
      </View>
    </View>
  );
}

function Tag({ c, children }: { c: PlanPalette; children: ReactNode }) {
  return (
    <View style={[styles.tag, { backgroundColor: c.accentSoft }]}>
      <Text style={{ color: c.accentStrong, fontWeight: '800' }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  content: { padding: 20, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  header: { borderRadius: 24, borderWidth: 1, padding: 18, gap: 10 },
  title: { fontSize: 22, fontWeight: '800' },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
  done: { borderRadius: 20, borderWidth: 1.5, padding: 16, gap: 4 },
  doneTitle: { fontSize: 18, fontWeight: '800' },
  actions: { gap: 10 },
  notice: { borderRadius: 18, padding: 14, gap: 6 },
  timeline: { borderRadius: 24, borderWidth: 1, padding: 16, gap: 10 },
  startLine: { fontSize: 13, fontWeight: '700' },
  move: { fontSize: 12, marginLeft: 44 },
  moveBox: { borderRadius: 14, padding: 10, marginLeft: 44, gap: 4 },
  moveHead: { fontSize: 13, fontWeight: '800' },
  stop: { flexDirection: 'row', gap: 12 },
  order: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  orderText: { color: '#ffffff', fontWeight: '900', fontSize: 15 },
  name: { fontSize: 16, fontWeight: '800' },
  nameVisited: { textDecorationLine: 'line-through' },
  meta: { fontSize: 12, lineHeight: 18 },
  visitRow: { flexDirection: 'row', marginTop: 6 },
  visitButton: { borderRadius: 999, paddingHorizontal: 22, paddingVertical: 10 },
  visitText: { fontSize: 15, fontWeight: '800' },
  tag: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  footnote: { fontSize: 12, lineHeight: 18 },
});
