/// <reference types="node" />
// v3.0 みんなのルート・行った記録・投稿・反応・写真の API クライアントと、画面をまたぐ同期の単体テスト
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jwtSubject } from '../src/auth/jwt';
import {
  activeFilterCount,
  createRouteSync,
  optimisticToggle,
  withOverride,
} from '../src/routes/route-sync';
import { budgetText, dateText, durationText, feedEmptyText, filterOptions } from '../src/routes/route-format';
import {
  addRouteComment,
  createVisitRecord,
  DEFAULT_FEED_QUERY,
  draftToPayload,
  durationFromTimes,
  feedRpcArgs,
  getRoutePost,
  listPublicRoutes,
  normalizeTime,
  routePhotoPath,
  saveRoutePlaces,
  signRoutePhotoUrls,
  startRouteFromPost,
  toggleRouteReaction,
  toRouteCard,
  toRouteDetail,
  updateRoutePost,
  validateDraft,
  type RoutePostDraft,
} from '../src/routes/route-posts-client';
import { classifyHttpError } from '../src/services/rest';
import type { FetchLike } from '../src/services/backend';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** payload {"sub": UID} の JWT（署名は検証しない） */
const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: UID })).toString('base64url')}.y`;

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}

const CARD = {
  id: 'p1',
  title: '秋の円山さんぽ',
  lead: '公園からカフェへ',
  area: '円山',
  genre: 'カフェ',
  theme: 'ひとり',
  budget_yen: 2000,
  duration_minutes: 90,
  visibility: 'public',
  published_at: '2026-09-28T01:00:00Z',
  created_at: '2026-09-27T10:00:00Z',
  visited_on: '2026-09-27',
  memory: null,
  cover_photo_path: `${UID}/p1/a.jpg`,
  stop_names: ['円山公園', '円山のカフェ'],
  author_name: 'さっぽろ散歩',
  like_count: 3,
  wish_count: 1,
  comment_count: 0,
  liked: true,
  wished: false,
  is_mine: false,
};

describe('応答の読み取り', () => {
  it('カードを表示用に変換し、壊れた行は落とす', () => {
    const c = toRouteCard(CARD)!;
    assert.equal(c.title, '秋の円山さんぽ');
    assert.deepEqual(c.stopNames, ['円山公園', '円山のカフェ']);
    assert.equal(c.likeCount, 3);
    assert.equal(c.liked, true);
    assert.equal(toRouteCard({ id: 'x' }), null);
    assert.equal(toRouteCard(null), null);
    // 数値が無ければ 0 / null（作らない）
    const bare = toRouteCard({ id: 'b', title: 't' })!;
    assert.equal(bare.budgetYen, null);
    assert.equal(bare.durationMinutes, null);
    assert.equal(bare.visibility, 'private');
    assert.equal(bare.authorName, 'Mikke ユーザー');
  });

  it('詳細は立ち寄りを順番に並べ、不正な時刻は捨てる', () => {
    const d = toRouteDetail({
      ...CARD,
      plan_id: null,
      stops: [
        { sequence: 2, name: 'カフェ', visited_time: '12:00', action: 'コーヒー', note: null, photo_path: null, place_id: 'x', category: 'cafe' },
        { sequence: 1, name: '公園', visited_time: 'noon', action: null, note: '紅葉', photo_path: `${UID}/p1/a.jpg`, place_id: 'y', category: null },
        { name: '壊れた行' },
      ],
      comments: [{ id: 'c1', body: 'いいね', created_at: '2026-09-28T02:00:00Z', author_name: 'B', is_mine: true }, { id: 'c2' }],
    })!;
    assert.deepEqual(d.stops.map((s) => s.name), ['公園', 'カフェ']);
    assert.equal(d.stops[0].visitedTime, null);
    assert.equal(d.stops[1].visitedTime, '12:00');
    assert.equal(d.comments.length, 1);
    assert.equal(d.comments[0].isMine, true);
  });
});

describe('一覧・詳細の呼び出し', () => {
  it('list_public_routes: ユーザー JWT で RPC を呼び、user_id は送らない', async () => {
    const f = fakeFetch([{ status: 200, body: [CARD, { broken: true }] }]);
    const q = { ...DEFAULT_FEED_QUERY, query: '  公園 ', genre: 'カフェ', maxBudget: 3000, sort: 'likes' as const };
    const r = await listPublicRoutes(q, 40, { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(r.ok);
    assert.equal(r.data.length, 1);
    assert.equal(f.calls[0].url, 'https://example.supabase.co/rest/v1/rpc/list_public_routes');
    assert.equal(f.calls[0].headers?.Authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(f.calls[0].body!);
    assert.deepEqual(body, { p_query: '公園', p_area: null, p_max_budget: 3000, p_genre: 'カフェ', p_theme: null, p_sort: 'likes', p_limit: 40, p_offset: 40 });
    assert.ok(!f.calls[0].body!.includes(UID));
  });

  it('空のキーワードは null で送る', () => {
    assert.equal(feedRpcArgs({ ...DEFAULT_FEED_QUERY, query: '   ' }).p_query, null);
  });

  it('未ログイン・設定なしは送らない', async () => {
    const f = fakeFetch([{ status: 200, body: [] }]);
    const r = await listPublicRoutes(DEFAULT_FEED_QUERY, 0, { config: CONFIG, accessToken: null, fetchImpl: f.impl });
    assert.equal(r.ok ? 'ok' : r.kind, 'unauthorized');
    const c = await listPublicRoutes(DEFAULT_FEED_QUERY, 0, { config: { supabaseUrl: null, anonKey: null }, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(c.ok ? 'ok' : c.kind, 'config');
    assert.equal(f.calls.length, 0);
  });

  it('get_route_post が null（非公開・削除・非表示）なら not_found', async () => {
    const f = fakeFetch([{ status: 200, body: null }]);
    const r = await getRoutePost('p1', { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(r.ok ? 'ok' : r.kind, 'not_found');
  });

  it('業務エラーは認証エラーと取り違えない（42501 → HTTP 403 でもログアウトさせない）', () => {
    assert.equal(classifyHttpError(403, { code: '42501', message: 'invalid_photo_path' }, '').kind, 'invalid');
    assert.equal(classifyHttpError(404, { code: 'P0002', message: 'route_post_not_found' }, '').kind, 'not_found');
    assert.equal(classifyHttpError(401, { code: 'PGRST301', message: 'JWT expired' }, '').kind, 'unauthorized');
    assert.equal(classifyHttpError(500, {}, 'boom').kind, 'server');
  });
});

describe('反応・コメント', () => {
  it('toggle_route_reaction の結果（サーバーの件数）を返す', async () => {
    const f = fakeFetch([{ status: 200, body: { kind: 'like', active: false, like_count: 2, wish_count: 5 } }]);
    const r = await toggleRouteReaction('p1', 'like', { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(r.ok);
    assert.deepEqual(r.data, { kind: 'like', active: false, likeCount: 2, wishCount: 5 });
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_post_id: 'p1', p_kind: 'like' });
  });

  it('コメントは1〜100文字だけ送る', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'c1', body: 'よかった', created_at: 'x', author_name: 'A', is_mine: true } }]);
    const empty = await addRouteComment('p1', '   ', { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(empty.ok ? 'ok' : empty.kind, 'invalid');
    const long = await addRouteComment('p1', 'あ'.repeat(101), { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(long.ok ? 'ok' : long.kind, 'invalid');
    assert.equal(f.calls.length, 0);
    const ok = await addRouteComment('p1', ' よかった ', { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(ok.ok);
    assert.equal(JSON.parse(f.calls[0].body!).p_body, 'よかった');
  });
});

describe('行った記録・投稿', () => {
  it('記録: 行った場所が無ければ送らない / 公開済みは分かる文言にする', async () => {
    const f = fakeFetch([{ status: 400, body: { code: '22023', message: 'record_already_published' } }]);
    const none = await createVisitRecord('plan', [], '', { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(none.ok ? 'ok' : none.kind, 'invalid');
    assert.equal(f.calls.length, 0);
    const pub = await createVisitRecord('plan', ['a'], ' メモ ', { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(!pub.ok && pub.message.includes('すでに公開'));
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_plan_id: 'plan', p_place_ids: ['a'], p_memory: 'メモ' });
  });

  it('時刻の正規化（全角コロン・4桁も受け付け、不正は undefined）', () => {
    assert.equal(normalizeTime(''), null);
    assert.equal(normalizeTime('9:05'), '09:05');
    assert.equal(normalizeTime('1030'), '10:30');
    assert.equal(normalizeTime('10：30'), '10:30');
    assert.equal(normalizeTime('24:00'), undefined);
    assert.equal(normalizeTime('朝'), undefined);
  });

  it('所要時間は入力された時刻が2つ以上あるときだけ計算する（推測しない）', () => {
    assert.equal(durationFromTimes(['10:30', null, '13:00']), 150);
    assert.equal(durationFromTimes(['10:30']), null);
    assert.equal(durationFromTimes(['13:00', '10:00']), null);
  });

  const draft: RoutePostDraft = {
    title: ' 秋の円山 ',
    lead: '',
    area: '円山',
    genre: 'カフェ',
    theme: null,
    budgetYen: 3000,
    stops: [
      { sequence: 2, visitedTime: '12:00', action: 'コーヒー', note: '', photoPath: `${UID}/p1/b.jpg` },
      { sequence: 1, visitedTime: '10:30', action: '', note: '紅葉', photoPath: null },
    ],
  };

  it('入力の検証', () => {
    assert.equal(validateDraft(draft), null);
    assert.ok(validateDraft({ ...draft, title: '  ' }));
    assert.ok(validateDraft({ ...draft, title: 'あ'.repeat(41) }));
    assert.ok(validateDraft({ ...draft, stops: [{ ...draft.stops[0], note: 'あ'.repeat(301) }] }));
  });

  it('送る内容: 時刻から所要時間、写真のある最初の立ち寄りを表紙に', async () => {
    const payload = draftToPayload(draft, `${UID}/p1/b.jpg`);
    assert.equal(payload.title, '秋の円山');
    assert.equal(payload.duration_minutes, 90);
    const f = fakeFetch([{ status: 200, body: { id: 'p1', visibility: 'private' } }]);
    const r = await updateRoutePost('p1', draft, false, { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(r.ok);
    const body = JSON.parse(f.calls[0].body!);
    assert.equal(body.p_publish, false, '下書きの保存では公開しない');
    assert.equal(body.p_post.cover_photo_path, `${UID}/p1/b.jpg`);
    const bad = await updateRoutePost('p1', { ...draft, title: '' }, true, { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(bad.ok ? 'ok' : bad.kind, 'invalid');
    assert.equal(f.calls.length, 1);
  });

  it('同じ順番で行く / 今日向けに調整', async () => {
    const s = fakeFetch([{ status: 200, body: { id: 'plan-1', status: 'accepted' } }]);
    const r = await startRouteFromPost('p1', { config: CONFIG, accessToken: TOKEN, fetchImpl: s.impl });
    assert.ok(r.ok && r.data.planId === 'plan-1');
    const a = fakeFetch([{ status: 200, body: ['x', 'y'] }]);
    const ids = await saveRoutePlaces('p1', { config: CONFIG, accessToken: TOKEN, fetchImpl: a.impl });
    assert.deepEqual(ids.ok ? ids.data : null, ['x', 'y']);
    assert.ok(a.calls[0].url.endsWith('/rpc/save_route_places'));
  });
});

describe('写真', () => {
  it('パスは <user_id>/<post_id>/<file>.jpg', () => {
    assert.equal(routePhotoPath(UID, 'p1', 'abc'), `${UID}/p1/abc.jpg`);
  });

  it('署名付きURL: 見られない写真（error）は含めず、相対URLを完全なURLにする', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: [
          { path: `${UID}/p1/a.jpg`, signedURL: `/object/sign/route-photos/${UID}/p1/a.jpg?token=t`, error: null },
          { path: 'other/p/x.jpg', signedURL: null, error: 'Either the object does not exist or you do not have access to it' },
        ],
      },
    ]);
    const r = await signRoutePhotoUrls([`${UID}/p1/a.jpg`, 'other/p/x.jpg'], { config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(r.ok);
    assert.deepEqual(r.data, [{ path: `${UID}/p1/a.jpg`, url: `https://example.supabase.co/storage/v1/object/sign/route-photos/${UID}/p1/a.jpg?token=t` }]);
    assert.equal(f.calls[0].url, 'https://example.supabase.co/storage/v1/object/sign/route-photos');
  });
});

