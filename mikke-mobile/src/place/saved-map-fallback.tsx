/**
 * 地図を表示できない環境（Web / Android で Google Maps キー未設定）の代替表示。
 * ピンと同じデータを一覧にし、タップで選択できる（選択時の下部カードは実地図と共通）。
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

import { distanceMeters } from './saved-map-data';
import type { SavedMapViewProps } from './saved-map-types';

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)}km`;
}

export function SavedMapFallback({
  pins,
  selectedId,
  onSelect,
  bottomInset,
  currentLocation,
  reason,
}: SavedMapViewProps & { reason: string }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={[styles.flex, { backgroundColor: theme.background }]}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]}>
      <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.noticeTitle, { color: theme.text }]}>この環境では地図を表示できません</Text>
        <Text style={{ color: theme.textSecondary }}>{reason}</Text>
      </View>
      {pins.map((pin) => {
        const selected = pin.id === selectedId;
        return (
          <Pressable
            key={pin.id}
            onPress={() => onSelect(selected ? null : pin.id)}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <Text style={[styles.rowName, { color: theme.text }]} numberOfLines={1}>
              📍 {pin.item.name}
            </Text>
            <Text style={[styles.rowMeta, { color: theme.textSecondary }]}>
              {currentLocation
                ? `現在地から ${formatDistance(distanceMeters(currentLocation, pin))}`
                : `${pin.latitude.toFixed(5)}, ${pin.longitude.toFixed(5)}`}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // 上部の件数・現在地ボタン（/map で重ねて表示）に隠れないよう上を空ける
  content: { padding: 16, paddingTop: 120, gap: 8 },
  notice: { borderRadius: 12, padding: 12, gap: 4 },
  noticeTitle: { fontWeight: '700' },
  row: { borderRadius: 10, padding: 12, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12 },
});
