/**
 * Step 4-8: 今日のプランの地図（/today/map）。Step 4-7 の地図本体（PlanRouteMapBody）をそのまま使う。
 * プランは Supabase から復元した今日のプラン（アプリ再起動後も開ける）。
 */
import { router } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { PillButton, PlanMessage } from '@/plan/plan-option-views';
import { PlanRouteMapBody } from '@/plan/plan-route-map-screen';
import { usePlanPalette } from '@/plan/plan-theme';
import { useTodayPlan } from '@/today/use-today-plan';

export default function TodayMapScreen() {
  const c = usePlanPalette();
  const { state, reload } = useTodayPlan();

  if (state.phase === 'unauthorized') return <SavedPlacesUnauthorized description="今日のプランを見るにはログインしてください。" />;
  if (state.plan) return <PlanRouteMapBody planId={state.plan.plan_id} badge={state.plan.variant ?? '✓'} />;
  if (state.phase === 'loading' || state.phase === 'idle') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.accent} size="large" />
      </View>
    );
  }
  if (state.phase === 'error') {
    return (
      <PlanMessage c={c} icon="🙏" title="今日のプランを読み込めませんでした" body="通信環境を確認して、もう一度お試しください。">
        <PillButton c={c} primary label="もう一度試す" onPress={reload} />
      </PlanMessage>
    );
  }
  return (
    <PlanMessage c={c} icon="✨" title="今日のプランはまだありません">
      <PillButton c={c} primary label="今日どこ行く？" onPress={() => router.replace('/plan')} />
    </PlanMessage>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
