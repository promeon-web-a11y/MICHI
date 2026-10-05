/**
 * Step 4-2 / 4-3: 保存マップ。
 * ログイン中ユーザーの保存Place（/saved と同じ取得結果を共有）を地図上のピンで表示し、現在地との位置関係を示す。
 *
 * 構成（将来の「地図 + 下部カード / Bottom Sheet」の土台）:
 *   地図（全面） + 上部の件数・現在地ボタン + 下部のPlaceカード（ピン選択時）
 * 座標が無い・不正な Place はピンにせず件数だけ知らせる（画面全体はエラーにしない）。
 *
 * 現在地（Step 4-3）:
 * - 開いた時は「すでに許可済み」の場合だけ、ダイアログを出さずに1回取得する
 * - 未許可の場合は「現在地へ」ボタンを押した時に初めて権限をたずねる
 * - 拒否・位置情報サービスOFF・タイムアウト等では保存Placeだけの地図のまま使える
 */
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';
import { useCurrentLocation } from '@/location/use-current-location';
import { computeInitialView, computeRegion, findSelectedPin, regionAround, toMapPins } from '@/place/saved-map-data';
import type { MapCamera } from '@/place/saved-map-types';
import { SavedMapView } from '@/place/saved-map-view';
import {
  SavedPlaceCard,
  SavedPlacesError,
  SavedPlacesLoading,
  SavedPlacesUnauthorized,
} from '@/place/saved-place-views';
import { useSavedPlaces } from '@/place/use-saved-places';
import { Button } from '@/components/ui/button';

/** 下部カードの高さが測れるまでの仮の値 */
const DEFAULT_SHEET_HEIGHT = 120;

/** 自動の表示範囲はピンの顔ぶれ・現在地の有無が変わった時だけ変える */
const autoKeyFor = (pinsKey: string, hasLocation: boolean) => `auto:${pinsKey}:${hasLocation ? 'loc' : 'noloc'}`;

