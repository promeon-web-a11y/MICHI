/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike } from '../src/place/identify-place-client';
import {
  fetchTodayPlan,
  nextVisitedIds,
  recordVisit,
  TODAY_MESSAGES,
  todayPlanQueries,
  todayWindowStart,
  toTodayPlan,
  type FetchTodayResult,
  type TodayPlan,
  type VisitResult,
} from '../src/today/today-plan-client';
import { applyVisitedIds, createTodayPlanStore, TODAY_STALE_MS } from '../src/today/today-plan-store';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const PLAN_ID = '2687aac6-0000-4000-8000-000000000001';
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-09-26T07:00:00.000Z');

const planRow = (overrides: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  status: 'accepted',
  accepted_at: '2026-09-26T06:02:21.611759+00:00',
  estimated_budget: 3000,
  variant: 'A',
  title: 'THE BUTTERでゆったり',
  concept: 'コスパ良いカフェでゆっくり過ごす',
  budget_status: 'estimated',
  duration_minutes: 180,
  budget_yen: 3000,
  transport_modes: ['walking', 'train', 'bus'],
  ...overrides,
});
const item = (seq: number, id: string, name: string) => ({
  sequence: seq,
  stay_minutes: 60,
  start_at: `2026-09-26T0${seq}:10:00.000Z`,
  selection_reason: `${name}の理由`,
  places: { id, name, category: 'cafe', address: '札幌市中央区', latitude: '43.06', longitude: '141.35', provider: 'google', provider_place_id: `ChIJ-${id}` },
});
const ITEMS = [item(2, 'p2', 'パフェ佐藤'), item(1, 'p1', 'THE BUTTER')];

// ---------------------------------------------------------------------------------------------
describe('今日のプランの取得（Supabase から復元）', () => {
  it('DB の行 → 表示用（訪問順・訪問状態・完了）', () => {
    const p = toTodayPlan(planRow(), ITEMS, { went: true, visited_place_ids: ['p1'] })!;
    assert.equal(p.plan_id, PLAN_ID);
    assert.equal(p.title, 'THE BUTTERでゆったり');
    assert.deepEqual(p.stops.map((s) => [s.order, s.name, s.visited]), [[1, 'THE BUTTER', true], [2, 'パフェ佐藤', false]]);
    assert.equal(p.stops[0].latitude, 43.06);
    assert.equal(p.stops[0].google_place_id, 'ChIJ-p1');
    assert.equal(p.stops[0].planned_arrival_at, '2026-09-26T01:10:00.000Z');
    assert.deepEqual([p.visited_count, p.completed], [1, false]);
    assert.deepEqual([p.duration_minutes, p.budget_yen, p.places_budget_yen, p.budget_status], [180, 3000, 3000, 'estimated']);
    assert.equal(toTodayPlan(planRow(), ITEMS, { visited_place_ids: ['p1', 'p2'] })!.completed, true, '全スポット訪問で完了');
  });

  it('訪問記録なし・壊れた行・accepted 以外・場所なし', () => {
    assert.equal(toTodayPlan(planRow(), ITEMS, null)!.visited_count, 0);
    assert.equal(toTodayPlan(planRow({ status: 'generated' }), ITEMS, null), null);
    assert.equal(toTodayPlan(null, ITEMS, null), null);
    assert.equal(toTodayPlan(planRow(), [], null), null);
    assert.equal(toTodayPlan(planRow({ title: null }), ITEMS, null)!.title, '今日のプラン');
    const broken = [{ sequence: 1, places: null }, item(2, 'p2', 'パフェ佐藤')];
    assert.deepEqual(toTodayPlan(planRow(), broken, null)!.stops.map((s) => s.order), [1]);
  });

  it('クエリ: 本人の accepted（mobile で作ったもの・直近24時間）だけ。user_id は送らない', () => {
    const since = todayWindowStart(NOW);
    assert.equal(since, '2026-09-25T07:00:00.000Z');
    const q = todayPlanQueries(since);
    assert.ok(q.plan.includes('status=eq.accepted'));
    // v3: みんなのルートの「同じ順番で行く」（mobile_route_copy）も今日のプランになる
    assert.ok(q.plan.includes('condition_json->>source=in.(mobile_plan_options,mobile_route_copy)'));
    assert.ok(q.plan.includes(`accepted_at=gte.${encodeURIComponent(since)}`));
    assert.ok(q.plan.includes('order=accepted_at.desc') && q.plan.includes('limit=1'));
    for (const path of [q.plan, q.items(PLAN_ID), q.visits(PLAN_ID)]) assert.ok(!path.includes('user_id'));
    assert.ok(!q.plan.includes('origin'), '出発地点（condition_json.origin_coarse）は読まない');
  });
});

