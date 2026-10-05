/**
 * プラン地図の代替表示（Web / 地図機能を含まないビルド / Android の地図キー未設定）。
 * 訪問順の一覧をタップで選べるようにする（選択時の下部カードはネイティブ地図と共通）。
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatClock } from './plan-option-format';
import type { PlanRouteMapViewProps } from './plan-route-map-types';

export function PlanRouteMapFallback({ c, model, selectedIndex, onSelect, bottomInset, reason }: PlanRouteMapViewProps & { reason: string }) {
  return (
    <ScrollView style={[styles.flex, { backgroundColor: c.background }]} contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]}>
      <View style={[styles.notice, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.noticeTitle, { color: c.text }]}>地図表示はアプリ版で利用できます</Text>
        <Text style={{ color: c.textSecondary }}>{reason}</Text>
      </View>
      <View style={[styles.row, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={[styles.badge, styles.originBadge]}>
          <Text style={styles.badgeText}>●</Text>
        </View>
        <Text style={[styles.name, { color: c.text }]}>現在地を出発</Text>
      </View>
      {model.stops.map((s) => {
        const selected = s.index === selectedIndex;
        return (
          <Pressable
            key={s.place_id}
            onPress={() => onSelect(s.index)}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: selected ? c.accentSoft : c.card, borderColor: selected ? c.accent : c.border, opacity: pressed ? 0.8 : 1 },
            ]}>
            <View style={[styles.badge, { backgroundColor: c.accent }]}>
              <Text style={styles.badgeText}>{s.order}</Text>
            </View>
            <View style={styles.flex}>
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                {s.name}
              </Text>
              <Text style={{ color: c.textSecondary, fontSize: 12 }}>
                {s.arrival_at ? `${formatClock(s.arrival_at)} ごろ到着` : '到着時刻は未確定'}・滞在 {s.stay_minutes}分
              </Text>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, paddingTop: 110, gap: 10 },
  notice: { borderRadius: 18, borderWidth: 1, padding: 14, gap: 4 },
  noticeTitle: { fontWeight: '800', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, borderWidth: 1, padding: 12 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  originBadge: { backgroundColor: '#1A73E8' },
  badgeText: { color: '#fff', fontWeight: '900' },
  name: { fontSize: 15, fontWeight: '800' },
});
