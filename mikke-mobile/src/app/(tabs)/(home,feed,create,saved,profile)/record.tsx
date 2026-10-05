/**
 * v3.0 記録入力「今日の記録を残そう」。採用済みプランの立ち寄り先から、実際に行った場所だけを選んで
 * 非公開の記録として保存する（create_visit_record。既存の answer_visit にも反映され、訪問KPIの正本は変わらない）。
 * 公開は保存一覧「行った記録」→ 投稿画面での明示操作だけ。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiOptions, callApi, useApiResource } from '@/lib/use-api-resource';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { categoryLabel } from '@/plan/plan-option-format';
import { cleanupRoutePhotos, createVisitRecord, MAX_MEMORY_LENGTH } from '@/routes/route-posts-client';
import { routeSync } from '@/routes/use-route-sync';
import { loadAcceptedPlan } from '@/today/load-accepted-plan';
import { invalidateTodayPlan } from '@/today/use-today-plan';
import { Icon } from '@/ui/icon';
import { BackLink, ErrorState, Field, FormGroup, H1, Loading, Muted, Notice, PrimaryButton, Screen, V } from '@/ui/kit';

export default function RecordScreen() {
  const { planId } = useLocalSearchParams<{ planId: string }>();
  const plan = useApiResource(planId ? `plan:${planId}` : null, (opts) => loadAcceptedPlan(String(planId), opts), { staleMs: 0 });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [memory, setMemory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (plan.phase === 'unauthorized') return <SavedPlacesUnauthorized description="記録するにはログインしてください。" />;

  let body: React.ReactNode;
  if (plan.phase === 'loading' || plan.phase === 'idle') body = <Loading />;
  else if (!plan.data) body = <ErrorState message={plan.message} onRetry={plan.reload} />;
  else {
    const p = plan.data;
    // 最初は「行った」を記録済みの場所にチェック
    const selected = picked ?? new Set(p.stops.filter((s) => s.visited).map((s) => s.place_id));
    const toggle = (id: string) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setPicked(next);
    };
    const save = async () => {
      if (saving) return;
      if (selected.size === 0) {
        setError('行った場所を一つ以上選んでください。');
        return;
      }
      setSaving(true);
      setError(null);
      // プランの順番のまま送る
      const ids = p.stops.filter((s) => selected.has(s.place_id)).map((s) => s.place_id);
      const r = await callApi((opts) => createVisitRecord(p.plan_id, ids, memory, opts));
      setSaving(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      invalidateTodayPlan();
      routeSync.bump('myPosts');
      // 付け直しで外した場所の写真を片付ける（残す場所の時刻・写真・ひと言はサーバーが引き継ぐ）
      void cleanupRoutePhotos(r.data.id, apiOptions());
      // このタブの Stack を最初に戻してから、保存一覧の「行った記録」を開く
      if (router.canDismiss()) router.dismissAll();
      router.navigate({ pathname: '/saved', params: { tab: 'records', notice: 'recorded' } });
    };

    body = (
      <>
        <H1>今日の記録を残そう</H1>
        <Muted>{`「${p.title}」で実際に行った場所だけを選んでください。`}</Muted>
        <View style={styles.options}>
          {p.stops.map((s) => {
            const on = selected.has(s.place_id);
            return (
              <Pressable
                key={s.place_id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${s.name} 行った場合にチェック`}
                onPress={() => toggle(s.place_id)}
                style={[styles.option, on ? styles.optionOn : null]}>
                <View style={[styles.check, on ? styles.checkOn : null]}>{on ? <Icon name="check" size={14} color={V.white} strokeWidth={2.4} /> : null}</View>
                <View style={styles.flex}>
                  <Text style={styles.name}>{s.name}</Text>
                  <Text style={styles.sub}>
                    {categoryLabel(s.category)} · {s.visited ? '「行った」を記録済み' : '行った場合にチェック'}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        <FormGroup label="ひと言（任意）">
          <Field
            multiline
            value={memory}
            onChangeText={setMemory}
            maxLength={MAX_MEMORY_LENGTH}
            placeholder="今日の思い出をひと言"
            accessibilityLabel="ひと言（任意）"
          />
        </FormGroup>
        <Notice>保存した記録は最初は非公開です。公開するには、保存一覧の「行った記録」から投稿してください。</Notice>
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <PrimaryButton label="非公開で記録を保存" busy={saving} onPress={save} />
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
  flex: { flex: 1 },
  options: { gap: 9, marginTop: 19 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 15, borderWidth: 1, borderColor: '#EFEEE6', backgroundColor: V.paper, minHeight: 60 },
  optionOn: { borderColor: V.coral, backgroundColor: V.pale },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: V.sub, alignItems: 'center', justifyContent: 'center', backgroundColor: V.white },
  checkOn: { backgroundColor: V.coral, borderColor: V.coral },
  name: { fontSize: 14, fontWeight: '800', color: V.ink },
  sub: { fontSize: 11, color: V.sub, marginTop: 2 },
});
