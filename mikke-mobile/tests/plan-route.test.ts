/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike } from '../src/place/identify-place-client';
import { callRoutePlan, isRoutedPlan, ROUTE_ERROR_MESSAGES, type RoutedPlan, type RouteLeg, type RouteResult } from '../src/plan/plan-route-client';
import {
  budgetSummaryText,
  distanceText,
  faresSummaryText,
  fitMessage,
  googleMapsDirectionsUrl,
  legFailureText,
  legFareText,
  minutesText,
  modeLabel,
  transitNoteText,
  vehicleLabel,
} from '../src/plan/plan-route-format';
import { createPlanRouteStore, routeCacheKey } from '../src/plan/plan-route-store';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const PLAN_ID = '2687aac6-0000-4000-8000-000000000001';
const ORIGIN = { latitude: 43.0687, longitude: 141.3508 };

const leg = (overrides: Partial<RouteLeg> = {}): RouteLeg => ({
  index: 0,
  from_name: '現在地',
  to_place_id: 'p1',
  status: 'ok',
  failure_reason: null,
  times_uncertain: false,
  mode: 'TRANSIT',
  departure_at: '2026-09-26T01:01:00.000Z',
  arrival_at: '2026-09-26T01:22:00.000Z',
  duration_minutes: 21,
  distance_meters: 4200,
  steps: [
    { kind: 'walk', duration_seconds: 300, distance_meters: 350 },
    {
      kind: 'transit',
      vehicle_type: 'SUBWAY',
      vehicle_name: '地下鉄',
      line_name: '南北線',
      line_short_name: 'N',
      line_color: '#00a650',
      agency: '札幌市交通局',
      headsign: '真駒内',
      departure_stop: 'さっぽろ',
      arrival_stop: '大通',
      departure_at: '2026-09-26T01:08:00.000Z',
      arrival_at: '2026-09-26T01:10:00.000Z',
      stop_count: 1,
      duration_seconds: 120,
    },
  ],
  fare: { amount: 210, currency: 'JPY' },
  fare_status: 'known',
  transit_unavailable: false,
  alternatives: [{ mode: 'WALK', duration_minutes: 40 }],
  polyline: 'abc',
  ...overrides,
});

const ROUTED: RoutedPlan = {
  plan_id: PLAN_ID,
  computed_at: '2026-09-26T01:00:20.000Z',
  departure_at: '2026-09-26T01:01:00.000Z',
  duration_minutes: 180,
  transport_modes: ['walking', 'train', 'bus'],
  route_status: 'ok',
  fit_status: 'fits',
  adjustments: [],
  end_at: '2026-09-26T02:22:00.000Z',
  total_minutes: 81,
  legs: [leg()],
  stops: [
    {
      place_id: 'p1',
      google_place_id: 'ChIJ1',
      name: 'THE BUTTER',
      category: 'cafe',
      address: '札幌市中央区',
      latitude: 43.06,
      longitude: 141.35,
      stay_minutes: 60,
      original_stay_minutes: 60,
      arrival_at: '2026-09-26T01:22:00.000Z',
      leave_at: '2026-09-26T02:22:00.000Z',
    },
  ],
  fares: { status: 'all_known', known_total: 210, currency: 'JPY', unknown_legs: 0 },
  budget: {
    budget_yen: 3000,
    places_yen: 2000,
    places_status: 'estimated',
    transit_fare_yen: 210,
    confirmed_total_yen: 2210,
    completeness: 'complete',
    over_budget: false,
  },
};

