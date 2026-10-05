/**
 * v3.0 保存一覧「ルート」から開く、自分が選んだルート（採用済みプラン）。立ち寄り順と訪問の状況、記録への導線。
 * 今日のプラン（直近24時間）なら /today と同じ内容を、地図・実ルートを含めてそちらで見られる。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useApiResource } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { categoryLabel } from '@/plan/plan-option-format';
import { dateText } from '@/routes/route-format';
import { loadAcceptedPlan } from '@/today/load-accepted-plan';
import { useTodayPlan } from '@/today/use-today-plan';
import { BackLink, ErrorState, H1, Loading, Muted, PrimaryButton, Screen, SecondaryButton, V } from '@/ui/kit';

export default function PlanHistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const plan = useApiResource(id ? `plan:${id}` : null, (opts) => loadAcceptedPlan(String(id), opts), { staleMs: 10_000 });
  const { state: today } = useTodayPlan();

  if (plan.phase === 'unauthorized') return <SavedPlacesUnauthorized description="ルートを見るにはログインしてください。" />;

  let body: React.ReactNode;
  if (plan.phase === 'loading' || plan.phase === 'idle') body = <Loading />;
  else if (!plan.data) body = <ErrorState message={plan.message} onRetry={plan.reload} />;
  else {
    const p = plan.data;
    const isToday = today.plan?.plan_id === p.plan_id;
    body = (
      <>
        <H1>{p.title}</H1>
        <Muted>
          {dateText(p.accepted_at)}に選んだルート · 行った {p.visited_count} / {p.stops.length}か所
        </Muted>
        <View style={{ marginTop: 12 }}>
          {p.stops.map((s, i) => (
            <View key={s.place_id} style={styles.step}>
              <View style={[styles.number, s.visited ? { backgroundColor: V.coral } : null]}>
                <Text style={[styles.numberText, s.visited ? { color: V.white } : null]}>{s.visited ? '✓' : i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{s.name}</Text>
                <Text style={styles.sub}>
                  {categoryLabel(s.category)} · {s.visited ? '行った' : 'まだ記録していません'}
                </Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ gap: 10, marginTop: 20 }}>
          {isToday ? <SecondaryButton label="今日のルート（地図・移動）を開く" onPress={() => router.push('/today')} /> : null}
          <PrimaryButton label="お出かけを記録" onPress={() => router.push({ pathname: '/record', params: { planId: p.plan_id } })} />
        </View>
      </>
    );
  }
  return (
    <Screen>
      <BackLink />
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: V.line },
  number: { width: 28, height: 28, borderRadius: 14, backgroundColor: V.pale, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: V.deep, fontWeight: '800' },
  name: { fontSize: 14, fontWeight: '800', color: V.ink },
  sub: { fontSize: 12, color: V.sub },
});
