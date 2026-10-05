/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acquireCurrentLocation,
  createCurrentLocationStore,
  LAST_KNOWN_MAX_AGE_MS,
  LOCATION_MESSAGES,
  LOCATION_REUSE_MS,
  toCurrentLocation,
  toPlanOrigin,
} from '../src/location/current-location-service';
import type { LocationPermission, LocationProvider, RawPosition } from '../src/location/current-location-types';
import { locationProvider as webProvider } from '../src/location/location-provider.web';
import {
  computeInitialView,
  CURRENT_AREA_DELTA,
  distanceMeters,
  NEARBY_RADIUS_M,
  regionAround,
  toMapPins,
} from '../src/place/saved-map-data';
import { toSavedPlaceItem, type SavedPlaceItem } from '../src/place/saved-places-client';

const NOW = 1_790_000_000_000;
const SAPPORO_STATION = { latitude: 43.0687, longitude: 141.3508 };

const pos = (latitude: unknown, longitude: unknown, extra: Partial<RawPosition> & { accuracy?: unknown } = {}): RawPosition => ({
  coords: { latitude, longitude, accuracy: extra.accuracy ?? 35 },
  timestamp: extra.timestamp ?? NOW,
});

/** 呼び出しを記録するモックの取得元 */
function provider(opts: {
  available?: boolean;
  permission?: LocationPermission;
  afterRequest?: LocationPermission;
  services?: boolean | Error;
  lastKnown?: RawPosition | null | Error;
  current?: RawPosition | Error | 'hang';
}) {
  const calls = { request: 0, current: 0, lastKnown: 0 };
  let permission = opts.permission ?? { granted: true, canAskAgain: true };
  const p: LocationProvider = {
    isAvailable: () => opts.available ?? true,
    getPermission: async () => permission,
    requestPermission: async () => {
      calls.request++;
      permission = opts.afterRequest ?? permission;
      return permission;
    },
    hasServicesEnabled: async () => {
      if (opts.services instanceof Error) throw opts.services;
      return opts.services ?? true;
    },
    getLastKnown: async () => {
      calls.lastKnown++;
      if (opts.lastKnown instanceof Error) throw opts.lastKnown;
      return opts.lastKnown ?? null;
    },
    getCurrent: () => {
      calls.current++;
      if (opts.current === 'hang') return new Promise(() => {});
      if (opts.current instanceof Error) return Promise.reject(opts.current);
      return Promise.resolve(opts.current ?? pos(SAPPORO_STATION.latitude, SAPPORO_STATION.longitude));
    },
  };
  return { p, calls };
}

const run = (p: LocationProvider, prompt = true, timeoutMs = 50) => acquireCurrentLocation(p, { prompt, timeoutMs, now: () => NOW });

