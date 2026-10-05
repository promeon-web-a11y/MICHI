/**
 * 共有 → 場所の特定 → 確認 → 保存 の表示部品（共有受信 /handle-share と、URL から保存 /add-place で共有）。
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PillButton } from '@/plan/plan-option-views';
import type { PlanPalette } from '@/plan/plan-theme';

import type { PlaceSummary } from './share-flow';

export function Busy({ c, label, hint }: { c: PlanPalette; label: string; hint?: string }) {
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={c.accent} />
      <Text style={[styles.title, { color: c.text }]}>{label}</Text>
      {hint ? <Text style={{ color: c.textSecondary }}>{hint}</Text> : null}
    </View>
  );
}

export function Message({ c, icon, title, body, children }: { c: PlanPalette; icon: string; title: string; body?: string; children?: React.ReactNode }) {
  return (
    <View style={styles.center}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      {body ? <Text style={[styles.body, { color: c.textSecondary }]}>{body}</Text> : null}
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

export function PlaceCard({ c, place, selected }: { c: PlanPalette; place: PlaceSummary; selected?: boolean }) {
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: selected ? c.accent : c.border }]}>
      <Text style={[styles.placeName, { color: c.text }]}>{place.name}</Text>
      <Text style={{ color: c.textSecondary }}>{place.address ?? '住所情報なし'}</Text>
    </View>
  );
}

export function ReviewCandidates({
  c,
  candidates,
  onChoose,
  onSkip,
}: {
  c: PlanPalette;
  candidates: PlaceSummary[];
  onChoose: (googlePlaceId: string) => void;
  onSkip: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(candidates.length === 1 ? candidates[0].googlePlaceId : null);
  return (
    <View style={styles.gap}>
      <Text style={[styles.title, { color: c.text }]}>この場所で合っていますか？</Text>
      <Text style={{ color: c.textSecondary }}>候補がいくつか見つかりました。保存する場所を選んでください。</Text>
      {candidates.map((p) => (
        <Pressable
          key={p.googlePlaceId}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === p.googlePlaceId }}
          accessibilityLabel={`${p.name} ${p.address ?? ''}`}
          onPress={() => setSelected(p.googlePlaceId)}>
          <PlaceCard c={c} place={p} selected={selected === p.googlePlaceId} />
        </Pressable>
      ))}
      <View style={styles.actions}>
        <PillButton c={c} label="この場所を保存" primary disabled={!selected} onPress={() => selected && onChoose(selected)} />
        <PillButton c={c} label="どれも違う（保存しない）" onPress={onSkip} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 32 },
  gap: { gap: 12 },
  icon: { fontSize: 44 },
  title: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 4 },
  card: { alignSelf: 'stretch', borderRadius: 20, borderWidth: 1.5, padding: 16, gap: 4 },
  placeName: { fontSize: 17, fontWeight: '800' },
});
