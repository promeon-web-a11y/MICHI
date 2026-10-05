/**
 * Step 3-4: identify-place の結果 → save-place Edge Function（Supabase の places / saved_places へ保存）。
 * React Native / expo に依存しない（fetch を注入して Node で単体テストするため）。
 *
 * - confirmed: 特定された Place を保存できる
 * - needs_review: ユーザーが候補を1件選んだ場合だけ保存できる（自動保存しない）
 * - not_found / insufficient_information / error: 保存しない
 * user_id は送らない（サーバーが JWT から確定する）。
 */
import { fetchWithTimeout, isAbortError, resolveBackend, type BackendConfig, type FetchLike } from '../services/backend';

import type {
  IdentifyPlaceRequest,
  IdentifyPlaceResponse,
  IdentifySource,
  PlaceResult,
} from './identify-place-client';

export type SavePlaceRequest = {
  place: {
    google_place_id: string;
    name: string;
    formatted_address: string | null;
    latitude: number | null;
    longitude: number | null;
    primary_type: string | null;
    types: string[];
    business_status: string | null;
  };
  share: { source: IdentifySource; url: string | null; text: string | null };
  identification: { status: 'confirmed' | 'needs_review'; confidence: number | null; selected_by_user: boolean };
};

export type SaveStatus = 'saved' | 'already_saved' | 'unauthorized' | 'invalid_request' | 'error';

export type SavePlaceResponse = {
  status: SaveStatus;
  message: string;
  reason: string;
  place: {
    place_id: string;
    google_place_id: string;
    name: string;
    address: string;
    latitude: number | null;
    longitude: number | null;
    category: string;
  } | null;
  saved_place: { id: string; saved_at: string; source_platform: string; source_url: string } | null;
  place_reused: boolean | null;
  warnings: string[];
  error: { code: string } | null;
};

/** 画面表示用の保存結果。サーバー応答が無い失敗（通信・設定）も status で表す */
export type SaveResult = {
  status: SaveStatus;
  /** 利用者向け文言 */
  message: string;
  httpStatus: number | null;
  data: SavePlaceResponse | null;
  /** 開発用の詳細（トークン等は含めない） */
  devDetail: string | null;
};

export const SAVE_TIMEOUT_MS = 20_000;

export const SAVE_MESSAGES: Record<SaveStatus, string> = {
  saved: '保存しました',
  already_saved: 'すでに保存されています',
  unauthorized: 'ログインが必要です',
  invalid_request: '保存できませんでした',
  error: '保存できませんでした',
};

const SAVE_STATUSES: SaveStatus[] = ['saved', 'already_saved', 'unauthorized', 'invalid_request', 'error'];

function toPlacePayload(place: PlaceResult): SavePlaceRequest['place'] {
  return {
    google_place_id: place.google_place_id,
    name: place.name,
    formatted_address: place.formatted_address,
    latitude: place.latitude,
    longitude: place.longitude,
    primary_type: place.primary_type,
    types: place.types,
    business_status: place.business_status,
  };
}

/**
 * 保存リクエストを作る。保存してはいけない状態では null。
 * @param selectedPlaceId needs_review でユーザーが選んだ候補の Google Place ID
 */
export function buildSaveRequest(
  result: IdentifyPlaceResponse | null | undefined,
  sent: IdentifyPlaceRequest | null | undefined,
  selectedPlaceId?: string | null
): SavePlaceRequest | null {
  if (!result) return null;
  const share = {
    // source はサーバーが URL から再判定した値を使う
    source: result.input?.source ?? sent?.source ?? 'unknown',
    url: sent?.url ?? null,
    text: sent?.text ?? null,
  };

  if (result.status === 'confirmed') {
    if (!result.place?.google_place_id) return null;
    return {
      place: toPlacePayload(result.place),
      share,
      identification: { status: 'confirmed', confidence: result.confidence, selected_by_user: false },
    };
  }
  if (result.status === 'needs_review') {
    // ユーザーの選択が無ければ保存しない
    if (!selectedPlaceId) return null;
    const candidate = result.candidates.find((c) => c.google_place_id === selectedPlaceId);
    if (!candidate) return null;
    return {
      place: toPlacePayload(candidate),
      share,
      identification: { status: 'needs_review', confidence: candidate.score, selected_by_user: true },
    };
  }
  return null;
}

export function isSavePlaceResponse(value: unknown): value is SavePlaceResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return SAVE_STATUSES.includes(v.status as SaveStatus) && typeof v.reason === 'string';
}

function result(status: SaveStatus, devDetail: string | null, httpStatus: number | null = null, data: SavePlaceResponse | null = null): SaveResult {
  return { status, message: SAVE_MESSAGES[status], httpStatus, data, devDetail };
}

/** save-place を呼ぶ。例外は投げない */
export async function callSavePlace(
  request: SavePlaceRequest,
  options: { config: BackendConfig; accessToken: string | null; fetchImpl?: FetchLike; timeoutMs?: number }
): Promise<SaveResult> {
  const backend = resolveBackend(options.config);
  if (!backend) return result('error', 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定または不正');
  if (!options.accessToken) return result('unauthorized', 'access token がありません（未ログイン）');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? SAVE_TIMEOUT_MS;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/functions/v1/save-place`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: backend.anonKey,
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify(request),
      },
      timeoutMs
    );
  } catch (e) {
    if (isAbortError(e)) return result('error', `save-place が ${timeoutMs}ms 以内に応答しませんでした（保存されたかは再保存で確認できます）`);
    return result('error', `network: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (e) {
    return result('error', `レスポンス本文の読み取りに失敗: ${String(e)}`, response.status);
  }
  let body: unknown = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // 下で扱う
  }

  if (isSavePlaceResponse(body)) {
    return result(body.status, `HTTP ${response.status} ${body.reason}`, response.status, body);
  }
  // Edge Functions のゲートウェイ（verify_jwt）が不正/期限切れ JWT を弾いた場合は独自形式の 401
  if (response.status === 401 || response.status === 403) {
    return result('unauthorized', `HTTP ${response.status} ${bodyText.slice(0, 200)}`, response.status);
  }
  return result('error', `HTTP ${response.status} ${bodyText.slice(0, 200)}`, response.status);
}
