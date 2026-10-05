/**
 * Step 4-2: 保存Place → 地図用データ（ピン・初期表示範囲・選択）。
 * 地図ライブラリに依存しない純粋関数（Node で単体テストするため）。
 */
import type { SavedPlaceItem } from './saved-places-client';

export type MapPin = {
  /** saved_places.id（ユーザーの保存単位で一意） */
  id: string;
  latitude: number;
  longitude: number;
  item: SavedPlaceItem;
};

export type MapRegion = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

/** 1件だけ・近接した複数件のときの表示範囲（度）。約1km四方 */
export const MIN_REGION_DELTA = 0.01;
/** ピンが画面端に張り付かないよう、外接矩形に足す余白の倍率 */
export const REGION_PADDING_FACTOR = 1.4;

export function isValidCoordinate(latitude: unknown, longitude: unknown): latitude is number {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  // (0, 0) はデータ欠損の既定値であることがほとんどなので表示しない
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

/** 座標が正常な Place だけをピンにする。座標の無い Place は missing に分ける */
export function toMapPins(items: readonly SavedPlaceItem[]): { pins: MapPin[]; missing: SavedPlaceItem[] } {
  const pins: MapPin[] = [];
  const missing: SavedPlaceItem[] = [];
  for (const item of items) {
    if (isValidCoordinate(item.latitude, item.longitude)) {
      pins.push({ id: item.savedPlaceId, latitude: item.latitude, longitude: item.longitude as number, item });
    } else {
      missing.push(item);
    }
  }
  return { pins, missing };
}

/** 全ピンが収まる初期表示範囲。0件なら null */
export function computeRegion(pins: readonly Pick<MapPin, 'latitude' | 'longitude'>[]): MapRegion | null {
  if (pins.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of pins) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLng = Math.min(minLng, p.longitude);
    maxLng = Math.max(maxLng, p.longitude);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.min(180, Math.max(MIN_REGION_DELTA, (maxLat - minLat) * REGION_PADDING_FACTOR)),
    longitudeDelta: Math.min(360, Math.max(MIN_REGION_DELTA, (maxLng - minLng) * REGION_PADDING_FACTOR)),
  };
}

// ---------------------------------------------------------------------------------------------
// Step 4-3: 現在地を含めた表示範囲
// ---------------------------------------------------------------------------------------------

/** 現在地から「近くの保存Place」とみなす距離。日帰りで回れる範囲（都市圏＋近郊）を想定 */
export const NEARBY_RADIUS_M = 30_000;
/** 現在地周辺だけを見せるときの表示範囲（度）。約3km四方（徒歩〜自転車圏） */
export const CURRENT_AREA_DELTA = 0.03;

type LatLng = { latitude: number; longitude: number };

/** 2点間の距離（メートル, 球面近似） */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 現在地周辺の表示範囲 */
export function regionAround(point: LatLng, delta: number = CURRENT_AREA_DELTA): MapRegion {
  return { latitude: point.latitude, longitude: point.longitude, latitudeDelta: delta, longitudeDelta: delta };
}

export type InitialMapView = {
  region: MapRegion | null;
  /** 地図側で「これらが全部収まる」ように合わせる点（画面の縦横比に合わせられる）。空なら region を使う */
  fitPoints: LatLng[];
  /**
   * saved: 現在地なし → 保存Place全体（Step 4-2 と同じ）
   * current_nearby: 現在地 + 30km 以内の保存Place
   * current_only: 近くに保存Placeが無い → 現在地周辺だけ
   */
  mode: 'saved' | 'current_nearby' | 'current_only';
  /** 表示範囲に含めた近くのピン数 */
  nearbyCount: number;
  /** 30km より遠く、表示範囲に含めなかったピン数 */
  farCount: number;
};

/**
 * 初期表示範囲を決める。
 * - 現在地なし: 保存Place全体（computeRegion）
 * - 現在地あり: 現在地 + 半径 30km 以内の保存Place が収まる範囲。遠い Place は無理に含めない
 *   （北海道と東京に保存があっても日本全体までズームアウトしない）
 * - 近くに保存Place が無い: 現在地周辺（約3km四方）
 */
export function computeInitialView(pins: readonly MapPin[], current: LatLng | null): InitialMapView {
  const point = (p: LatLng): LatLng => ({ latitude: p.latitude, longitude: p.longitude });
  if (!current) {
    // Step 4-2 と同じ: 1件はその周辺、複数件は全ピンに合わせる
    return {
      region: computeRegion(pins),
      fitPoints: pins.length >= 2 ? pins.map(point) : [],
      mode: 'saved',
      nearbyCount: pins.length,
      farCount: 0,
    };
  }
  const nearby = pins.filter((p) => distanceMeters(current, p) <= NEARBY_RADIUS_M);
  const farCount = pins.length - nearby.length;
  if (nearby.length === 0) {
    return { region: regionAround(current), fitPoints: [], mode: 'current_only', nearbyCount: 0, farCount };
  }
  const fitted = computeRegion([current, ...nearby])!;
  // 現在地のすぐ近くにしか無い場合にズームしすぎないよう、最低でも現在地周辺の範囲は確保する
  const tooSmall = fitted.latitudeDelta < CURRENT_AREA_DELTA && fitted.longitudeDelta < CURRENT_AREA_DELTA;
  return {
    region: {
      ...fitted,
      latitudeDelta: Math.max(fitted.latitudeDelta, CURRENT_AREA_DELTA),
      longitudeDelta: Math.max(fitted.longitudeDelta, CURRENT_AREA_DELTA),
    },
    fitPoints: tooSmall ? [] : [point(current), ...nearby.map(point)],
    mode: 'current_nearby',
    nearbyCount: nearby.length,
    farCount,
  };
}

/** 選択中のピン。再取得で消えた（または座標が無くなった）Place は選択解除扱い */
export function findSelectedPin(pins: readonly MapPin[], selectedId: string | null): MapPin | null {
  if (!selectedId) return null;
  return pins.find((p) => p.id === selectedId) ?? null;
}
