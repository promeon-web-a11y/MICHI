/**
 * Step 4-7: 選択したプランの地図（/plan/results/[variant]/map）。
 * このセッションで生成・選択したプランの確認だけを行い、地図の本体は PlanRouteMapBody（/today/map と共有）。
 */
import { router, useLocalSearchParams } from 'expo-router';

import { PillButton, PlanMessage } from '@/plan/plan-option-views';
import { PlanRouteMapBody } from '@/plan/plan-route-map-screen';
import { usePlanPalette } from '@/plan/plan-theme';
import { usePlanOptions } from '@/plan/use-plan-options';

export default function PlanRouteMapScreen() {
  const c = usePlanPalette();
  const { variant } = useLocalSearchParams<{ variant: string }>();
  const state = usePlanOptions();
  const plan = state.response?.plans.find((p) => p.variant === variant);
  const accepted = !!plan && state.selection.status === 'accepted' && state.selection.planId === plan.plan_id;

  if (!plan) {
    return (
      <PlanMessage c={c} icon="🔍" title="プランが見つかりませんでした" body="プランの一覧からもう一度選んでください。">
        <PillButton c={c} primary label="プランの一覧へ" onPress={() => router.replace('/plan/results')} />
      </PlanMessage>
    );
  }
  if (!accepted) {
    return (
      <PlanMessage c={c} icon="🗺️" title="プランを選ぶと地図でルートを確認できます" body="詳細画面の「このプランにする」を押してください。">
        <PillButton c={c} primary label="プランの詳細へ" onPress={() => router.back()} />
      </PlanMessage>
    );
  }
  return <PlanRouteMapBody planId={plan.plan_id} badge={plan.variant} />;
}
