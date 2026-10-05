/**
 * Step 4-7: 選択したプランの地図（iOS / Android）。react-native-maps を保存マップと同じ方法で遅延読み込みする。
 * Web では plan-route-map-view.web.tsx が代わりに読み込まれ、react-native-maps はバンドルされない。
 *
 * - 現在地: 青い点（保存マップと同じデザイン）
 * - 場所: 訪問順の番号入りピン（選択中は大きく濃く）
 * - 経路線: route-plan の encoded polyline をデコードしたものだけ。徒歩は点線、車は実線。取れない区間は描かない
 */
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type MapViewType from 'react-native-maps';

import { ANDROID_KEY_MISSING_REASON, isAndroidMapsConfigured, loadMaps, MAPS_MISSING_REASON, type MapsModule } from '@/place/maps-module';
import { CURRENT_LOCATION_COLOR } from '@/place/saved-map-view';

import { PlanRouteMapFallback } from './plan-route-map-fallback';
import type { PlanRouteMapViewProps } from './plan-route-map-types';

export function PlanRouteMapView(props: PlanRouteMapViewProps) {
  const maps = loadMaps();
  if (!maps) return <PlanRouteMapFallback {...props} reason={MAPS_MISSING_REASON} />;
  if (!isAndroidMapsConfigured()) return <PlanRouteMapFallback {...props} reason={ANDROID_KEY_MISSING_REASON} />;
  return <NativeRouteMap {...props} maps={maps} />;
}

function NativeRouteMap({ c, model, selectedIndex, onSelect, bottomInset, maps }: PlanRouteMapViewProps & { maps: MapsModule }) {
  const { default: MapView, Marker, Polyline } = maps;
  const mapRef = useRef<MapViewType>(null);
  const fitted = useRef(false);

  // 現在地＋全ての場所＋経路線が1画面に収まるように合わせる（最初の1回だけ。ユーザーの操作を戻さない）
  const fit = () => {
    if (fitted.current) return;
    fitted.current = true;
    if (model.fitPoints.length >= 2) {
      mapRef.current?.fitToCoordinates(model.fitPoints, {
        edgePadding: { top: 140, right: 56, bottom: bottomInset + 56, left: 56 },
        animated: false,
      });
    } else if (model.region) {
      mapRef.current?.animateToRegion(model.region, 0);
    }
  };

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      initialRegion={model.region ?? undefined}
      onMapReady={fit}
      toolbarEnabled={false}
      mapPadding={{ top: 0, right: 0, bottom: bottomInset, left: 0 }}>
      {model.lines.map((line) => (
        <Polyline
          key={`line-${line.legIndex}`}
          coordinates={line.points}
          strokeColor={c.accent}
          strokeWidth={5}
          lineDashPattern={line.dashed ? [8, 8] : undefined}
        />
      ))}
      {model.origin ? (
        <Marker identifier="origin" coordinate={model.origin} anchor={{ x: 0.5, y: 0.5 }} title="現在地" zIndex={900}>
          <View style={styles.originDot} />
        </Marker>
      ) : null}
      {model.stops.map((s) => {
        const selected = s.index === selectedIndex;
        return (
          <Marker
            key={s.place_id}
            identifier={s.place_id}
            coordinate={{ latitude: s.latitude, longitude: s.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={selected ? 1000 : 500 + s.order}
            // 選択状態で見た目が変わるので描き直しを許可（ピンは最大4つ）
            tracksViewChanges
            onPress={() => onSelect(s.index)}>
            <View
              style={[
                styles.pin,
                selected ? styles.pinSelected : null,
                { backgroundColor: selected ? c.accentStrong : c.accent },
              ]}>
              <Text style={[styles.pinText, selected ? styles.pinTextSelected : null]}>{s.order}</Text>
            </View>
          </Marker>
        );
      })}
    </MapView>
  );
}

const styles = StyleSheet.create({
  originDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: CURRENT_LOCATION_COLOR,
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  pin: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinSelected: { width: 40, height: 40, borderRadius: 20 },
  pinText: { color: '#ffffff', fontWeight: '900', fontSize: 14 },
  pinTextSelected: { fontSize: 18 },
});
