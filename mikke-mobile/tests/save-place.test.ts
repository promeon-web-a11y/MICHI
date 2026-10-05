/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike, IdentifyPlaceRequest, IdentifyPlaceResponse, ScoredPlace } from '../src/place/identify-place-client';
import {
  buildSaveRequest,
  callSavePlace,
  isSavePlaceResponse,
  type SavePlaceResponse,
} from '../src/place/save-place-client';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };

const SENT: IdentifyPlaceRequest = {
  url: 'https://www.instagram.com/p/abc/',
  text: '札幌のスタバに行きたい https://www.instagram.com/p/abc/?igsh=1',
  source: 'instagram',
};

const candidate = (id: string, name: string, score: number): ScoredPlace => ({
  google_place_id: id,
  name,
  formatted_address: `北海道札幌市 ${name}`,
  latitude: 43.06,
  longitude: 141.35,
  primary_type: 'coffee_shop',
  types: ['coffee_shop', 'cafe'],
  business_status: 'OPERATIONAL',
  score,
  score_detail: { name: 0.9, area: 1, category: 1, closed_penalty: false },
});

const identify = (overrides: Partial<IdentifyPlaceResponse> = {}): IdentifyPlaceResponse => ({
  status: 'confirmed',
  confidence: 0.98,
  reason: 'matched',
  message: '場所を特定しました。',
  input: { source: 'instagram', url: SENT.url, has_text: true, warnings: [] },
  extraction: null,
  extraction_candidates: [],
  insufficient_reason: null,
  searches: [],
  place: {
    google_place_id: 'ChIJ_grand_hotel',
    name: 'スターバックス コーヒー 札幌グランドホテル店',
    formatted_address: '北海道札幌市中央区北１条西４丁目',
    latitude: 43.0628,
    longitude: 141.3527,
    primary_type: 'coffee_shop',
    types: ['coffee_shop', 'cafe'],
    business_status: 'OPERATIONAL',
  },
  candidates: [],
  error: null,
  ...overrides,
});

const NEEDS_REVIEW = identify({
  status: 'needs_review',
  confidence: 0.58,
  reason: 'multiple_similar_places',
  place: null,
  candidates: [candidate('ChIJ_s1', 'スタバ 大通店', 0.8), candidate('ChIJ_s2', 'スタバ 札幌駅前店', 0.78)],
});

const saveResponse = (overrides: Partial<SavePlaceResponse> = {}): SavePlaceResponse => ({
  status: 'saved',
  message: '保存しました',
  reason: 'saved',
  place: {
    place_id: '11111111-1111-4111-8111-111111111111',
    google_place_id: 'ChIJ_grand_hotel',
    name: 'スターバックス コーヒー 札幌グランドホテル店',
    address: '北海道札幌市中央区北１条西４丁目',
    latitude: 43.0628,
    longitude: 141.3527,
    category: 'cafe',
  },
  saved_place: { id: 'sp1', saved_at: '2026-09-26T00:00:00Z', source_platform: 'instagram', source_url: SENT.url! },
  place_reused: false,
  warnings: [],
  error: null,
  ...overrides,
});

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

describe('buildSaveRequest', () => {
  it('confirmed → Place と共有元を送る（user_id は含めない）', () => {
    const r = buildSaveRequest(identify(), SENT);
    assert.ok(r);
    assert.equal(r.place.google_place_id, 'ChIJ_grand_hotel');
    assert.deepEqual(r.identification, { status: 'confirmed', confidence: 0.98, selected_by_user: false });
    assert.deepEqual(r.share, { source: 'instagram', url: SENT.url, text: SENT.text });
    assert.ok(!JSON.stringify(r).includes('user_id'));
  });

  it('5. needs_review は選択なしでは保存リクエストを作らない（自動保存しない）', () => {
    assert.equal(buildSaveRequest(NEEDS_REVIEW, SENT), null);
    assert.equal(buildSaveRequest(NEEDS_REVIEW, SENT, null), null);
    assert.equal(buildSaveRequest(NEEDS_REVIEW, SENT, 'ChIJ_not_in_candidates'), null);
  });

  it('6. needs_review で選んだ候補を送る', () => {
    const r = buildSaveRequest(NEEDS_REVIEW, SENT, 'ChIJ_s2');
    assert.ok(r);
    assert.equal(r.place.google_place_id, 'ChIJ_s2');
    assert.equal(r.place.name, 'スタバ 札幌駅前店');
    assert.deepEqual(r.identification, { status: 'needs_review', confidence: 0.78, selected_by_user: true });
    assert.ok(!('score' in r.place), 'スコア等の開発用項目は Place 情報に含めない');
  });

  it('not_found / insufficient_information / error は保存しない', () => {
    for (const status of ['not_found', 'insufficient_information', 'error'] as const) {
      const r = identify({ status, place: null, candidates: [candidate('ChIJ_x', 'x', 0.3)] });
      assert.equal(buildSaveRequest(r, SENT), null, status);
      assert.equal(buildSaveRequest(r, SENT, 'ChIJ_x'), null, `${status} + 選択`);
    }
  });

  it('10. confirmed でも Place ID が無ければ保存しない', () => {
    const r = identify({ place: { ...identify().place!, google_place_id: '' } });
    assert.equal(buildSaveRequest(r, SENT), null);
    assert.equal(buildSaveRequest(identify({ place: null }), SENT), null);
    assert.equal(buildSaveRequest(null, SENT), null);
  });

  it('textのみの共有: url=null・source はサーバー判定値', () => {
    const r = buildSaveRequest(identify({ input: { source: 'unknown', url: null, has_text: true, warnings: [] } }), {
      url: null,
      text: '森彦',
      source: 'unknown',
    });
    assert.deepEqual(r?.share, { source: 'unknown', url: null, text: '森彦' });
  });
});

