/// <reference types="node" />
// v3.0 通報・ブロック、いいね・行きたいの状態指定、使われていない写真の片付け、業務エラーの文言の単体テスト
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blockUser, listBlockedUsers, reportContent, unblockUser } from '../src/moderation/moderation-client';
import { cleanupRoutePhotos, removeRoutePhotos, toggleRouteReaction, toRouteCard } from '../src/routes/route-posts-client';
import { classifyHttpError, CODE_MESSAGES, restRequest } from '../src/services/rest';
import type { FetchLike } from '../src/services/backend';

const CONFIG = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-public-key' };
const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url')}.y`;

type Call = { url: string; method?: string; body?: string };
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}
const opts = (f: ReturnType<typeof fakeFetch>) => ({ config: CONFIG, accessToken: TOKEN, fetchImpl: f.impl });

describe('通報', () => {
  it('投稿の通報は post_id だけを送り、コメントの通報は comment_id だけを送る（相手の user_id は扱わない）', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'r1', already_reported: false } }]);
    const post = await reportContent('post', { postId: 'p1', commentId: 'c1' }, 'spam', '  宣伝  ', opts(f));
    assert.ok(post.ok);
    assert.deepEqual(post.data, { id: 'r1', alreadyReported: false });
    assert.ok(f.calls[0].url.endsWith('/rest/v1/rpc/report_route_content'));
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_target_type: 'post', p_reason: 'spam', p_post_id: 'p1', p_comment_id: null, p_detail: '宣伝' });

    await reportContent('comment', { postId: 'p1', commentId: 'c1' }, 'harassment', '', opts(f));
    assert.deepEqual(JSON.parse(f.calls[1].body!), { p_target_type: 'comment', p_reason: 'harassment', p_post_id: null, p_comment_id: 'c1', p_detail: null });

    await reportContent('user', { postId: 'p1', commentId: 'c1' }, 'other', '', opts(f));
    assert.deepEqual(JSON.parse(f.calls[2].body!), { p_target_type: 'user', p_reason: 'other', p_post_id: null, p_comment_id: 'c1', p_detail: null });
    for (const c of f.calls) assert.doesNotMatch(c.body!, /user_id/);
  });

  it('入力の誤りは送らない', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const long = await reportContent('post', { postId: 'p1' }, 'spam', 'あ'.repeat(501), opts(f));
    assert.equal(long.ok ? 'ok' : long.kind, 'invalid');
    const noComment = await reportContent('comment', { postId: 'p1' }, 'spam', '', opts(f));
    assert.equal(noComment.ok ? 'ok' : noComment.kind, 'invalid');
    const badReason = await reportContent('post', { postId: 'p1' }, 'nope' as never, '', opts(f));
    assert.equal(badReason.ok ? 'ok' : badReason.kind, 'invalid');
    assert.equal(f.calls.length, 0);
  });

  it('二重通報は alreadyReported、サーバーの業務エラーは画面用の文言になる', async () => {
    const dup = await reportContent('post', { postId: 'p1' }, 'spam', '', opts(fakeFetch([{ status: 200, body: { id: 'r1', already_reported: true } }])));
    assert.ok(dup.ok && dup.data.alreadyReported);
    const own = await reportContent('post', { postId: 'p1' }, 'spam', '', opts(fakeFetch([{ status: 400, body: { code: '22023', message: 'invalid_report_own_content' } }])));
    assert.deepEqual(own.ok ? null : [own.kind, own.message], ['invalid', CODE_MESSAGES.invalid_report_own_content]);
    const many = await reportContent('post', { postId: 'p1' }, 'spam', '', opts(fakeFetch([{ status: 400, body: { code: '22023', message: 'invalid_report_too_many' } }])));
    assert.equal(many.ok ? null : many.message, CODE_MESSAGES.invalid_report_too_many);
    const gone = await reportContent('post', { postId: 'p1' }, 'spam', '', opts(fakeFetch([{ status: 400, body: { code: 'P0002', message: 'route_content_not_found' } }])));
    assert.deepEqual(gone.ok ? null : [gone.kind, gone.message], ['not_found', CODE_MESSAGES.route_content_not_found]);
  });
});

