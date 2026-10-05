/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeRegion,
  findSelectedPin,
  isValidCoordinate,
  MIN_REGION_DELTA,
  toMapPins,
} from '../src/place/saved-map-data';
import { toSavedPlaceItem, type FetchSavedPlacesResult, type SavedPlaceItem } from '../src/place/saved-places-client';
import { createSavedPlacesStore, viewSavedPlaces } from '../src/place/saved-places-store';

function item(id: string, latitude: unknown, longitude: unknown, savedAt = '2026-09-26T00:00:00Z'): SavedPlaceItem {
  const converted = toSavedPlaceItem({
    id,
    saved_at: savedAt,
    source_platform: 'instagram',
    source_url: 'https://www.instagram.com/p/abc/',
    place: { id: `place-${id}`, name: `Place ${id}`, category: 'cafe', address: '北海道札幌市中央区', latitude, longitude },
  });
  assert.ok(converted);
  return converted;
}

const SAPPORO = item('sapporo', 43.0628, 141.3527);
const OTARU = item('otaru', 43.1907, 140.9947);
const ASAHIKAWA = item('asahikawa', 43.7706, 142.365);

// ---------------------------------------------------------------------------------------------
describe('toMapPins（地図用データ）', () => {
  it('2・8. 正常な緯度経度の Place だけがピンになる（複数）', () => {
    const { pins, missing } = toMapPins([SAPPORO, OTARU, ASAHIKAWA]);
    assert.deepEqual(pins.map((p) => p.id), ['sapporo', 'otaru', 'asahikawa']);
    assert.equal(missing.length, 0);
    assert.equal(pins[0].latitude, 43.0628);
    assert.equal(pins[0].longitude, 141.3527);
    assert.equal(pins[0].item.name, 'Place sapporo', 'カード表示用に元データを保持');
  });

  it('3. 座標欠損・不正の Place を除外し、正常な Place は残す', () => {
    const broken = [
      item('no-lat', null, 141.35),
      item('no-lng', 43.06, null),
      item('both-null', null, null),
      item('string-bad', 'abc', '141'),
      item('out-of-range', 91, 141),
      item('lng-out', 43, 181),
      item('null-island', 0, 0),
    ];
    const { pins, missing } = toMapPins([SAPPORO, ...broken]);
    assert.deepEqual(pins.map((p) => p.id), ['sapporo']);
    assert.deepEqual(missing.map((m) => m.savedPlaceId), broken.map((b) => b.savedPlaceId));
  });

  it('数値文字列の座標（Postgres numeric）はピンになる', () => {
    const { pins } = toMapPins([item('str', '43.062800', '141.352700')]);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].latitude, 43.0628);
  });

  it('4. 0件 / 座標付き 0件', () => {
    assert.deepEqual(toMapPins([]), { pins: [], missing: [] });
    const r = toMapPins([item('a', null, null)]);
    assert.equal(r.pins.length, 0);
    assert.equal(r.missing.length, 1);
  });

  it('isValidCoordinate', () => {
    assert.equal(isValidCoordinate(35.68, 139.76), true);
    assert.equal(isValidCoordinate(-33.86, 151.2), true);
    assert.equal(isValidCoordinate(90, 180), true);
    for (const [lat, lng] of [[NaN, 1], [1, Infinity], [null, 1], [undefined, 1], ['35', 139], [0, 0], [-91, 0]] as [unknown, unknown][]) {
      assert.equal(isValidCoordinate(lat, lng), false, `${lat},${lng}`);
    }
  });
});

