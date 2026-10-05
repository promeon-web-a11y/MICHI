/**
 * Step 4-6: 選択したプランの実ルート表示（詳細画面に組み込む）。
 * 表示する経路・時刻・運賃はすべて Google Routes API の応答から。取れない値は「情報なし」とし推測しない。
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useCurrentLocation } from '@/location/use-current-location';
import { appLog } from '@/lib/logger';

import { categoryLabel, formatClock } from './plan-option-format';
import { PillButton } from './plan-option-views';
import type { RoutedPlan, RouteLeg, RouteStep } from './plan-route-client';
import {
  budgetSummaryText,
  distanceText,
  faresSummaryText,
  fitMessage,
  legFailureText,
  legFareText,
  legMapsLinks,
  minutesText,
  modeLabel,
  TRANSIT_HANDOFF_TEXT,
  transitNoteText,
  vehicleLabel,
  walkReferenceText,
  type MapsLink,
} from './plan-route-format';
import type { PlanPalette } from './plan-theme';
import { planRouteActions, routeOrigin, usePlanRoutes } from './use-plan-route';

export function PlanRouteSection({ c, planId, onOpenMap }: { c: PlanPalette; planId: string; onOpenMap?: () => void }) {
  const entry = usePlanRoutes()[planId];
  const location = useCurrentLocation();
  const [needsOrigin, setNeedsOrigin] = useState(false);

  useEffect(() => {
    // 選択直後・再表示時に1回。キャッシュが新しければ通信しない
    planRouteActions.load(planId).then((started) => setNeedsOrigin(!started));
  }, [planId]);

  const retry = async (force: boolean) => {
    if (!routeOrigin()) {
      const r = await location.locate({ prompt: true });
      if (!r.ok) return;
    }
    const started = await planRouteActions.load(planId, { force });
    setNeedsOrigin(!started);
  };

  if (needsOrigin && !entry) {
    return (
      <Notice c={c}>
        <Text style={{ color: c.text }}>実際の移動ルートを調べるには現在地が必要です。</Text>
        {location.message ? <Text style={{ color: c.textSecondary }}>{location.message}</Text> : null}
        <PillButton c={c} label="📍 現在地を取得してルートを調べる" onPress={() => retry(false)} />
      </Notice>
    );
  }
  if (!entry || (entry.status === 'loading' && !entry.data)) {
    return (
      <Notice c={c}>
        <View style={styles.row}>
          <ActivityIndicator color={c.accent} />
          <Text style={{ color: c.text }}>実際の移動ルートを調べています…</Text>
        </View>
      </Notice>
    );
  }
  if (entry.status === 'error') {
    return (
      <Notice c={c}>
        <Text style={{ color: c.text }}>{entry.error.message}</Text>
        {entry.error.retryable || entry.error.kind === 'origin_required' ? (
          <PillButton c={c} label="もう一度試す" onPress={() => retry(true)} />
        ) : null}
      </Notice>
    );
  }
  const data = entry.data!;
  return (
    <View style={styles.gap}>
      {onOpenMap ? <PillButton c={c} primary label="🗺️ 地図でルートを見る" onPress={onOpenMap} /> : null}
      <RouteSummary c={c} route={data} />
      <RouteTimeline c={c} route={data} />
      <Text style={[styles.footnote, { color: c.textSecondary }]}>
        経路・時刻・運賃は Google の情報です。運賃が取得できない区間は表示していません。ガソリン代・駐車料金・高速料金は含みません。
      </Text>
      <Pressable onPress={() => retry(true)} disabled={entry.status === 'loading'} hitSlop={8} style={styles.refresh}>
        <Text style={[styles.link, { color: c.accentStrong }]}>{entry.status === 'loading' ? '更新中…' : 'ルートを更新'}</Text>
      </Pressable>
    </View>
  );
}

function RouteSummary({ c, route }: { c: PlanPalette; route: RoutedPlan }) {
  const fit = fitMessage(route);
  const over = route.budget.over_budget === true;
  const dropped = route.adjustments.filter((a) => a.type === 'dropped_place');
  return (
    <View style={[styles.summary, { backgroundColor: route.fit_status === 'does_not_fit' || over ? c.warningSoft : c.accentSoft }]}>
      {fit ? <Text style={[styles.summaryStrong, { color: c.text }]}>{fit}</Text> : null}
      {route.total_minutes !== null ? (
        <Text style={{ color: c.text }}>
          ⏰ {formatClock(route.departure_at)} 出発 → {route.end_at ? `${formatClock(route.end_at)} ごろ終了` : ''}（{route.total_minutes}分・指定 {route.duration_minutes}分）
        </Text>
      ) : null}
      <Text style={{ color: c.text }}>🚉 {faresSummaryText(route.fares)}</Text>
      <Text style={[over ? styles.summaryStrong : null, { color: over ? c.warning : c.text }]}>💴 {budgetSummaryText(route.budget)}</Text>
      {dropped.length > 0 ? (
        <Text style={{ color: c.textSecondary }}>時間内に収めるため外した場所: {dropped.map((d) => d.place_name).join('、')}</Text>
      ) : null}
    </View>
  );
}

function RouteTimeline({ c, route }: { c: PlanPalette; route: RoutedPlan }) {
  const origin = routeOrigin();
  return (
    <View style={[styles.timeline, { backgroundColor: c.card, borderColor: c.border }]}>
      <Row c={c} time={formatClock(route.departure_at)} dot={c.textSecondary}>
        <Text style={[styles.place, { color: c.text }]}>現在地を出発</Text>
      </Row>
      {route.legs.map((leg, i) => {
        const stop = route.stops[i];
        const links = legMapsLinks(route, i, origin);
        return (
          <Fragment key={`${leg.index}-${stop.place_id}`}>
            <LegBlock c={c} leg={leg} links={links} />
            <Row c={c} time={stop.arrival_at ? formatClock(stop.arrival_at) : '—'} dot={c.accent}>
              <Text style={[styles.place, { color: c.text }]}>{stop.name}</Text>
              <Text style={[styles.meta, { color: c.textSecondary }]}>
                {categoryLabel(stop.category)}・滞在 {stop.stay_minutes}分
                {stop.stay_minutes !== stop.original_stay_minutes ? `（元 ${stop.original_stay_minutes}分）` : ''}
                {stop.leave_at ? `・${formatClock(stop.leave_at)} ごろ出発` : ''}
              </Text>
              {!stop.arrival_at ? (
                <Text style={[styles.meta, { color: c.warning }]}>
                  {leg.status === 'external_transit' || leg.times_uncertain
                    ? '到着時刻は公共交通のルートによって変わります'
                    : '到着時刻は確認できませんでした'}
                </Text>
              ) : null}
            </Row>
          </Fragment>
        );
      })}
    </View>
  );
}

export function MapsLinkButton({ c, link, strong }: { c: PlanPalette; link: MapsLink; strong?: boolean }) {
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() => Linking.openURL(link.url).catch((e) => appLog.warn('Google マップを開けませんでした', e))}
      style={({ pressed }) => [strong ? [styles.strongLink, { borderColor: c.accent }] : null, { opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.link, { color: c.accentStrong }]}>{link.label} ›</Text>
    </Pressable>
  );
}

function LegBlock({ c, leg, links }: { c: PlanPalette; leg: RouteLeg; links: ReturnType<typeof legMapsLinks> }) {
  const fare = legFareText(leg);
  const mode = modeLabel(leg.mode);
  const walkRef = walkReferenceText(leg);
  return (
    <View style={styles.row}>
      <Text style={styles.time} />
      <View style={styles.rail}>
        <View style={[styles.line, { backgroundColor: c.border }]} />
      </View>
      <View style={[styles.legBody, { backgroundColor: c.background }]}>
        {leg.status === 'failed' ? (
          <Text style={{ color: c.warning }}>❔ {legFailureText(leg)}</Text>
        ) : leg.status === 'external_transit' ? (
          // 公共交通: 路線・時刻・所要時間・運賃は Mikke では出さず、Google マップへ誘導する
          <>
            <Text style={[styles.legHead, { color: c.text }]}>🚉 公共交通</Text>
            <Text style={[styles.meta, { color: c.text }]}>{TRANSIT_HANDOFF_TEXT}</Text>
            {walkRef ? <Text style={[styles.meta, { color: c.textSecondary }]}>{walkRef}</Text> : null}
          </>
        ) : (
          <>
            <Text style={[styles.legHead, { color: c.text }]}>
              {mode.icon} {mode.label} {leg.duration_minutes}分
              {leg.mode !== 'TRANSIT' && distanceText(leg.distance_meters) ? `・${distanceText(leg.distance_meters)}` : ''}
            </Text>
            {leg.mode === 'TRANSIT' ? leg.steps.map((s, i) => <StepLine key={i} c={c} step={s} />) : null}
            {fare ? <Text style={[styles.meta, { color: c.text }]}>{fare}</Text> : null}
            {transitNoteText(leg) ? (
              <Text style={[styles.meta, { color: c.textSecondary }]}>{transitNoteText(leg)}</Text>
            ) : null}
            {leg.alternatives.length > 0 ? (
              <Text style={[styles.meta, { color: c.textSecondary }]}>
                ほかの手段: {leg.alternatives.map((a) => `${modeLabel(a.mode).label} ${a.duration_minutes}分`).join('・')}
              </Text>
            ) : null}
            {leg.times_uncertain ? (
              <Text style={[styles.meta, { color: c.warning }]}>前の区間の所要時間が確定していないため、時刻は目安です</Text>
            ) : null}
          </>
        )}
        {links.primary ? <MapsLinkButton c={c} link={links.primary} strong={leg.status === 'external_transit'} /> : null}
        {links.transit ? <MapsLinkButton c={c} link={links.transit} /> : null}
      </View>
    </View>
  );
}

function StepLine({ c, step }: { c: PlanPalette; step: RouteStep }) {
  if (step.kind !== 'transit') {
    const d = distanceText(step.distance_meters);
    return (
      <Text style={[styles.meta, { color: c.textSecondary }]}>
        {step.kind === 'walk' ? '🚶 徒歩' : '🚗 車'} {minutesText(step.duration_seconds)}
        {d ? `・${d}` : ''}
      </Text>
    );
  }
  const v = vehicleLabel(step);
  const line = step.line_name ?? step.line_short_name;
  return (
    <View style={[styles.transit, { borderLeftColor: step.line_color ?? c.accent }]}>
      <Text style={[styles.legHead, { color: c.text }]}>
        {v.icon} {line ? `${line}（${v.label}）` : v.label}
      </Text>
      <Text style={{ color: c.text }}>
        {step.departure_stop ?? '乗車駅不明'} → {step.arrival_stop ?? '降車駅不明'}
      </Text>
      <Text style={[styles.meta, { color: c.textSecondary }]}>
        {step.departure_at && step.arrival_at ? `${formatClock(step.departure_at)} → ${formatClock(step.arrival_at)}` : '時刻情報なし'}
        {step.stop_count !== null ? `・${step.stop_count}駅` : ''}
        {step.headsign ? `・${step.headsign}方面` : ''}
      </Text>
    </View>
  );
}

function Row({ c, time, dot, children }: { c: PlanPalette; time: string; dot: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.time, { color: c.text }]}>{time}</Text>
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function Notice({ c, children }: { c: PlanPalette; children: ReactNode }) {
  return <View style={[styles.notice, { backgroundColor: c.card, borderColor: c.border }]}>{children}</View>;
}

const styles = StyleSheet.create({
  gap: { gap: 12 },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 0 },
  notice: { borderRadius: 20, borderWidth: 1, padding: 16, gap: 10 },
  summary: { borderRadius: 20, padding: 14, gap: 6 },
  summaryStrong: { fontWeight: '800' },
  timeline: { borderRadius: 24, borderWidth: 1, paddingVertical: 16, paddingHorizontal: 12 },
  time: { width: 50, fontSize: 14, fontWeight: '800', paddingTop: 1 },
  rail: { width: 20, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  line: { width: 2, flex: 1, minHeight: 24 },
  body: { flex: 1, gap: 3, paddingBottom: 6 },
  legBody: { flex: 1, borderRadius: 14, padding: 10, marginVertical: 6, gap: 4 },
  legHead: { fontSize: 14, fontWeight: '800' },
  transit: { borderLeftWidth: 4, paddingLeft: 8, gap: 2, marginVertical: 2 },
  place: { fontSize: 16, fontWeight: '800' },
  meta: { fontSize: 12 },
  link: { fontSize: 13, fontWeight: '800', marginTop: 2 },
  strongLink: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, alignSelf: 'flex-start', marginTop: 4 },
  footnote: { fontSize: 12, lineHeight: 18 },
  refresh: { alignSelf: 'flex-end' },
});
