/// <reference types="node" />
// v3 デザイン反映: お店・スポットの API クライアント、いいね / 行きたい の画面間の状態、立ち寄り写真の縦横の単体テスト
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toRouteDetail, POST_LIMITS } from '../src/routes/route-posts-client';
import { createRouteSync, DEFAULT_SPOT_QUERY } from '../src/routes/route-sync';
import { createSpotSync, toggleSpotReaction, withSpotOverride } from '../src/spots/spot-sync';
import { getSpot, listPublicSpots, setPlaceReaction, SPOT_CATEGORIES, toSpotCard } from '../src/spots/spots-client';
import type { FetchLike } from '../src/services/backend';

// route-views は React Native を読み込むため、写真の縦横の判定だけを同じ式で確認する
function photoAspect(width: number | undefined, height: number | undefined): number {
  if (!width || !height) return 16 / 10;
  return height > width ? 4 / 5 : 16 / 10;
}

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url')}.y`;

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body?: string }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { impl, calls };
}
const opts = (f: ReturnType<typeof fakeFetch>) => ({ config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });

const SPOT = {
  id: 'p1',
  name: 'テスト喫茶',
  category: 'cafe',
  address: 'テスト市 1-1',
  maps_url: null,
  area: 'テスト地区',
  photo_path: 'u/post/a.jpg',
  like_count: 3,
  route_count: 2,
  liked: false,
  wished: true,
};

describe('お店・スポットの応答', () => {
  it('カードを表示用に変換し、壊れた行は落とす。写真・地域が無ければ null（作らない）', () => {
    const c = toSpotCard(SPOT);
    assert.equal(c?.categoryLabel, 'カフェ');
    assert.deepEqual([c?.likeCount, c?.routeCount, c?.liked, c?.wished], [3, 2, false, true]);
    assert.equal(toSpotCard({ id: 'x' }), null);
    const bare = toSpotCard({ id: 'p2', name: '名前だけ' });
    assert.deepEqual([bare?.photoPath, bare?.area, bare?.address, bare?.categoryLabel], [null, null, null, 'その他']);
  });

  it('一覧は検索語・カテゴリ・ページを送る', async () => {
    const f = fakeFetch([{ status: 200, body: [SPOT, { bad: true }] }]);
    const r = await listPublicSpots({ query: '  喫茶 ', category: 'cafe' }, 40, opts(f));
    assert.ok(r.ok && r.data.length === 1);
    assert.ok(f.calls[0].url.endsWith('/rest/v1/rpc/list_public_spots'));
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_query: '喫茶', p_category: 'cafe', p_limit: 40, p_offset: 40 });
    assert.equal(SPOT_CATEGORIES[0].value, null);
  });

  it('詳細は写真と、その場所を含むルートを返す。見られない場所は not_found', async () => {
    const f = fakeFetch([{ status: 200, body: { ...SPOT, photos: ['u/post/a.jpg', 3], routes: [{ id: 'r1', title: 'ルート' }] } }]);
    const r = await getSpot('p1', opts(f));
    assert.ok(r.ok);
    assert.deepEqual(r.data.photos, ['u/post/a.jpg']);
    assert.equal(r.data.routes[0].id, 'r1');
    const none = await getSpot('p9', opts(fakeFetch([{ status: 200, body: null }])));
    assert.equal(none.ok ? 'ok' : none.kind, 'not_found');
  });

  it('いいね / 行きたい は状態を指定して送る', async () => {
    const f = fakeFetch([{ status: 200, body: { kind: 'wish', active: true, liked: false, wished: true, like_count: 3 } }]);
    const r = await setPlaceReaction('p1', 'wish', true, opts(f));
    assert.deepEqual(r.ok ? r.data : null, { liked: false, wished: true, likeCount: 3 });
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_place_id: 'p1', p_kind: 'wish', p_active: true });
  });
});

describe('いいね / 行きたい の画面間の状態', () => {
  const base = { liked: false, wished: false, likeCount: 3 };

  it('押すとすぐ表示が変わり、サーバーの実数で確定する。いいね と 行きたい は別', async () => {
    const store = createSpotSync();
    const sent: boolean[] = [];
    const err = await toggleSpotReaction(store, 'p1', 'like', base, async (active) => {
      sent.push(active);
      assert.deepEqual(store.getState().overrides.p1, { liked: true, likeCount: 4 }, '通信中は楽観的に表示');
      return { ok: true, data: { liked: true, wished: false, likeCount: 10 } };
    });
    assert.equal(err, null);
    assert.deepEqual(sent, [true]);
    assert.deepEqual(withSpotOverride(base, 'p1', store.getState().overrides), { liked: true, wished: false, likeCount: 10 });
    assert.equal(store.getState().versions.likes, 1);
    assert.equal(store.getState().versions.spots, 0);
  });

  it('失敗したら元に戻し、文言を返す', async () => {
    const store = createSpotSync();
    const err = await toggleSpotReaction(store, 'p1', 'wish', base, async () => ({ ok: false, message: '通信できません' }));
    assert.equal(err, '通信できません');
    assert.deepEqual(store.getState().overrides.p1, { wished: false });
    assert.deepEqual(store.getState().pending, {});
  });

  it('通信中に同じ場所・同じ種類を押しても二重に送らない（別の種類は送れる）', async () => {
    const store = createSpotSync();
    let release: () => void = () => {};
    const calls: string[] = [];
    const first = toggleSpotReaction(store, 'p1', 'wish', base, (a) => {
      calls.push(`wish:${a}`);
      return new Promise((resolve) => (release = () => resolve({ ok: true, data: { ...base, wished: true } })));
    });
    assert.equal(await toggleSpotReaction(store, 'p1', 'wish', base, async () => ({ ok: true, data: base })), null);
    await toggleSpotReaction(store, 'p1', 'like', base, async (a) => {
      calls.push(`like:${a}`);
      return { ok: true, data: { ...base, liked: true, likeCount: 4 } };
    });
    release();
    await first;
    assert.deepEqual(calls, ['wish:true', 'like:true']);
    assert.deepEqual(store.getState().overrides.p1, { liked: true, wished: true, likeCount: 4 });
  });
});

describe('みつける・ルート詳細', () => {
  it('対象の切り替えとスポットの検索条件を保つ', () => {
    const s = createRouteSync();
    assert.equal(s.getState().discoverType, 'routes');
    s.setDiscoverType('spots');
    s.setSpotQuery({ category: 'cafe' });
    assert.deepEqual([s.getState().discoverType, s.getState().spotQuery], ['spots', { ...DEFAULT_SPOT_QUERY, category: 'cafe' }]);
    s.reset();
    assert.equal(s.getState().discoverType, 'routes');
  });

  it('立ち寄りの 行きたい を読む・コメントは300文字まで', () => {
    const d = toRouteDetail({ id: 'r1', title: 't', stops: [{ sequence: 1, name: 'A', place_id: 'p1', wished: true }, { sequence: 2, name: 'B' }] });
    assert.deepEqual(d?.stops.map((s) => s.wished), [true, false]);
    assert.equal(POST_LIMITS.note, 300);
  });

  it('立ち寄り写真は縦長なら 4:5、横長・不明なら 16:10', () => {
    assert.equal(photoAspect(800, 1000), 4 / 5);
    assert.equal(photoAspect(1600, 1000), 16 / 10);
    assert.equal(photoAspect(undefined, undefined), 16 / 10);
  });
});
