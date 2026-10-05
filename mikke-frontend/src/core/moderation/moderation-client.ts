/**
 * 通報・ブロックの API（mikke-supabase-backend 202609290009）。React / expo に依存しない（Node で単体テスト）。
 *
 * - 相手の user_id はアプリに渡さない。ユーザーの通報・ブロックは、その人の投稿（postId）かコメント（commentId）で指定する
 * - 通報は content_reports に記録され、運営が SQL Editor で確認・対処する（docs/moderation-runbook.md）
 * - 通報した投稿・コメントは、通報した本人には表示されなくなる。ブロックするとお互いの投稿・コメントが表示されなくなる
 */
import { apiFail, rpc, str, type ApiOptions, type ApiResult } from '../services/rest';

export type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'privacy' | 'other';

export const REPORT_REASONS: readonly { value: ReportReason; label: string }[] = [
  { value: 'spam', label: '宣伝・スパム' },
  { value: 'harassment', label: '嫌がらせ・誹謗中傷' },
  { value: 'inappropriate', label: '性的・暴力的など不適切' },
  { value: 'privacy', label: '個人情報・無断撮影' },
  { value: 'other', label: 'その他' },
];

export const MAX_REPORT_DETAIL = 500;

/** 通報・ブロックの対象。コメントなら commentId、投稿なら postId */
export type UgcTarget = { postId: string; commentId?: string | null };

export type ReportTargetType = 'post' | 'comment' | 'user';

function targetArgs(t: UgcTarget) {
  return t.commentId ? { p_post_id: null, p_comment_id: t.commentId } : { p_post_id: t.postId, p_comment_id: null };
}

export async function reportContent(
  type: ReportTargetType,
  target: UgcTarget,
  reason: ReportReason,
  detail: string,
  opts: ApiOptions
): Promise<ApiResult<{ id: string; alreadyReported: boolean }>> {
  if (type === 'comment' && !target.commentId) return apiFail('invalid', 'comment target without commentId');
  if (!REPORT_REASONS.some((r) => r.value === reason)) return apiFail('invalid', 'reason', '通報の理由を選んでください。');
  const trimmed = detail.trim();
  if (trimmed.length > MAX_REPORT_DETAIL) return apiFail('invalid', 'detail', `詳しい内容は${MAX_REPORT_DETAIL}文字以内にしてください。`);
  // 投稿の通報はコメントを含めない（サーバーが post + comment を不正とする）
  const args = type === 'post' ? { p_post_id: target.postId, p_comment_id: null } : targetArgs(target);
  const r = await rpc('report_route_content', { p_target_type: type, p_reason: reason, ...args, p_detail: trimmed || null }, opts);
  if (!r.ok) return r;
  const v = (r.data ?? {}) as Record<string, unknown>;
  const id = str(v.id);
  return id ? { ok: true, data: { id, alreadyReported: v.already_reported === true } } : apiFail('server', '想定外の応答: report_route_content');
}

export async function blockUser(target: UgcTarget, opts: ApiOptions): Promise<ApiResult<{ name: string }>> {
  const r = await rpc('block_user', targetArgs(target), opts);
  if (!r.ok) return r;
  const v = (r.data ?? {}) as Record<string, unknown>;
  return v.blocked === true ? { ok: true, data: { name: str(v.name) ?? 'Mikke ユーザー' } } : apiFail('server', '想定外の応答: block_user');
}

export type BlockedUser = { id: string; name: string; blockedAt: string | null };

export async function listBlockedUsers(opts: ApiOptions): Promise<ApiResult<BlockedUser[]>> {
  const r = await rpc('list_blocked_users', {}, opts);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return apiFail('server', '想定外の応答: list_blocked_users');
  const out: BlockedUser[] = [];
  for (const row of r.data) {
    const v = (row ?? {}) as Record<string, unknown>;
    const id = str(v.id);
    if (id) out.push({ id, name: str(v.name) ?? 'Mikke ユーザー', blockedAt: str(v.blocked_at) });
  }
  return { ok: true, data: out };
}

export async function unblockUser(blockId: string, opts: ApiOptions): Promise<ApiResult<null>> {
  const r = await rpc('unblock_user', { p_block_id: blockId }, opts);
  return r.ok ? { ok: true, data: null } : r;
}
