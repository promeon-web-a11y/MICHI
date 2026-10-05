/**
 * Step 4-4「今日どこ行く？」条件入力。
 * いくつか選ぶだけで、あとは Mikke が考える（フォームにしない）。
 *
 *   保存Place件数 → 出発地点（現在地）→ 使える時間 → 予算 → 移動手段 → 気分  … 下部に固定の CTA
 *
 * CTA を押すと PlanConditions を作ってアプリ内ストアに確定し、A/B/C プランの生成を始めて結果画面へ進む（Step 4-5）。
 * 現在地は Step 4-3 の useCurrentLocation、保存Placeは Step 4-1 の useSavedPlaces を再利用する。
 *
 * v3.0: 下部タブの中に表示（上部に Mikke と地域・戻る）。
 *   ?source=saved | conditions … ＋プランの入口から（文言だけ変わる）
 *   ?routeId=… … みんなのルートの「今日向けに調整」。送信時にそのルートの場所を保存場所に加え（save_route_places）、
 *                 その場所だけを候補に generate-plan-options を呼ぶ
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentLocation } from '@/location/use-current-location';
import { SavedPlacesUnauthorized } from '@/place/saved-place-views';
import { useSavedPlaces } from '@/place/use-saved-places';
import {
  buildPlanConditions,
  BUDGET_OPTIONS,
  DURATION_OPTIONS,
  MAX_PREFERENCES,
  PLAN_ISSUE_MESSAGES,
  PREFERENCE_OPTIONS,
  TRANSPORT_OPTIONS,
} from '@/plan/plan-conditions';
import { usePlanPalette, type PlanPalette } from '@/plan/plan-theme';
import { planDraftActions, usePlanDraft } from '@/plan/use-plan-draft';
import { planOptionsActions, usePlanOptions } from '@/plan/use-plan-options';
import { appLog } from '@/lib/logger';
import { callApi } from '@/lib/use-api-resource';
import { markSavedPlacesChanged } from '@/place/saved-places-client';
import { saveRoutePlaces } from '@/routes/route-posts-client';
import { AppHeader, BackLink, H1, Muted, V } from '@/ui/kit';

export default function PlanConditionsScreen() {
  const c = usePlanPalette();
  const { source, routeId, routeTitle } = useLocalSearchParams<{ source?: string; routeId?: string; routeTitle?: string }>();
  const { view: saved, reload: reloadSaved } = useSavedPlaces();
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const location = useCurrentLocation();
  const { draft } = usePlanDraft();
  const generating = usePlanOptions().status === 'generating';
  const [transportHint, setTransportHint] = useState(false);

  // 許可済みの場合だけ、ダイアログを出さずに現在地を取得（取得済みで新しければ通信しない）
  const { locate } = location;
  useEffect(() => {
    locate({ prompt: false });
  }, [locate]);

  if (saved.phase === 'unauthorized') {
    return <SavedPlacesUnauthorized description="プランをつくるにはログインしてください。" />;
  }

  const savedCount = saved.phase === 'ready' ? saved.items.length : null;
  // ルートから調整する場合は、送信時にそのルートの場所を保存するので保存0件でも進める
  const effectiveSavedCount = routeId ? Math.max(savedCount ?? 0, 1) : savedCount;
  const result = buildPlanConditions({ draft, location: location.location, savedPlaceCount: effectiveSavedCount });

  const onSubmit = async () => {
    if (!result.ok || generating || preparing) return; // 二重送信防止（ストア側でも1本にまとめる）
    let extra: { placeIds: string[]; basedOnRoutePostId: string } | null = null;
    if (routeId) {
      setPreparing(true);
      setPrepareError(null);
      const r = await callApi((opts) => saveRoutePlaces(String(routeId), opts));
      setPreparing(false);
      if (!r.ok) {
        setPrepareError(r.message);
        return;
      }
      markSavedPlacesChanged();
      extra = { placeIds: r.data, basedOnRoutePostId: String(routeId) };
    }
    planDraftActions.submit(result.conditions);
    // 座標は記録しない（条件の形だけ）
    appLog.info('プラン条件を確定しました', {
      duration_minutes: result.conditions.duration_minutes,
      budget_yen: result.conditions.budget_yen,
      transport_modes: result.conditions.transport_modes,
      preferences: result.conditions.preferences,
      saved_place_count: result.conditions.saved_place_count,
    });
    planOptionsActions.generate(result.conditions, extra);
    router.push('/plan/results');
  };

  const onToggleTransport = (mode: (typeof TRANSPORT_OPTIONS)[number]['value']) => {
    const isLast = draft.transportModes.length === 1 && draft.transportModes[0] === mode;
    setTransportHint(isLast);
    planDraftActions.toggleTransport(mode);
  };

  const ctaIssue = result.ok ? null : PLAN_ISSUE_MESSAGES[result.issues[0]];

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: V.white }]}>
      <AppHeader />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 150 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <BackLink />
          <H1 style={{ marginTop: 0 }}>今日の条件を教えて</H1>
          <Muted>
            {routeId
              ? `「${routeTitle ?? 'みんなのルート'}」を元に調整します。このルートの場所をあなたの保存場所に加え、その中から提案します。`
              : source === 'saved'
                ? '保存した行きたい場所から組み立てます。'
                : 'いくつか選ぶだけ。今の気分に合わせて、保存した場所から考えます。'}
          </Muted>
        </View>

        {routeId ? null : <SavedPlacesSummary c={c} phase={saved.phase} count={savedCount} onRetry={reloadSaved} />}

        <Card c={c} icon="📍" title="出発地点">
          <OriginContent c={c} location={location} />
        </Card>

        <Card c={c} icon="⏰" title="使える時間" note="これから何時間くらい？">
          <View style={styles.chips}>
            {DURATION_OPTIONS.map((o) => (
              <Chip
                key={o.minutes}
                c={c}
                label={o.label}
                selected={draft.durationMinutes === o.minutes}
                onPress={() => planDraftActions.setDuration(o.minutes)}
              />
            ))}
          </View>
        </Card>

        <Card c={c} icon="💴" title="予算" note="1人あたり・食事や交通費もふくめて">
          <View style={styles.chips}>
            {BUDGET_OPTIONS.map((o) => (
              <Chip
                key={String(o.yen)}
                c={c}
                label={o.label}
                selected={draft.budgetYen === o.yen}
                onPress={() => planDraftActions.setBudget(o.yen)}
              />
            ))}
          </View>
        </Card>

        <Card c={c} icon="🚶" title="移動手段" note="いくつでも選べます">
          <View style={styles.grid}>
            {TRANSPORT_OPTIONS.map((o) => (
              <OptionTile
                key={o.value}
                c={c}
                icon={o.icon}
                label={o.label}
                selected={draft.transportModes.includes(o.value)}
                onPress={() => onToggleTransport(o.value)}
              />
            ))}
          </View>
          {transportHint ? (
            <Text style={[styles.hint, { color: c.warning }]}>移動手段は1つ以上選んでください</Text>
          ) : null}
        </Card>

        <Card c={c} icon="✨" title="気分" note={`${MAX_PREFERENCES}つまで・おまかせでもOK`}>
          <View style={styles.chips}>
            {PREFERENCE_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                c={c}
                label={`${o.icon} ${o.label}`}
                selected={draft.preferences.includes(o.value)}
                onPress={() => planDraftActions.togglePreference(o.value)}
              />
            ))}
          </View>
        </Card>
      </ScrollView>

      {/* 下部の固定 CTA（片手で押せる位置） */}
      <View style={[styles.ctaBar, { backgroundColor: V.white, borderTopColor: c.border, paddingBottom: 12 }]}>
        {prepareError ? <Text style={[styles.ctaIssue, { color: c.warning }]}>{prepareError}</Text> : null}
        {ctaIssue ? <Text style={[styles.ctaIssue, { color: c.textSecondary }]}>{ctaIssue}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !result.ok || generating || preparing }}
          disabled={!result.ok || generating || preparing}
          onPress={onSubmit}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: result.ok && !generating ? (pressed ? c.accentPressed : c.accent) : c.disabled },
          ]}>
          <Text style={[styles.ctaText, { color: result.ok && !generating ? c.onAccent : c.textSecondary }]}>
            {preparing ? 'ルートの場所を準備しています…' : generating ? 'プランをつくっています…' : 'ルートを見てみる →'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------------------------

function SavedPlacesSummary({
  c,
  phase,
  count,
  onRetry,
}: {
  c: PlanPalette;
  phase: string;
  count: number | null;
  onRetry: () => void;
}) {
  let body: ReactNode;
  if (phase === 'error') {
    body = (
      <View style={styles.rowBetween}>
        <Text style={[styles.summaryText, styles.flex, { color: c.text }]}>保存した場所を読み込めませんでした</Text>
        <SmallButton c={c} label="再読み込み" onPress={onRetry} />
      </View>
    );
  } else if (count === null) {
    body = (
      <View style={styles.row}>
        <ActivityIndicator color={c.accent} />
        <Text style={[styles.summaryText, { color: c.textSecondary }]}>保存した場所を確認しています…</Text>
      </View>
    );
  } else if (count === 0) {
    body = (
      <View style={styles.gapSmall}>
        <Text style={[styles.summaryText, { color: c.text }]}>まだ保存した場所がありません</Text>
        <Text style={{ color: c.textSecondary }}>
          Instagram や TikTok で気になった場所を、共有メニューから Mikke に保存してみましょう。
        </Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.rowBetween}>
        <Text style={[styles.summaryText, styles.flex, { color: c.text }]}>
          保存した<Text style={{ color: c.accentStrong }}>{count}</Text>スポットからプランを考えます
        </Text>
        <SmallButton c={c} label="地図で見る" onPress={() => router.push('/map')} />
      </View>
    );
  }
  return <View style={[styles.summary, { backgroundColor: c.accentSoft }]}>{body}</View>;
}

