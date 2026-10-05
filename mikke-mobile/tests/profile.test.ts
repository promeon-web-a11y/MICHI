/// <reference types="node" />
// v3.0 マイページ・設定（public.users）と今月のルート生成回数の単体テスト
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchGenerationUsage,
  fetchProfile,
  toGenerationUsage,
  toProfile,
  toProfileRow,
  updateProfile,
  validateProfilePatch,
} from '../src/profile/profile-client';
import type { FetchLike } from '../src/services/backend';
import { fetchAcceptedPlans, todayPlanQueries } from '../src/today/today-plan-client';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: UID })).toString('base64url')}.y`;

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

const ROW = { display_name: ' さっぽろ散歩 ', home_area: '円山', show_posts_in_feed: false, notify_weekend_hints: true, notify_saved_updates: false };

describe('プロフィール', () => {
  it('行の読み取り（空白は除く・列が無い場合は既定値）', () => {
    assert.deepEqual(toProfile(ROW), {
      displayName: 'さっぽろ散歩',
      homeArea: '円山',
      showPostsInFeed: false,
      notifyWeekendHints: true,
      notifySavedUpdates: false,
    });
    const legacy = toProfile({ display_name: null, home_area: '' })!;
    assert.equal(legacy.displayName, null);
    assert.equal(legacy.homeArea, null);
    assert.equal(legacy.showPostsInFeed, true, 'migration 前は「表示する」扱い');
  });

  it('入力の検証と送る列', () => {
    assert.ok(validateProfilePatch({ displayName: '  ' }));
    assert.ok(validateProfilePatch({ displayName: 'あ'.repeat(21) }));
    assert.equal(validateProfilePatch({ displayName: '散歩好き' }), null);
    assert.ok(validateProfilePatch({ homeArea: 'あ'.repeat(21) }));
    assert.deepEqual(toProfileRow({ displayName: ' A ', showPostsInFeed: false }), { display_name: 'A', show_posts_in_feed: false });
  });

  it('取得・保存は本人の行（JWT の sub）だけを指定し、RLS に任せる', async () => {
    const g = fakeFetch(200, [ROW]);
    const r = await fetchProfile({ config: CONFIG, accessToken: TOKEN, fetchImpl: g.impl });
    assert.ok(r.ok);
    assert.ok(g.calls[0].url.includes(`users?select=`) && g.calls[0].url.endsWith(`&id=eq.${UID}`));
    const u = fakeFetch(200, [{ ...ROW, home_area: '大通' }]);
    const saved = await updateProfile({ homeArea: '大通' }, { config: CONFIG, accessToken: TOKEN, fetchImpl: u.impl });
    assert.ok(saved.ok && saved.data.homeArea === '大通');
    assert.equal(u.calls[0].method, 'PATCH');
    assert.equal(u.calls[0].headers?.Prefer, 'return=representation');
    assert.deepEqual(JSON.parse(u.calls[0].body!), { home_area: '大通' });
    const invalid = await updateProfile({ displayName: '' }, { config: CONFIG, accessToken: TOKEN, fetchImpl: u.impl });
    assert.equal(invalid.ok ? 'ok' : invalid.kind, 'invalid');
    assert.equal(u.calls.length, 1);
  });
});

describe('今月のルート生成回数', () => {
  it('上限が未確定（null）なら残り回数も null（固定の数字を出さない）', () => {
    assert.deepEqual(toGenerationUsage({ used: 2, monthly_limit: null, remaining: null, period_end: '2026-10-01T00:00:00+09:00' }), {
      used: 2,
      monthlyLimit: null,
      remaining: null,
      periodEnd: '2026-10-01T00:00:00+09:00',
    });
    assert.equal(toGenerationUsage({ used: 1, monthly_limit: 5, remaining: 4 })!.remaining, 4);
    assert.equal(toGenerationUsage({}), null);
  });

  it('サーバーの RPC を呼ぶ', async () => {
    const f = fakeFetch(200, { used: 0, monthly_limit: null, remaining: null });
    const r = await fetchGenerationUsage({ config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.ok(r.ok && r.data.used === 0);
    assert.ok(f.calls[0].url.endsWith('/rest/v1/rpc/get_plan_generation_usage'));
  });
});

describe('保存一覧「ルート」', () => {
  it('採用済みプランを新しい順に取得（user_id は送らない）', async () => {
    const f = fakeFetch(200, [
      { id: 'p1', accepted_at: '2026-09-28T01:00:00Z', title: '円山さんぽ', source: 'mobile_plan_options' },
      { id: 'p2', accepted_at: '2026-09-27T01:00:00Z', title: null, source: 'mobile_route_copy' },
      { broken: true },
    ]);
    const r = await fetchAcceptedPlans({ config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });
    assert.equal(r.status, 'ok');
    if (r.status === 'ok') {
      assert.deepEqual(r.plans.map((p) => p.title), ['円山さんぽ', '今日のルート']);
    }
    assert.ok(f.calls[0].url.includes('status=eq.accepted') && f.calls[0].url.includes('order=accepted_at.desc'));
    assert.ok(!f.calls[0].url.includes('user_id'));
  });

  it('今日のプランには「同じ順番で行く」で作ったプランも含む', () => {
    const q = decodeURIComponent(todayPlanQueries('x').plan);
    assert.ok(q.includes('source:condition_json->>source'));
    assert.ok(q.includes('condition_json->>source=in.(mobile_plan_options,mobile_route_copy)'));
  });
});

describe('サーバー更新前（migration 未適用）', () => {
  it('新しい列が無ければ、表示名・地域だけ読み直す', async () => {
    const calls: string[] = [];
    const impl: FetchLike = async (url) => {
      calls.push(url);
      if (calls.length === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ code: '42703', message: 'column users.show_posts_in_feed does not exist' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify([{ display_name: 'A', home_area: '円山' }]) };
    };
    const r = await fetchProfile({ config: CONFIG, accessToken: TOKEN, fetchImpl: impl });
    assert.ok(r.ok && r.data.homeArea === '円山' && r.data.showPostsInFeed === true);
    assert.equal(calls.length, 2);
  });

  it('RPC が無い（PGRST202）は「準備中」と伝え、見つからない扱いにしない', async () => {
    const impl: FetchLike = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.get_plan_generation_usage' }) });
    const r = await fetchGenerationUsage({ config: CONFIG, accessToken: TOKEN, fetchImpl: impl });
    assert.ok(!r.ok && r.kind === 'server' && r.message.includes('準備中'));
  });
});
