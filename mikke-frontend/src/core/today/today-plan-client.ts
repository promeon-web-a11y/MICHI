/**
 * Step 4-8「今日のプラン」: 本人の accepted プランの取得と、スポットごとの訪問記録。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * - 取得はユーザー JWT + RLS（plans_all_own / plan_items_select_own / visits_all_own）。user_id は送らない
 * - 訪問記録は既存の answer_visit RPC（security definer）。visits は (user_id, plan_id) で1行で、
 *   visited_place_ids に行った場所を累積する。記録の直前にサーバーの最新値を読み直して足すので、
 *   同じ場所を二重に記録せず、別の端末で記録した場所も消さない
 * - メモリ上の状態に依存せず、アプリ再起動後も Supabase から復元できる
 */
import {
  fetchWithTimeout,
  isAbortError,
  resolveBackend,
  type BackendConfig,
  type FetchLike,
} from '../services/backend';

/** 「今日のプラン」とみなす範囲（accepted になってからの時間） */
export const TODAY_WINDOW_HOURS = 24;
const TIMEOUT_MS = 15_000;

export type TodayStop = {
  place_id: string;
  google_place_id: string | null;
  order: number;
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  stay_minutes: number;
  /** Step 4-5 で計算した到着予定（目安）。実ルートがあればそちらを優先して表示する */
  planned_arrival_at: string | null;
  reason: string;
  visited: boolean;
};

export type TodayPlan = {
  plan_id: string;
  /** mobile_plan_options（提案から選んだ）/ mobile_route_copy（みんなのルートの「同じ順番で行く」） */
  source: string | null;
  variant: string | null;
  title: string;
  concept: string | null;
  accepted_at: string;
  duration_minutes: number | null;
  budget_yen: number | null;
  places_budget_yen: number | null;
  budget_status: 'estimated' | 'partial' | 'unknown';
  transport_modes: string[];
  stops: TodayStop[];
  visited_place_ids: string[];
  visited_count: number;
  completed: boolean;
};

export type FetchTodayResult =
  | { status: 'ok'; plan: TodayPlan }
  | { status: 'none' }
  | { status: 'unauthorized' | 'error'; message: string; devDetail: string };

export type VisitResult =
  | { status: 'visited'; visited_place_ids: string[] }
  | { status: 'already_visited'; visited_place_ids: string[] }
  | {
      status: 'unauthorized' | 'plan_not_accepted' | 'not_in_plan' | 'error';
      message: string;
      devDetail: string;
    };

export const TODAY_MESSAGES = {
  load_error: '今日のプランを読み込めませんでした。',
  unauthorized: 'ログインが必要です。',
  visit_error: '記録できませんでした。通信環境を確認してもう一度お試しください。',
  plan_not_accepted: 'このプランは記録できない状態です。プランを確認してください。',
  not_in_plan: 'この場所はプランに含まれていないため記録できません。',
} as const;

// ---------------------------------------------------------------------------------------------

export function todayWindowStart(now: Date): string {
  return new Date(now.getTime() - TODAY_WINDOW_HOURS * 3_600_000).toISOString();
}

const PLAN_SELECT = [
  'id',
  'status',
  'accepted_at',
  'estimated_budget',
  'source:condition_json->>source',
  'variant:condition_json->option->>variant',
  'title:condition_json->option->>title',
  'concept:condition_json->option->>concept',
  'budget_status:condition_json->option->>budget_status',
  'duration_minutes:condition_json->duration_minutes',
  'budget_yen:condition_json->budget_yen',
  'transport_modes:condition_json->transport_modes',
].join(',');

