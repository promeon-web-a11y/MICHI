/**
 * 保存マップの地図本体（iOS / Android）。react-native-maps を使う。
 * Web では saved-map-view.web.tsx が代わりに読み込まれ、このファイル（react-native-maps）はバンドルされない。
 *
 * - iOS: Apple Maps（API キー不要）
 * - Android: Google Maps。AndroidManifest に Maps SDK for Android のキーが必要（app.config.ts）。
 *   キー無しでビルドした場合は地図を出さず代替表示にする（Google Maps SDK がキー無しで落ちるのを避ける）。
 *
 * react-native-maps は import した時点でネイティブモジュール（RNMapsAirModule）を必須とするため、静的 import しない。
 * react-native-maps 追加前の Development Build では /map を含む全ルートの読み込みでアプリが落ちてしまうので、
 * ネイティブ側がある場合だけ遅延 require し、無ければ「再ビルドが必要」の代替表示にする。
 *
 * 現在地（Step 4-3）: showsUserLocation は使わない（地図SDKが表示中ずっと位置を追い続けるため）。
 * 「必要な時に1回取得した現在地」を青い点と精度円で描く。
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type MapViewType from 'react-native-maps';
import type { MapPressEvent } from 'react-native-maps';

import { ANDROID_KEY_MISSING_REASON, isAndroidMapsConfigured, loadMaps, MAPS_MISSING_REASON, type MapsModule } from './maps-module';
import { SavedMapFallback } from './saved-map-fallback';
import type { MapCamera, SavedMapViewProps } from './saved-map-types';

const SELECTED_PIN_COLOR = '#208AEF';
const PIN_COLOR = '#E8505B';
export const CURRENT_LOCATION_COLOR = '#1A73E8';
/** 精度円の最小半径（m）。精度が良すぎる場合でも点だけにならないように */
const MIN_ACCURACY_RADIUS_M = 20;

export function SavedMapView(props: SavedMapViewProps) {
  const maps = loadMaps();
  if (!maps) return <SavedMapFallback {...props} reason={MAPS_MISSING_REASON} />;
  if (!isAndroidMapsConfigured()) return <SavedMapFallback {...props} reason={ANDROID_KEY_MISSING_REASON} />;
  return <NativeMap {...props} maps={maps} />;
}

function NativeMap({
  pins,
  selectedId,
  onSelect,
  bottomInset,
  currentLocation,
  camera,
  maps,
}: SavedMapViewProps & { maps: MapsModule }) {
  const { default: MapView, Marker, Circle } = maps;
  const mapRef = useRef<MapViewType>(null);
  const ready = useRef(false);
  // camera.key が変わった時だけ動かす（選択・再描画・ユーザーの操作後に勝手に戻さない）
  const appliedKey = useRef<string | null>(null);

  const applyCamera = (target: MapCamera | null) => {
    if (!ready.current || !target || appliedKey.current === target.key) return;
    appliedKey.current = target.key;
    if (target.fitPoints.length >= 2) {
      mapRef.current?.fitToCoordinates(target.fitPoints, {
        edgePadding: { top: 100, right: 48, bottom: bottomInset + 48, left: 48 },
        animated: true,
      });
    } else {
      mapRef.current?.animateToRegion(target.region, 400);
    }
  };

  useEffect(() => {
    applyCamera(camera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera?.key]);

  const handleMapPress = (event: MapPressEvent) => {
    // Android ではピンのタップでも地図の onPress が来るので無視する
    if (event.nativeEvent.action === 'marker-press') return;
    onSelect(null);
  };

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      // 最初のフレームから目的の範囲で表示する。以降の移動は camera.key の変化で行う
      initialRegion={camera?.region}
      onMapReady={() => {
        ready.current = true;
        applyCamera(camera);
      }}
      onPress={handleMapPress}
      toolbarEnabled={false}
      mapPadding={{ top: 0, right: 0, bottom: bottomInset, left: 0 }}>
      {currentLocation ? (
        <>
          <Circle
            center={{ latitude: currentLocation.latitude, longitude: currentLocation.longitude }}
            radius={Math.max(MIN_ACCURACY_RADIUS_M, currentLocation.accuracy ?? MIN_ACCURACY_RADIUS_M)}
            fillColor="rgba(26, 115, 232, 0.15)"
            strokeColor="rgba(26, 115, 232, 0.4)"
            strokeWidth={1}
          />
          <Marker
            identifier="current-location"
            coordinate={{ latitude: currentLocation.latitude, longitude: currentLocation.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            title="現在地"
            zIndex={1000}>
            <View style={styles.currentDot} />
          </Marker>
        </>
      ) : null}
      {pins.map((pin) => (
        <Marker
          key={pin.id}
          identifier={pin.id}
          coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
          title={pin.item.name}
          description={pin.item.categoryLabel}
          pinColor={pin.id === selectedId ? SELECTED_PIN_COLOR : PIN_COLOR}
          onPress={() => onSelect(pin.id)}
        />
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  currentDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: CURRENT_LOCATION_COLOR,
    borderWidth: 3,
    borderColor: '#ffffff',
  },
});