function OriginContent({ c, location }: { c: PlanPalette; location: ReturnType<typeof useCurrentLocation> }) {
  const { status, error, message } = location;
  const current = location.location;
  const locating = status === 'locating';
  const locate = (force: boolean) => location.locate({ prompt: true, force });

  return (
    <View style={styles.gapSmall}>
      <Text style={[styles.originMain, { color: c.text }]}>現在地から</Text>
      {locating ? (
        <View style={styles.row}>
          <ActivityIndicator color={c.accent} />
          <Text style={{ color: c.textSecondary }}>現在地を取得しています…</Text>
        </View>
      ) : current ? (
        <View style={styles.rowBetween}>
          <Text style={{ color: c.textSecondary }}>
            ✓ 取得済み{current.accuracy !== null ? `（誤差 約${Math.round(current.accuracy)}m）` : ''}
          </Text>
          <SmallButton c={c} label="更新" onPress={() => locate(true)} />
        </View>
      ) : error ? (
        <View style={[styles.notice, { backgroundColor: c.warningSoft }]}>
          <Text style={{ color: c.text }}>{message}</Text>
          <View style={styles.row}>
            {error !== 'unsupported' ? <SmallButton c={c} label="もう一度" onPress={() => locate(true)} /> : null}
            {error === 'permission_blocked' && Platform.OS !== 'web' ? (
              <SmallButton c={c} label="設定を開く" onPress={location.openSettings} />
            ) : null}
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => locate(false)}
          style={({ pressed }) => [styles.locateButton, { borderColor: c.accent, opacity: pressed ? 0.7 : 1 }]}>
          <Text style={[styles.locateText, { color: c.accentStrong }]}>📍 現在地を取得</Text>
        </Pressable>
      )}
    </View>
  );
}

