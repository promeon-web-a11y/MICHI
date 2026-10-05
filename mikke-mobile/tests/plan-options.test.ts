/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike } from '../src/place/identify-place-client';
import { buildPlanConditions, DEFAULT_PLAN_DRAFT, toggleTransport, type PlanConditions } from '../src/plan/plan-conditions';
import {
  budgetText,
  categoryLabel,
  formatClock,
  mainPlacesText,
  noticeText,
  resultsHeadline,
  totalTimeText,
} from '../src/plan/plan-option-format';
import {
  acceptPlanOption,
  callGeneratePlanOptions,
  isPlanOptionsResponse,
  PLAN_ERROR_MESSAGES,
  type PlanOption,
  type PlanOptionsResponse,
  type PlanOptionsResult,
} from '../src/plan/plan-options-client';
import { createPlanOptionsStore } from '../src/plan/plan-options-store';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };

const CONDITIONS: PlanConditions = (() => {
  const r = buildPlanConditions({
    draft: toggleTransport(DEFAULT_PLAN_DRAFT, 'car'),
    location: { latitude: 43.0687, longitude: 141.3508, accuracy: 40, timestamp: Date.UTC(2026, 8, 26, 1), source: 'current' },
    savedPlaceCount: 5,
    now: () => new Date(Date.UTC(2026, 8, 26, 1, 0)),
  });
  assert.ok(r.ok);
  return r.conditions;
})();

const option = (variant: 'A' | 'B' | 'C', overrides: Partial<PlanOption> = {}): PlanOption => ({
  plan_id: `plan-${variant}`,
  variant,
  title: `プラン${variant}`,
  concept: 'コンセプト',
  summary: 'まとめ',
  estimated_start_at: '2026-09-26T01:00:00.000Z',
  estimated_end_at: '2026-09-26T03:10:00.000Z',
  estimated_total_minutes: 130,
  travel_buffer_minutes: 25,
  estimated_budget_yen: 2000,
  budget_status: 'estimated',
  within_budget: true,
  items: [
    {
      order: 1,
      place_id: 'p1',
      place_name: '森のカフェ',
      category: 'cafe',
      address: '北海道札幌市',
      latitude: 43.06,
      longitude: 141.34,
      estimated_arrival_at: '2026-09-26T01:10:00.000Z',
      estimated_stay_minutes: 60,
      travel_buffer_minutes: 10,
      reason: '保存していたカフェ',
      hours_status: 'unknown',
      price_band: 'under_1000',
    },
  ],
  ...overrides,
});

const RESPONSE: PlanOptionsResponse = {
  set_id: 'set-1',
  generated_at: '2026-09-26T01:00:00.000Z',
  plan_count: 3,
  candidate_count: 5,
  search_radius_km: 15,
  notice: null,
  plans: [option('A'), option('B'), option('C')],
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
describe('callGeneratePlanOptions', () => {
  it('1・2・15. PlanConditions（複数の移動手段含む）をそのまま送り、A/B/C を受け取る', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: RESPONSE }));
    const r = await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl });
    assert.ok(r.ok);
    assert.deepEqual(r.data.plans.map((p) => p.variant), ['A', 'B', 'C']);
    assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/generate-plan-options');
    assert.equal(calls[0].init?.headers?.Authorization, 'Bearer user-jwt');
    const sent = JSON.parse(calls[0].init?.body ?? '');
    assert.deepEqual(sent, { conditions: CONDITIONS, generation_sequence: 1 });
    assert.deepEqual(sent.conditions.transport_modes, ['walking', 'train', 'bus', 'car']);
    assert.ok(!JSON.stringify(sent).includes('user_id'));
  });

  it('19. 未ログインは通信せず unauthorized / 401 も unauthorized', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: RESPONSE }));
    const r = await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: null, fetchImpl: impl });
    assert.equal(!r.ok && r.kind, 'unauthorized');
    assert.equal(calls.length, 0);
    const g = fakeFetch(() => ({ status: 401, body: { code: 401, message: 'Invalid JWT' } }));
    assert.equal(((await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 'bad', fetchImpl: g.impl })) as { kind: string }).kind, 'unauthorized');
  });

  it('サーバーのエラーを種類別・やさしい文言に変換（技術的な文字列を見せない）', async () => {
    const cases: [number, unknown, string, boolean][] = [
      [422, { error: 'no_saved_places' }, 'no_saved_places', false],
      [422, { error: 'no_candidates', candidate_stats: {} }, 'no_candidates', false],
      [502, { error: 'ai_generation_failed', retryable: true }, 'generation_failed', true], // 16. OpenAI 失敗
      [422, { error: 'ai_output_failed_validation' }, 'generation_failed', true], // 17. 不正な AI レスポンス
      [500, { error: 'candidate_query_failed' }, 'server', true], // 20. DB 取得失敗
      [500, { error: 'plan_save_failed' }, 'server', true],
      [400, { error: 'origin_required' }, 'invalid_request', false],
      [504, '<html>Gateway Timeout</html>', 'server', true],
    ];
    for (const [status, body, kind, retryable] of cases) {
      const { impl } = fakeFetch(() => ({ status, body }));
      const r = await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.equal(r.ok, false);
      if (r.ok) continue;
      assert.equal(r.kind, kind, `${status} ${JSON.stringify(body)}`);
      assert.equal(r.retryable, retryable);
      assert.equal(r.message, PLAN_ERROR_MESSAGES[r.kind]);
      assert.ok(!/HTTP|error|null|undefined/i.test(r.message), r.message);
    }
  });

  it('21. ネットワークエラー / 18. タイムアウト', async () => {
    const net = fakeFetch(() => Promise.reject(new TypeError('Network request failed')));
    assert.equal(((await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 't', fetchImpl: net.impl })) as { kind: string }).kind, 'network');
    const hanging: FetchLike = (_u, init) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const r = await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 't', fetchImpl: hanging, timeoutMs: 20 });
    assert.equal(!r.ok && r.kind, 'timeout');
  });

  it('17b. 200 でも形が不正なら invalid_response', async () => {
    for (const body of [{}, { plans: [] }, { plans: [option('A'), { ...option('A'), plan_id: 'x' }] }, { plans: [{ ...option('A'), items: [] }] }, 'not json']) {
      const { impl } = fakeFetch(() => ({ status: 200, body }));
      const r = await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.equal(!r.ok && r.kind, 'invalid_response', JSON.stringify(body));
    }
    assert.equal(isPlanOptionsResponse(RESPONSE), true);
  });
});