export default function SavedMapScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { view, reload } = useSavedPlaces();
  const location = useCurrentLocation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetHeight, setSheetHeight] = useState(DEFAULT_SHEET_HEIGHT);
  /** ユーザーが現在地を求めた（ボタンを押した）か。黙って試した取得の失敗ではバナーを出さない */
  const [requested, setRequested] = useState(false);
  /** ボタン操作による表示範囲。自動の表示範囲が変わるまで有効 */
  const [override, setOverride] = useState<{ autoKey: string; camera: MapCamera } | null>(null);
  const cameraSeq = useRef(0);

  // 許可済みの場合だけ、ダイアログを出さずに現在地を1回取得（新しい現在地があれば通信もしない）
  const { locate } = location;
  useEffect(() => {
    locate({ prompt: false });
  }, [locate]);

  const { pins, missing } = toMapPins(view.items);
  const pinsKey = pins.map((p) => p.id).join(',');
  const current = location.location;
  const initialView = computeInitialView(pins, current);
  const autoKey = autoKeyFor(pinsKey, current !== null);
  const autoCamera: MapCamera | null = initialView.region
    ? { key: autoKey, region: initialView.region, fitPoints: initialView.fitPoints }
    : null;
  const camera = override && override.autoKey === autoKey ? override.camera : autoCamera;

  const moveCamera = (camera: MapCamera, hasLocation: boolean) =>
    setOverride({ autoKey: autoKeyFor(pinsKey, hasLocation), camera });

  const goToCurrentLocation = async () => {
    setRequested(true);
    const result = await locate({ prompt: true });
    if (!result.ok) return;
    cameraSeq.current += 1;
    moveCamera({ key: `current:${cameraSeq.current}`, region: regionAround(result.location), fitPoints: [] }, true);
  };

  const retryLocation = async () => {
    setRequested(true);
    const result = await locate({ prompt: true, force: true });
    if (!result.ok) return;
    cameraSeq.current += 1;
    moveCamera({ key: `current:${cameraSeq.current}`, region: regionAround(result.location), fitPoints: [] }, true);
  };

  const showAllPins = () => {
    const region = computeRegion(pins);
    if (!region) return;
    cameraSeq.current += 1;
    moveCamera(
      { key: `all:${cameraSeq.current}`, region, fitPoints: pins.length >= 2 ? pins.map(({ latitude, longitude }) => ({ latitude, longitude })) : [] },
      current !== null
    );
  };

  if (view.phase === 'unauthorized') {
    return <SavedPlacesUnauthorized description="保存マップを見るにはログインしてください。" />;
  }
  if (view.phase === 'loading' || view.phase === 'idle') return <SavedPlacesLoading />;
  if (view.phase === 'error') return <SavedPlacesError devDetail={view.devDetail} onRetry={reload} />;

  if (view.items.length === 0) {
    return (
      <Empty
        title="まだ保存した場所がありません"
        body="Instagram や TikTok の共有メニューから Mikke を選ぶと、保存した場所が地図に表示されます。"
      />
    );
  }
  if (pins.length === 0) {
    return (
      <Empty
        title="地図に表示できる場所がありません"
        body={`保存した ${view.items.length} 件の場所に位置情報がありません。`}
        action={<Button title="保存した場所の一覧を見る" onPress={() => router.push('/saved')} />}
      />
    );
  }

  const selected = findSelectedPin(pins, selectedId);
  const bottomInset = sheetHeight + insets.bottom;
  const locating = location.status === 'locating';
  const showLocationError = requested && location.status === 'error' && location.message;

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <SavedMapView
        pins={pins}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        bottomInset={bottomInset}
        currentLocation={current}
        camera={camera}
      />

      <View style={styles.topArea} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <View style={[styles.badge, { backgroundColor: theme.backgroundElement }]}>
            <Text style={[styles.badgeText, { color: theme.text }]}>
              {pins.length}件を表示{missing.length > 0 ? `（位置情報なし ${missing.length}件）` : ''}
            </Text>
          </View>
          <Chip label={view.refreshing ? '更新中…' : '再読み込み'} onPress={reload} disabled={view.refreshing} />
        </View>

        <View style={styles.topRow} pointerEvents="box-none">
          <Chip label={locating ? '現在地を取得中…' : '📍 現在地へ'} onPress={goToCurrentLocation} disabled={locating} />
          {current && initialView.farCount > 0 ? (
            <Chip label={`遠くの保存場所も見る（${initialView.farCount}件）`} onPress={showAllPins} />
          ) : null}
        </View>

        {showLocationError ? (
          <View style={[styles.banner, styles.shadow, { backgroundColor: theme.backgroundElement }]}>
            <Text style={{ color: theme.text }}>{location.message}</Text>
            <View style={styles.bannerActions}>
              {location.error !== 'unsupported' ? <Chip label="再試行" onPress={retryLocation} disabled={locating} /> : null}
              {location.error === 'permission_blocked' && Platform.OS !== 'web' ? (
                <Chip label="設定を開く" onPress={location.openSettings} />
              ) : null}
              <Chip label="閉じる" onPress={() => setRequested(false)} />
            </View>
          </View>
        ) : null}
      </View>

      {/* 下部カード（将来 Bottom Sheet に置き換える場所） */}
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
        pointerEvents="box-none"
        onLayout={(e) => setSheetHeight(Math.round(e.nativeEvent.layout.height - insets.bottom))}>
        {selected ? (
          <View style={styles.selected}>
            <SavedPlaceCard item={selected.item} style={styles.shadow} />
            <Pressable onPress={() => setSelectedId(null)} hitSlop={8} style={styles.close}>
              <Text style={{ color: theme.textSecondary }}>閉じる</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.hint, styles.shadow, { backgroundColor: theme.backgroundElement }]}>
            <Text style={{ color: theme.textSecondary }}>ピンをタップすると場所の情報が表示されます</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function Chip({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.badge,
        styles.shadow,
        { backgroundColor: theme.backgroundElement, opacity: pressed || disabled ? 0.6 : 1 },
      ]}>
      <Text style={[styles.badgeText, { color: theme.text }]}>{label}</Text>
    </Pressable>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.flex, styles.center, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      <Text style={{ color: theme.textSecondary, textAlign: 'center' }}>{body}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  topArea: { position: 'absolute', top: 12, left: 12, right: 12, gap: 8 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  banner: { borderRadius: 14, padding: 12, gap: 8 },
  bannerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sheet: { position: 'absolute', left: 12, right: 12, bottom: 0 },
  selected: { gap: 6 },
  close: { alignSelf: 'center', padding: 4 },
  hint: { borderRadius: 14, padding: 14, alignItems: 'center' },
  shadow: {
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});
