/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRoutedPlan, type RoutedPlan, type RouteLeg, type RouteResult, type RouteStop } from '../src/plan/plan-route-client';
import {
  faresSummaryText,
  fitMessage,
  legFareText,
  legMapsLinks,
  legModeLabel,
  planModesText,
  TRANSIT_HANDOFF_BUTTON,
  transitNoteText,
  walkReferenceText,
} from '../src/plan/plan-route-format';
import { buildRouteMapModel, decodePolyline, nextMoveText, planMapSummary } from '../src/plan/plan-route-map-data';
import { createPlanRouteStore } from '../src/plan/plan-route-store';

// Google の公式ドキュメントの例（Encoded Polyline Algorithm Format）
const GOOGLE_EXAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const ORIGIN = { latitude: 43.0687, longitude: 141.3508 };
const PLAN_ID = '2687aac6-0000-4000-8000-000000000001';

/** 2点の polyline を作る（テスト用エンコーダ: 公式アルゴリズムどおり） */
function encode(points: { latitude: number; longitude: number }[]): string {
  let prevLat = 0;
  let prevLng = 0;
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let out = '';
    while (s >= 0x20) {
      out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    return out + String.fromCharCode(s + 63);
  };
  return points
    .map((p) => {
      const lat = Math.round(p.latitude * 1e5);
      const lng = Math.round(p.longitude * 1e5);
      const r = enc(lat - prevLat) + enc(lng - prevLng);
      prevLat = lat;
      prevLng = lng;
      return r;
    })
    .join('');
}

const stop = (i: number, lat: number | null, lng: number | null, extra: Partial<RouteStop> = {}): RouteStop => ({
  place_id: `p${i}`,
  google_place_id: `ChIJ${i}`,
  name: `場所${i}`,
  category: 'cafe',
  address: '札幌市中央区',
  latitude: lat as number,
  longitude: lng as number,
  stay_minutes: 60,
  original_stay_minutes: 60,
  arrival_at: '2026-09-26T01:20:00.000Z',
  leave_at: '2026-09-26T02:20:00.000Z',
  ...extra,
});

const leg = (i: number, overrides: Partial<RouteLeg> = {}): RouteLeg => ({
  index: i,
  from_name: i === 0 ? '現在地' : `場所${i}`,
  to_place_id: `p${i + 1}`,
  status: 'ok',
  failure_reason: null,
  times_uncertain: false,
  mode: 'WALK',
  departure_at: '2026-09-26T01:01:00.000Z',
  arrival_at: '2026-09-26T01:20:00.000Z',
  duration_minutes: 8,
  distance_meters: 650,
  steps: [],
  fare: null,
  fare_status: 'not_applicable',
  transit_status: 'not_requested',
  transit_unavailable: false,
  alternatives: [],
  polyline: encode([ORIGIN, { latitude: 43.0640, longitude: 141.3469 }]),
  ...overrides,
});

