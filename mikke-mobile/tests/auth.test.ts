/**
 * Step 4-9: ログインの永続化（トークン更新・新規登録・復元・自動更新・ログアウト）。
 * 実際の Supabase には接続しない（fetch とストレージはモック）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAuthController, REFRESH_BEFORE_MS, type AuthStorage } from '../src/auth/auth-controller';
import { refreshSession, signOutRemote, signUp, validateCredentials, type RefreshResult, type StoredAuth } from '../src/auth/auth-session';
import type { DevSession, FetchLike } from '../src/place/identify-place-client';

const config = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-test' };
const NOW = 1_000_000_000_000;

type Call = { url: string; headers: Record<string, string>; body: any };

function mockFetch(status: number, body: unknown, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

const tokenBody = { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, user: { email: 'u@example.com' } };

describe('refreshSession', () => {
  it('成功: 新しいアクセストークンと（ローテーションされた）リフレッシュトークンを返す', async () => {
    const calls: Call[] = [];
    const r = await refreshSession('rt-old', 'u@example.com', { config, fetchImpl: mockFetch(200, tokenBody, calls), now: () => NOW });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.session.accessToken, 'at-new');
      assert.equal(r.session.refreshToken, 'rt-new');
      assert.equal(r.session.expiresAt, NOW + 3600_000);
    }
    assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
    assert.deepEqual(calls[0].body, { refresh_token: 'rt-old' });
    assert.equal(calls[0].headers.apikey, 'anon-test');
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  it('400（無効・再利用されたトークン）は invalid', async () => {
    const r = await refreshSession('rt', null, { config, fetchImpl: mockFetch(400, { error_code: 'refresh_token_not_found' }) });
    assert.deepEqual([r.ok, !r.ok && r.kind], [false, 'invalid']);
  });

  it('500 は server、通信失敗は network（どちらもトークンは無効扱いにしない）', async () => {
    const r1 = await refreshSession('rt', null, { config, fetchImpl: mockFetch(500, {}) });
    assert.equal(!r1.ok && r1.kind, 'server');
    const r2 = await refreshSession('rt', null, {
      config,
      fetchImpl: async () => {
        throw new TypeError('Network request failed');
      },
    });
    assert.equal(!r2.ok && r2.kind, 'network');
  });

  it('設定が無ければ config（通信しない）', async () => {
    const calls: Call[] = [];
    const r = await refreshSession('rt', null, { config: { supabaseUrl: null, anonKey: null }, fetchImpl: mockFetch(200, tokenBody, calls) });
    assert.equal(!r.ok && r.kind, 'config');
    assert.equal(calls.length, 0);
  });
});

describe('validateCredentials / signUp', () => {
  it('メール形式とパスワード長を確認する', () => {
    assert.match(validateCredentials('abc', 'password') ?? '', /メールアドレス/);
    assert.match(validateCredentials('a@b.co', '123') ?? '', /6文字以上/);
    assert.equal(validateCredentials(' a@b.co ', '123456'), null);
  });

  it('セッション付きで返れば signed_in', async () => {
    const r = await signUp('u@example.com', 'secret123', { config, fetchImpl: mockFetch(200, tokenBody), now: () => NOW });
    assert.equal(r.status, 'signed_in');
  });

  it('メール確認が必要な設定（セッションなし）は confirmation_required', async () => {
    const r = await signUp('u@example.com', 'secret123', { config, fetchImpl: mockFetch(200, { id: 'x', email: 'u@example.com' }) });
    assert.equal(r.status, 'confirmation_required');
  });

  it('登録済み・弱いパスワード・回数制限は日本語で案内する（技術用語を出さない）', async () => {
    const cases: [number, unknown, RegExp][] = [
      [422, { error_code: 'user_already_exists' }, /すでに登録/],
      [422, { error_code: 'weak_password' }, /別のパスワード/],
      [429, { error_code: 'over_request_rate_limit' }, /時間をおいて/],
      [500, 'oops', /登録できませんでした/],
    ];
    for (const [status, body, re] of cases) {
      const r = await signUp('u@example.com', 'secret123', { config, fetchImpl: mockFetch(status, body) });
      assert.equal(r.status, 'error');
      if (r.status === 'error') {
        assert.match(r.userMessage, re);
        assert.doesNotMatch(r.userMessage, /HTTP|JWT|Supabase|JSON|API/);
      }
    }
  });

  it('入力が不正なら送信しない', async () => {
    const calls: Call[] = [];
    const r = await signUp('bad', 'secret123', { config, fetchImpl: mockFetch(200, tokenBody, calls) });
    assert.equal(r.status, 'error');
    assert.equal(calls.length, 0);
  });

  it('signOutRemote は本人のトークンで /logout を呼ぶ', async () => {
    const calls: Call[] = [];
    await signOutRemote('at-1', { config, fetchImpl: mockFetch(204, '', calls) });
    assert.match(calls[0].url, /\/auth\/v1\/logout$/);
    assert.equal(calls[0].headers.Authorization, 'Bearer at-1');
  });
});

// ---------------------------------------------------------------------------------------------

function memoryStorage(initial: StoredAuth | null = null) {
  let value = initial;
  const storage: AuthStorage & { value: () => StoredAuth | null } = {
    read: async () => value,
    write: async (v) => {
      value = v;
    },
    clear: async () => {
      value = null;
    },
    value: () => value,
  };
  return storage;
}

const session = (n: number, expiresAt = NOW + 3600_000): DevSession => ({
  accessToken: `at-${n}`,
  refreshToken: `rt-${n}`,
  email: 'u@example.com',
  expiresAt,
});

function harness(options: { stored?: StoredAuth | null; results?: RefreshResult[] } = {}) {
  const storage = memoryStorage(options.stored ?? null);
  const refreshCalls: string[] = [];
  const results = [...(options.results ?? [])];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let clock = NOW;
  const logouts: string[] = [];
  const controller = createAuthController({
    storage,
    refresh: async (token) => {
      refreshCalls.push(token);
      return results.shift() ?? { ok: false, kind: 'network', devDetail: 'no more results' };
    },
    logoutRemote: async (token) => {
      logouts.push(token);
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    controller,
    storage,
    refreshCalls,
    timers,
    logouts,
    flush,
    advance: (ms: number) => {
      clock += ms;
    },
    activeTimer: () => timers.filter((t) => !t.cleared).at(-1),
  };
}

describe('auth controller', () => {
  it('保存が無ければ restoring → ready（未ログイン）', async () => {
    const h = harness();
    assert.equal(h.controller.getStatus(), 'restoring');
    await h.controller.restore();
    assert.equal(h.controller.getStatus(), 'ready');
    assert.equal(h.controller.getSession(), null);
    assert.equal(h.refreshCalls.length, 0);
  });

  it('保存済みトークンで復元し、ローテーション後のトークンを保存し直す', async () => {
    const h = harness({ stored: { refreshToken: 'rt-0', email: 'u@example.com' }, results: [{ ok: true, session: session(1) }] });
    let notified = 0;
    h.controller.subscribe(() => notified++);
    await h.controller.restore();
    await h.flush();
    assert.equal(h.controller.getSession()?.accessToken, 'at-1');
    assert.deepEqual(h.refreshCalls, ['rt-0']);
    assert.deepEqual(h.storage.value(), { refreshToken: 'rt-1', email: 'u@example.com' });
    assert.equal(h.controller.getStatus(), 'ready');
    assert.ok(notified >= 1);
  });

  it('無効なトークンなら保存を消して未ログインにする', async () => {
    const h = harness({ stored: { refreshToken: 'rt-0', email: null }, results: [{ ok: false, kind: 'invalid', devDetail: '400' }] });
    await h.controller.restore();
    await h.flush();
    assert.equal(h.controller.getSession(), null);
    assert.equal(h.storage.value(), null);
  });

  it('通信エラーなら保存は残し、前面復帰で再試行して復元する', async () => {
    const h = harness({
      stored: { refreshToken: 'rt-0', email: null },
      results: [{ ok: false, kind: 'network', devDetail: 'offline' }, { ok: true, session: session(2) }],
    });
    await h.controller.restore();
    assert.equal(h.controller.getSession(), null);
    assert.notEqual(h.storage.value(), null);
    await h.controller.onForeground();
    await h.flush();
    assert.equal(h.controller.getSession()?.accessToken, 'at-2');
    assert.deepEqual(h.storage.value(), { refreshToken: 'rt-2', email: 'u@example.com' });
  });

  it('ログイン成功でトークンを保存し、期限の5分前に自動更新を予約する', async () => {
    const h = harness({ results: [{ ok: true, session: session(2, NOW + 7200_000) }] });
    await h.controller.restore();
    h.controller.signedIn(session(1));
    await h.flush();
    assert.deepEqual(h.storage.value(), { refreshToken: 'rt-1', email: 'u@example.com' });
    const t = h.activeTimer();
    assert.equal(t?.ms, 3600_000 - REFRESH_BEFORE_MS);
    t!.fn();
    await h.flush();
    assert.equal(h.controller.getSession()?.accessToken, 'at-2');
    assert.equal(h.storage.value()?.refreshToken, 'rt-2');
  });

  it('401 のときは1回だけ更新し、成功すれば続行できる', async () => {
    const h = harness({ results: [{ ok: true, session: session(2) }] });
    await h.controller.restore();
    h.controller.signedIn(session(1));
    assert.equal(await h.controller.handleUnauthorized(), true);
    assert.equal(h.controller.getSession()?.accessToken, 'at-2');
  });

  it('同時に届いた 401 でも更新は1回にまとめる', async () => {
    const h = harness({ results: [{ ok: true, session: session(2) }] });
    await h.controller.restore();
    h.controller.signedIn(session(1));
    const [a, b] = await Promise.all([h.controller.handleUnauthorized(), h.controller.handleUnauthorized()]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(h.refreshCalls.length, 1);
  });

  it('401 で更新も無効ならログアウトし、保存も消す', async () => {
    const h = harness({ results: [{ ok: false, kind: 'invalid', devDetail: '400' }] });
    await h.controller.restore();
    h.controller.signedIn(session(1));
    assert.equal(await h.controller.handleUnauthorized(), false);
    await h.flush();
    assert.equal(h.controller.getSession(), null);
    assert.equal(h.storage.value(), null);
  });

  it('401 で更新が通信エラーなら画面上は未ログインだが、保存は残して前面復帰で復元する', async () => {
    const h = harness({ results: [{ ok: false, kind: 'network', devDetail: 'offline' }, { ok: true, session: session(3) }] });
    await h.controller.restore();
    h.controller.signedIn(session(1));
    await h.flush();
    assert.equal(await h.controller.handleUnauthorized(), false);
    await h.flush();
    assert.equal(h.controller.getSession(), null);
    assert.equal(h.storage.value()?.refreshToken, 'rt-1');
    await h.controller.onForeground();
    assert.equal(h.controller.getSession()?.accessToken, 'at-3');
  });

  it('前面復帰: 期限が近ければ更新、余裕があれば何もしない', async () => {
    const h = harness({ results: [{ ok: true, session: session(2) }] });
    await h.controller.restore();
    h.controller.signedIn(session(1));
    await h.controller.onForeground();
    assert.equal(h.refreshCalls.length, 0);
    h.advance(3600_000 - REFRESH_BEFORE_MS + 1);
    await h.controller.onForeground();
    assert.deepEqual(h.refreshCalls, ['rt-1']);
  });

  it('ログアウトで保存を消し、予約した更新も止め、サーバー側のセッションも無効にする', async () => {
    const h = harness();
    await h.controller.restore();
    h.controller.signedIn(session(1));
    await h.controller.signOut();
    await h.flush();
    assert.equal(h.controller.getSession(), null);
    assert.equal(h.storage.value(), null);
    assert.equal(h.activeTimer(), undefined);
    assert.deepEqual(h.logouts, ['at-1']);
  });
});
