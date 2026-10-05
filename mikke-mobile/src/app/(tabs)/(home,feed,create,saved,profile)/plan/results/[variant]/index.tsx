/**
 * Step 4-5 / 4-6: プラン詳細。回る順番をタイムラインで見せ、「このプランにする」で選ぶ（既存 accept_plan RPC）。
 * - 選ぶ前: 時刻は目安。移動の所要時間・路線・運賃は表示しない
 * - 選んだ後: route-plan（Google Routes API）の実ルートに置き換える（PlanRouteSection）
 */
import { router, useLocalSearchParams } from 'expo-router';
import { Fragment, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader, BackLink, V } from '@/ui/kit';

import {
  budgetText,
  categoryLabel,
  formatClock,
  TIME_DISCLAIMER,
  totalTimeText,
} from '@/plan/plan-option-format';
import { PillButton, PlanLoading, PlanMessage, VariantBadge } from '@/plan/plan-option-views';
import type { PlanOptionItem } from '@/plan/plan-options-client';
import { PlanRouteSection } from '@/plan/plan-route-view';
import { usePlanPalette, type PlanPalette } from '@/plan/plan-theme';
import { planOptionsActions, usePlanOptions } from '@/plan/use-plan-options';

export default function PlanDetailScreen() {
  const c = usePlanPalette();
  const { variant } = useLocalSearchParams<{ variant: string }>();
  const state = usePlanOptions();

  if (state.status === 'generating') return <PlanLoading c={c} />;
  const plan = state.response?.plans.find((p) => p.variant === variant);
  if (!plan) {
    return (
      <PlanMessage c={c} icon="🔍" title="プランが見つかりませんでした" body="プランの一覧からもう一度選んでください。">
        <PillButton c={c} primary label="プランの一覧へ" onPress={() => router.replace('/plan/results')} />
      </PlanMessage>
    );
  }

  const selection = state.selection;
  const acceptedHere = selection.status === 'accepted' && selection.planId === plan.plan_id;
  const acceptedOther = selection.status === 'accepted' && selection.planId !== plan.plan_id;
  const accepting = selection.status === 'accepting';
  const acceptError = selection.status === 'error' && selection.planId === plan.plan_id ? selection.message : null;
  const otherVariant = acceptedOther ? state.response?.plans.find((p) => p.plan_id === selection.planId)?.variant : null;

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: V.white }]}>
      <AppHeader />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 150 }]}>
        <BackLink label="提案の一覧" />
        <View style={styles.header}>
          <VariantBadge c={c} variant={plan.variant} size={44} />
          <View style={styles.flex}>
            <Text style={[styles.title, { color: c.text }]}>{plan.title}</Text>
            <Text style={[styles.concept, { color: c.accentStrong }]}>{plan.concept}</Text>
          </View>
        </View>
        <Text style={[styles.summary, { color: c.text }]}>{plan.summary}</Text>
        <View style={styles.metaRow}>
          <Meta c={c} text={`⏰ ${totalTimeText(plan)}`} />
          <Meta c={c} text={`💴 ${budgetText(plan)}`} />
          <Meta c={c} text={`📍 ${plan.items.length}か所`} />
        </View>

        {acceptedHere ? (
          <PlanRouteSection
            c={c}
            planId={plan.plan_id}
            onOpenMap={() => router.push({ pathname: '/plan/results/[variant]/map', params: { variant: plan.variant } })}
          />
        ) : (
          <>
            <View style={[styles.timeline, { backgroundColor: c.card, borderColor: c.border }]}>
              <TimelineRow c={c} time={formatClock(plan.estimated_start_at)} dot="start">
                <Text style={[styles.placeName, { color: c.text }]}>現在地から出発</Text>
              </TimelineRow>
              {plan.items.map((item) => (
                <Fragment key={item.place_id}>
                  <MoveRow c={c} />
                  <StopRow c={c} item={item} />
                </Fragment>
              ))}
            </View>
            <Text style={[styles.disclaimer, { color: c.textSecondary }]}>{TIME_DISCLAIMER}</Text>
          </>
        )}
      </ScrollView>

      <View style={[styles.ctaBar, { backgroundColor: c.background, borderTopColor: c.border, paddingBottom: 12 }]}>
        {acceptError ? <Text style={[styles.ctaNote, { color: c.warning }]}>{acceptError}</Text> : null}
        {acceptedHere ? (
          <Text style={[styles.ctaNote, { color: c.text }]}>このプランに決めました！ 実際の移動ルートを上に表示しています。</Text>
        ) : acceptedOther ? (
          <Text style={[styles.ctaNote, { color: c.textSecondary }]}>プラン{otherVariant}を選択済みです</Text>
        ) : null}
        <PillButton
          c={c}
          primary
          disabled={acceptedOther || accepting}
          label={acceptedHere ? '今日のプランを開く' : accepting ? '選んでいます…' : 'このプランにする'}
          onPress={() => (acceptedHere ? router.push('/today') : planOptionsActions.accept(plan.plan_id))}
        />
      </View>
    </SafeAreaView>
  );
}