function routed(legs: RouteLeg[], stops: RouteStop[], overrides: Partial<RoutedPlan> = {}): RoutedPlan {
  return {
    plan_id: PLAN_ID,
    computed_at: '2026-09-26T01:00:20.000Z',
    departure_at: '2026-09-26T01:01:00.000Z',
    duration_minutes: 180,
    transport_modes: ['walking', 'train', 'bus'],
    transit_routing: 'google_maps',
    route_status: 'ok',
    fit_status: 'fits',
    adjustments: [],
    end_at: '2026-09-26T03:00:00.000Z',
    total_minutes: 120,
    legs,
    stops,
    fares: { status: 'not_applicable', known_total: 0, currency: null, unknown_legs: 0, external_legs: 0 },
    budget: { budget_yen: 3000, places_yen: 2000, places_status: 'estimated', transit_fare_yen: 0, confirmed_total_yen: 2000, completeness: 'complete', over_budget: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
describe('Polyline decode', () => {
  it('Google 公式の例をデコードできる', () => {
    assert.deepEqual(decodePolyline(GOOGLE_EXAMPLE), [
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]);
  });

  it('往復（エンコード→デコード）で札幌の座標が保たれる', () => {
    const pts = [ORIGIN, { latitude: 43.06, longitude: 141.35 }, { latitude: 43.05512, longitude: 141.34001 }];
    assert.deepEqual(decodePolyline(encode(pts)), pts);
  });

  it('空・null・壊れた文字列は []（部分的な線を描かない）', () => {
    assert.deepEqual(decodePolyline(null), []);
    assert.deepEqual(decodePolyline(''), []);
    assert.deepEqual(decodePolyline('_p~iF~ps|U_ulL'), [], '末尾が途中で切れている');
    assert.deepEqual(decodePolyline('\u0010\u0011'), [], '範囲外の文字');
  });
});

describe('地図用モデル', () => {
  it('Place 複数件・複数 polyline: 現在地・番号付きの場所・区間ごとの線・fit 対象', () => {
    const r = routed(
      [leg(0), leg(1, { mode: 'DRIVE', polyline: encode([{ latitude: 43.064, longitude: 141.3469 }, { latitude: 43.06, longitude: 141.36 }]) })],
      [stop(1, 43.064, 141.3469), stop(2, 43.06, 141.36)]
    );
    const m = buildRouteMapModel(r, ORIGIN);
    assert.deepEqual(m.origin, ORIGIN);
    assert.deepEqual(m.stops.map((s) => [s.order, s.name]), [[1, '場所1'], [2, '場所2']]);
    assert.deepEqual(m.lines.map((l) => [l.legIndex, l.mode, l.dashed, l.points.length]), [[0, 'WALK', true, 2], [1, 'DRIVE', false, 2]]);
    assert.equal(m.legsWithoutLine, 0);
    assert.equal(m.fitPoints.length, 1 + 2 + 4, '現在地＋場所＋線の点');
    assert.ok(m.region);
  });

  it('Place 1件・現在地なし → その場所の周辺（最小範囲）', () => {
    const m = buildRouteMapModel(routed([leg(0, { polyline: null })], [stop(1, 43.064, 141.3469)]), null);
    assert.equal(m.origin, null);
    assert.equal(m.fitPoints.length, 1);
    assert.deepEqual(m.region, { latitude: 43.064, longitude: 141.3469, latitudeDelta: 0.01, longitudeDelta: 0.01 });
  });

  it('一部 polyline 欠損・取得失敗・公共交通の区間 → 線を引かない（直線で補わない）', () => {
    const r = routed(
      [
        leg(0, { polyline: null }),
        leg(1, { status: 'failed', mode: null, failure_reason: 'api_error', polyline: null }),
        leg(2, { status: 'external_transit', mode: 'TRANSIT', polyline: null, walk_reference: { duration_minutes: 56, distance_meters: 3907, polyline: GOOGLE_EXAMPLE } }),
      ],
      [stop(1, 43.064, 141.3469), stop(2, 43.06, 141.36), stop(3, 43.07, 141.35)]
    );
    const m = buildRouteMapModel(r, ORIGIN);
    assert.deepEqual(m.lines, [], '徒歩の参考ルートも公共交通の線としては描かない');
    assert.equal(m.legsWithoutLine, 3);
    assert.equal(m.stops.length, 3);
  });

  it('Place 座標欠損は地図に出さず件数だけ（順番の番号は元のまま）', () => {
    const m = buildRouteMapModel(routed([leg(0), leg(1)], [stop(1, null, null), stop(2, 43.06, 141.36)]), ORIGIN);
    assert.deepEqual(m.stops.map((s) => s.order), [2]);
    assert.equal(m.missingStops, 1);
  });

  it('不正な現在地は使わない', () => {
    assert.equal(buildRouteMapModel(routed([leg(0)], [stop(1, 43.06, 141.36)]), { latitude: 0, longitude: 0 }).origin, null);
  });
});

describe('概要・下部カード', () => {
  it('概要: 時間・スポット数・移動手段・交通費（取れたものだけ）', () => {
    const r = routed(
      [leg(0), leg(1, { status: 'external_transit', mode: 'TRANSIT', fare_status: 'external', polyline: null })],
      [stop(1, 43.06, 141.35), stop(2, 43.07, 141.36)],
      { fares: { status: 'not_applicable', known_total: 0, currency: null, unknown_legs: 0, external_legs: 1 } }
    );
    assert.deepEqual(planMapSummary(r), ['3時間プラン', '2スポット', '徒歩＋公共交通', '交通費は Google マップで確認']);
    const walkOnly = routed([leg(0)], [stop(1, 43.06, 141.35)]);
    assert.deepEqual(planMapSummary(walkOnly), ['3時間プラン', '1スポット', '徒歩'], '交通費が関係なければ出さない');
    const fares = routed([leg(0)], [stop(1, 43.06, 141.35)], { fares: { status: 'partial', known_total: 290, currency: 'JPY', unknown_legs: 1, external_legs: 0 } });
    assert.ok(planMapSummary(fares).includes('交通費 290円＋一部不明'));
  });

  it('次の移動: 徒歩 / 公共交通（Google マップで確認）/ 最後', () => {
    const r = routed(
      [leg(0), leg(1, { duration_minutes: 12 }), leg(2, { status: 'external_transit', mode: 'TRANSIT', duration_minutes: null })],
      [stop(1, 43.06, 141.35), stop(2, 43.07, 141.36), stop(3, 43.08, 141.37)]
    );
    assert.equal(nextMoveText(r, 0), '🚶 徒歩 12分');
    assert.equal(nextMoveText(r, 1), '🚉 公共交通（Google マップで確認）');
    assert.equal(nextMoveText(r, 2), null);
    assert.deepEqual(legModeLabel({ status: 'failed', mode: null }), { icon: '❔', label: '経路を取得できませんでした' });
    assert.equal(planModesText([{ status: 'ok', mode: 'DRIVE' }, { status: 'failed', mode: null }]), '車');
  });
});

describe('Google マップ連携', () => {
  const r = routed(
    [
      leg(0, { mode: 'WALK', transit_status: 'not_requested' }),
      leg(1, { mode: 'DRIVE', transit_status: 'disabled' }),
      leg(2, { status: 'external_transit', mode: 'TRANSIT', polyline: null }),
      leg(3, { status: 'failed', mode: null, failure_reason: 'no_route', polyline: null }),
    ],
    [stop(1, 43.06, 141.35), stop(2, 43.07, 141.36), stop(3, 43.08, 141.37), stop(4, 43.09, 141.38)]
  );

  it('徒歩・車は区間ごとに travelmode 付きで開く', () => {
    const a = legMapsLinks(r, 0, ORIGIN);
    assert.equal(a.primary?.url, 'https://www.google.com/maps/dir/?api=1&origin=43.068700%2C141.350800&destination=%E5%A0%B4%E6%89%801&destination_place_id=ChIJ1&travelmode=walking');
    assert.equal(a.transit, null);
    const b = legMapsLinks(r, 1, ORIGIN);
    assert.ok(b.primary?.url.includes('travelmode=driving'));
    assert.ok(b.primary?.url.includes('origin=43.060000%2C141.350000'), '2区間目の出発は1つ前の場所');
  });

  it('公共交通を選んでいれば「Google マップで公共交通ルートを見る」（travelmode=transit）', () => {
    const b = legMapsLinks(r, 1, ORIGIN);
    assert.equal(b.transit?.label, TRANSIT_HANDOFF_BUTTON);
    assert.ok(b.transit?.url.endsWith('travelmode=transit'));
    const c = legMapsLinks(r, 2, ORIGIN);
    assert.equal(c.primary?.label, 'Google マップで公共交通ルートを見る');
    assert.ok(c.primary?.url.endsWith('travelmode=transit'));
  });

  it('取得失敗の区間は手段を指定せずに開く・現在地不明なら origin を省く', () => {
    assert.ok(!legMapsLinks(r, 3, ORIGIN).primary?.url.includes('travelmode='));
    assert.ok(!legMapsLinks(r, 0, null).primary?.url.includes('origin='));
    assert.deepEqual(legMapsLinks(r, 9, ORIGIN), { primary: null, transit: null });
  });
});

describe('公共交通の表示（推測しない）', () => {
  const ext = leg(0, { status: 'external_transit', mode: 'TRANSIT', fare_status: 'external', transit_status: 'disabled', duration_minutes: null, walk_reference: { duration_minutes: 56, distance_meters: 3907, polyline: null } });

  it('徒歩の参考は「公共交通なら〜」と誤解されない書き方', () => {
    const t = walkReferenceText(ext)!;
    assert.equal(t, '参考: 歩いて行く場合は約56分（3.9km）');
    assert.ok(!t.includes('公共交通'));
    assert.equal(walkReferenceText(leg(0)), null);
  });

  it('公共交通の運賃・所要時間は出さない', () => {
    assert.equal(legFareText(ext), null);
    assert.equal(transitNoteText({ ...ext, mode: 'WALK' }), null);
    assert.equal(faresSummaryText({ status: 'not_applicable', known_total: 0, currency: null, unknown_legs: 0, external_legs: 1 }), '交通費: 公共交通の運賃は Google マップで確認してください');
    assert.equal(
      fitMessage({ fit_status: 'unknown', adjustments: [], legs: [{ status: 'ok' }, { status: 'external_transit' }] }),
      '公共交通で移動する区間があるため、到着時刻は Google マップで確認してください。'
    );
    assert.equal(fitMessage({ fit_status: 'unknown', adjustments: [], legs: [{ status: 'failed' }] }), '一部の移動ルートを取得できなかったため、時刻は目安です。');
  });

  it('新しい応答（external_transit）も古い応答も受け付ける', () => {
    assert.equal(isRoutedPlan(routed([ext], [stop(1, 43.06, 141.35)])), true);
  });
});

describe('キャッシュ再利用（詳細画面 → 地図画面）', () => {
  it('同じプラン・同じ出発地点なら地図を開いても route-plan を呼ばない', async () => {
    const calls: string[] = [];
    const store = createPlanRouteStore({
      fetch: async (planId) => {
        calls.push(planId);
        return { ok: true, data: routed([leg(0)], [stop(1, 43.06, 141.35)]) } as RouteResult;
      },
    });
    await store.load(PLAN_ID, ORIGIN); // 詳細画面
    await store.load(PLAN_ID, ORIGIN); // 地図画面
    assert.equal(calls.length, 1);
    assert.equal(store.getState()[PLAN_ID].status, 'ready');
  });
});
