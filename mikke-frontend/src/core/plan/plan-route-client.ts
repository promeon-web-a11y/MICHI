/**
 * Step 4-6: 選択したプランの実ルート（route-plan Edge Function / Google Routes API）。
 * React / expo に依存しない（fetch を注入して Node で単体テスト）。
 *
 * Google のキーはサーバー側のみ。モバイルは Supabase の URL / anon key とユーザー JWT、出発地点（現在地）だけを送る。
 * 出発地点はメモリ上で使うだけで、サーバーでも保存・ログされない。
 */
import {
  fetchWithTimeout,
  isAbortError,
  resolveBackend,
  type BackendConfig,
  type FetchLike,
} from '../services/backend';

export type RouteMode = 'WALK' | 'TRANSIT' | 'DRIVE';

export type WalkStep = { kind: 'walk'; duration_seconds: number; distance_meters: number | null };
export type DriveStep = { kind: 'drive'; duration_seconds: number; distance_meters: number | null };
export type TransitStep = {
  kind: 'transit';
  vehicle_type: string | null;
  vehicle_name: string | null;
  line_name: string | null;
  line_short_name: string | null;
  line_color: string | null;
  agency: string | null;
  headsign: string | null;
  departure_stop: string | null;
  arrival_stop: string | null;
  departure_at: string | null;
  arrival_at: string | null;
  stop_count: number | null;
  duration_seconds: number | null;
};
export type RouteStep = WalkStep | DriveStep | TransitStep;

export type RouteLeg = {
  index: number;
  from_name: string;
  to_place_id: string;
  /**
   * ok: Google の実ルート / failed: 取得できなかった /
   * external_transit: 公共交通（Google マップで確認）。所要時間・路線・時刻・運賃は Mikke 側では持たない
   */
  status: 'ok' | 'failed' | 'external_transit';
  failure_reason: 'no_route' | 'api_error' | 'timeout' | 'deadline_exceeded' | null;
  times_uncertain: boolean;
  mode: RouteMode | null;
  departure_at: string;
  arrival_at: string | null;
  duration_minutes: number | null;
  distance_meters: number | null;
  steps: RouteStep[];
  fare: { amount: number; currency: string } | null;
  /** external: 公共交通の運賃は Mikke では分からない（Google マップで確認） */
  fare_status: 'known' | 'unknown' | 'not_applicable' | 'external';
  /** external_transit の区間だけ: Google の徒歩ルート（参考。公共交通の所要時間ではない） */
  walk_reference?: { duration_minutes: number; distance_meters: number | null; polyline: string | null } | null;
  /**
   * TRANSIT の結果（新しい route-plan のみ。古いサーバーの応答には無い）
   * no_route: 見つからなかった / api_error・timeout・invalid_response: 取得できなかった /
   * not_requested: 問い合わせていない / disabled: 日本 MVP で問い合わせない設定（Google マップへ誘導）
   */
  transit_status?: 'ok' | 'no_route' | 'invalid_response' | 'api_error' | 'timeout' | 'not_requested' | 'disabled';
  /** 古いサーバーとの互換用 */
  transit_unavailable: boolean;
  /** 区間ごとの Routes API 呼び出しの診断（座標・キーは含まれない） */
  diagnostics?: { mode: RouteMode; status: string; http_status: number | null; error_status: string | null }[];
  alternatives: { mode: RouteMode; duration_minutes: number }[];
  polyline: string | null;
};

export type RouteStop = {
  place_id: string;
  google_place_id: string | null;
  name: string;
  category: string;
  address: string;
  latitude: number;
  longitude: number;
  stay_minutes: number;
  original_stay_minutes: number;
  arrival_at: string | null;
  leave_at: string | null;
};

export type RouteAdjustment =
  | { type: 'shortened_stay'; place_id: string; place_name: string; from_minutes: number; to_minutes: number }
  | { type: 'dropped_place'; place_id: string; place_name: string };

export type RoutedPlan = {
  plan_id: string;
  computed_at: string;
  departure_at: string;
  duration_minutes: number;
  transport_modes: string[];
  /** routes_api: 公共交通も Routes API / google_maps: 公共交通は Google マップへ誘導（日本 MVP） */
  transit_routing?: 'routes_api' | 'google_maps';
  route_status: 'ok' | 'partial' | 'failed';
  fit_status: 'fits' | 'adjusted' | 'does_not_fit' | 'unknown';
  adjustments: RouteAdjustment[];
  end_at: string | null;
  total_minutes: number | null;
  legs: RouteLeg[];
  stops: RouteStop[];
  fares: {
    status: 'all_known' | 'partial' | 'none_known' | 'not_applicable';
    known_total: number;
    currency: string | null;
    unknown_legs: number;
    /** Google マップで確認する公共交通の区間数（運賃は分からない） */
    external_legs?: number;
  };
  budget: {
    budget_yen: number | null;
    places_yen: number | null;
    places_status: 'estimated' | 'partial' | 'unknown';
    transit_fare_yen: number;
    confirmed_total_yen: number;
    completeness: 'complete' | 'partial';
    over_budget: boolean | null;
  };
};