describe('acceptPlanOption（既存 accept_plan RPC）', () => {
  it('25. プラン選択: RPC を plan_id だけで呼ぶ', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { id: 'plan-A', status: 'accepted' } }));
    const r = await acceptPlanOption('plan-A', { config: CONFIG, accessToken: 't', fetchImpl: impl });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/accept_plan');
    assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), { p_plan_id: 'plan-A' });
  });

  it('対象なし（他人のプラン含む）/ 未ログイン / 通信エラー', async () => {
    const nf = fakeFetch(() => ({ status: 400, body: { code: 'P0002', message: 'plan_not_found_or_not_acceptable' } }));
    assert.equal(((await acceptPlanOption('x', { config: CONFIG, accessToken: 't', fetchImpl: nf.impl })) as { kind: string }).kind, 'not_found');
    assert.equal(((await acceptPlanOption('x', { config: CONFIG, accessToken: null })) as { kind: string }).kind, 'unauthorized');
    const net = fakeFetch(() => Promise.reject(new TypeError('offline')));
    assert.equal(((await acceptPlanOption('x', { config: CONFIG, accessToken: 't', fetchImpl: net.impl })) as { kind: string }).kind, 'network');
  });
});

// ---------------------------------------------------------------------------------------------
describe('planOptionsStore', () => {
  function setup(results: PlanOptionsResult[], acceptOk = true) {
    const generateCalls: number[] = [];
    let resolveNext: ((r: PlanOptionsResult) => void) | null = null;
    const store = createPlanOptionsStore({
      generate: (_c, seq) => {
        generateCalls.push(seq);
        const next = results.shift();
        if (next) return Promise.resolve(next);
        return new Promise((r) => (resolveNext = r));
      },
      accept: async () => (acceptOk ? { ok: true } : { ok: false, kind: 'server', message: 'プランを選べませんでした。もう一度お試しください。', devDetail: 'x' }),
    });
    return { store, generateCalls, resolve: (r: PlanOptionsResult) => resolveNext?.(r) };
  }
  const OK: PlanOptionsResult = { ok: true, data: RESPONSE };
  const FAIL: PlanOptionsResult = { ok: false, kind: 'generation_failed', message: PLAN_ERROR_MESSAGES.generation_failed, retryable: true, devDetail: 'HTTP 502' };

  it('22. 二重送信防止: 生成中の再押下はリクエストしない', async () => {
    const { store, generateCalls, resolve } = setup([]);
    const p1 = store.generate(CONDITIONS);
    const p2 = store.generate(CONDITIONS);
    store.retry();
    assert.equal(store.getState().status, 'generating');
    resolve(OK);
    await Promise.all([p1, p2]);
    assert.equal(generateCalls.length, 1);
    assert.equal(store.getState().status, 'ready');
  });

  it('23. 結果: 生成成功で ready、失敗で error（もう一度試すで回復）', async () => {
    const { store, generateCalls } = setup([FAIL, OK]);
    await store.generate(CONDITIONS);
    assert.equal(store.getState().status, 'error');
    assert.deepEqual(store.getState().error, { kind: 'generation_failed', message: PLAN_ERROR_MESSAGES.generation_failed, retryable: true });
    await store.retry();
    assert.equal(store.getState().status, 'ready');
    assert.deepEqual(generateCalls, [1, 1], '再試行は同じ generation_sequence');
  });

  it('作り直しは generation_sequence を増やし 3 まで', async () => {
    const { store, generateCalls } = setup([OK, OK, OK, OK]);
    await store.generate(CONDITIONS);
    await store.regenerate();
    await store.regenerate();
    await store.regenerate();
    assert.deepEqual(generateCalls, [1, 2, 3]);
  });

  it('25. プラン選択は1セットにつき1つ・存在しない ID は無視', async () => {
    const { store } = setup([OK]);
    await store.generate(CONDITIONS);
    await store.accept('unknown');
    assert.deepEqual(store.getState().selection, { status: 'none' });
    await store.accept('plan-B');
    assert.deepEqual(store.getState().selection, { status: 'accepted', planId: 'plan-B' });
    await store.accept('plan-A');
    assert.deepEqual(store.getState().selection, { status: 'accepted', planId: 'plan-B' }, '選択済みなら変えない');
  });

  it('選択の失敗はそのプランにエラーとして出す', async () => {
    const { store } = setup([OK], false);
    await store.generate(CONDITIONS);
    await store.accept('plan-A');
    assert.equal(store.getState().selection.status, 'error');
  });

  it('作り直すと選択はリセット', async () => {
    const { store } = setup([OK, OK]);
    await store.generate(CONDITIONS);
    await store.accept('plan-A');
    await store.regenerate();
    assert.deepEqual(store.getState().selection, { status: 'none' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('表示（結果画面・詳細画面）', () => {
  it('23. 結果画面の見出し・注意', () => {
    assert.equal(resultsHeadline(3), '3つのプランをつくりました');
    assert.equal(resultsHeadline(2), '2つのプランをつくりました');
    assert.equal(resultsHeadline(1), 'プランをつくりました');
    assert.match(noticeText('few_candidates', 1) ?? '', /1つのプラン/);
    assert.equal(noticeText(null, 3), null);
  });

  it('予算: 料金情報が不足していれば金額を断定しない', () => {
    assert.equal(budgetText({ estimated_budget_yen: 2000, budget_status: 'estimated' }), '〜2,000円（目安）');
    assert.equal(budgetText({ estimated_budget_yen: 1000, budget_status: 'partial' }), '〜1,000円＋料金不明あり（目安）');
    assert.equal(budgetText({ estimated_budget_yen: null, budget_status: 'unknown' }), '料金情報なし');
  });

  it('24. 詳細画面: 時刻（目安）・合計時間・カテゴリ・主な場所', () => {
    assert.equal(formatClock('2026-09-26T01:10:00.000Z', 540), '10:10');
    assert.equal(formatClock('invalid'), '');
    assert.equal(totalTimeText({ estimated_total_minutes: 130 }), '約2時間10分');
    assert.equal(totalTimeText({ estimated_total_minutes: 58 }), '約1時間');
    assert.equal(categoryLabel('cafe'), 'カフェ');
    assert.equal(categoryLabel('unknown_category'), 'その他');
    const many = option('A', { items: ['a', 'b', 'c', 'd'].map((n, i) => ({ ...option('A').items[0], order: i + 1, place_id: n, place_name: n })) });
    assert.equal(mainPlacesText(many), 'a → b → c ほか');
  });
});

// ---------------------------------------------------------------------------------------------
describe('v3: 公開ルートを元にした提案（今日向けに調整）', () => {
  it('place_ids と元ルートを送る。指定が無ければ従来どおり送らない', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: RESPONSE }));
    await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 't', fetchImpl: impl, extra: { placeIds: ['p1', 'p2'], basedOnRoutePostId: 'post-1' } });
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body.place_ids, ['p1', 'p2']);
    assert.equal(body.based_on_route_post_id, 'post-1');
    await callGeneratePlanOptions(CONDITIONS, { config: CONFIG, accessToken: 't', fetchImpl: impl });
    const plain = JSON.parse(String(calls[1].init?.body));
    assert.ok(!('place_ids' in plain) && !('based_on_route_post_id' in plain));
  });

  it('再試行・作り直しでも同じ候補（extra）を使う', async () => {
    const seen: unknown[] = [];
    const store = createPlanOptionsStore({
      generate: async (_c, _seq, extra) => {
        seen.push(extra);
        return { ok: false, kind: 'server', message: 'x', retryable: true, devDetail: 'x' };
      },
      accept: async () => ({ ok: true }),
    });
    const extra = { placeIds: ['p1'], basedOnRoutePostId: 'post-1' };
    await store.generate(CONDITIONS, extra);
    await store.retry();
    assert.deepEqual(seen, [extra, extra]);
    assert.deepEqual(store.getState().extra, extra);
    await store.generate(CONDITIONS);
    assert.equal(store.getState().extra, null);
  });
});