describe('computeRegion（初期表示範囲）', () => {
  it('9. 1件: その場所を中心に最小範囲（約1km）', () => {
    const { pins } = toMapPins([SAPPORO]);
    assert.deepEqual(computeRegion(pins), {
      latitude: 43.0628,
      longitude: 141.3527,
      latitudeDelta: MIN_REGION_DELTA,
      longitudeDelta: MIN_REGION_DELTA,
    });
  });

  it('8. 複数件: 全ピンが範囲内に収まる（余白あり）', () => {
    const { pins } = toMapPins([SAPPORO, OTARU, ASAHIKAWA]);
    const r = computeRegion(pins)!;
    for (const p of pins) {
      assert.ok(Math.abs(p.latitude - r.latitude) < r.latitudeDelta / 2, `lat ${p.id}`);
      assert.ok(Math.abs(p.longitude - r.longitude) < r.longitudeDelta / 2, `lng ${p.id}`);
    }
    // 余白: 外接矩形より広い
    assert.ok(r.latitudeDelta > 43.7706 - 43.0628);
  });

  it('同じ場所に近い複数件でも最小範囲より狭くならない', () => {
    const r = computeRegion([
      { latitude: 43.0628, longitude: 141.3527 },
      { latitude: 43.0629, longitude: 141.3528 },
    ])!;
    assert.equal(r.latitudeDelta, MIN_REGION_DELTA);
    assert.equal(r.longitudeDelta, MIN_REGION_DELTA);
  });

  it('0件は null', () => {
    assert.equal(computeRegion([]), null);
  });
});