type Call = { url: string; init: Parameters<FetchLike>[1] };
function fakeFetch(handler: () => { status: number; body: unknown } | Promise<never>) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = await handler();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------------------------
describe('callRoutePlan', () => {
  it('19. accepted plan の plan_id と出発地点だけを送る（user_id は送らない）', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: ROUTED }));
    const r = await callRoutePlan(PLAN_ID, ORIGIN, { config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl });
    assert.ok(r.ok);
    assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/route-plan');
    assert.equal(calls[0].init?.headers?.Authorization, 'Bearer user-jwt');
    assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), { plan_id: PLAN_ID, origin: ORIGIN });
  });

  it('22. 未ログイン / 位置情報なし（Web 含む）は通信しない', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: ROUTED }));
    assert.equal(((await callRoutePlan(PLAN_ID, ORIGIN, { config: CONFIG, accessToken: null, fetchImpl: impl })) as { kind: string }).kind, 'unauthorized');
    assert.equal(((await callRoutePlan(PLAN_ID, null, { config: CONFIG, accessToken: 't', fetchImpl: impl })) as { kind: string }).kind, 'origin_required');
    assert.equal(calls.length, 0);
  });

  it('20・21・12. サーバーのエラーをやさしい文言へ（generated / 他人の plan / Routes 失敗）', async () => {
    const cases: [number, unknown, string, boolean][] = [
      [409, { error: 'plan_not_accepted' }, 'plan_not_accepted', false],
      [404, { error: 'plan_not_found' }, 'plan_not_found', false], // 他ユーザーの plan も RLS で 404
      [422, { error: 'unsupported_plan' }, 'unsupported_plan', false],
      [400, { error: 'origin_required' }, 'origin_required', false],
      [502, { error: 'routes_unavailable', reasons: ['api_error'] }, 'routes_unavailable', true],
      [500, { error: 'server_configuration_missing' }, 'server', true],
      [401, { code: 401, message: 'Invalid JWT' }, 'unauthorized', false],
    ];
    for (const [status, body, kind, retryable] of cases) {
      const { impl } = fakeFetch(() => ({ status, body }));
      const r = await callRoutePlan(PLAN_ID, ORIGIN, { config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.equal(r.ok, false);
      if (r.ok) continue;
      assert.equal(r.kind, kind, `${status}`);
      assert.equal(r.retryable, retryable);
      assert.equal(r.message, ROUTE_ERROR_MESSAGES[r.kind]);
      assert.ok(!/HTTP|error|Invalid/.test(r.message));
    }
  });

  it('13・ネットワーク. タイムアウト / 通信エラー / 不正な応答', async () => {
    const hanging: FetchLike = (_u, init) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    assert.equal(((await callRoutePlan(PLAN_ID, ORIGIN, { config: CONFIG, accessToken: 't', fetchImpl: hanging, timeoutMs: 20 })) as { kind: string }).kind, 'timeout');
    const net = fakeFetch(() => Promise.reject(new TypeError('offline')));
    assert.equal(((await callRoutePlan(PLAN_ID, ORIGIN, { config: CONFIG, accessToken: 't', fetchImpl: net.impl })) as { kind: string }).kind, 'network');
    for (const body of [{}, { ...ROUTED, legs: [] }, 'x']) {
      const f = fakeFetch(() => ({ status: 200, body }));
      assert.equal(((await callRoutePlan(PLAN_ID, ORIGIN, { config: CONFIG, accessToken: 't', fetchImpl: f.impl })) as { kind: string }).kind, 'invalid_response');
    }
    assert.equal(isRoutedPlan(ROUTED), true);
  });
});

