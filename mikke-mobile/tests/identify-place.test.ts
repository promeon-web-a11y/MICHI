/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMAIL_NOT_CONFIRMED_MESSAGE,
  buildIdentifyRequest,
  callIdentifyPlace,
  isIdentifyPlaceResponse,
  isSessionValid,
  resolveBackend,
  signInWithPassword,
  type FetchLike,
  type IdentifyPlaceResponse,
} from '../src/place/identify-place-client';
import { processSharePayloads } from '../src/share/process-share-payloads';

const CONFIG = { supabaseUrl: 'https://example.supabase.co/', anonKey: 'anon-public-key' };

const response = (overrides: Partial<IdentifyPlaceResponse> = {}): IdentifyPlaceResponse => ({
  status: 'confirmed',
  confidence: 0.9,
  reason: 'matched',
  message: '場所を特定しました。',
  input: { source: 'instagram', url: 'https://www.instagram.com/p/abc/', has_text: true, warnings: [] },
  extraction: null,
  extraction_candidates: [],
  insufficient_reason: null,
  searches: [{ query: '森彦 札幌', result_count: 1 }],
  place: {
    google_place_id: 'ChIJ_x',
    name: '森彦',
    formatted_address: '北海道札幌市中央区',
    latitude: 43.06,
    longitude: 141.31,
    primary_type: 'cafe',
    types: ['cafe'],
    business_status: 'OPERATIONAL',
  },
  candidates: [],
  error: null,
  ...overrides,
});

type Call = { url: string; init: Parameters<FetchLike>[1] };
function fakeFetch(handler: (call: Call) => { status: number; body: unknown } | Promise<never>) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = await handler({ url, init });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { impl, calls };
}

describe('buildIdentifyRequest（Step 3-2 の出力 → identify-place 入力）', () => {
  it('Instagram URL + text: 正規化URLを送る', () => {
    const analysis = processSharePayloads([
      { shareType: 'text', value: '札幌の #森彦 でモーニング\nhttps://www.instagram.com/p/abc/?igsh=xyz' },
    ]);
    assert.deepEqual(buildIdentifyRequest(analysis), {
      url: 'https://www.instagram.com/p/abc/',
      text: '札幌の #森彦 でモーニング\nhttps://www.instagram.com/p/abc/?igsh=xyz',
      source: 'instagram',
    });
  });

  it('TikTok / YouTube / Web の source を引き継ぐ', () => {
    const tiktok = buildIdentifyRequest(processSharePayloads([{ shareType: 'url', value: 'https://vt.tiktok.com/ZS1/' }]));
    assert.equal(tiktok?.source, 'tiktok');
    assert.equal(tiktok?.text, null);
    const yt = buildIdentifyRequest(processSharePayloads([{ shareType: 'text', value: '白い恋人パーク https://youtu.be/a?si=1' }]));
    assert.equal(yt?.source, 'youtube');
    assert.equal(yt?.url, 'https://youtu.be/a');
    const web = buildIdentifyRequest(processSharePayloads([{ shareType: 'url', value: 'https://tabelog.com/x/?utm_source=a' }]));
    assert.deepEqual(web, { url: 'https://tabelog.com/x/', text: null, source: 'web' });
  });

  it('textのみ → source=unknown', () => {
    const r = buildIdentifyRequest(processSharePayloads([{ shareType: 'text', value: '円山の森彦' }]));
    assert.deepEqual(r, { url: null, text: '円山の森彦', source: 'unknown' });
  });

  it('URL も text も無い・不正入力 → null', () => {
    assert.equal(buildIdentifyRequest(processSharePayloads([])), null);
    assert.equal(buildIdentifyRequest(processSharePayloads([{ shareType: 'image', value: 'file:///a.jpg' }])), null);
    assert.equal(buildIdentifyRequest(processSharePayloads([{ shareType: 'text', value: '   ' }])), null);
    assert.equal(buildIdentifyRequest(null), null);
  });

  it('malformed URL（https://）は URL として送らずテキスト扱い', () => {
    const r = buildIdentifyRequest(processSharePayloads([{ shareType: 'text', value: '森彦 https://' }]));
    assert.equal(r?.url, null);
    assert.equal(r?.text, '森彦 https://');
  });
});

