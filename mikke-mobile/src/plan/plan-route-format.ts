/**
 * 実ルートの表示用フォーマット（純粋関数）。値はすべて Google Routes API の応答から。
 * 取れなかった値は「情報なし」とし、推測で埋めない。
 */
import type { RoutedPlan, RouteLeg, RouteMode, TransitStep } from './plan-route-client';

/** Google の TransitVehicleType → 表示（アイコンと種別名） */
export function vehicleLabel(step: Pick<TransitStep, 'vehicle_type' | 'vehicle_name'>): { icon: string; label: string } {
  const t = step.vehicle_type ?? '';
  if (t === 'SUBWAY' || t === 'METRO_RAIL') return { icon: '🚇', label: step.vehicle_name ?? '地下鉄' };
  if (t === 'HIGH_SPEED_TRAIN') return { icon: '🚄', label: step.vehicle_name ?? '新幹線' };
  if (['HEAVY_RAIL', 'COMMUTER_TRAIN', 'RAIL', 'LONG_DISTANCE_TRAIN'].includes(t)) return { icon: '🚃', label: step.vehicle_name ?? '電車' };
  if (['BUS', 'INTERCITY_BUS', 'TROLLEYBUS'].includes(t)) return { icon: '🚌', label: step.vehicle_name ?? 'バス' };
  if (t === 'TRAM') return { icon: '🚋', label: step.vehicle_name ?? '路面電車' };
  if (t === 'MONORAIL') return { icon: '🚝', label: step.vehicle_name ?? 'モノレール' };
  if (t === 'FERRY') return { icon: '⛴️', label: step.vehicle_name ?? 'フェリー' };
  return { icon: '🚉', label: step.vehicle_name ?? '公共交通' };
}

/** 区間の移動手段の表示。Google マップへ誘導する公共交通は「公共交通（Google マップで確認）」 */
export function legModeLabel(leg: Pick<RouteLeg, 'status' | 'mode'>): { icon: string; label: string } {
  if (leg.status === 'external_transit') return { icon: '🚉', label: '公共交通（Google マップで確認）' };
  if (leg.status === 'failed') return { icon: '❔', label: '経路を取得できませんでした' };
  return modeLabel(leg.mode);
}

/** プラン全体で使う移動手段（例: 徒歩＋公共交通）。取れていない区間は含めない */
export function planModesText(legs: Pick<RouteLeg, 'status' | 'mode'>[]): string | null {
  const labels: string[] = [];
  const add = (l: string) => {
    if (!labels.includes(l)) labels.push(l);
  };
  for (const leg of legs) {
    if (leg.status === 'external_transit') add('公共交通');
    else if (leg.status === 'ok' && leg.mode === 'WALK') add('徒歩');
    else if (leg.status === 'ok' && leg.mode === 'DRIVE') add('車');
    else if (leg.status === 'ok' && leg.mode === 'TRANSIT') add('公共交通');
  }
  return labels.length > 0 ? labels.join('＋') : null;
}

export function modeLabel(mode: RouteMode | null): { icon: string; label: string } {
  if (mode === 'WALK') return { icon: '🚶', label: '徒歩' };
  if (mode === 'DRIVE') return { icon: '🚗', label: '車' };
  if (mode === 'TRANSIT') return { icon: '🚉', label: '公共交通' };
  return { icon: '❔', label: '移動' };
}

export function minutesText(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.max(1, Math.round(seconds / 60));
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}

export function distanceText(meters: number | null): string | null {
  if (meters === null) return null;
  return meters < 1000 ? `${Math.round(meters / 10) * 10}m` : `${(meters / 1000).toFixed(1)}km`;
}

export function moneyText(amount: number, currency: string | null): string {
  if (currency === null || currency === 'JPY') return `${Math.round(amount).toLocaleString('ja-JP')}円`;
  return `${amount.toLocaleString('ja-JP')} ${currency}`;
}

/**
 * 区間の運賃。取得できない場合は「運賃情報なし」、公共交通を使わない区間と
 * Google マップで確認する公共交通の区間（external）は null（表示しない）
 */
