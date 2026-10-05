/**
 * 選択したプラン（accepted）の地図の本体。
 * Step 4-7 の /plan/results/[variant]/map と Step 4-8 の /today/map で共有する（プラン ID だけで動く）。
 * 現在地 → 場所1 → 場所2 … を、番号付きピンと Google の実ルートの経路線で表示する。
 *
 * - 経路は Step 4-6 の route-plan の結果（10分キャッシュ）を再利用。取得済みなら通信しない
 * - 経路線は取得できた区間だけ。公共交通は Google マップへ誘導し、路線・時刻・運賃は表示しない
 * - accepted かどうかの確認は呼び出し側で行う（route-plan もサーバー側で accepted 以外を拒否する）
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCurrentLocation } from '@/location/use-current-location';

import { categoryLabel, formatClock } from './plan-option-format';
import { PillButton, PlanMessage, VariantBadge } from './plan-option-views';
import type { RoutedPlan } from './plan-route-client';
import { legMapsLinks } from './plan-route-format';
import { buildRouteMapModel, nextMoveText, planMapSummary } from './plan-route-map-data';
import { PlanRouteMapView } from './plan-route-map-view';
import { MapsLinkButton } from './plan-route-view';
import { usePlanPalette, type PlanPalette } from './plan-theme';
import { planRouteActions, routeOrigin, usePlanRoutes } from './use-plan-route';

const DEFAULT_SHEET_HEIGHT = 200;

export function PlanRouteMapBody({ planId, badge }: { planId: string; badge: string }) {
  const c = usePlanPalette();
  const insets = useSafeAreaInsets();
  const location = useCurrentLocation();
  const entry = usePlanRoutes()[planId];
  const [selectedIndex, setSelectedIndex] = useState<number | null>(0);
  const [sheetHeight, setSheetHeight] = useState(DEFAULT_SHEET_HEIGHT);
  const [noOrigin, setNoOrigin] = useState(false);

  // 取得済み（10分以内・同じ出発地点）ならキャッシュを使い通信しない
  useEffect(() => {
    planRouteActions.load(planId).then((started) => setNoOrigin(!started));
  }, [planId]);

  const locateAndLoad = async () => {
    const r = await location.locate({ prompt: true });
    if (!r.ok) return;
    const started = await planRouteActions.load(planId);
    setNoOrigin(!started);
  };

  if (noOrigin && !entry) {
    return (
      <PlanMessage c={c} icon="📍" title="現在地が分かりません" body={location.message ?? 'ルートを表示するには現在地が必要です。'}>
        <PillButton c={c} primary label="📍 現在地を取得する" onPress={locateAndLoad} />
        <PillButton c={c} label="戻る" onPress={() => router.back()} />
      </PlanMessage>
    );
  }
  if (!entry || (entry.status === 'loading' && !entry.data)) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.accent} size="large" />
        <Text style={{ color: c.text }}>ルートを準備しています…</Text>
      </View>
    );
  }
  if (entry.status === 'error') {
    return (
      <PlanMessage c={c} icon="🙏" title="ルートを表示できませんでした" body={entry.error.message}>
        {entry.error.retryable ? (
          <PillButton c={c} primary label="もう一度試す" onPress={() => planRouteActions.load(planId, { force: true })} />
        ) : null}
        <PillButton c={c} label="戻る" onPress={() => router.back()} />
      </PlanMessage>
    );
  }

  const route = entry.data!;
  const model = buildRouteMapModel(route, routeOrigin());
  const summary = planMapSummary(route);
  const selected = model.stops.find((s) => s.index === selectedIndex) ?? model.stops[0] ?? null;

  return (
    <View style={[styles.flex, { backgroundColor: c.background }]}>
      <PlanRouteMapView
        c={c}
        model={model}
        selectedIndex={selected?.index ?? null}
        onSelect={setSelectedIndex}
        bottomInset={sheetHeight + insets.bottom}
      />

      {/* 上部: プランの概要（取れた情報だけ） */}
      <View style={styles.top} pointerEvents="box-none">
        <View style={[styles.summary, styles.shadow, { backgroundColor: c.card }]}>
          <VariantBadge c={c} variant={badge} size={28} />
          <Text style={[styles.summaryText, { color: c.text }]} numberOfLines={2}>
            {summary.join('・')}
          </Text>
        </View>
        {model.missingStops > 0 || model.legsWithoutLine > 0 ? (
          <View style={[styles.note, { backgroundColor: c.warningSoft }]}>
            <Text style={[styles.noteText, { color: c.text }]}>
              {[
                model.missingStops > 0 ? `位置情報の無い場所 ${model.missingStops}件は地図に出していません` : null,
                model.legsWithoutLine > 0 ? '経路線の無い区間は、下のカードから Google マップで確認できます' : null,
              ]
                .filter(Boolean)
                .join('。')}
            </Text>
          </View>
        ) : null}
      </View>

      {/* 下部: 選択中の場所カード（将来 Bottom Sheet にする場所） */}
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
        pointerEvents="box-none"
        onLayout={(e) => setSheetHeight(Math.round(e.nativeEvent.layout.height - insets.bottom))}>
        {selected ? (
          <StopCard c={c} route={route} index={selected.index} order={selected.order} />
        ) : (
          <View style={[styles.card, styles.shadow, { backgroundColor: c.card }]}>
            <Text style={{ color: c.textSecondary }}>地図に表示できる場所がありません</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function StopCard({ c, route, index, order }: { c: PlanPalette; route: RoutedPlan; index: number; order: number }) {
  const stop = route.stops[index];
  const next = nextMoveText(route, index);
  // この場所までの行き方（公共交通なら Google マップの公共交通ルート）
  const links = legMapsLinks(route, index, routeOrigin());
  return (
    <View style={[styles.card, styles.shadow, { backgroundColor: c.card }]}>
      <View style={styles.cardHead}>
        <View style={[styles.order, { backgroundColor: c.accent }]}>
          <Text style={styles.orderText}>{order}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>
            {stop.name}
          </Text>
          <Text style={{ color: c.textSecondary, fontSize: 13 }}>{categoryLabel(stop.category)}</Text>
        </View>
      </View>
      {stop.address ? (
        <Text style={{ color: c.textSecondary, fontSize: 13 }} numberOfLines={2}>
          {stop.address}
        </Text>
      ) : null}
      <Text style={{ color: c.text, fontSize: 14 }}>
        {stop.arrival_at ? `${formatClock(stop.arrival_at)} ごろ到着` : '到着時刻は未確定'}・滞在 {stop.stay_minutes}分
      </Text>
      <Text style={{ color: c.text, fontSize: 14 }}>{next ? `次の移動: ${next}` : 'プランの最後の場所です'}</Text>
      <View style={styles.links}>
        {links.primary ? <MapsLinkButton c={c} link={{ ...links.primary, label: `ここへの行き方: ${links.primary.label}` }} /> : null}
        {links.transit ? <MapsLinkButton c={c} link={links.transit} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  top: { position: 'absolute', top: 12, left: 12, right: 12, gap: 8 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  summaryText: { flex: 1, fontSize: 13, fontWeight: '700' },
  note: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  noteText: { fontSize: 12 },
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 0 },
  card: { borderRadius: 24, padding: 16, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  order: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  orderText: { color: '#ffffff', fontWeight: '900', fontSize: 16 },
  name: { fontSize: 18, fontWeight: '800' },
  links: { gap: 4, marginTop: 2 },
  shadow: {
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
});
