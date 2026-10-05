/**
 * v3.0 今日のルート提案（Step 4-5 の A/B/C プラン一覧を参照画面のデザインに）。
 * - 主提案: 淡いカード＋点線の縦タイムライン。代案2件
 * - 生成・採用は既存ストア（generate-plan-options / accept_plan）。選んだら「今日のルート」へ
 * - 時刻は直線距離からの目安。経路・運賃・営業時間は断言しない（くわしく見る → 実ルートの確認は従来の詳細画面）
 */
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { palettes } from '@/constants/theme';
import { budgetLabel, durationLabel } from '@/plan/plan-conditions';
import { budgetText, categoryLabel, formatClock, mainPlacesText, noticeText, TIME_DISCLAIMER, totalTimeText } from '@/plan/plan-option-format';
import { goToConditions, PlanLoading } from '@/plan/plan-option-views';
import type { PlanOption } from '@/plan/plan-options-client';
import { MAX_GENERATION_SEQUENCE } from '@/plan/plan-options-store';
import { planOptionsActions, usePlanOptions } from '@/plan/use-plan-options';
import { Icon } from '@/ui/icon';
import { BackLink, H1, H2, Notice, PrimaryButton, Screen, SecondaryButton, TextButton, Tiny, V } from '@/ui/kit';

const ALT_LABELS = ['主提案', '代案 1', '代案 2'];