export function legFareText(leg: Pick<RouteLeg, 'fare' | 'fare_status'>): string | null {
  if (leg.fare_status === 'not_applicable' || leg.fare_status === 'external') return null;
  if (leg.fare_status === 'known' && leg.fare) return `運賃 ${moneyText(leg.fare.amount, leg.fare.currency)}`;
  return '運賃情報なし';
}

/** 公共交通を Google マップへ誘導するときの案内（路線・時刻・運賃は Mikke では出さない） */
export const TRANSIT_HANDOFF_TEXT = '公共交通の詳しいルートは Google マップで確認できます';
export const TRANSIT_HANDOFF_BUTTON = 'Google マップで公共交通ルートを見る';

/** 公共交通の区間で参考に出す徒歩ルート。公共交通の所要時間と誤解されない書き方にする */
export function walkReferenceText(leg: Pick<RouteLeg, 'walk_reference'>): string | null {
  const w = leg.walk_reference;
  if (!w) return null;
  const d = distanceText(w.distance_meters);
  return `参考: 歩いて行く場合は約${w.duration_minutes}分${d ? `（${d}）` : ''}`;
}

export function faresSummaryText(fares: RoutedPlan['fares']): string {
  const external = fares.external_legs ?? 0;
  if (external > 0) {
    // 公共交通の運賃は Mikke では分からない（推測しない）
    if (fares.status === 'all_known' && fares.known_total > 0) {
      return `確認できた交通費 ${moneyText(fares.known_total, fares.currency)}＋公共交通の運賃は Google マップで確認`;
    }
    return '交通費: 公共交通の運賃は Google マップで確認してください';
  }
  switch (fares.status) {
    case 'all_known':
      return `交通費 ${moneyText(fares.known_total, fares.currency)}`;
    case 'partial':
      return fares.known_total > 0
        ? `確認できた交通費 ${moneyText(fares.known_total, fares.currency)}＋一部運賃不明`
        : '交通費: 一部の運賃情報なし';
    case 'none_known':
      return '交通費: 運賃情報なし';
    default:
      return '交通費: 公共交通の利用なし（ガソリン代・駐車料金は含みません）';
  }
}

export function budgetSummaryText(budget: RoutedPlan['budget']): string {
  const total = moneyText(budget.confirmed_total_yen, 'JPY');
  const base = budget.completeness === 'complete' ? `合計 ${total}（目安）` : `確認できた範囲で ${total}`;
  if (budget.budget_yen === null) return base;
  if (budget.over_budget === true) return `${base}・予算（${moneyText(budget.budget_yen, 'JPY')}）を超えています`;
  if (budget.over_budget === false) return `${base}・予算内`;
  return `${base}・予算内かは料金情報不足のため判定できません`;
}

export function fitMessage(plan: Pick<RoutedPlan, 'fit_status' | 'adjustments'> & { legs?: Pick<RouteLeg, 'status'>[] }): string | null {
  if (plan.fit_status === 'does_not_fit') {
    return '実際の移動時間を確認したところ、このプランは指定した時間内に収まりません。';
  }
  if (plan.fit_status === 'unknown') {
    const legs = plan.legs ?? [];
    if (legs.some((l) => l.status === 'external_transit') && !legs.some((l) => l.status === 'failed')) {
      return '公共交通で移動する区間があるため、到着時刻は Google マップで確認してください。';
    }
    return '一部の移動ルートを取得できなかったため、時刻は目安です。';
  }
  if (plan.fit_status === 'adjusted') {
    return (
      '実際の移動時間に合わせて調整しました: ' +
      plan.adjustments
        .map((a) => (a.type === 'dropped_place' ? `${a.place_name}を外しました` : `${a.place_name}の滞在を${a.from_minutes}分→${a.to_minutes}分に`))
        .join('、')
    );
  }
  return null;
}

/**
 * 公共交通についての注記。「見つからなかった」と「取得できなかった」を区別する。
 * 公共交通を使った区間・問い合わせていない区間では null。
 */