/** PostgREST のクエリ。user_id は含めない（RLS で本人の行だけになる） */
export function todayPlanQueries(since: string) {
  const planSelect = PLAN_SELECT;
  return {
    plan:
      `plans?select=${encodeURIComponent(planSelect)}` +
      `&status=eq.accepted&condition_json->>source=in.(mobile_plan_options,mobile_route_copy)` +
      `&accepted_at=gte.${encodeURIComponent(since)}&order=accepted_at.desc&limit=1`,
    items: (planId: string) =>
      `plan_items?select=${encodeURIComponent('sequence,stay_minutes,start_at,selection_reason,places(id,name,category,address,latitude,longitude,provider,provider_place_id)')}` +
      `&plan_id=eq.${planId}&order=sequence.asc`,
    visits: (planId: string) => `visits?select=went,visited_place_ids,answered_at&plan_id=eq.${planId}`,
  };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** DB の行 → 表示用。壊れた行は落とす */
export function toTodayPlan(planRow: unknown, itemRows: unknown, visitRow: unknown): TodayPlan | null {
  if (!planRow || typeof planRow !== 'object') return null;
  const p = planRow as Record<string, any>;
  if (typeof p.id !== 'string' || p.status !== 'accepted' || typeof p.accepted_at !== 'string') return null;
  const visitedIds: string[] =
    visitRow && typeof visitRow === 'object' && Array.isArray((visitRow as any).visited_place_ids)
      ? (visitRow as any).visited_place_ids.filter((id: unknown) => typeof id === 'string')
      : [];
  const stops: TodayStop[] = [];
  for (const item of Array.isArray(itemRows) ? [...itemRows].sort((a: any, b: any) => a.sequence - b.sequence) : []) {
    const place = (item as any)?.places;
    if (!place || typeof place.id !== 'string') continue;
    stops.push({
      place_id: place.id,
      google_place_id: place.provider === 'google' && typeof place.provider_place_id === 'string' ? place.provider_place_id : null,
      order: stops.length + 1,
      name: String(place.name ?? '（名称不明の場所）'),
      category: String(place.category ?? 'other'),
      address: String(place.address ?? ''),
      latitude: num(place.latitude),
      longitude: num(place.longitude),
      stay_minutes: num((item as any).stay_minutes) ?? 0,
      planned_arrival_at: typeof (item as any).start_at === 'string' ? (item as any).start_at : null,
      reason: String((item as any).selection_reason ?? ''),
      visited: visitedIds.includes(place.id),
    });
  }
  if (stops.length === 0) return null;
  const visitedCount = stops.filter((s) => s.visited).length;
  const status = p.budget_status;
  return {
    plan_id: p.id,
    source: typeof p.source === 'string' ? p.source : null,
    variant: typeof p.variant === 'string' ? p.variant : null,
    title: typeof p.title === 'string' && p.title ? p.title : '今日のプラン',
    concept: typeof p.concept === 'string' ? p.concept : null,
    accepted_at: p.accepted_at,
    duration_minutes: num(p.duration_minutes),
    budget_yen: num(p.budget_yen),
    places_budget_yen: num(p.estimated_budget),
    budget_status: status === 'estimated' || status === 'partial' ? status : 'unknown',
    transport_modes: Array.isArray(p.transport_modes) ? p.transport_modes.filter((m: unknown) => typeof m === 'string') : [],
    stops,
    visited_place_ids: visitedIds,
    visited_count: visitedCount,
    completed: visitedCount === stops.length,
  };
}

/** 次に answer_visit へ送る visited_place_ids。すでに記録済み・プラン外なら送らない */
export function nextVisitedIds(
  current: readonly string[],
  placeId: string,
  planPlaceIds: readonly string[]
): { ok: true; ids: string[] } | { ok: false; reason: 'already_visited' | 'not_in_plan' } {
  if (!planPlaceIds.includes(placeId)) return { ok: false, reason: 'not_in_plan' };
  if (current.includes(placeId)) return { ok: false, reason: 'already_visited' };
  // プラン外の ID（古いデータ）は answer_visit が拒否するので除き、重複もなくす
  const ids = [...new Set([...current.filter((id) => planPlaceIds.includes(id)), placeId])];
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------------------------

type Opts = { config: BackendConfig; accessToken: string | null; fetchImpl?: FetchLike };

async function request(path: string, opts: Opts & { method?: 'GET' | 'POST'; body?: unknown }) {
  const backend = resolveBackend(opts.config);
  if (!backend) return { kind: 'config' as const };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/rest/v1/${path}`,
      {
        method: opts.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${opts.accessToken}`,
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      },
      TIMEOUT_MS
    );
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { kind: 'http' as const, status: res.status, ok: res.ok, json, text };
  } catch (e) {
    return { kind: 'network' as const, detail: isAbortError(e) ? 'timeout' : String(e) };
  }
}

