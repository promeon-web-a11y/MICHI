/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike } from '../src/place/identify-place-client';
import {
  buildSavedPlacesUrl,
  fetchSavedPlaces,
  type FetchSavedPlacesResult,
  formatSavedAt,
  getSavedPlacesChangeVersion,
  markSavedPlacesChanged,
  SAVED_PLACES_SELECT,
  shouldRefetchSavedPlaces,
  toSavedPlaceItem,
  toSavedPlaceItems,
} from '../src/place/saved-places-client';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const messageOf = (r: FetchSavedPlacesResult) => ('message' in r ? r.message : null);
const detailOf = (r: FetchSavedPlacesResult) => ('devDetail' in r ? r.devDetail : null);

const row = (id: string, savedAt: string, overrides: Record<string, unknown> = {}) => ({
  id,
  saved_at: savedAt,
  source_platform: 'instagram',
  source_url: 'https://www.instagram.com/p/abc/',
  place: {
    id: `place-${id}`,
    name: 'スターバックス コーヒー 札幌グランドホテル店',
    category: 'cafe',
    address: '日本、〒060-0001 北海道札幌市中央区北１条西４丁目',
    latitude: 43.0628,
    longitude: 141.3527,
  },
  ...overrides,
});

type Call = { url: string; init: Parameters<FetchLike>[1] };
function fakeFetch(handler: () => { status: number; body: unknown } | Promise<never>) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = await handler();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { impl, calls };
}

describe('buildSavedPlacesUrl', () => {
  it('saved_places に places を埋め込み、saved_at DESC で取得する', () => {
    const url = new URL(buildSavedPlacesUrl('https://example.supabase.co'));
    assert.equal(url.pathname, '/rest/v1/saved_places');
    assert.equal(url.searchParams.get('select'), SAVED_PLACES_SELECT);
    assert.equal(url.searchParams.get('order'), 'saved_at.desc');
    assert.equal(url.searchParams.get('limit'), '200');
    for (const col of ['saved_at', 'source_platform', 'source_url', 'name', 'category', 'address', 'latitude', 'longitude']) {
      assert.ok(SAVED_PLACES_SELECT.includes(col), col);
    }
  });

  it('9. user_id をクエリに含めない（RLS に任せる）', () => {
    const url = buildSavedPlacesUrl('https://example.supabase.co');
    assert.ok(!url.includes('user_id'));
  });
});