// ---------------------------------------------------------------------------------------------
describe('acquireCurrentLocation（取得フロー）', () => {
  it('1. 許可済み → 正常取得（latitude / longitude / accuracy / 取得時刻）', async () => {
    const { p, calls } = provider({});
    const r = await run(p);
    assert.deepEqual(r, {
      ok: true,
      location: { latitude: 43.0687, longitude: 141.3508, accuracy: 35, timestamp: NOW, source: 'current' },
    });
    assert.equal(calls.request, 0, '許可済みならダイアログを出さない');
  });

  it('2. 初回権限要求 → 許可 → 正常取得', async () => {
    const { p, calls } = provider({
      permission: { granted: false, canAskAgain: true },
      afterRequest: { granted: true, canAskAgain: true },
    });
    const r = await run(p, true);
    assert.equal(r.ok, true);
    assert.equal(calls.request, 1);
  });

  it('2b. prompt=false（画面を開いた時）は未許可でもダイアログを出さない', async () => {
    const { p, calls } = provider({ permission: { granted: false, canAskAgain: true } });
    const r = await run(p, false);
    assert.deepEqual(r, { ok: false, reason: 'permission_denied' });
    assert.equal(calls.request, 0);
    assert.equal(calls.current, 0);
  });

  it('3. 権限拒否 → permission_denied（測位しない）', async () => {
    const { p, calls } = provider({
      permission: { granted: false, canAskAgain: true },
      afterRequest: { granted: false, canAskAgain: true },
    });
    assert.deepEqual(await run(p), { ok: false, reason: 'permission_denied' });
    assert.equal(calls.current, 0);
  });

  it('4. 永久拒否相当（canAskAgain=false）→ permission_blocked、ダイアログも出さない', async () => {
    const { p, calls } = provider({ permission: { granted: false, canAskAgain: false } });
    assert.deepEqual(await run(p), { ok: false, reason: 'permission_blocked' });
    assert.equal(calls.request, 0);
    // 拒否直後に「今後表示しない」になった場合
    const after = provider({
      permission: { granted: false, canAskAgain: true },
      afterRequest: { granted: false, canAskAgain: false },
    });
    assert.deepEqual(await run(after.p), { ok: false, reason: 'permission_blocked' });
  });

  it('5. 位置情報サービス OFF → services_disabled（測位しない）', async () => {
    const { p, calls } = provider({ services: false });
    assert.deepEqual(await run(p), { ok: false, reason: 'services_disabled' });
    assert.equal(calls.current, 0);
  });

  it('6. 取得 API エラー → unavailable / 権限APIエラー → unavailable', async () => {
    const a = provider({ current: new Error('Location provider is unavailable') });
    const r = await run(a.p);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'unavailable');
    const b: LocationProvider = { ...provider({}).p, getPermission: () => Promise.reject(new Error('boom')) };
    assert.equal(((await run(b)) as { reason: string }).reason, 'unavailable');
  });

  it('7. タイムアウト → timeout', async () => {
    const { p } = provider({ current: 'hang' });
    assert.deepEqual(await run(p, true, 20), { ok: false, reason: 'timeout' });
  });

  it('8. 不正な緯度経度 → invalid_coordinates', async () => {
    for (const [lat, lng] of [[NaN, 141], [43, Infinity], [91, 141], [43, 181], [0, 0], [null, 141], ['43', '141']] as [unknown, unknown][]) {
      const { p } = provider({ current: pos(lat, lng) });
      assert.deepEqual(await run(p), { ok: false, reason: 'invalid_coordinates' }, `${lat},${lng}`);
    }
  });

  it('直近のキャッシュ位置が新しく精度も十分なら測位しない', async () => {
    const { p, calls } = provider({ lastKnown: pos(43.06, 141.35, { timestamp: NOW - 30_000, accuracy: 80 }) });
    const r = await run(p);
    assert.equal(r.ok && r.location.source, 'last_known');
    assert.equal(calls.current, 0);
  });

  it('キャッシュ位置が古い・不正・取得エラーなら測位する', async () => {
    for (const lastKnown of [pos(43.06, 141.35, { timestamp: NOW - LAST_KNOWN_MAX_AGE_MS - 1 }), pos(NaN, 1), new Error('x')]) {
      const { p, calls } = provider({ lastKnown });
      const r = await run(p);
      assert.equal(r.ok && r.location.source, 'current');
      assert.equal(calls.current, 1);
    }
  });

  it('位置情報サービスの判定に失敗しても測位は試す', async () => {
    const { p } = provider({ services: new Error('not supported') });
    assert.equal((await run(p)).ok, true);
  });

  it('15. Web / 位置情報モジュールを含まないビルド → unsupported（例外を投げない）', async () => {
    assert.deepEqual(await run(webProvider), { ok: false, reason: 'unsupported' });
    assert.deepEqual(await run(provider({ available: false }).p), { ok: false, reason: 'unsupported' });
  });

  it('全ての失敗理由に日本語メッセージがある', () => {
    for (const message of Object.values(LOCATION_MESSAGES)) assert.match(message, /[ぁ-ん]/);
    assert.match(LOCATION_MESSAGES.permission_denied, /位置情報を許可すると、現在地からプランを作成できます/);
  });
});