const isAuthError = (status: number, json: unknown) =>
  status === 401 || status === 403 || String((json as any)?.code ?? '').startsWith('PGRST30');

export async function fetchTodayPlan(opts: Opts & { now?: Date }): Promise<FetchTodayResult> {
  if (!opts.accessToken) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: 'no token' };
  const q = todayPlanQueries(todayWindowStart(opts.now ?? new Date()));
  const fail = (r: Awaited<ReturnType<typeof request>>): FetchTodayResult => {
    if (r.kind === 'http' && isAuthError(r.status, r.json)) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: `HTTP ${r.status}` };
    const detail = r.kind === 'http' ? `HTTP ${r.status} ${String((r.json as any)?.code ?? r.text.slice(0, 80))}` : r.kind === 'network' ? r.detail : 'config';
    return { status: 'error', message: TODAY_MESSAGES.load_error, devDetail: detail };
  };

  const planRes = await request(q.plan, opts);
  if (planRes.kind !== 'http' || !planRes.ok || !Array.isArray(planRes.json)) return fail(planRes);
  const planRow = planRes.json[0];
  if (!planRow) return { status: 'none' };
  const [itemsRes, visitsRes] = await Promise.all([request(q.items(planRow.id), opts), request(q.visits(planRow.id), opts)]);
  if (itemsRes.kind !== 'http' || !itemsRes.ok || !Array.isArray(itemsRes.json)) return fail(itemsRes);
  if (visitsRes.kind !== 'http' || !visitsRes.ok || !Array.isArray(visitsRes.json)) return fail(visitsRes);
  const plan = toTodayPlan(planRow, itemsRes.json, visitsRes.json[0] ?? null);
  return plan ? { status: 'ok', plan } : { status: 'none' };
}

/** スポットを「行った」にする（既存 answer_visit RPC） */
export async function recordVisit(planId: string, placeId: string, planPlaceIds: readonly string[], opts: Opts): Promise<VisitResult> {
  if (!opts.accessToken) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: 'no token' };
  const failVisit = (r: Awaited<ReturnType<typeof request>>): VisitResult => {
    if (r.kind === 'http') {
      const code = String((r.json as any)?.code ?? '');
      const message = String((r.json as any)?.message ?? '');
      // answer_visit の業務エラーを先に見る。visited_place_not_in_plan（42501）は PostgREST では HTTP 403 になるため、
      // 認証エラーと取り違えてログアウトさせないようにする
      if (code === 'P0002' || message.includes('accepted_plan_not_found')) {
        return { status: 'plan_not_accepted', message: TODAY_MESSAGES.plan_not_accepted, devDetail: `HTTP ${r.status} ${code}` };
      }
      if (message.includes('visited_place_not_in_plan')) {
        return { status: 'not_in_plan', message: TODAY_MESSAGES.not_in_plan, devDetail: `HTTP ${r.status} ${code}` };
      }
      if (isAuthError(r.status, r.json)) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: `HTTP ${r.status}` };
      return { status: 'error', message: TODAY_MESSAGES.visit_error, devDetail: `HTTP ${r.status} ${code}` };
    }
    return { status: 'error', message: TODAY_MESSAGES.visit_error, devDetail: r.kind === 'network' ? r.detail : 'config' };
  };

  // 1. サーバーの最新の記録を読み直す（別の端末・二重タップで消さない / 重ねない）
  const current = await request(todayPlanQueries('').visits(planId), opts);
  if (current.kind !== 'http' || !current.ok || !Array.isArray(current.json)) return failVisit(current);
  const currentIds: string[] = Array.isArray(current.json[0]?.visited_place_ids) ? current.json[0].visited_place_ids : [];
  const next = nextVisitedIds(currentIds, placeId, planPlaceIds);
  if (!next.ok) {
    if (next.reason === 'already_visited') return { status: 'already_visited', visited_place_ids: currentIds };
    return { status: 'not_in_plan', message: TODAY_MESSAGES.not_in_plan, devDetail: 'not in plan' };
  }

  // 2. 既存 RPC で記録（本人の accepted プラン・プラン内の場所だけをサーバーが受け付ける）
  const res = await request('rpc/answer_visit', {
    ...opts,
    method: 'POST',
    body: { p_plan_id: planId, p_went: true, p_visited_place_ids: next.ids },
  });
  if (res.kind !== 'http' || !res.ok) return failVisit(res);
  const saved = Array.isArray((res.json as any)?.visited_place_ids) ? (res.json as any).visited_place_ids : next.ids;
  return { status: 'visited', visited_place_ids: saved };
}

