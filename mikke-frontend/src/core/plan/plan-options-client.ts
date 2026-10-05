/**
 * Step 4-5: PlanConditions → generate-plan-options Edge Function（A/B/C プラン）と、プランの選択（accept_plan RPC）。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * - OpenAI キーはサーバー側のみ。モバイルは Supabase の URL / anon key とユーザーの JWT だけを使う
 * - user_id は送らない（サーバーが JWT → auth.uid() で確定）
 */
import {
  fetchWithTimeout,
  isAbortError,
  resolveBackend,
  type BackendConfig,
  type FetchLike,
} from '../services/backend';

import type { PlanConditions } from './plan-conditions';

export type PlanOptionItem = {
  order: number;
  place_id: string;
  place_name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** 到着の目安（直線距離からの概算で計算）。時刻表ではない */
  estimated_arrival_at: string;
  estimated_stay_minutes: number;
  /** この場所の前の移動の目安（分）。経路・所要時間としては表示しない */
  travel_buffer_minutes: number;
  reason: string;
  hours_status: 'confirmed_open' | 'unknown';
  price_band: string;
};

export type BudgetStatus = 'estimated' | 'partial' | 'unknown';

export type PlanOption = {
  plan_id: string;
  variant: 'A' | 'B' | 'C';
  title: string;
  concept: string;
  summary: string;
  estimated_start_at: string;
  estimated_end_at: string;
  estimated_total_minutes: number;
  travel_buffer_minutes: number;
  estimated_budget_yen: number | null;
  budget_status: BudgetStatus;
  within_budget: boolean | null;
  items: PlanOptionItem[];
};

export type PlanOptionsResponse = {
  set_id: string;
  generated_at: string;
  plan_count: number;
  candidate_count: number;
  search_radius_km: number;
  notice: 'few_candidates' | 'partial' | null;
  plans: PlanOption[];
};

export type PlanOptionsErrorKind =
  | 'config'
  | 'unauthorized'
  | 'invalid_request'
  | 'no_saved_places'
  | 'no_candidates'
  | 'generation_failed'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response';

export type PlanOptionsResult =
  | { ok: true; data: PlanOptionsResponse }
  | { ok: false; kind: PlanOptionsErrorKind; message: string; retryable: boolean; devDetail: string };

/** 利用者向けの文言（技術的なエラー文字列は見せない） */
export const PLAN_ERROR_MESSAGES: Record<PlanOptionsErrorKind, string> = {
  config: 'アプリの接続設定が不足しています。',
  unauthorized: 'ログインが必要です。ログインしてからもう一度お試しください。',
  invalid_request: '条件を確認して、もう一度お試しください。',
  no_saved_places: 'まだ保存した場所がありません。SNS で見つけた場所を Mikke に保存してから試してみてください。',
  no_candidates:
    'この条件で行けそうな保存場所が見つかりませんでした。使える時間を長くするか、移動手段を増やしてみてください。',
  generation_failed: 'うまくプランを作れませんでした。もう一度お試しください。',
  server: 'いまプランを作れませんでした。少し時間をおいてもう一度お試しください。',
  network: 'ネットワークに接続できませんでした。通信環境を確認してもう一度お試しください。',
  timeout: 'プランづくりに時間がかかっています。もう一度お試しください。',
  invalid_response: 'うまくプランを作れませんでした。もう一度お試しください。',
};

const RETRYABLE: Record<PlanOptionsErrorKind, boolean> = {
  config: false,
  unauthorized: false,
  invalid_request: false,
  no_saved_places: false,
  no_candidates: false,
  generation_failed: true,
  server: true,
  network: true,
  timeout: true,
  invalid_response: true,
};

/** サーバーは AI を最大2回呼ぶ（各30秒）ため、それより長く待つ */
export const GENERATE_TIMEOUT_MS = 75_000;
const ACCEPT_TIMEOUT_MS = 15_000;

function fail(kind: PlanOptionsErrorKind, devDetail: string): PlanOptionsResult {
  return { ok: false, kind, message: PLAN_ERROR_MESSAGES[kind], retryable: RETRYABLE[kind], devDetail };
}

const VARIANTS = ['A', 'B', 'C'];

