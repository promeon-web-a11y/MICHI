/**
 * v3 マイページ・設定: 本人のプロフィール（public.users）と今月のルート生成回数。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * - 表示名・よく行く地域は既存列 display_name / home_area。投稿の表示・通知は 202609280008 で追加した列
 * - 読み書きはユーザー JWT + RLS（users_select_own / users_update_own、更新できる列も GRANT で限定）
 * - 生成回数はサーバーの get_plan_generation_usage が正本。無料枠の上限は未確定のため null のことがある
 */
import { jwtSubject } from '../auth/jwt';
import { apiFail, bool, num, restRequest, rpc, str, type ApiOptions, type ApiResult } from '../services/rest';

export type Profile = {
  displayName: string | null;
  homeArea: string | null;
  showPostsInFeed: boolean;
  notifyWeekendHints: boolean;
  notifySavedUpdates: boolean;
};

export type ProfilePatch = Partial<Profile>;

export const PROFILE_SELECT = 'display_name,home_area,show_posts_in_feed,notify_weekend_hints,notify_saved_updates';
/** 202609280008 より前の DB でも表示名・地域は読めるようにする */
export const LEGACY_PROFILE_SELECT = 'display_name,home_area';
export const DISPLAY_NAME_MAX = 20;
export const HOME_AREA_MAX = 20;

/** 「よく行く地域」の候補（自由入力もできる） */
export const AREA_PRESETS = ['札幌', '円山', '大通', '札幌駅', 'すすきの', '中島公園'] as const;

export function toProfile(row: unknown): Profile | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  return {
    displayName: str(typeof r.display_name === 'string' ? r.display_name.trim() : null),
    homeArea: str(typeof r.home_area === 'string' ? r.home_area.trim() : null),
    // 列が無い（migration 未適用）場合も既定値で表示できるようにする
    showPostsInFeed: r.show_posts_in_feed === undefined ? true : bool(r.show_posts_in_feed),
    notifyWeekendHints: bool(r.notify_weekend_hints),
    notifySavedUpdates: bool(r.notify_saved_updates),
  };
}

export function validateProfilePatch(patch: ProfilePatch): string | null {
  if (patch.displayName !== undefined) {
    const v = (patch.displayName ?? '').trim();
    if (!v) return '表示名を入力してください。';
    if (v.length > DISPLAY_NAME_MAX) return `表示名は${DISPLAY_NAME_MAX}文字以内にしてください。`;
  }
  if (patch.homeArea !== undefined && patch.homeArea !== null) {
    const v = patch.homeArea.trim();
    if (!v) return '地域を入力してください。';
    if (v.length > HOME_AREA_MAX) return `地域は${HOME_AREA_MAX}文字以内にしてください。`;
  }
  return null;
}

export function toProfileRow(patch: ProfilePatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.displayName !== undefined) row.display_name = patch.displayName?.trim() || null;
  if (patch.homeArea !== undefined) row.home_area = patch.homeArea?.trim() || null;
  if (patch.showPostsInFeed !== undefined) row.show_posts_in_feed = patch.showPostsInFeed;
  if (patch.notifyWeekendHints !== undefined) row.notify_weekend_hints = patch.notifyWeekendHints;
  if (patch.notifySavedUpdates !== undefined) row.notify_saved_updates = patch.notifySavedUpdates;
  return row;
}

export async function fetchProfile(opts: ApiOptions): Promise<ApiResult<Profile>> {
  const uid = jwtSubject(opts.accessToken);
  if (!uid) return apiFail('unauthorized', 'no sub');
  let r = await restRequest(`users?select=${encodeURIComponent(PROFILE_SELECT)}&id=eq.${uid}`, opts);
  if (!r.ok && r.devDetail.includes('not_ready:42703')) {
    r = await restRequest(`users?select=${encodeURIComponent(LEGACY_PROFILE_SELECT)}&id=eq.${uid}`, opts);
  }
  if (!r.ok) return r;
  const profile = Array.isArray(r.data) ? toProfile(r.data[0]) : null;
  return profile ? { ok: true, data: profile } : apiFail('not_found', 'users row missing');
}

export async function updateProfile(patch: ProfilePatch, opts: ApiOptions): Promise<ApiResult<Profile>> {
  const invalid = validateProfilePatch(patch);
  if (invalid) return apiFail('invalid', 'validation', invalid);
  const uid = jwtSubject(opts.accessToken);
  if (!uid) return apiFail('unauthorized', 'no sub');
  const r = await restRequest(`users?id=eq.${uid}&select=${encodeURIComponent(PROFILE_SELECT)}`, {
    ...opts,
    method: 'PATCH',
    body: toProfileRow(patch),
    prefer: 'return=representation',
  });
  if (!r.ok) return r;
  const profile = Array.isArray(r.data) ? toProfile(r.data[0]) : null;
  return profile ? { ok: true, data: profile } : apiFail('server', 'no row returned');
}

export type GenerationUsage = {
  used: number;
  /** 無料枠の上限。未確定なら null（残り回数は表示しない） */
  monthlyLimit: number | null;
  remaining: number | null;
  periodEnd: string | null;
};

export function toGenerationUsage(value: unknown): GenerationUsage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const used = num(v.used);
  if (used === null) return null;
  const limit = num(v.monthly_limit);
  return { used, monthlyLimit: limit, remaining: limit === null ? null : num(v.remaining), periodEnd: str(v.period_end) };
}

export async function fetchGenerationUsage(opts: ApiOptions): Promise<ApiResult<GenerationUsage>> {
  const r = await rpc('get_plan_generation_usage', {}, opts);
  if (!r.ok) return r;
  const usage = toGenerationUsage(r.data);
  return usage ? { ok: true, data: usage } : apiFail('server', 'invalid usage');
}