type Call = { url: string; method: string; body: unknown; auth: string | undefined };
function fakeRest(routes: (url: string, method: string, body: unknown) => { status: number; body: unknown } | Promise<never>) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body, auth: init?.headers?.Authorization });
    const r = await routes(url, init?.method ?? 'GET', body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}

describe('fetchTodayPlan', () => {
  it('plans → plan_items と visits をユーザー JWT で取得', async () => {
    const { impl, calls } = fakeRest((url) => {
      if (url.includes('/plans?')) return { status: 200, body: [planRow()] };
      if (url.includes('/plan_items?')) return { status: 200, body: ITEMS };
      if (url.includes('/visits?')) return { status: 200, body: [{ went: true, visited_place_ids: ['p2'] }] };
      return { status: 404, body: {} };
    });
    const r = await fetchTodayPlan({ config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl, now: NOW });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.status === 'ok' && r.plan.stops.map((s) => s.visited), [false, true]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.auth === 'Bearer user-jwt'));
  });

  it('accepted プランなし → none（今日のプランカードを出さない）', async () => {
    const { impl, calls } = fakeRest(() => ({ status: 200, body: [] }));
    assert.deepEqual(await fetchTodayPlan({ config: CONFIG, accessToken: 't', fetchImpl: impl, now: NOW }), { status: 'none' });
    assert.equal(calls.length, 1);
  });

  it('未ログイン / 期限切れ JWT / DB エラー / 通信エラー', async () => {
    assert.equal((await fetchTodayPlan({ config: CONFIG, accessToken: null })).status, 'unauthorized');
    const expired = fakeRest(() => ({ status: 401, body: { code: 'PGRST301', message: 'JWT expired' } }));
    assert.equal((await fetchTodayPlan({ config: CONFIG, accessToken: 't', fetchImpl: expired.impl })).status, 'unauthorized');
    const dbErr = fakeRest(() => ({ status: 500, body: { code: '57014' } }));
    const e = await fetchTodayPlan({ config: CONFIG, accessToken: 't', fetchImpl: dbErr.impl });
    assert.equal(e.status, 'error');
    assert.equal(e.status === 'error' && e.message, TODAY_MESSAGES.load_error);
    const net = fakeRest(() => Promise.reject(new TypeError('offline')));
    assert.equal((await fetchTodayPlan({ config: CONFIG, accessToken: 't', fetchImpl: net.impl })).status, 'error');
  });
});