describe('toCurrentLocation / toPlanOrigin', () => {
  it('accuracy / timestamp が無い・不正なら null / 取得時刻で補う', () => {
    const r = toCurrentLocation({ coords: { latitude: 43, longitude: 141, accuracy: -1 } }, 'current', NOW);
    assert.deepEqual(r, { latitude: 43, longitude: 141, accuracy: null, timestamp: NOW, source: 'current' });
    assert.equal(toCurrentLocation(null, 'current', NOW), null);
    assert.equal(toCurrentLocation({} as RawPosition, 'current', NOW), null);
  });

  it('次工程（AIプラン生成）の出発地の形に変換', () => {
    assert.deepEqual(
      toPlanOrigin({ latitude: 43.0687, longitude: 141.3508, accuracy: 35.6, timestamp: Date.UTC(2026, 8, 26, 0, 0, 0), source: 'current' }),
      { latitude: 43.0687, longitude: 141.3508, accuracy_m: 36, captured_at: '2026-09-26T00:00:00.000Z' }
    );
  });
});

describe('現在地ストア（/map と次工程で共有）', () => {
  function setup(p: LocationProvider) {
    let clock = NOW;
    const results: unknown[] = [];
    const store = createCurrentLocationStore({ provider: p, now: () => clock, timeoutMs: 50, onResult: (s) => results.push(s) });
    return { store, results, advance: (ms: number) => (clock += ms) };
  }

  it('13. 現在地ボタン: 取得 → ready。5分以内の再押下は再取得しない', async () => {
    const { p, calls } = provider({});
    const { store, advance } = setup(p);
    assert.equal(store.getState().status, 'idle');
    const pending = store.locate({ prompt: true });
    assert.equal(store.getState().status, 'locating');
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(store.getState().status, 'ready');
    assert.equal(store.getState().location?.latitude, 43.0687);
    advance(60_000);
    await store.locate({ prompt: true });
    assert.equal(calls.current, 1, '取得済みの現在地を再利用');
    advance(LOCATION_REUSE_MS);
    await store.locate({ prompt: true });
    assert.equal(calls.current, 2, '古くなったら取得し直す');
    await store.locate({ prompt: true, force: true });
    assert.equal(calls.current, 3, '再試行（force）は常に取得');
  });

  it('同時に押しても測位は1回', async () => {
    const { p, calls } = provider({});
    const { store } = setup(p);
    await Promise.all([store.locate({ prompt: true }), store.locate({ prompt: true }), store.locate({ prompt: false })]);
    assert.equal(calls.current, 1);
  });

  it('失敗しても以前の現在地は保持し、エラー理由を出す', async () => {
    let fail = false;
    const base = provider({}).p;
    const p: LocationProvider = { ...base, getCurrent: () => (fail ? Promise.reject(new Error('x')) : base.getCurrent()) };
    const { store } = setup(p);
    await store.locate({ prompt: true });
    fail = true;
    await store.locate({ prompt: true, force: true });
    assert.equal(store.getState().status, 'error');
    assert.equal(store.getState().error, 'unavailable');
    assert.equal(store.getState().location?.latitude, 43.0687);
  });

  it('プライバシー: ログ用の通知に座標を含めない', async () => {
    const { store, results } = setup(provider({}).p);
    await store.locate({ prompt: true });
    const text = JSON.stringify(results);
    assert.ok(!text.includes('43.0687') && !text.includes('141.3508'), text);
  });
});

// ---------------------------------------------------------------------------------------------
function item(id: string, latitude: unknown, longitude: unknown): SavedPlaceItem {
  const converted = toSavedPlaceItem({
    id,
    saved_at: '2026-09-26T00:00:00Z',
    source_platform: 'instagram',
    source_url: null,
    place: { id: `p-${id}`, name: id, category: 'cafe', address: '', latitude, longitude },
  });
  assert.ok(converted);
  return converted;
}

const ODORI = item('odori', 43.0606, 141.3545); // 札幌駅から約1km
const MARUYAMA = item('maruyama', 43.0543, 141.3106); // 約3.6km
const OTARU = item('otaru', 43.1907, 140.9947); // 約32km
const TOKYO = item('tokyo', 35.6812, 139.7671); // 約830km