describe('findSelectedPin（Place選択）', () => {
  const { pins } = toMapPins([SAPPORO, OTARU]);

  it('7. 選択したピンの Place 名・カテゴリ・住所を取れる', () => {
    const selected = findSelectedPin(pins, 'otaru');
    assert.equal(selected?.item.name, 'Place otaru');
    assert.equal(selected?.item.categoryLabel, 'カフェ');
    assert.equal(selected?.item.address, '北海道札幌市中央区');
  });

  it('未選択・存在しない（再取得で消えた）ID は null', () => {
    assert.equal(findSelectedPin(pins, null), null);
    assert.equal(findSelectedPin(pins, 'deleted'), null);
  });

  it('座標の無い Place は選択できない', () => {
    const { pins: withMissing } = toMapPins([SAPPORO, item('nocoord', null, null)]);
    assert.equal(findSelectedPin(withMissing, 'nocoord'), null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('savedPlacesStore（/saved と /map で共有する取得）', () => {
  function setup(results: FetchSavedPlacesResult[] | ((token: string) => Promise<FetchSavedPlacesResult>)) {
    const calls: string[] = [];
    let clock = 1_000_000;
    let version = 0;
    const unauthorized: string[] = [];
    const store = createSavedPlacesStore({
      fetch: async (token) => {
        calls.push(token);
        if (typeof results === 'function') return results(token);
        return results.shift() ?? { status: 'ok', items: [], skipped: 0 };
      },
      now: () => clock,
      getVersion: () => version,
      onUnauthorized: (d) => unauthorized.push(d),
    });
    return {
      store,
      calls,
      unauthorized,
      advance: (ms: number) => (clock += ms),
      bumpVersion: () => (version += 1),
    };
  }

  it('1. ログインユーザーの保存Placeを取得できる', async () => {
    const { store, calls } = setup([{ status: 'ok', items: [SAPPORO, OTARU], skipped: 0 }]);
    await store.load('token-a');
    const s = store.getState();
    assert.equal(s.phase, 'ready');
    assert.deepEqual(s.items.map((i) => i.savedPlaceId), ['sapporo', 'otaru']);
    assert.deepEqual(calls, ['token-a']);
  });

  it('/saved → /map の移動（新しいうち）は再取得しない。同時取得は1本にまとめる', async () => {
    const { store, calls, advance } = setup([{ status: 'ok', items: [SAPPORO], skipped: 0 }]);
    await Promise.all([store.load('t'), store.load('t'), store.load('t')]);
    assert.equal(calls.length, 1);
    advance(10_000);
    await store.load('t');
    assert.equal(calls.length, 1);
    advance(60_000);
    await store.load('t');
    assert.equal(calls.length, 2, '60秒以上経てば再取得');
  });

  it('保存が発生したら次のフォーカスで再取得 / 手動の再読み込みは常に取得', async () => {
    const { store, calls, bumpVersion } = setup([]);
    await store.load('t');
    bumpVersion();
    await store.load('t');
    assert.equal(calls.length, 2);
    await store.load('t', { force: true });
    assert.equal(calls.length, 3);
  });

  it('再読み込み中は一覧を保持したまま refreshing', async () => {
    let resolve!: (r: FetchSavedPlacesResult) => void;
    const s2 = createSavedPlacesStore({ fetch: () => new Promise((r) => (resolve = r)) });
    const first = s2.load('t', { force: true });
    assert.equal(s2.getState().phase, 'loading', '初回は loading');
    resolve({ status: 'ok', items: [SAPPORO], skipped: 0 });
    await first;
    const second = s2.load('t', { force: true });
    assert.equal(s2.getState().phase, 'ready');
    assert.equal(s2.getState().refreshing, true);
    assert.equal(s2.getState().items.length, 1);
    resolve({ status: 'ok', items: [SAPPORO, OTARU], skipped: 0 });
    await second;
    assert.equal(s2.getState().refreshing, false);
    assert.equal(s2.getState().items.length, 2);
  });

  it('5. DB エラー → error（再読み込みで回復）', async () => {
    const { store } = setup([
      { status: 'error', message: '保存した場所を読み込めませんでした', devDetail: 'HTTP 500' },
      { status: 'ok', items: [SAPPORO], skipped: 0 },
    ]);
    await store.load('t');
    assert.equal(store.getState().phase, 'error');
    assert.equal(store.getState().devDetail, 'HTTP 500');
    await store.load('t', { force: true });
    assert.equal(store.getState().phase, 'ready');
  });

  it('6. 未ログイン → 通信せず unauthorized / 期限切れ JWT → unauthorized（一覧は破棄）', async () => {
    const { store, calls, unauthorized } = setup([
      { status: 'ok', items: [SAPPORO], skipped: 0 },
      { status: 'unauthorized', message: 'ログインが必要です', devDetail: 'HTTP 401 PGRST301' },
    ]);
    await store.load(null);
    assert.equal(store.getState().phase, 'unauthorized');
    assert.equal(calls.length, 0);
    await store.load('t');
    await store.load('t', { force: true });
    assert.equal(store.getState().phase, 'unauthorized');
    assert.equal(store.getState().items.length, 0);
    assert.deepEqual(unauthorized, ['HTTP 401 PGRST301']);
  });

  it('別ユーザーでログインし直したら前の一覧を持ち越さない', async () => {
    let resolveB!: (r: FetchSavedPlacesResult) => void;
    const store = createSavedPlacesStore({
      fetch: (token) =>
        token === 'user-a'
          ? Promise.resolve({ status: 'ok', items: [SAPPORO], skipped: 0 })
          : new Promise((r) => (resolveB = r)),
    });
    await store.load('user-a');
    const pendingB = store.load('user-b');
    assert.equal(store.getState().phase, 'loading');
    assert.equal(store.getState().items.length, 0, 'user-a の一覧は消える');
    resolveB({ status: 'ok', items: [OTARU], skipped: 0 });
    await pendingB;
    assert.deepEqual(store.getState().items.map((i) => i.savedPlaceId), ['otaru']);
  });

  it('取得中にセッションが変わったら古い結果を捨てる', async () => {
    let resolveA!: (r: FetchSavedPlacesResult) => void;
    const store = createSavedPlacesStore({
      fetch: (token) =>
        token === 'user-a' ? new Promise((r) => (resolveA = r)) : Promise.resolve({ status: 'ok', items: [OTARU], skipped: 0 }),
    });
    const pendingA = store.load('user-a');
    await store.load('user-b');
    resolveA({ status: 'ok', items: [SAPPORO], skipped: 0 });
    await pendingA;
    assert.deepEqual(store.getState().items.map((i) => i.savedPlaceId), ['otaru']);
  });

  it('viewSavedPlaces: 未ログイン・別セッションの結果は見せない', async () => {
    const { store } = setup([{ status: 'ok', items: [SAPPORO], skipped: 0 }]);
    await store.load('t');
    assert.equal(viewSavedPlaces(store.getState(), null).phase, 'unauthorized');
    assert.equal(viewSavedPlaces(store.getState(), 'other').phase, 'loading');
    assert.equal(viewSavedPlaces(store.getState(), 'other').items.length, 0);
    assert.equal(viewSavedPlaces(store.getState(), 't').phase, 'ready');
  });
});