/** 応答の形を確認する（壊れた応答で画面を落とさない） */
export function isPlanOptionsResponse(value: unknown): value is PlanOptionsResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.plans) || v.plans.length < 1 || v.plans.length > 3) return false;
  const seen = new Set<string>();
  for (const p of v.plans as Record<string, unknown>[]) {
    if (!p || typeof p.plan_id !== 'string' || !VARIANTS.includes(p.variant as string) || seen.has(p.variant as string)) return false;
    seen.add(p.variant as string);
    if (typeof p.title !== 'string' || !Array.isArray(p.items) || p.items.length < 1) return false;
    for (const item of p.items as Record<string, unknown>[]) {
      if (!item || typeof item.place_id !== 'string' || typeof item.place_name !== 'string') return false;
    }
  }
  return true;
}

function kindForError(status: number, code: string | null): PlanOptionsErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (code === 'no_saved_places') return 'no_saved_places';
  if (code === 'no_candidates') return 'no_candidates';
  if (code === 'ai_generation_failed' || code === 'ai_output_failed_validation') return 'generation_failed';
  if (status === 400) return 'invalid_request';
  return 'server';
}

/**
 * v3「今日向けに調整」: 公開ルートの場所だけを候補にする（generate-plan-options の place_ids）。
 * 省略時は従来どおり保存した場所すべてから考える
 */
export type PlanGenerationExtra = { placeIds?: string[]; basedOnRoutePostId?: string };

export async function callGeneratePlanOptions(
  conditions: PlanConditions,
  options: {
    config: BackendConfig;
    accessToken: string | null;
    generationSequence?: number;
    extra?: PlanGenerationExtra | null;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }
): Promise<PlanOptionsResult> {
  const backend = resolveBackend(options.config);
  if (!backend) return fail('config', 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定または不正');
  if (!options.accessToken) return fail('unauthorized', 'access token がありません（未ログイン）');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? GENERATE_TIMEOUT_MS;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/functions/v1/generate-plan-options`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify({
          conditions,
          generation_sequence: options.generationSequence ?? 1,
          ...(options.extra?.placeIds?.length ? { place_ids: options.extra.placeIds } : {}),
          ...(options.extra?.basedOnRoutePostId ? { based_on_route_post_id: options.extra.basedOnRoutePostId } : {}),
        }),
      },
      timeoutMs
    );
  } catch (e) {
    if (isAbortError(e)) return fail('timeout', `generate-plan-options が ${timeoutMs}ms 以内に応答しませんでした`);
    return fail('network', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }

  let text = '';
  try {
    text = await response.text();
  } catch (e) {
    return fail('network', `本文の読み取りに失敗: ${String(e)}`);
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 下で扱う
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null;
    return fail(kindForError(response.status, code), `HTTP ${response.status} ${code ?? text.slice(0, 120)}`);
  }
  if (!isPlanOptionsResponse(body)) return fail('invalid_response', `想定外の応答: ${text.slice(0, 120)}`);
  return { ok: true, data: body };
}

export type AcceptResult =
  | { ok: true }
  | { ok: false; kind: 'unauthorized' | 'not_found' | 'network' | 'server' | 'config'; message: string; devDetail: string };

const ACCEPT_MESSAGES = {
  config: 'アプリの接続設定が不足しています。',
  unauthorized: 'ログインが必要です。',
  not_found: 'このプランは選べませんでした。プランを作り直してください。',
  network: 'ネットワークに接続できませんでした。もう一度お試しください。',
  server: 'プランを選べませんでした。もう一度お試しください。',
} as const;

/** 既存の accept_plan RPC（security definer / auth.uid()）でプランを選ぶ */
export async function acceptPlanOption(
  planId: string,
  options: { config: BackendConfig; accessToken: string | null; fetchImpl?: FetchLike }
): Promise<AcceptResult> {
  const failAccept = (kind: keyof typeof ACCEPT_MESSAGES, devDetail: string): AcceptResult => ({
    ok: false,
    kind,
    message: ACCEPT_MESSAGES[kind],
    devDetail,
  });
  const backend = resolveBackend(options.config);
  if (!backend) return failAccept('config', 'Supabase の設定がありません');
  if (!options.accessToken) return failAccept('unauthorized', '未ログイン');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/rest/v1/rpc/accept_plan`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify({ p_plan_id: planId }),
      },
      ACCEPT_TIMEOUT_MS
    );
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) return failAccept('unauthorized', `HTTP ${response.status}`);
    // accept_plan は対象が無い（他人のプラン含む）と P0002 plan_not_found_or_not_acceptable
    if (text.includes('P0002') || text.includes('plan_not_found')) return failAccept('not_found', `HTTP ${response.status}`);
    return failAccept('server', `HTTP ${response.status} ${text.slice(0, 120)}`);
  } catch (e) {
    return failAccept('network', isAbortError(e) ? 'timeout' : String(e));
  }
}