function TimelineRow({
  c,
  time,
  dot,
  children,
}: {
  c: PlanPalette;
  time: string;
  dot: 'start' | 'stop';
  children: ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.time, { color: c.text }]}>{time ? `${time}頃` : ''}</Text>
      <View style={styles.rail}>
        <View style={[styles.dot, dot === 'start' ? { backgroundColor: c.textSecondary } : { backgroundColor: c.accent }]} />
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function MoveRow({ c }: { c: PlanPalette }) {
  return (
    <View style={styles.row}>
      <Text style={styles.time} />
      <View style={styles.rail}>
        <View style={[styles.line, { backgroundColor: c.border }]} />
      </View>
      <View style={[styles.body, styles.moveBody]}>
        <Text style={[styles.move, { color: c.textSecondary }]}>↓ 移動　「このプランにする」で実際のルートを確認できます</Text>
      </View>
    </View>
  );
}

function StopRow({ c, item }: { c: PlanPalette; item: PlanOptionItem }) {
  return (
    <TimelineRow c={c} time={formatClock(item.estimated_arrival_at)} dot="stop">
      <Text style={[styles.placeName, { color: c.text }]}>{item.place_name}</Text>
      <Text style={[styles.placeMeta, { color: c.textSecondary }]}>
        {categoryLabel(item.category)}・滞在 約{item.estimated_stay_minutes}分
      </Text>
      <Text style={[styles.reason, { color: c.text }]}>「{item.reason}」</Text>
      {item.address ? <Text style={[styles.placeMeta, { color: c.textSecondary }]}>{item.address}</Text> : null}
      <Text style={[styles.hours, { color: item.hours_status === 'confirmed_open' ? c.accentStrong : c.textSecondary }]}>
        {item.hours_status === 'confirmed_open' ? '登録された営業時間内です' : '営業時間は未確認です'}
      </Text>
    </TimelineRow>
  );
}

function Meta({ c, text }: { c: PlanPalette; text: string }) {
  return (
    <View style={[styles.meta, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.metaText, { color: c.text }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 20, gap: 14 },
  header: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800' },
  concept: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  summary: { fontSize: 15, lineHeight: 22 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  meta: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  metaText: { fontSize: 13, fontWeight: '700' },
  timeline: { borderRadius: 24, borderWidth: 1, paddingVertical: 16, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  time: { width: 58, fontSize: 14, fontWeight: '800', paddingTop: 1 },
  rail: { width: 22, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  line: { width: 2, flex: 1, minHeight: 28 },
  body: { flex: 1, gap: 3, paddingBottom: 6 },
  moveBody: { justifyContent: 'center', paddingVertical: 6 },
  move: { fontSize: 12 },
  placeName: { fontSize: 16, fontWeight: '800' },
  placeMeta: { fontSize: 13 },
  reason: { fontSize: 14, lineHeight: 20, marginTop: 2 },
  hours: { fontSize: 12, fontWeight: '600' },
  disclaimer: { fontSize: 12, lineHeight: 18 },
  ctaBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, gap: 8, borderTopWidth: 1 },
  ctaNote: { fontSize: 13, textAlign: 'center' },
});
