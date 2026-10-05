/**
 * Step 4-7: 選択したプランの地図表示用データ（純粋関数・Node で単体テスト）。
 * Step 4-6 の route-plan の結果をそのまま使い、新しい経路計算はしない。
 *
 * - 経路線は Google Routes API が返した encoded polyline だけから描く
 * - 経路を取得できなかった区間・Google マップで確認する公共交通の区間には線を引かない（直線も引かない）
 */
import { computeRegion, isValidCoordinate, type MapRegion } from '../place/saved-map-data';

import { durationLabel } from './plan-conditions';
import type { RoutedPlan, RouteLeg, RouteMode, RouteStop } from './plan-route-client';
import { legModeLabel, moneyText, planModesText } from './plan-route-format';

export type LatLng = { latitude: number; longitude: number };

/**
 * Google の Encoded Polyline Algorithm Format（精度 1e5）をデコードする。
 * 壊れた文字列・範囲外の座標を含む場合は [] を返す（部分的な線は描かない）。
 */
export function decodePolyline(encoded: string | null | undefined): LatLng[] {
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 35) return null;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return [];
    lat += dLat;
    lng += dLng;
    const p = { latitude: lat / 1e5, longitude: lng / 1e5 };
    if (Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) return [];
    points.push(p);
  }
  return points;
}

export type RouteMapStop = RouteStop & { order: number; index: number };

export type RouteMapLine = {
  legIndex: number;
  mode: RouteMode;
  /** 徒歩は点線で見分けやすくする */
  dashed: boolean;
  points: LatLng[];
};

export type RouteMapModel = {
  origin: LatLng | null;
  /** 座標が正常な場所だけ（順番は元のプランの番号のまま） */
  stops: RouteMapStop[];
  lines: RouteMapLine[];
  /** 座標が無い・不正で地図に出せない場所の数 */
  missingStops: number;
  /** 経路線を描けなかった区間の数（取得失敗・公共交通・polyline なし） */
  legsWithoutLine: number;
  /** 画面に収める点（現在地＋場所＋経路線） */
  fitPoints: LatLng[];
  /** 1点だけの場合などに使う表示範囲 */
  region: MapRegion | null;
};

/** 経路線の点が多すぎると fit が重くなるので間引く（形は十分に保てる） */
function sample(points: LatLng[], max = 60): LatLng[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  out.push(points[points.length - 1]);
  return out;
}

export function buildRouteMapModel(route: Pick<RoutedPlan, 'legs' | 'stops'>, origin: LatLng | null): RouteMapModel {
  const validOrigin = origin && isValidCoordinate(origin.latitude, origin.longitude) ? origin : null;
  const stops: RouteMapStop[] = [];
  route.stops.forEach((s, i) => {
    if (isValidCoordinate(s.latitude, s.longitude)) stops.push({ ...s, order: i + 1, index: i });
  });
  const lines: RouteMapLine[] = [];
  let legsWithoutLine = 0;
  route.legs.forEach((leg: RouteLeg, i) => {
    const points = leg.status === 'ok' ? decodePolyline(leg.polyline) : [];
    if (points.length >= 2 && leg.mode) {
      lines.push({ legIndex: i, mode: leg.mode, dashed: leg.mode === 'WALK', points });
    } else {
      legsWithoutLine += 1;
    }
  });
  const fitPoints: LatLng[] = [
    ...(validOrigin ? [validOrigin] : []),
    ...stops.map((s) => ({ latitude: s.latitude, longitude: s.longitude })),
    ...lines.flatMap((l) => sample(l.points)),
  ];
  return {
    origin: validOrigin,
    stops,
    lines,
    missingStops: route.stops.length - stops.length,
    legsWithoutLine,
    fitPoints,
    region: computeRegion(fitPoints),
  };
}

/** 地図上部の概要（取れていない情報は出さない） */
export function planMapSummary(route: Pick<RoutedPlan, 'duration_minutes' | 'legs' | 'stops' | 'fares'>): string[] {
  const items: string[] = [];
  if (route.duration_minutes > 0) items.push(`${durationLabel(route.duration_minutes)}プラン`);
  if (route.stops.length > 0) items.push(`${route.stops.length}スポット`);
  const modes = planModesText(route.legs);
  if (modes) items.push(modes);
  const f = route.fares;
  if ((f.external_legs ?? 0) > 0) {
    items.push(f.status === 'all_known' && f.known_total > 0 ? `交通費 ${moneyText(f.known_total, f.currency)}＋公共交通は Google マップで確認` : '交通費は Google マップで確認');
  } else if (f.status === 'all_known') {
    items.push(`交通費 ${moneyText(f.known_total, f.currency)}`);
  } else if (f.status === 'partial') {
    items.push(`交通費 ${moneyText(f.known_total, f.currency)}＋一部不明`);
  } else if (f.status === 'none_known') {
    items.push('運賃情報なし');
  }
  return items;
}

/** 下部カードの「次の場所への移動」。最後の場所なら null */
export function nextMoveText(route: Pick<RoutedPlan, 'legs'>, stopIndex: number): string | null {
  const leg = route.legs[stopIndex + 1];
  if (!leg) return null;
  const label = legModeLabel(leg);
  return leg.status === 'ok' && leg.duration_minutes !== null ? `${label.icon} ${label.label} ${leg.duration_minutes}分` : `${label.icon} ${label.label}`;
}