describe('computeInitialView（現在地を含めた初期表示）', () => {
  it('distanceMeters の目安', () => {
    const [otaru, tokyo] = toMapPins([OTARU, TOKYO]).pins;
    const d = distanceMeters(SAPPORO_STATION, otaru);
    assert.ok(d > 30_000 && d < 34_000, String(d));
    assert.ok(distanceMeters(SAPPORO_STATION, tokyo) > 800_000);
  });

  it('現在地なし → Step 4-2 と同じ（保存Place全体）', () => {
    const { pins } = toMapPins([ODORI, MARUYAMA, TOKYO]);
    const v = computeInitialView(pins, null);
    assert.equal(v.mode, 'saved');
    assert.equal(v.fitPoints.length, 3);
    assert.equal(v.farCount, 0);
  });

  it('9. 保存Place 0件 + 現在地 → 現在地周辺', () => {
    const v = computeInitialView([], SAPPORO_STATION);
    assert.equal(v.mode, 'current_only');
    assert.deepEqual(v.region, regionAround(SAPPORO_STATION));
    assert.equal(computeInitialView([], null).region, null);
  });

  it('10. 保存Placeあり + 現在地 → 現在地と近くの Place が収まる', () => {
    const { pins } = toMapPins([ODORI, MARUYAMA]);
    const v = computeInitialView(pins, SAPPORO_STATION);
    assert.equal(v.mode, 'current_nearby');
    assert.equal(v.nearbyCount, 2);
    assert.equal(v.farCount, 0);
    assert.equal(v.fitPoints.length, 3, '現在地 + 2件');
    for (const p of [SAPPORO_STATION, ...pins]) {
      assert.ok(Math.abs(p.latitude - v.region!.latitude) <= v.region!.latitudeDelta / 2);
      assert.ok(Math.abs(p.longitude - v.region!.longitude) <= v.region!.longitudeDelta / 2);
    }
  });

  it('11. 座標なし Place が混在しても正常な Place だけで計算', () => {
    const { pins, missing } = toMapPins([ODORI, item('nocoord', null, null), item('bad', 999, 1)]);
    assert.equal(missing.length, 2);
    const v = computeInitialView(pins, SAPPORO_STATION);
    assert.equal(v.nearbyCount, 1);
    assert.equal(v.farCount, 0);
  });

  it('12. 極端に遠い Place（東京・小樽）は表示範囲に含めない（日本全体までズームアウトしない）', () => {
    const { pins } = toMapPins([ODORI, OTARU, TOKYO]);
    const v = computeInitialView(pins, SAPPORO_STATION);
    assert.equal(v.mode, 'current_nearby');
    assert.equal(v.nearbyCount, 1);
    assert.equal(v.farCount, 2);
    assert.ok(v.region!.latitudeDelta < 1, `latitudeDelta=${v.region!.latitudeDelta}`);
    assert.ok(!v.fitPoints.some((p) => p.latitude === TOKYO.latitude));
  });

  it('12b. 近くに保存Placeが1件も無い → 現在地周辺（約3km）のみ', () => {
    const { pins } = toMapPins([TOKYO]);
    const v = computeInitialView(pins, SAPPORO_STATION);
    assert.equal(v.mode, 'current_only');
    assert.equal(v.farCount, 1);
    assert.equal(v.region!.latitudeDelta, CURRENT_AREA_DELTA);
  });

  it('現在地のすぐ近くの1件だけなら、ズームしすぎず現在地周辺の範囲を確保', () => {
    const near = item('near', 43.0689, 141.351);
    const v = computeInitialView(toMapPins([near]).pins, SAPPORO_STATION);
    assert.equal(v.region!.latitudeDelta, CURRENT_AREA_DELTA);
    assert.deepEqual(v.fitPoints, [], 'fitToCoordinates ではなく region を使う');
  });

  it('しきい値は 30km', () => {
    assert.equal(NEARBY_RADIUS_M, 30_000);
  });
});