describe('toSavedPlaceItem（places JOIN 結果の変換）', () => {
  it('6. 表示用に変換（カテゴリ名・数値化・source 表示名）', () => {
    const item = toSavedPlaceItem(row('s1', '2026-09-26T00:05:00+00:00', { place: { ...row('s1', '').place, latitude: '43.062800', longitude: '141.352700' } }));
    assert.deepEqual(item, {
      savedPlaceId: 's1',
      placeId: 'place-s1',
      name: 'スターバックス コーヒー 札幌グランドホテル店',
      category: 'cafe',
      categoryLabel: 'カフェ',
      address: '日本、〒060-0001 北海道札幌市中央区北１条西４丁目',
      latitude: 43.0628, // numeric が文字列で返っても数値にする
      longitude: 141.3527,
      savedAt: '2026-09-26T00:05:00+00:00',
      sourcePlatform: 'instagram',
      sourcePlatformLabel: 'Instagram',
      sourceUrl: 'https://www.instagram.com/p/abc/',
      sourceLinkLabel: '元の投稿・リンクを見る',
    });
  });

  it('7. source_url がある場合（Google Maps 代替URLは文言を変える）', () => {
    const maps = toSavedPlaceItem(row('s1', '2026-09-26T00:00:00Z', {
      source_platform: 'other',
      source_url: 'https://www.google.com/maps/search/?api=1&query=%E6%A3%AE%E5%BD%A6&query_place_id=ChIJxxx',
    }));
    assert.equal(maps?.sourceLinkLabel, 'Google マップで見る');
    assert.equal(maps?.sourcePlatformLabel, 'その他');
    const tiktok = toSavedPlaceItem(row('s2', '2026-09-26T00:00:00Z', { source_platform: 'tiktok', source_url: 'https://www.tiktok.com/@a/video/1' }));
    assert.equal(tiktok?.sourceLinkLabel, '元の投稿・リンクを見る');
  });

  it('8. source_url が無い・空・http(s) 以外なら導線を出さない', () => {
    for (const source_url of [null, '', '   ', 'javascript:alert(1)', 'not a url', 'intent://x']) {
      const item = toSavedPlaceItem(row('s1', '2026-09-26T00:00:00Z', { source_url }));
      assert.equal(item?.sourceUrl, null, String(source_url));
      assert.equal(item?.sourceLinkLabel, null);
    }
  });

  it('places 欠損・未知カテゴリ・住所なしでも落ちない', () => {
    const noPlace = toSavedPlaceItem(row('s1', '2026-09-26T00:00:00Z', { place: null, source_platform: null }));
    assert.equal(noPlace?.name, '（名称不明の場所）');
    assert.equal(noPlace?.categoryLabel, 'その他');
    assert.equal(noPlace?.address, null);
    assert.equal(noPlace?.latitude, null);
    assert.equal(noPlace?.sourcePlatformLabel, null);
    const unknown = toSavedPlaceItem(row('s2', '2026-09-26T00:00:00Z', { place: { ...row('x', '').place, category: 'new_category', address: '' } }));
    assert.equal(unknown?.categoryLabel, 'new_category');
    assert.equal(unknown?.address, null);
  });

  it('id / saved_at の無い壊れた行は除外', () => {
    for (const bad of [null, 1, 'x', {}, { id: 's1' }, { saved_at: '2026-09-26T00:00:00Z' }]) {
      assert.equal(toSavedPlaceItem(bad), null);
    }
    const { items, skipped } = toSavedPlaceItems([row('ok', '2026-09-26T00:00:00Z'), null, { id: 1 }]);
    assert.equal(items.length, 1);
    assert.equal(skipped, 2);
    assert.deepEqual(toSavedPlaceItems('not array'), { items: [], skipped: 0 });
  });
});