describe('callSavePlace', () => {
  const request = buildSaveRequest(identify(), SENT)!;

  it('1. saved: 関数URL・ヘッダー', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: saveResponse() }));
    const r = await callSavePlace(request, { config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl });
    assert.equal(r.status, 'saved');
    assert.equal(r.message, '保存しました');
    assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/save-place');
    assert.equal(calls[0].init?.headers?.Authorization, 'Bearer user-jwt');
    assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), request);
  });

  it('3. already_saved', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: saveResponse({ status: 'already_saved', message: 'すでに保存されています', reason: 'already_saved', place_reused: true }) }));
    const r = await callSavePlace(request, { config: CONFIG, accessToken: 't', fetchImpl: impl });
    assert.equal(r.status, 'already_saved');
    assert.equal(r.message, 'すでに保存されています');
  });

  it('7. 未ログインは通信せず unauthorized', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: saveResponse() }));
    const r = await callSavePlace(request, { config: CONFIG, accessToken: null, fetchImpl: impl });
    assert.equal(r.status, 'unauthorized');
    assert.equal(r.message, 'ログインが必要です');
    assert.equal(calls.length, 0);
  });

  it('8. 不正JWT: Edge Function の 401 / ゲートウェイ独自形式の 401 どちらも unauthorized', async () => {
    const own = fakeFetch(() => ({ status: 401, body: { ...saveResponse({ status: 'unauthorized', message: 'ログインが必要です', reason: 'invalid_session', place: null, saved_place: null }) } }));
    assert.equal((await callSavePlace(request, { config: CONFIG, accessToken: 'bad', fetchImpl: own.impl })).status, 'unauthorized');
    const gateway = fakeFetch(() => ({ status: 401, body: { code: 401, message: 'Invalid JWT' } }));
    const r = await callSavePlace(request, { config: CONFIG, accessToken: 'bad', fetchImpl: gateway.impl });
    assert.equal(r.status, 'unauthorized');
    assert.match(r.devDetail ?? '', /Invalid JWT/);
  });

  it('11. サーバーエラー / 不正応答 / 入力拒否 / 設定なし → 保存できませんでした', async () => {
    const cases: [number, unknown, string][] = [
      [500, saveResponse({ status: 'error', message: '保存できませんでした', reason: 'db_error', place: null, saved_place: null, error: { code: 'db_error' } }), 'error'],
      [400, saveResponse({ status: 'invalid_request', message: '保存できませんでした', reason: 'google_place_id_required', place: null, saved_place: null }), 'invalid_request'],
      [502, '<html>Bad Gateway</html>', 'error'],
      [200, { foo: 1 }, 'error'],
    ];
    for (const [status, body, expected] of cases) {
      const { impl } = fakeFetch(() => ({ status, body }));
      const r = await callSavePlace(request, { config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.equal(r.status, expected, String(status));
      assert.equal(r.message, '保存できませんでした');
    }
    const noConfig = await callSavePlace(request, { config: { supabaseUrl: null, anonKey: null }, accessToken: 't' });
    assert.equal(noConfig.status, 'error');
  });

  it('ネットワークエラー・タイムアウト', async () => {
    const net = fakeFetch(() => Promise.reject(new TypeError('Network request failed')));
    assert.equal((await callSavePlace(request, { config: CONFIG, accessToken: 't', fetchImpl: net.impl })).status, 'error');
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const r = await callSavePlace(request, { config: CONFIG, accessToken: 't', fetchImpl: hanging, timeoutMs: 20 });
    assert.equal(r.status, 'error');
    assert.match(r.devDetail ?? '', /応答しませんでした/);
  });

  it('isSavePlaceResponse', () => {
    assert.equal(isSavePlaceResponse(saveResponse()), true);
    assert.equal(isSavePlaceResponse({ status: 'ok', reason: 'x' }), false);
    assert.equal(isSavePlaceResponse(null), false);
  });
});
