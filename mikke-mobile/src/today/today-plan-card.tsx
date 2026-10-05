/**
 * ホーム画面の「今日のプラン」カード。accepted のプランがあるときだけ表示する（無ければ何も出さない）。
 * Supabase から取得するので、アプリを再起動しても表示される。
 * 見た目は v3 の共通部品（kit の色・主ボタン）にそろえる。ボタンの文字は本文色（コーラル上で 5.0:1）
 */
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { PrimaryButton, V } from '@/ui/kit';

import { useTodayPlan } from './use-today-plan';

export function TodayPlanCard() {
  const { state } = useTodayPlan();
  const plan = state.plan;
  if (!plan) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.label}>今日のプラン</Text>
      <Text style={styles.title} numberOfLines={2}>
        {plan.title}
      </Text>
      <Text style={styles.sub}>{plan.completed ? '今日のプラン完了' : `訪問 ${plan.visited_count} / ${plan.stops.length} スポット`}</Text>
      <PrimaryButton label="続きを見る →" onPress={() => router.push('/today')} style={{ marginTop: 10 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, borderColor: V.line, backgroundColor: V.white, padding: 16, gap: 4, marginBottom: 4 },
  label: { fontSize: 11, fontWeight: '800', color: V.deep },
  title: { fontSize: 17, lineHeight: 24, fontWeight: '800', color: V.ink },
  sub: { fontSize: 12, color: V.sub },
});