describe('fetchSavedPlaces', () => {
  it('1・2. ログインユーザーの JWT で取得し、saved_at DESC に並ぶ', async () => {
    // サーバーの順序が崩れていても新しい順に並べ直す
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: [
        row('old', '2026-09-20T10:00:00+00:00'),
        row('newest', '2026-09-26T09:00:00+00:00'),
        row('mid', '2026-09-25T00:00:00+00:00'),
      ],
    }));
    const r = await fetchSavedPlaces({ config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.status === 'ok' && r.items.map((i) => i.savedPlaceId), ['newest', 'mid', 'old']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.method, 'GET');
    assert.equal(calls[0].init?.headers?.Authorization, 'Bearer user-jwt', 'anon key ではなくユーザー JWT');
    assert.equal(calls[0].init?.headers?.apikey, 'anon-public-key');
    assert.equal(calls[0].init?.body, undefined);
  });

  it('3. 0件', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [] }));
    const r = await fetchSavedPlaces({ config: CONFIG, accessToken: 't', fetchImpl: impl });
    assert.deepEqual(r, { status: 'ok', items: [], skipped: 0 });
  });

  it('4. DB エラー（500 / 400 PostgREST エラー / 非JSON / 想定外の形）', async () => {
    const cases: [number, unknown][] = [
      [500, { code: '57014', message: 'canceling statement due to statement timeout' }],
      [400, { code: 'PGRST200', message: 'Could not find a relationship' }],
      [502, '<html>Bad Gateway</html>'],
      [200, { not: 'array' }],
      [200, ''],
    ];
    for (const [status, body] of cases) {
      const { impl } = fakeFetch(() => ({ status, body }));
      const r = await fetchSavedPlaces({ config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.equal(r.status, 'error', String(status));
      assert.equal(messageOf(r), '保存した場所を読み込めませんでした');
    }
  });

  it('ネットワークエラー・タイムアウト', async () => {
    const net = fakeFetch(() => Promise.reject(new TypeError('Network request failed')));
    assert.equal((await fetchSavedPlaces({ config: CONFIG, accessToken: 't', fetchImpl: net.impl })).status, 'error');
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const r = await fetchSavedPlaces({ config: CONFIG, accessToken: 't', fetchImpl: hanging, timeoutMs: 20 });
    assert.equal(r.status, 'error');
    assert.equal(detailOf(r), 'timeout');
  });

  it('5. 未ログインは通信せず unauthorized、期限切れ JWT も unauthorized', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const r = await fetchSavedPlaces({ config: CONFIG, accessToken: null, fetchImpl: impl });
    assert.equal(r.status, 'unauthorized');
    assert.equal(messageOf(r), 'ログインが必要です');
    assert.equal(calls.length, 0);
    for (const [status, body] of [
      [401, { code: 'PGRST301', message: 'JWT expired' }],
      [401, { code: 'PGRST303', message: 'JWT expired' }],
      [403, { code: '42501', message: 'permission denied' }],
    ] as [number, unknown][]) {
      const f = fakeFetch(() => ({ status, body }));
      assert.equal((await fetchSavedPlaces({ config: CONFIG, accessToken: 'expired', fetchImpl: f.impl })).status, 'unauthorized');
    }
  });

  it('9. 他人の user_id をどこにも指定しない（URL・ヘッダー）', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    await fetchSavedPlaces({ config: CONFIG, accessToken: 't', fetchImpl: impl });
    const sent = JSON.stringify(calls[0]);
    assert.ok(!sent.includes('user_id'));
    assert.ok(!sent.includes(OTHER_USER));
  });

  it('設定不足は error（通信しない）', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const r = await fetchSavedPlaces({ config: { supabaseUrl: null, anonKey: null }, accessToken: 't', fetchImpl: impl });
    assert.equal(r.status, 'error');
    assert.equal(calls.length, 0);
  });
});

describe('formatSavedAt', () => {
  it('タイムゾーンを反映して表示（JST = +540分）', () => {
    assert.equal(formatSavedAt('2026-09-26T00:05:00+00:00', 540), '2026/09/26 09:05');
    assert.equal(formatSavedAt('2026-12-31T15:30:00Z', 540), '2027/01/01 00:30');
    assert.equal(formatSavedAt('invalid'), '');
  });
});

describe('一覧の再取得タイミング', () => {
  const base = { fetchedVersion: 0, currentVersion: 0, now: 100_000 };

  it('未取得なら取得する', () => {
    assert.equal(shouldRefetchSavedPlaces({ ...base, lastFetchedAt: null }), true);
  });

  it('直前に取得済みで変更が無ければ取得しない（フォーカスのたびに通信しない）', () => {
    assert.equal(shouldRefetchSavedPlaces({ ...base, lastFetchedAt: 90_000 }), false);
  });

  it('Place を保存した後は必ず取得する', () => {
    const before = getSavedPlacesChangeVersion();
    markSavedPlacesChanged();
    const after = getSavedPlacesChangeVersion();
    assert.equal(after, before + 1);
    assert.equal(shouldRefetchSavedPlaces({ ...base, lastFetchedAt: 99_999, fetchedVersion: before, currentVersion: after }), true);
  });

  it('60秒以上経っていれば取得する', () => {
    assert.equal(shouldRefetchSavedPlaces({ ...base, lastFetchedAt: 40_000 }), true);
    assert.equal(shouldRefetchSavedPlaces({ ...base, lastFetchedAt: 40_001 }), false);
  });
});