export function transitNoteText(leg: Pick<RouteLeg, 'transit_status' | 'transit_unavailable' | 'mode'>): string | null {
  if (leg.mode === 'TRANSIT') return null;
  switch (leg.transit_status) {
    case 'no_route':
      return '公共交通の経路が見つかりませんでした';
    case 'api_error':
    case 'timeout':
    case 'invalid_response':
      return '公共交通の経路を取得できませんでした';
    case 'ok':
    case 'not_requested':
    case 'disabled': // 案内とボタンは画面側で別に出す
      return null;
    default:
      // 古いサーバー（transit_status なし）
      return leg.transit_unavailable ? '公共交通の経路は見つかりませんでした' : null;
  }
}

export function legFailureText(leg: Pick<RouteLeg, 'failure_reason'>): string {
  switch (leg.failure_reason) {
    case 'no_route':
      return '選んだ移動手段では経路が見つかりませんでした';
    case 'timeout':
    case 'deadline_exceeded':
      return '経路の取得に時間がかかったため表示できません';
    default:
      return '経路を取得できませんでした';
  }
}

// ---------------------------------------------------------------------------------------------
// Google Maps への引き渡し（Maps URLs の Directions。アプリが無い端末ではブラウザで開く）
// https://www.google.com/maps/dir/?api=1&origin=…&destination=…&destination_place_id=…&travelmode=…
// ---------------------------------------------------------------------------------------------
const TRAVELMODE: Record<RouteMode, string> = { WALK: 'walking', TRANSIT: 'transit', DRIVE: 'driving' };

export type MapsLink = { label: string; url: string };

/**
 * 区間 index（前の地点 → stops[index]）の Google マップへのリンク。
 * - 徒歩・車: その手段で開く（primary）。公共交通も選んでいれば「公共交通ルートを見る」（transit）も出す
 * - 公共交通（Google マップで確認）: travelmode=transit を primary にする
 * - 取得失敗: 手段を指定せずに開く
 * origin が無い（現在地不明）場合は origin を省く（Google マップ側で現在地から検索される）
 */
export function legMapsLinks(
  route: Pick<RoutedPlan, 'legs' | 'stops'>,
  index: number,
  origin: { latitude: number; longitude: number } | null
): { primary: MapsLink | null; transit: MapsLink | null } {
  const leg = route.legs[index];
  const stop = route.stops[index];
  if (!leg || !stop) return { primary: null, transit: null };
  const prev = index > 0 ? route.stops[index - 1] : null;
  const from = prev ? { latitude: prev.latitude, longitude: prev.longitude } : origin;
  const url = (mode: RouteMode | null) =>
    googleMapsDirectionsUrl({
      origin: from,
      destination: { latitude: stop.latitude, longitude: stop.longitude },
      destinationName: stop.name,
      destinationPlaceId: stop.google_place_id,
      mode,
    });
  if (leg.status === 'external_transit') return { primary: { label: TRANSIT_HANDOFF_BUTTON, url: url('TRANSIT') }, transit: null };
  if (leg.status === 'failed') return { primary: { label: 'Google マップで開く', url: url(null) }, transit: null };
  return {
    primary: { label: 'Google マップで開く', url: url(leg.mode) },
    transit: leg.transit_status === 'disabled' ? { label: TRANSIT_HANDOFF_BUTTON, url: url('TRANSIT') } : null,
  };
}

export function googleMapsDirectionsUrl(args: {
  origin: { latitude: number; longitude: number } | null;
  destination: { latitude: number; longitude: number };
  destinationName?: string | null;
  destinationPlaceId?: string | null;
  mode: RouteMode | null;
}): string {
  const coord = (p: { latitude: number; longitude: number }) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  const params: string[] = ['api=1'];
  // origin を省くと Google マップ側で現在地から検索される
  if (args.origin) params.push(`origin=${encodeURIComponent(coord(args.origin))}`);
  if (args.destinationPlaceId) {
    // destination_place_id には destination が必要
    params.push(`destination=${encodeURIComponent(args.destinationName || coord(args.destination))}`);
    params.push(`destination_place_id=${encodeURIComponent(args.destinationPlaceId)}`);
  } else {
    params.push(`destination=${encodeURIComponent(coord(args.destination))}`);
  }
  if (args.mode) params.push(`travelmode=${TRAVELMODE[args.mode]}`);
  return `https://www.google.com/maps/dir/?${params.join('&')}`;
}