describe('訪問記録（既存 answer_visit RPC）', () => {
  it('nextVisitedIds: 追加・二重記録しない・プラン外は送らない', () => {
    assert.deepEqual(nextVisitedIds([], 'p1', ['p1', 'p2']), { ok: true, ids: ['p1'] });
    assert.deepEqual(nextVisitedIds(['p1'], 'p2', ['p1', 'p2']), { ok: true, ids: ['p1', 'p2'] });
    assert.deepEqual(nextVisitedIds(['p1'], 'p1', ['p1', 'p2']), { ok: false, reason: 'already_visited' });
    assert.deepEqual(nextVisitedIds([], 'px', ['p1']), { ok: false, reason: 'not_in_plan' });
    assert.deepEqual(nextVisitedIds(['old', 'p1', 'p1'], 'p2', ['p1', 'p2']), { ok: true, ids: ['p1', 'p2'] });
  });

  it('サーバーの最新の記録を読み直してから、足した集合で answer_visit を呼ぶ（user_id は送らない）', async () => {
    const { impl, calls } = fakeRest((url, method, body) => {
      if (url.includes('/visits?')) return { status: 200, body: [{ went: true, visited_place_ids: ['p2'] }] }; // 別の端末で p2 を記録済み
      if (url.endsWith('/rpc/answer_visit') && method === 'POST') {
        return { status: 200, body: { id: 'v1', plan_id: PLAN_ID, went: true, visited_place_ids: (body as any).p_visited_place_ids } };
      }
      return { status: 404, body: {} };
    });
    const r = await recordVisit(PLAN_ID, 'p1', ['p1', 'p2'], { config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl });
    assert.deepEqual(r, { status: 'visited', visited_place_ids: ['p2', 'p1'] });
    const rpc = calls.find((c) => c.url.endsWith('/rpc/answer_visit'))!;
    assert.deepEqual(rpc.body, { p_plan_id: PLAN_ID, p_went: true, p_visited_place_ids: ['p2', 'p1'] });
    assert.ok(!JSON.stringify(rpc.body).includes('user_id'));
    assert.ok(!JSON.stringify(calls).includes(OTHER_USER));
  });

  it('既に訪問済みなら RPC を呼ばない（二重記録しない）', async () => {
    const { impl, calls } = fakeRest(() => ({ status: 200, body: [{ went: true, visited_place_ids: ['p1'] }] }));
    const r = await recordVisit(PLAN_ID, 'p1', ['p1', 'p2'], { config: CONFIG, accessToken: 't', fetchImpl: impl });
    assert.deepEqual(r, { status: 'already_visited', visited_place_ids: ['p1'] });
    assert.ok(!calls.some((c) => c.url.includes('/rpc/')));
  });

  it('本人の accepted プランでない（他人のプラン含む）→ plan_not_accepted、プラン外 → not_in_plan', async () => {
    const other = fakeRest((url) =>
      url.includes('/visits?') ? { status: 200, body: [] } : { status: 400, body: { code: 'P0002', message: 'accepted_plan_not_found' } }
    );
    assert.equal((await recordVisit(PLAN_ID, 'p1', ['p1'], { config: CONFIG, accessToken: 't', fetchImpl: other.impl })).status, 'plan_not_accepted');
    const outside = fakeRest((url) =>
      url.includes('/visits?') ? { status: 200, body: [] } : { status: 403, body: { code: '42501', message: 'visited_place_not_in_plan' } }
    );
    // 42501 は PostgREST では HTTP 403 だが、認証エラー（ログアウト）と取り違えない
    const r = await recordVisit(PLAN_ID, 'p1', ['p1'], { config: CONFIG, accessToken: 't', fetchImpl: outside.impl });
    assert.equal(r.status, 'not_in_plan');
    const realAuth = fakeRest((url) => (url.includes('/visits?') ? { status: 200, body: [] } : { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } }));
    assert.equal((await recordVisit(PLAN_ID, 'p1', ['p1'], { config: CONFIG, accessToken: 't', fetchImpl: realAuth.impl })).status, 'unauthorized');
    assert.equal((await recordVisit(PLAN_ID, 'px', ['p1'], { config: CONFIG, accessToken: 't', fetchImpl: other.impl })).status, 'not_in_plan');
  });

  it('記録失敗（500・通信エラー）・未ログイン', async () => {
    const err = fakeRest((url) => (url.includes('/visits?') ? { status: 200, body: [] } : { status: 500, body: { code: 'XX000' } }));
    const r = await recordVisit(PLAN_ID, 'p1', ['p1'], { config: CONFIG, accessToken: 't', fetchImpl: err.impl });
    assert.equal(r.status, 'error');
    assert.equal(r.status === 'error' && r.message, TODAY_MESSAGES.visit_error);
    const net = fakeRest(() => Promise.reject(new TypeError('offline')));
    assert.equal((await recordVisit(PLAN_ID, 'p1', ['p1'], { config: CONFIG, accessToken: 't', fetchImpl: net.impl })).status, 'error');
    assert.equal((await recordVisit(PLAN_ID, 'p1', ['p1'], { config: CONFIG, accessToken: null })).status, 'unauthorized');
  });
});