describe('resolveBackend', () => {
  it('末尾スラッシュを除く・未設定や不正値は null', () => {
    assert.deepEqual(resolveBackend(CONFIG), { baseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' });
    assert.equal(resolveBackend({ supabaseUrl: null, anonKey: 'x' }), null);
    assert.equal(resolveBackend({ supabaseUrl: 'https://a.supabase.co', anonKey: '  ' }), null);
    assert.equal(resolveBackend({ supabaseUrl: 'not a url', anonKey: 'x' }), null);
  });
});

describe('callIdentifyPlace', () => {
  const req = { url: 'https://www.instagram.com/p/abc/', text: '森彦', source: 'instagram' as const };

  it('正常系: 関数URL・ヘッダー・本文', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: response() }));
    const r = await callIdentifyPlace(req, { config: CONFIG, accessToken: 'user-jwt', fetchImpl: impl });
    assert.ok(r.ok);
    assert.equal(r.ok && r.data.place?.google_place_id, 'ChIJ_x');
    assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/identify-place');
    assert.equal(calls[0].init?.headers?.Authorization, 'Bearer user-jwt');
    assert.equal(calls[0].init?.headers?.apikey, 'anon-public-key');
    assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), req);
  });

  it('needs_review（候補付き）/ not_found / insufficient_information もそのまま返す', async () => {
    for (const status of ['needs_review', 'not_found', 'insufficient_information'] as const) {
      const { impl } = fakeFetch(() => ({ status: 200, body: response({ status, place: null }) }));
      const r = await callIdentifyPlace(req, { config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.ok(r.ok && r.data.status === status);
    }
  });

  it('サーバー側 API エラー（HTTP 502 + status=error）は結果として表示できる', async () => {
    const { impl } = fakeFetch(() => ({
      status: 502,
      body: response({ status: 'error', place: null, error: { stage: 'openai', code: 'ai_timeout' } }),
    }));
    const r = await callIdentifyPlace(req, { config: CONFIG, accessToken: 't', fetchImpl: impl });
    assert.ok(r.ok);
    assert.equal(r.ok && r.data.error?.code, 'ai_timeout');
    assert.equal(r.ok && r.httpStatus, 502);
  });

  it('設定なし・未ログインは通信しない', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: response() }));
    const a = await callIdentifyPlace(req, { config: { supabaseUrl: null, anonKey: null }, accessToken: 't', fetchImpl: impl });
    assert.equal(!a.ok && a.kind, 'config');
    const b = await callIdentifyPlace(req, { config: CONFIG, accessToken: null, fetchImpl: impl });
    assert.equal(!b.ok && b.kind, 'auth');
    assert.equal(calls.length, 0);
  });

  it('401 → auth / 500(非JSON) → http / 200(想定外JSON) → invalid_response', async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: 'invalid_session' }, 'auth'],
      [500, '<html>Internal</html>', 'http'],
      [500, { error: 'server_configuration_missing' }, 'http'],
      [200, { foo: 1 }, 'invalid_response'],
      [200, '', 'invalid_response'],
    ];
    for (const [status, body, kind] of cases) {
      const { impl } = fakeFetch(() => ({ status, body }));
      const r = await callIdentifyPlace(req, { config: CONFIG, accessToken: 't', fetchImpl: impl });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.kind, kind, `${status}`);
        assert.ok(r.userMessage.length > 0);
        assert.ok(!r.userMessage.includes('HTTP'), 'ユーザー向け文言に開発用詳細を混ぜない');
      }
    }
  });

  it('ネットワークエラー', async () => {
    const { impl } = fakeFetch(() => Promise.reject(new TypeError('Network request failed')));
    const r = await callIdentifyPlace(req, { config: CONFIG, accessToken: 't', fetchImpl: impl });
    assert.equal(!r.ok && r.kind, 'network');
    assert.match(!r.ok ? r.devDetail : '', /Network request failed/);
  });

  it('タイムアウト（AbortController で中断）', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const r = await callIdentifyPlace(req, { config: CONFIG, accessToken: 't', fetchImpl: hanging, timeoutMs: 20 });
    assert.equal(!r.ok && r.kind, 'timeout');
  });
});