export default function PlanResultsScreen() {
  const state = usePlanOptions();
  const selection = state.selection;

  if (state.status === 'generating') return <PlanLoading c={palettes.light} />;

  // 選んだプランの採用（accept_plan）が完了したら「今日のルート」へ
  const choose = async (plan: PlanOption) => {
    if (selection.status === 'accepted' && selection.planId === plan.plan_id) {
      router.push('/today');
      return;
    }
    await planOptionsActions.accept(plan.plan_id);
    const after = planOptionsActions.getState().selection;
    if (after.status === 'accepted' && after.planId === plan.plan_id) router.push('/today');
  };

  let body: React.ReactNode;
  if (state.status === 'error' && state.error) {
    const e = state.error;
    body = (
      <>
        <H1>{e.kind === 'unauthorized' ? 'ログインが必要です' : 'ルートを作れませんでした'}</H1>
        <Notice tone="warn">{e.message}</Notice>
        {e.retryable ? <PrimaryButton label="もう一度試す" onPress={() => planOptionsActions.retry()} /> : null}
        <SecondaryButton label="条件を変える" onPress={goToConditions} style={{ marginTop: 10 }} />
      </>
    );
  } else if (state.status !== 'ready' || !state.response) {
    body = (
      <>
        <H1>まだ提案がありません</H1>
        <Notice>条件を選んで「ルートを見てみる」を押してください。</Notice>
        <PrimaryButton label="条件を選ぶ" onPress={() => router.replace('/plan')} />
      </>
    );
  } else {
    const response = state.response;
    const [main, ...alts] = response.plans;
    const acceptedId = selection.status === 'accepted' ? selection.planId : null;
    const accepting = selection.status === 'accepting';
    const notice = noticeText(response.notice, response.plans.length);
    const c = state.conditions;
    body = (
      <>
        <H1 style={{ marginBottom: 11 }}>今日のルート提案</H1>
        <View style={styles.summary}>
          <Pill icon="pin" text="現在地から" />
          {c ? <Pill icon="clock" text={`希望 ${durationLabel(c.duration_minutes)}`} /> : null}
          {c ? <Pill icon="wallet" text={`希望 ${budgetLabel(c.budget_yen)}`} /> : null}
          {state.extra?.basedOnRoutePostId ? <Pill icon="users" text="みんなのルートから" /> : null}
        </View>
        {notice ? <Notice tone="warn" style={{ marginTop: 0 }}>{notice}</Notice> : null}
        {selection.status === 'error' ? <Notice tone="warn" style={{ marginTop: 0 }}>{selection.message}</Notice> : null}

        <View style={styles.main}>
          <Text style={styles.label}>{ALT_LABELS[0]}</Text>
          <H2 style={{ marginTop: 5, marginBottom: 3 }}>{main.title}</H2>
          <Text style={styles.description}>
            {main.items.length}か所を順番にめぐるプラン · {totalTimeText(main)} · {budgetText(main)}
          </Text>
          <View style={styles.timeline} accessibilityLabel="主提案の立ち寄り順">
            <Svg style={styles.dots} width={4} height="100%">
              <Line x1={2} y1={0} x2={2} y2="100%" stroke="#DBB8AF" strokeWidth={3} strokeDasharray="0.1 6" strokeLinecap="round" />
            </Svg>
            {main.items.map((item, i) => (
              <View key={item.place_id} style={styles.stop}>
                <View style={[styles.marker, { backgroundColor: i % 2 === 1 ? V.orange : V.coral }]}>
                  <Text style={styles.markerText}>{i + 1}</Text>
                </View>
                <View style={[styles.stopCard, { backgroundColor: i % 2 === 1 ? '#F3EFE8' : V.pale }]}>
                  <View style={styles.flex}>
                    <Text style={styles.stopSmall}>
                      {i + 1}か所目{item.estimated_arrival_at ? ` · ${formatClock(item.estimated_arrival_at)}頃（目安）` : ''}
                    </Text>
                    <Text style={styles.stopName}>{item.place_name}</Text>
                  </View>
                  <View style={styles.stopTile}>
                    <Text style={styles.stopTileText}>{categoryLabel(item.category)}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
          <PrimaryButton
            label={acceptedId === main.plan_id ? '今日のルートを開く →' : accepting ? '選んでいます…' : 'このルートを選ぶ →'}
            busy={accepting && selection.planId === main.plan_id}
            disabled={(!!acceptedId && acceptedId !== main.plan_id) || accepting}
            onPress={() => void choose(main)}
          />
          <View style={{ alignItems: 'center', marginTop: 6 }}>
            <TextButton label="くわしく見る（理由・営業時間）" onPress={() => router.push({ pathname: '/plan/results/[variant]', params: { variant: main.variant } })} />
          </View>
        </View>

        {alts.length > 0 ? (
          <View style={styles.sectionHead}>
            <H2>ほかの提案</H2>
          </View>
        ) : null}
        {alts.map((plan, i) => (
          <View key={plan.plan_id} style={styles.alt}>
            <Text style={styles.label}>{ALT_LABELS[i + 1]}</Text>
            <Text style={styles.altTitle}>{plan.title}</Text>
            <Text style={styles.altChain}>{mainPlacesText(plan)}</Text>
            <Text style={styles.altChain}>
              {totalTimeText(plan)} · {budgetText(plan)}
            </Text>
            <View style={styles.altActions}>
              <TextButton
                label={acceptedId === plan.plan_id ? '今日のルートを開く →' : 'このルートを選ぶ →'}
                onPress={() => (acceptedId && acceptedId !== plan.plan_id) || accepting ? undefined : void choose(plan)}
                color={(acceptedId && acceptedId !== plan.plan_id) || accepting ? V.sub : V.deep}
              />
              <TextButton label="くわしく見る" color={V.sub} onPress={() => router.push({ pathname: '/plan/results/[variant]', params: { variant: plan.variant } })} />
            </View>
          </View>
        ))}

        <Notice>{TIME_DISCLAIMER}</Notice>
        {state.generationSequence < MAX_GENERATION_SEQUENCE && !acceptedId ? (
          <SecondaryButton label="別のルートを考える" onPress={() => planOptionsActions.regenerate()} />
        ) : null}
        <Tiny style={{ marginTop: 10 }}>店舗・営業時間は出かける前にご確認ください。</Tiny>
      </>
    );
  }

  return (
    <Screen>
      <BackLink label="条件を変える" onPress={goToConditions} />
      {body}
    </Screen>
  );
}

function Pill({ icon, text }: { icon: 'pin' | 'clock' | 'wallet' | 'users'; text: string }) {
  return (
    <View style={styles.pill}>
      <Icon name={icon} size={12} color={V.ink} />
      <Text style={styles.pillText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  summary: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 18 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: V.soft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { fontSize: 11, color: V.ink },
  main: { paddingHorizontal: 14, paddingTop: 16, paddingBottom: 15, borderRadius: 19, backgroundColor: V.paper, borderWidth: 1, borderColor: V.line },
  label: { fontSize: 11, color: V.deep, fontWeight: '800' },
  description: { fontSize: 11, color: V.sub, marginBottom: 17 },
  timeline: { position: 'relative', gap: 14, marginBottom: 17 },
  dots: { position: 'absolute', left: 21, top: 20, bottom: 26 },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  marker: { width: 27, height: 27, borderRadius: 14, marginLeft: 9, marginRight: 11, alignItems: 'center', justifyContent: 'center' },
  markerText: { color: '#33231F', fontSize: 12, fontWeight: '800' },
  stopCard: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 14, padding: 9 },
  stopSmall: { fontSize: 10, color: V.sub, marginBottom: 2 },
  stopName: { fontSize: 12, lineHeight: 16, fontWeight: '800', color: V.ink },
  stopTile: { width: 47, height: 47, borderRadius: 9, backgroundColor: '#FFFFFFB3', alignItems: 'center', justifyContent: 'center', padding: 2 },
  stopTileText: { fontSize: 9, color: V.deep, fontWeight: '800', textAlign: 'center' },
  sectionHead: { marginTop: 25, marginBottom: 4 },
  alt: { borderWidth: 1, borderColor: V.line, borderRadius: 15, paddingHorizontal: 14, paddingVertical: 12, marginVertical: 9, backgroundColor: V.white },
  altTitle: { fontSize: 14, fontWeight: '800', color: V.ink, marginVertical: 4 },
  altChain: { fontSize: 11, color: V.sub, lineHeight: 17 },
  altActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
});
