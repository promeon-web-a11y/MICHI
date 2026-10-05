/**
 * アカウント削除（アプリ側）。実際の Supabase には接続しない（fetch・ストレージはモック）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  createAccountDeleter,
  DELETE_ACCOUNT_CONFIRM,
  DELETE_ACCOUNT_MESSAGES,
  requestAccountDeletion,
  type DeleteAccountCallResult,
} from '../src/auth/account-deletion';
import { createAuthController, type AuthStorage } from '../src/auth/auth-controller';
import type { RefreshResult, StoredAuth } from '../src/auth/auth-session';
import type { DevSession, FetchLike } from '../src/place/identify-place-client';

const config = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-test' };

type Call = { url: string; headers: Record<string, string>; body: any };
function mockFetch(status: number, body: unknown, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

const TECH_TERMS = /HTTP|JWT|Supabase|service_role|JSON|API|Edge|token|トークン/i;

describe('requestAccountDeletion', () => {
  it('本人のアクセストークンで delete-account を呼び、本文は確認用の固定値だけ（user_id を送らない）', async () => {
    const calls: Call[] = [];
    const r = await requestAccountDeletion({ config, accessToken: 'at-1', fetchImpl: mockFetch(200, { status: 'deleted', reason: 'account_deleted' }, calls) });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/delete-account');
    assert.equal(calls[0].headers.Authorization, 'Bearer at-1');
    assert.equal(calls[0].headers.apikey, 'anon-test');
    assert.deepEqual(calls[0].body, { confirm: DELETE_ACCOUNT_CONFIRM });
  });

  it('未ログインでは通信しない', async () => {
    const calls: Call[] = [];
    const r = await requestAccountDeletion({ config, accessToken: null, fetchImpl: mockFetch(200, {}, calls) });
    assert.equal(!r.ok && r.kind, 'unauthorized');
    assert.equal(calls.length, 0);
  });

  it('401 は unauthorized、500・想定外の本文・通信失敗は失敗', async () => {
    assert.equal((await requestAccountDeletion({ config, accessToken: 'a', fetchImpl: mockFetch(401, { status: 'unauthorized' }) })).ok, false);
    const r401 = await requestAccountDeletion({ config, accessToken: 'a', fetchImpl: mockFetch(401, 'Invalid JWT') });
    assert.equal(!r401.ok && r401.kind, 'unauthorized');
    const r500 = await requestAccountDeletion({ config, accessToken: 'a', fetchImpl: mockFetch(500, { status: 'error' }) });
    assert.equal(!r500.ok && r500.kind, 'error');
    const r200bad = await requestAccountDeletion({ config, accessToken: 'a', fetchImpl: mockFetch(200, 'ok') });
    assert.equal(r200bad.ok, false, '「deleted」と返らない限り成功扱いにしない');
    const rNet = await requestAccountDeletion({
      config,
      accessToken: 'a',
      fetchImpl: async () => {
        throw new TypeError('Network request failed');
      },
    });
    assert.equal(!rNet.ok && rNet.kind, 'network');
  });
});

describe('createAccountDeleter', () => {
  function harness(results: DeleteAccountCallResult[], options: { token?: string | null; refreshOk?: boolean } = {}) {
    let token: string | null = options.token === undefined ? 'at-1' : options.token;
    const requests: string[] = [];
    let deletedCalls = 0;
    let refreshes = 0;
    const pending: ((r: DeleteAccountCallResult) => void)[] = [];
    const deleter = createAccountDeleter({
      getAccessToken: () => token,
      request: async (t) => {
        requests.push(t);
        const next = results.shift();
        if (next) return next;
        return new Promise((resolve) => pending.push(resolve));
      },
      refreshAfterUnauthorized: async () => {
        refreshes++;
        if (options.refreshOk) token = 'at-2';
        else token = null;
        return !!options.refreshOk;
      },
      onDeleted: async () => {
        deletedCalls++;
      },
    });
    return { deleter, requests, pending, deletedCalls: () => deletedCalls, refreshes: () => refreshes };
  }

  it('成功したら後始末（端末のログイン情報の消去）を呼ぶ', async () => {
    const h = harness([{ ok: true }]);
    assert.deepEqual(await h.deleter.delete(), { status: 'deleted' });
    assert.equal(h.deletedCalls(), 1);
  });

  it('連打しても削除リクエストは1本だけ', async () => {
    const h = harness([]);
    const first = h.deleter.delete();
    const second = await h.deleter.delete();
    const third = await h.deleter.delete();
    assert.deepEqual([second.status, third.status], ['busy', 'busy']);
    assert.equal(h.requests.length, 1);
    assert.equal(h.deleter.isRunning(), true);
    h.pending[0]({ ok: true });
    assert.equal((await first).status, 'deleted');
    assert.equal(h.deleter.isRunning(), false);
    assert.equal(h.deletedCalls(), 1);
  });

  it('失敗したらセッションを消さず、利用者向けの文言を返す（技術用語なし）。やり直せる', async () => {
    const h = harness([{ ok: false, kind: 'error', devDetail: 'HTTP 500' }, { ok: true }]);
    const r = await h.deleter.delete();
    assert.equal(r.status, 'failed');
    if (r.status === 'failed') {
      assert.equal(r.message, DELETE_ACCOUNT_MESSAGES.failed);
      assert.doesNotMatch(r.message, TECH_TERMS);
    }
    assert.equal(h.deletedCalls(), 0);
    assert.equal((await h.deleter.delete()).status, 'deleted');
  });

  it('401 のときは1回だけトークンを更新して再試行する', async () => {
    const h = harness([{ ok: false, kind: 'unauthorized', devDetail: '401' }, { ok: true }], { refreshOk: true });
    assert.equal((await h.deleter.delete()).status, 'deleted');
    assert.deepEqual(h.requests, ['at-1', 'at-2']);
    assert.equal(h.refreshes(), 1);
  });

  it('更新もできなければ再ログインを案内し、削除扱いにしない', async () => {
    const h = harness([{ ok: false, kind: 'unauthorized', devDetail: '401' }], { refreshOk: false });
    const r = await h.deleter.delete();
    assert.equal(r.status === 'failed' && r.message, DELETE_ACCOUNT_MESSAGES.needLogin);
    assert.doesNotMatch(DELETE_ACCOUNT_MESSAGES.needLogin, TECH_TERMS);
    assert.equal(h.requests.length, 1);
    assert.equal(h.deletedCalls(), 0);
  });

  it('未ログインではリクエストしない', async () => {
    const h = harness([], { token: null });
    assert.equal((await h.deleter.delete()).status, 'failed');
    assert.equal(h.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------

function memoryStorage(initial: StoredAuth | null) {
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

const session = (n: number): DevSession => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}`, email: 'u@example.com', expiresAt: Date.now() + 3600_000 });

describe('auth controller: アカウント削除後', () => {
  it('SecureStore の保存（リフレッシュトークン・メール）とメモリ上のセッションを消し、サーバーの logout は呼ばない', async () => {
    const storage = memoryStorage(null);
    const logouts: string[] = [];
    const timers: { cleared: boolean }[] = [];
    const c = createAuthController({
      storage,
      refresh: async () => ({ ok: false, kind: 'network', devDetail: '' }),
      logoutRemote: async (t) => {
        logouts.push(t);
      },
      setTimer: () => {
        const t = { cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    });
    await c.restore();
    c.signedIn(session(1));
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.value()?.refreshToken, 'rt-1');
    await c.accountDeleted();
    assert.equal(c.getSession(), null);
    assert.equal(storage.value(), null);
    assert.deepEqual(logouts, []);
    assert.ok(timers.every((t) => t.cleared), '予約していた自動更新も止める');
  });

  it('削除前に始まったトークン更新が後から成功しても、削除済みアカウントのセッションに戻らない', async () => {
    const storage = memoryStorage(null);
    let resolveRefresh!: (r: RefreshResult) => void;
    const c = createAuthController({
      storage,
      refresh: () => new Promise((resolve) => (resolveRefresh = resolve)),
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    await c.restore();
    c.signedIn(session(1));
    const refreshing = c.handleUnauthorized();
    await c.accountDeleted();
    resolveRefresh({ ok: true, session: session(2) });
    await refreshing;
    await new Promise((r) => setImmediate(r));
    assert.equal(c.getSession(), null);
    assert.equal(storage.value(), null);
  });

  it('起動時の復元中に削除が完了した場合も、復元結果で上書きしない', async () => {
    const storage = memoryStorage({ refreshToken: 'rt-0', email: null });
    let resolveRefresh!: (r: RefreshResult) => void;
    const c = createAuthController({
      storage,
      refresh: () => new Promise((resolve) => (resolveRefresh = resolve)),
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    const restoring = c.restore();
    await new Promise((r) => setImmediate(r));
    await c.accountDeleted();
    resolveRefresh({ ok: true, session: session(1) });
    await restoring;
    assert.equal(c.getSession(), null);
    assert.equal(c.getStatus(), 'ready');
  });
});

describe('モバイルのバンドルに秘密鍵を置かない', () => {
  it('アプリのソースに service role / 管理 API を使うコードがない', async () => {
    const { readdir } = await import('node:fs/promises');
    const files: string[] = [];
    async function walk(dir: string) {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    }
    await walk('src');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      assert.doesNotMatch(src, /SERVICE_ROLE|service_role|auth\/v1\/admin|auth\.admin/, f);
    }
  });
});