describe('isIdentifyPlaceResponse', () => {
  it('status が既知の値でなければ false', () => {
    assert.equal(isIdentifyPlaceResponse(response()), true);
    assert.equal(isIdentifyPlaceResponse({ ...response(), status: 'ok' }), false);
    assert.equal(isIdentifyPlaceResponse(null), false);
  });
});

describe('signInWithPassword（開発用ログイン）', () => {
  it('成功時はトークンと有効期限を返す', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { access_token: 'jwt', refresh_token: 'rt', expires_in: 3600, user: { email: 'dev@example.com' } },
    }));
    const r = await signInWithPassword(' dev@example.com ', 'pw', { config: CONFIG, fetchImpl: impl, now: () => 1000 });
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.session, { accessToken: 'jwt', refreshToken: 'rt', email: 'dev@example.com', expiresAt: 1000 + 3600_000 });
    assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), { email: 'dev@example.com', password: 'pw' });
  });

  it('認証失敗・空入力・ネットワークエラー', async () => {
    const bad = fakeFetch(() => ({ status: 400, body: { error_code: 'invalid_credentials' } }));
    const r1 = await signInWithPassword('a@b.c', 'x', { config: CONFIG, fetchImpl: bad.impl });
    assert.equal(r1.ok, false);
    assert.ok(!r1.ok && !r1.devDetail.includes('x"'), 'パスワードを詳細に含めない');
    const r2 = await signInWithPassword('', '', { config: CONFIG, fetchImpl: bad.impl });
    assert.equal(r2.ok, false);
    const net = fakeFetch(() => Promise.reject(new TypeError('offline')));
    const r3 = await signInWithPassword('a@b.c', 'x', { config: CONFIG, fetchImpl: net.impl });
    assert.equal(r3.ok, false);
  });

  it('メール確認前（email_not_confirmed）と認証情報の不一致は別のメッセージになる', async () => {
    const unconfirmed = fakeFetch(() => ({ status: 400, body: { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' } }));
    const r1 = await signInWithPassword('a@b.c', 'correct-password', { config: CONFIG, fetchImpl: unconfirmed.impl });
    assert.equal(!r1.ok && r1.userMessage, EMAIL_NOT_CONFIRMED_MESSAGE);
    assert.match(EMAIL_NOT_CONFIRMED_MESSAGE, /確認メール/);

    // error_code が無く msg だけの古い形式でも判定する
    const legacy = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Email not confirmed', msg: 'Email not confirmed' } }));
    const r2 = await signInWithPassword('a@b.c', 'correct-password', { config: CONFIG, fetchImpl: legacy.impl });
    assert.equal(!r2.ok && r2.userMessage, EMAIL_NOT_CONFIRMED_MESSAGE);

    const wrong = fakeFetch(() => ({ status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }));
    const r3 = await signInWithPassword('a@b.c', 'wrong-password', { config: CONFIG, fetchImpl: wrong.impl });
    assert.equal(!r3.ok && r3.userMessage, 'メールアドレスまたはパスワードが違います。');
    assert.notEqual(!r3.ok && r3.userMessage, EMAIL_NOT_CONFIRMED_MESSAGE);
  });

  it('isSessionValid: 期限切れ間近は無効', () => {
    assert.equal(isSessionValid(null), false);
    assert.equal(isSessionValid({ accessToken: 'a', email: null, expiresAt: 100_000 }, 0), true);
    assert.equal(isSessionValid({ accessToken: 'a', email: null, expiresAt: 100_000 }, 80_000), false);
  });
});