describe('画面をまたぐ同期', () => {
  it('いいね・行きたいの楽観的な切り替え（一押しで登録・もう一度で解除）', () => {
    const base = { liked: false, likeCount: 0, wished: true, wishCount: 1 };
    const liked = optimisticToggle(base, 'like');
    assert.deepEqual(liked, { liked: true, likeCount: 1, wished: true, wishCount: 1 });
    assert.deepEqual(optimisticToggle(liked, 'like'), base);
    assert.deepEqual(optimisticToggle(base, 'wish'), { liked: false, likeCount: 0, wished: false, wishCount: 0 });
  });

  it('他の画面で押した反応を一覧のカードに重ねる・ログアウトで消す', () => {
    const sync = createRouteSync();
    const card = toRouteCard(CARD)!;
    sync.setReaction('p1', { liked: false, likeCount: 2, wished: true, wishCount: 2 });
    assert.equal(withOverride(card, sync.getState().overrides).wished, true);
    sync.bump('wishes', 'feed');
    assert.equal(sync.getState().versions.wishes, 1);
    sync.setFeedQuery({ genre: '自然' });
    assert.equal(activeFilterCount(sync.getState().feedQuery), 1);
    sync.reset();
    assert.deepEqual(sync.getState().overrides, {});
    assert.equal(sync.getState().feedQuery.genre, null);
  });
});

describe('表示文言（値が無いものは作らない）', () => {
  it('時間・費用・日付', () => {
    assert.equal(durationText(null), '時間未設定');
    assert.equal(durationText(150), '約2時間半');
    assert.equal(durationText(45), '約45分');
    assert.equal(budgetText(null), '費用未設定');
    assert.equal(budgetText(3000), '〜3,000円');
    assert.equal(dateText('2026-09-28'), '2026年9月28日');
    assert.ok(feedEmptyText(true).includes('条件に合う'));
    assert.ok(feedEmptyText(false).includes('まだ公開'));
  });

  it('地域の選択肢は実際に公開されている地域だけ', () => {
    const o = filterOptions(['円山', '大通']);
    assert.deepEqual(o.area.map((a) => a.value), [null, '円山', '大通']);
    assert.equal(o.budget[1].label, '〜1,000円');
  });

  it('JWT から user id を読む（壊れたトークンは null）', () => {
    assert.equal(jwtSubject(TOKEN), UID);
    assert.equal(jwtSubject('broken'), null);
    assert.equal(jwtSubject(null), null);
  });
});