describe('ブロック', () => {
  it('投稿またはコメントで相手を指定し、一覧・解除はブロックの id で行う', async () => {
    const f = fakeFetch([
      { status: 200, body: { blocked: true, name: 'Aさん' } },
      { status: 200, body: [{ id: 'b1', name: 'Aさん', blocked_at: '2026-09-29T00:00:00Z' }, { name: 'id なしは落とす' }] },
      { status: 200, body: true },
    ]);
    const b = await blockUser({ postId: 'p1', commentId: 'c9' }, opts(f));
    assert.deepEqual(b.ok ? b.data : null, { name: 'Aさん' });
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_post_id: null, p_comment_id: 'c9' });
    const list = await listBlockedUsers(opts(f));
    assert.deepEqual(list.ok ? list.data : null, [{ id: 'b1', name: 'Aさん', blockedAt: '2026-09-29T00:00:00Z' }]);
    const u = await unblockUser('b1', opts(f));
    assert.ok(u.ok);
    assert.deepEqual(JSON.parse(f.calls[2].body!), { p_block_id: 'b1' });
  });

  it('自分はブロックできない（サーバーのエラーを文言にする）', async () => {
    const r = await blockUser({ postId: 'p1' }, opts(fakeFetch([{ status: 400, body: { code: '22023', message: 'invalid_block_self' } }])));
    assert.equal(r.ok ? null : r.message, CODE_MESSAGES.invalid_block_self);
  });
});

describe('投稿停止中', () => {
  it('account_restricted（HTTP 403）は権限エラーではなく、制限中の文言にする', async () => {
    assert.equal(classifyHttpError(403, { code: '42501', message: 'account_restricted' }, '').kind, 'invalid');
    const r = await restRequest('rpc/add_route_comment', { ...opts(fakeFetch([{ status: 403, body: { code: '42501', message: 'account_restricted' } }])), method: 'POST', body: {} });
    assert.equal(r.ok ? null : r.message, CODE_MESSAGES.account_restricted);
  });

  it('運営が非表示にした自分の投稿はカードで分かる', () => {
    assert.equal(toRouteCard({ id: 'p1', title: 't', hidden_by_moderation: true })?.hiddenByModeration, true);
    assert.equal(toRouteCard({ id: 'p1', title: 't' })?.hiddenByModeration, false);
  });
});

describe('いいね・行きたい', () => {
  it('押した時点の状態から決めた active を送る（連打・二重送信でも同じ結果）', async () => {
    const f = fakeFetch([{ status: 200, body: { kind: 'like', active: true, like_count: 1, wish_count: 0 } }]);
    const r = await toggleRouteReaction('p1', 'like', opts(f), true);
    assert.ok(r.ok && r.data.active);
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_post_id: 'p1', p_kind: 'like', p_active: true });
  });
});

describe('使われていない写真の片付け', () => {
  it('100件ずつ Storage API で消し、失敗があれば false', async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `u/p/${i}.jpg`);
    const f = fakeFetch([{ status: 200, body: [] }]);
    assert.equal(await removeRoutePhotos(paths, opts(f)), true);
    assert.deepEqual(f.calls.map((c) => JSON.parse(c.body!).prefixes.length), [100, 100, 50]);
    assert.ok(f.calls.every((c) => c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/route-photos')));

    const g = fakeFetch([{ status: 200, body: [] }, { status: 500, body: {} }]);
    assert.equal(await removeRoutePhotos(paths.slice(0, 150), opts(g)), false);
    assert.equal(await removeRoutePhotos([], opts(g)), true);
  });

  it('サーバーが返した未使用の写真だけを消す', async () => {
    const f = fakeFetch([{ status: 200, body: ['u/p1/old.jpg', 3, null] }, { status: 200, body: [] }]);
    assert.equal(await cleanupRoutePhotos('p1', opts(f)), 1);
    assert.deepEqual(JSON.parse(f.calls[0].body!), { p_post_id: 'p1' });
    assert.ok(f.calls[0].url.endsWith('/rest/v1/rpc/list_unused_route_photos'));
    assert.deepEqual(JSON.parse(f.calls[1].body!), { prefixes: ['u/p1/old.jpg'] });

    const none = fakeFetch([{ status: 200, body: [] }]);
    assert.equal(await cleanupRoutePhotos(null, opts(none)), 0);
    assert.deepEqual(JSON.parse(none.calls[0].body!), {});
    assert.equal(none.calls.length, 1, '無ければ Storage を呼ばない');

    const notReady = fakeFetch([{ status: 404, body: { code: 'PGRST202', message: 'not found' } }]);
    assert.equal(await cleanupRoutePhotos('p1', opts(notReady)), 0, 'サーバー未更新でも失敗させない');
  });
});