describe('ルートのキャッシュ・二重リクエスト防止', () => {
  function setup(results: RouteResult[] = []) {
    let clock = 1_000_000;
    let pending: ((r: RouteResult) => void) | null = null;
    const calls: string[] = [];
    const store = createPlanRouteStore({
      fetch: (planId) => {
        calls.push(planId);
        const next = results.shift();
        return next ? Promise.resolve(next) : new Promise((r) => (pending = r));
      },
      now: () => clock,
    });
    return { store, calls, advance: (ms: number) => (clock += ms), resolve: (r: RouteResult) => pending?.(r) };
  }
  const OK: RouteResult = { ok: true, data: ROUTED };

  it('23. 取得中の再要求は送らない', async () => {
    const { store, calls, resolve } = setup();
    const a = store.load(PLAN_ID, ORIGIN);
    const b = store.load(PLAN_ID, ORIGIN);
    assert.equal(store.getState()[PLAN_ID].status, 'loading');
    resolve(OK);
    await Promise.all([a, b]);
    assert.equal(calls.length, 1);
    assert.equal(store.getState()[PLAN_ID].status, 'ready');
  });

  it('24. 同じプラン・ほぼ同じ出発地点・10分以内は再利用、それ以外は取り直す', async () => {
    const { store, calls, advance } = setup([OK, OK, OK, OK]);
    await store.load(PLAN_ID, ORIGIN);
    await store.load(PLAN_ID, { latitude: 43.06874, longitude: 141.35083 }); // 数m のずれ
    assert.equal(calls.length, 1);
    await store.load(PLAN_ID, { latitude: 43.075, longitude: 141.3508 }); // 約700m 移動
    assert.equal(calls.length, 2);
    advance(11 * 60_000);
    await store.load(PLAN_ID, { latitude: 43.075, longitude: 141.3508 });
    assert.equal(calls.length, 3);
    await store.load(PLAN_ID, { latitude: 43.075, longitude: 141.3508 }, { force: true });
    assert.equal(calls.length, 4, '「ルートを更新」は取り直す');
    assert.equal(routeCacheKey(PLAN_ID, ORIGIN), `${PLAN_ID}|43.069|141.351`);
  });

  it('失敗は error として保持し、再試行で回復', async () => {
    const fail: RouteResult = { ok: false, kind: 'routes_unavailable', message: ROUTE_ERROR_MESSAGES.routes_unavailable, retryable: true, devDetail: 'HTTP 502' };
    const { store } = setup([fail, OK]);
    await store.load(PLAN_ID, ORIGIN);
    assert.equal(store.getState()[PLAN_ID].status, 'error');
    await store.load(PLAN_ID, ORIGIN, { force: true });
    assert.equal(store.getState()[PLAN_ID].status, 'ready');
  });
});