// ---------------------------------------------------------------------------------------------
describe('今日のプランのストア', () => {
  const PLAN = toTodayPlan(planRow(), ITEMS, null)!;

  function setup(opts: { fetch?: () => Promise<FetchTodayResult>; visit?: (placeId: string) => Promise<VisitResult> } = {}) {
    let clock = 1_000_000;
    const fetchCalls: string[] = [];
    const visitCalls: string[] = [];
    let unauthorized = 0;
    const store = createTodayPlanStore({
      fetch: async (token) => {
        fetchCalls.push(token);
        return opts.fetch ? opts.fetch() : { status: 'ok', plan: PLAN };
      },
      visit: async (_t, _plan, placeId) => {
        visitCalls.push(placeId);
        return opts.visit ? opts.visit(placeId) : { status: 'visited', visited_place_ids: [placeId] };
      },
      now: () => clock,
      onUnauthorized: () => unauthorized++,
    });
    return { store, fetchCalls, visitCalls, advance: (ms: number) => (clock += ms), unauthorized: () => unauthorized };
  }

  it('再起動後の復元: 新しいストアでも Supabase から訪問状態ごと復元される', async () => {
    const restored = toTodayPlan(planRow(), ITEMS, { visited_place_ids: ['p1'] })!;
    const { store } = setup({ fetch: async () => ({ status: 'ok', plan: restored }) });
    await store.load('t');
    assert.equal(store.getState().phase, 'ready');
    assert.deepEqual(store.getState().plan!.stops.map((s) => s.visited), [true, false]);
  });

  it('reset（ログアウト・アカウント削除）で前のユーザーのプランを消す', async () => {
    const { store } = setup();
    await store.load('jwt-a');
    assert.notEqual(store.getState().plan, null);
    store.reset();
    assert.equal(store.getState().plan, null);
    assert.equal(store.getState().token, null);
  });

  it('60秒以内は取り直さない・invalidate（プラン選択直後）で取り直す・同時の取得は1本', async () => {
    const { store, fetchCalls, advance } = setup();
    await Promise.all([store.load('t'), store.load('t')]);
    assert.equal(fetchCalls.length, 1);
    advance(10_000);
    await store.load('t');
    assert.equal(fetchCalls.length, 1);
    store.invalidate();
    await store.load('t');
    assert.equal(fetchCalls.length, 2);
    advance(TODAY_STALE_MS);
    await store.load('t');
    assert.equal(fetchCalls.length, 3);
  });

  it('accepted プランなし → none / 未ログイン → unauthorized', async () => {
    const none = setup({ fetch: async () => ({ status: 'none' }) });
    await none.store.load('t');
    assert.deepEqual([none.store.getState().phase, none.store.getState().plan], ['none', null]);
    const anon = setup();
    await anon.store.load(null);
    assert.equal(anon.store.getState().phase, 'unauthorized');
    assert.equal(anon.fetchCalls.length, 0);
  });

  it('取得エラーでも表示中のプランは消さない', async () => {
    let fail = false;
    const { store, advance } = setup({
      fetch: async () => (fail ? { status: 'error', message: TODAY_MESSAGES.load_error, devDetail: 'HTTP 500' } : { status: 'ok', plan: PLAN }),
    });
    await store.load('t');
    fail = true;
    advance(TODAY_STALE_MS);
    await store.load('t');
    assert.equal(store.getState().phase, 'ready');
    assert.equal(store.getState().plan?.plan_id, PLAN_ID);
  });

  it('「行った」: 記録中は次を受け付けない（連打で二重記録しない）→ 全部訪れたら完了', async () => {
    let release!: (r: VisitResult) => void;
    const { store, visitCalls } = setup({ visit: (id) => (id === 'p1' ? new Promise((r) => (release = r)) : Promise.resolve({ status: 'visited', visited_place_ids: ['p1', id] })) });
    await store.load('t');
    const first = store.markVisited('t', 'p1');
    await store.markVisited('t', 'p1'); // 連打
    await store.markVisited('t', 'p2'); // 記録中の別スポット
    assert.deepEqual(visitCalls, ['p1']);
    assert.equal(store.getState().visiting, 'p1');
    release({ status: 'visited', visited_place_ids: ['p1'] });
    await first;
    assert.deepEqual(store.getState().plan!.stops.map((s) => s.visited), [true, false]);
    await store.markVisited('t', 'p1'); // 訪問済みは送らない
    assert.deepEqual(visitCalls, ['p1']);
    await store.markVisited('t', 'p2');
    assert.equal(store.getState().plan!.completed, true);
    assert.equal(store.getState().plan!.visited_count, 2);
  });

  it('既に訪問済み（別の端末で記録）→ サーバーの値で表示を更新', async () => {
    const { store } = setup({ visit: async () => ({ status: 'already_visited', visited_place_ids: ['p1', 'p2'] }) });
    await store.load('t');
    await store.markVisited('t', 'p1');
    assert.equal(store.getState().plan!.completed, true);
  });

  it('記録失敗はその場所にだけメッセージ・再試行で消える', async () => {
    let fail = true;
    const { store } = setup({
      visit: async (id) => (fail ? { status: 'error', message: TODAY_MESSAGES.visit_error, devDetail: 'HTTP 500' } : { status: 'visited', visited_place_ids: [id] }),
    });
    await store.load('t');
    await store.markVisited('t', 'p1');
    assert.deepEqual(store.getState().visitErrors, { p1: TODAY_MESSAGES.visit_error });
    assert.equal(store.getState().plan!.stops[0].visited, false);
    fail = false;
    await store.markVisited('t', 'p1');
    assert.deepEqual(store.getState().visitErrors, {});
    assert.equal(store.getState().plan!.stops[0].visited, true);
  });

  it('プランが accepted でなくなっていた → 取り直す / 認証切れ → unauthorized', async () => {
    const a = setup({ visit: async () => ({ status: 'plan_not_accepted', message: TODAY_MESSAGES.plan_not_accepted, devDetail: 'P0002' }) });
    await a.store.load('t');
    await a.store.markVisited('t', 'p1');
    assert.equal(a.fetchCalls.length, 2);
    const b = setup({ visit: async () => ({ status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: '401' }) });
    await b.store.load('t');
    await b.store.markVisited('t', 'p1');
    assert.equal(b.store.getState().phase, 'unauthorized');
    assert.equal(b.unauthorized(), 1);
  });

  it('applyVisitedIds', () => {
    const p: TodayPlan = applyVisitedIds(PLAN, ['p2']);
    assert.deepEqual([p.visited_count, p.completed, p.stops[1].visited], [1, false, true]);
  });
});