// ---------------------------------------------------------------------------------------------
// v3.0: 記録入力（/record）・保存一覧「ルート」・過去のプラン（/plans/[id]）
// ---------------------------------------------------------------------------------------------

/** 本人の採用済みプランを ID で取得（今日の24時間に限らない）。無ければ none */
export async function fetchAcceptedPlan(planId: string, opts: Opts): Promise<FetchTodayResult> {
  if (!opts.accessToken) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: 'no token' };
  if (!/^[0-9a-f-]{36}$/i.test(planId)) return { status: 'none' };
  const q = todayPlanQueries('');
  const fail = (r: Awaited<ReturnType<typeof request>>): FetchTodayResult => {
    if (r.kind === 'http' && isAuthError(r.status, r.json)) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: `HTTP ${r.status}` };
    return { status: 'error', message: TODAY_MESSAGES.load_error, devDetail: r.kind === 'http' ? `HTTP ${r.status}` : r.kind };
  };
  const planRes = await request(`plans?select=${encodeURIComponent(PLAN_SELECT)}&id=eq.${planId}&status=eq.accepted&limit=1`, opts);
  if (planRes.kind !== 'http' || !planRes.ok || !Array.isArray(planRes.json)) return fail(planRes);
  const planRow = planRes.json[0];
  if (!planRow) return { status: 'none' };
  const [itemsRes, visitsRes] = await Promise.all([request(q.items(planId), opts), request(q.visits(planId), opts)]);
  if (itemsRes.kind !== 'http' || !itemsRes.ok || !Array.isArray(itemsRes.json)) return fail(itemsRes);
  if (visitsRes.kind !== 'http' || !visitsRes.ok || !Array.isArray(visitsRes.json)) return fail(visitsRes);
  const plan = toTodayPlan(planRow, itemsRes.json, visitsRes.json[0] ?? null);
  return plan ? { status: 'ok', plan } : { status: 'none' };
}

export type AcceptedPlanSummary = { plan_id: string; title: string; accepted_at: string; source: string | null };

export const ACCEPTED_PLANS_LIMIT = 30;

/** 保存一覧「ルート」: 自分が選んだ（採用した）ルート。新しい順 */
export async function fetchAcceptedPlans(
  opts: Opts
): Promise<{ status: 'ok'; plans: AcceptedPlanSummary[] } | { status: 'unauthorized' | 'error'; message: string; devDetail: string }> {
  if (!opts.accessToken) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: 'no token' };
  const select = 'id,accepted_at,title:condition_json->option->>title,source:condition_json->>source';
  const r = await request(
    `plans?select=${encodeURIComponent(select)}&status=eq.accepted&order=accepted_at.desc&limit=${ACCEPTED_PLANS_LIMIT}`,
    opts
  );
  if (r.kind !== 'http' || !r.ok || !Array.isArray(r.json)) {
    if (r.kind === 'http' && isAuthError(r.status, r.json)) return { status: 'unauthorized', message: TODAY_MESSAGES.unauthorized, devDetail: `HTTP ${r.status}` };
    return { status: 'error', message: 'ルートを読み込めませんでした。', devDetail: r.kind === 'http' ? `HTTP ${r.status}` : r.kind };
  }
  const plans: AcceptedPlanSummary[] = [];
  for (const row of r.json as Record<string, unknown>[]) {
    if (typeof row?.id !== 'string' || typeof row.accepted_at !== 'string') continue;
    plans.push({
      plan_id: row.id,
      accepted_at: row.accepted_at,
      title: typeof row.title === 'string' && row.title ? row.title : '今日のルート',
      source: typeof row.source === 'string' ? row.source : null,
    });
  }
  return { status: 'ok', plans };
}