export type RouteErrorKind =
  | 'config'
  | 'unauthorized'
  | 'origin_required'
  | 'plan_not_found'
  | 'plan_not_accepted'
  | 'unsupported_plan'
  | 'routes_unavailable'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response';

export type RouteResult =
  | { ok: true; data: RoutedPlan }
  | { ok: false; kind: RouteErrorKind; message: string; retryable: boolean; devDetail: string };

export const ROUTE_ERROR_MESSAGES: Record<RouteErrorKind, string> = {
  config: 'アプリの接続設定が不足しています。',
  unauthorized: 'ログインが必要です。',
  origin_required: '現在地が分からないため、ルートを調べられません。現在地を取得してください。',
  plan_not_found: 'このプランが見つかりませんでした。',
  plan_not_accepted: '「このプランにする」で選んだプランだけルートを調べられます。',
  unsupported_plan: 'このプランはルート確認に対応していません。',
  routes_unavailable: '移動ルートを取得できませんでした。少し時間をおいてもう一度お試しください。',
  server: '移動ルートを取得できませんでした。少し時間をおいてもう一度お試しください。',
  network: 'ネットワークに接続できませんでした。通信環境を確認してもう一度お試しください。',
  timeout: 'ルートの確認に時間がかかっています。もう一度お試しください。',
  invalid_response: '移動ルートを取得できませんでした。もう一度お試しください。',
};

const RETRYABLE: Record<RouteErrorKind, boolean> = {
  config: false,
  unauthorized: false,
  origin_required: false,
  plan_not_found: false,
  plan_not_accepted: false,
  unsupported_plan: false,
  routes_unavailable: true,
  server: true,
  network: true,
  timeout: true,
  invalid_response: true,
};

/** サーバーは Routes の呼び出しを最大40秒で打ち切る */
export const ROUTE_TIMEOUT_MS = 60_000;

function fail(kind: RouteErrorKind, devDetail: string): RouteResult {
  return { ok: false, kind, message: ROUTE_ERROR_MESSAGES[kind], retryable: RETRYABLE[kind], devDetail };
}

export function isRoutedPlan(value: unknown): value is RoutedPlan {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.plan_id === 'string' &&
    Array.isArray(v.legs) &&
    Array.isArray(v.stops) &&
    v.legs.length === v.stops.length &&
    (v.legs as Record<string, unknown>[]).every(
      (l) => l && Array.isArray(l.steps) && (l.status === 'ok' || l.status === 'failed' || l.status === 'external_transit')
    ) &&
    !!v.fares &&
    !!v.budget
  );
}

function kindFor(status: number, code: string | null): RouteErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (code === 'origin_required') return 'origin_required';
  if (code === 'plan_not_found' || status === 404) return 'plan_not_found';
  if (code === 'plan_not_accepted' || status === 409) return 'plan_not_accepted';
  if (code === 'routes_unavailable') return 'routes_unavailable';
  if (status === 422) return 'unsupported_plan';
  return 'server';
}

export async function callRoutePlan(
  planId: string,
  origin: { latitude: number; longitude: number } | null,
  options: { config: BackendConfig; accessToken: string | null; fetchImpl?: FetchLike; timeoutMs?: number }
): Promise<RouteResult> {
  const backend = resolveBackend(options.config);
  if (!backend) return fail('config', 'Supabase の設定がありません');
  if (!options.accessToken) return fail('unauthorized', '未ログイン');
  if (!origin) return fail('origin_required', '出発地点がありません');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? ROUTE_TIMEOUT_MS;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/functions/v1/route-plan`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify({ plan_id: planId, origin: { latitude: origin.latitude, longitude: origin.longitude } }),
      },
      timeoutMs
    );
  } catch (e) {
    if (isAbortError(e)) return fail('timeout', `route-plan が ${timeoutMs}ms 以内に応答しませんでした`);
    return fail('network', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  let text = '';
  try {
    text = await response.text();
  } catch (e) {
    return fail('network', String(e));
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 下で扱う
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null;
    return fail(kindFor(response.status, code), `HTTP ${response.status} ${code ?? text.slice(0, 120)}`);
  }
  if (!isRoutedPlan(body)) return fail('invalid_response', `想定外の応答: ${text.slice(0, 120)}`);
  return { ok: true, data: body };
}