describe('表示（推測しない）', () => {
  it('3・10. 乗り物の種別と路線', () => {
    assert.deepEqual(vehicleLabel({ vehicle_type: 'SUBWAY', vehicle_name: null }), { icon: '🚇', label: '地下鉄' });
    assert.deepEqual(vehicleLabel({ vehicle_type: 'BUS', vehicle_name: '路線バス' }), { icon: '🚌', label: '路線バス' });
    assert.deepEqual(vehicleLabel({ vehicle_type: 'HEAVY_RAIL', vehicle_name: null }), { icon: '🚃', label: '電車' });
    assert.deepEqual(vehicleLabel({ vehicle_type: null, vehicle_name: null }), { icon: '🚉', label: '公共交通' });
    assert.deepEqual(modeLabel('WALK'), { icon: '🚶', label: '徒歩' });
    assert.deepEqual(modeLabel('DRIVE'), { icon: '🚗', label: '車' });
  });

  it('1・2. 距離・時間', () => {
    assert.equal(minutesText(300), '5分');
    assert.equal(minutesText(4500), '1時間15分');
    assert.equal(distanceText(347), '350m');
    assert.equal(distanceText(4210), '4.2km');
    assert.equal(distanceText(null), null);
  });

  it('8・9. 運賃: 取得できた区間だけ金額、取れない区間は「運賃情報なし」、徒歩・車は出さない', () => {
    assert.equal(legFareText(leg()), '運賃 210円');
    assert.equal(legFareText(leg({ fare: null, fare_status: 'unknown' })), '運賃情報なし');
    assert.equal(legFareText(leg({ mode: 'WALK', fare: null, fare_status: 'not_applicable' })), null);
    assert.equal(faresSummaryText({ status: 'all_known', known_total: 580, currency: 'JPY', unknown_legs: 0 }), '交通費 580円');
    assert.equal(faresSummaryText({ status: 'partial', known_total: 290, currency: 'JPY', unknown_legs: 1 }), '確認できた交通費 290円＋一部運賃不明');
    assert.equal(faresSummaryText({ status: 'none_known', known_total: 0, currency: null, unknown_legs: 2 }), '交通費: 運賃情報なし');
    assert.match(faresSummaryText({ status: 'not_applicable', known_total: 0, currency: null, unknown_legs: 0 }), /ガソリン代・駐車料金は含みません/);
  });

  it('17・18. 予算: 予算内 / 超過 / 判定できない', () => {
    assert.equal(budgetSummaryText(ROUTED.budget), '合計 2,210円（目安）・予算内');
    assert.equal(
      budgetSummaryText({ ...ROUTED.budget, confirmed_total_yen: 3290, completeness: 'partial', over_budget: true }),
      '確認できた範囲で 3,290円・予算（3,000円）を超えています'
    );
    assert.match(budgetSummaryText({ ...ROUTED.budget, completeness: 'partial', over_budget: null }), /判定できません/);
  });

  it('15・16. 時間: 収まる / 調整 / 収まらない', () => {
    assert.equal(fitMessage(ROUTED), null);
    assert.equal(
      fitMessage({ fit_status: 'does_not_fit', adjustments: [] }),
      '実際の移動時間を確認したところ、このプランは指定した時間内に収まりません。'
    );
    assert.match(
      fitMessage({ fit_status: 'adjusted', adjustments: [{ type: 'shortened_stay', place_id: 'p', place_name: 'パフェ佐藤', from_minutes: 45, to_minutes: 25 }] }) ?? '',
      /パフェ佐藤の滞在を45分→25分/
    );
    assert.match(fitMessage({ fit_status: 'adjusted', adjustments: [{ type: 'dropped_place', place_id: 'p', place_name: '大通公園' }] }) ?? '', /大通公園を外しました/);
  });

  it('公共交通: 「見つからなかった」と「取得できなかった」を区別（古いサーバーの応答にも対応）', () => {
    const walk = { mode: 'WALK' as const, transit_unavailable: true };
    assert.equal(transitNoteText({ ...walk, transit_status: 'no_route' }), '公共交通の経路が見つかりませんでした');
    for (const s of ['api_error', 'timeout', 'invalid_response'] as const) {
      assert.equal(transitNoteText({ ...walk, transit_status: s }), '公共交通の経路を取得できませんでした');
    }
    assert.equal(transitNoteText({ ...walk, transit_unavailable: false, transit_status: 'not_requested' }), null);
    assert.equal(transitNoteText({ mode: 'TRANSIT', transit_unavailable: false, transit_status: 'ok' }), null);
    assert.equal(transitNoteText(walk), '公共交通の経路は見つかりませんでした', 'transit_status が無い古い応答');
  });

  it('11・14. 経路なし・一部失敗の文言', () => {
    assert.equal(legFailureText({ failure_reason: 'no_route' }), '選んだ移動手段では経路が見つかりませんでした');
    assert.match(legFailureText({ failure_reason: 'timeout' }), /時間がかかった/);
  });

  it('25. Google マップの URL（公式 Maps URLs の Directions 形式）', () => {
    const url = googleMapsDirectionsUrl({
      origin: ORIGIN,
      destination: { latitude: 43.06, longitude: 141.35 },
      destinationName: 'THE BUTTER',
      destinationPlaceId: 'ChIJ1',
      mode: 'TRANSIT',
    });
    assert.equal(
      url,
      'https://www.google.com/maps/dir/?api=1&origin=43.068700%2C141.350800&destination=THE%20BUTTER&destination_place_id=ChIJ1&travelmode=transit'
    );
    const noPlace = googleMapsDirectionsUrl({ origin: null, destination: { latitude: 43.06, longitude: 141.35 }, mode: 'WALK' });
    assert.equal(noPlace, 'https://www.google.com/maps/dir/?api=1&destination=43.060000%2C141.350000&travelmode=walking');
    assert.ok(googleMapsDirectionsUrl({ origin: null, destination: { latitude: 1, longitude: 2 }, mode: 'DRIVE' }).endsWith('travelmode=driving'));
    assert.ok(url.length < 2048);
  });
});