function Card({ c, icon, title, note, children }: { c: PlanPalette; icon: string; title: string; note?: string; children: ReactNode }) {
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardIcon}>{icon}</Text>
        <Text style={[styles.cardTitle, { color: c.text }]}>{title}</Text>
        {note ? <Text style={[styles.cardNote, { color: c.textSecondary }]}>{note}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Chip({ c, label, selected, onPress }: { c: PlanPalette; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? c.accent : c.card,
          borderColor: selected ? c.accent : c.border,
          opacity: pressed ? 0.75 : 1,
        },
      ]}>
      <Text style={[styles.chipText, { color: selected ? c.onAccent : c.text }]}>{label}</Text>
    </Pressable>
  );
}

function OptionTile({
  c,
  icon,
  label,
  selected,
  onPress,
}: {
  c: PlanPalette;
  icon: string;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: selected ? c.accentSoft : c.card,
          borderColor: selected ? c.accent : c.border,
          opacity: pressed ? 0.75 : 1,
        },
      ]}>
      <Text style={styles.tileIcon}>{icon}</Text>
      <Text style={[styles.tileLabel, { color: c.text }]}>{label}</Text>
      {selected ? <Text style={[styles.tileCheck, { color: c.accentStrong }]}>✓</Text> : null}
    </Pressable>
  );
}

function SmallButton({ c, label, onPress }: { c: PlanPalette; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.smallButton, { borderColor: c.accent, opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.smallButtonText, { color: c.accentStrong }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 20, gap: 16 },
  header: { gap: 6, paddingTop: 4 },
  title: { fontSize: 28, fontWeight: '800' },
  subtitle: { fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  gapSmall: { gap: 8 },
  summary: { borderRadius: 20, padding: 16 },
  summaryText: { fontSize: 15, fontWeight: '700' },
  card: { borderRadius: 24, borderWidth: 1, padding: 18, gap: 14 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardIcon: { fontSize: 20 },
  cardTitle: { fontSize: 17, fontWeight: '800' },
  cardNote: { fontSize: 12, marginLeft: 'auto' },
  originMain: { fontSize: 20, fontWeight: '800' },
  locateButton: { borderWidth: 1.5, borderRadius: 16, paddingVertical: 14, alignItems: 'center' },
  locateText: { fontSize: 16, fontWeight: '700' },
  notice: { borderRadius: 16, padding: 12, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { borderRadius: 999, borderWidth: 1.5, paddingHorizontal: 16, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  chipText: { fontSize: 15, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    borderRadius: 18,
    borderWidth: 1.5,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 6,
  },
  tileIcon: { fontSize: 28 },
  tileLabel: { fontSize: 15, fontWeight: '700' },
  tileCheck: { position: 'absolute', top: 8, right: 12, fontSize: 16, fontWeight: '800' },
  hint: { fontSize: 13, fontWeight: '600' },
  smallButton: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  smallButtonText: { fontSize: 13, fontWeight: '700' },
  ctaBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, gap: 8, borderTopWidth: 1 },
  ctaIssue: { fontSize: 13, textAlign: 'center' },
  cta: { borderRadius: 999, paddingVertical: 17, alignItems: 'center' },
  ctaText: { fontSize: 17, fontWeight: '800' },
});
