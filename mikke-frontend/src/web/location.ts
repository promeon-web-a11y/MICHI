/**
 * プランの出発地点（Web 版）。
 * - 「現在地」: ブラウザの Geolocation API。利用者が許可したときだけ取得し、座標はブラウザのメモリ上だけで使う（保存・ログしない）
 * - 「駅名・住所で指定」: 位置情報を許可しない・使えない場合の代わり。既存の resolve-place（Google Places の検索）で候補を出し、
 *   選んだ場所の座標を出発地点にする。プラン生成は座標だけを使うため、バックエンドの変更は不要
 * 許可を求めるダイアログは、利用者が「現在地を使う」を押したときだけ出す（開いただけでは出さない）。
 */
'use client';

import { useSyncExternalStore } from 'react';

import type { CurrentLocation } from '@/core/location/current-location-types';
import { isValidLatLng, toCurrentLocation } from '@/core/location/current-location-service';
import { fetchWithTimeout, isAbortError, resolveBackend, type FetchLike } from '@/core/services/backend';
import { apiFail, type ApiOptions, type ApiResult } from '@/core/services/rest';

import { registerUserCacheReset } from './auth';
import { readSession, writeSession } from './session-persist';

export type OriginKind = 'current' | 'custom';
export type OriginError = 'permission_denied' | 'timeout' | 'unavailable' | 'unsupported';

export type OriginState = {
  status: 'idle' | 'locating' | 'ready' | 'error';
  kind: OriginKind | null;
  /** 出発地点の座標（現在地 or 指定した場所） */
  location: CurrentLocation | null;
  /** 画面に出す名前（「現在地」または選んだ場所の名前） */
  label: string | null;
  error: OriginError | null;
};

export const ORIGIN_MESSAGES: Record<OriginError, string> = {
  permission_denied: '位置情報が許可されていません。駅名や住所で出発地を指定できます（ブラウザの設定で位置情報を許可すると現在地も使えます）。',
  timeout: '現在地を取得できませんでした（時間切れ）。もう一度試すか、駅名や住所で指定してください。',
  unavailable: '現在地を取得できませんでした。もう一度試すか、駅名や住所で指定してください。',
  unsupported: 'このブラウザでは現在地を使えません。駅名や住所で出発地を指定してください。',
};

/** 取得済みの現在地を使い回す時間（毎回測位しない） */
const REUSE_MS = 5 * 60_000;
const LOCATE_TIMEOUT_MS = 15_000;

const INITIAL: OriginState = { status: 'idle', kind: null, location: null, label: null, error: null };
let state: OriginState = INITIAL;
const listeners = new Set<() => void>();
const ORIGIN_KEY = 'mikke:origin';
type SavedOrigin = { kind: OriginKind; label: string | null; latitude: number; longitude: number; timestamp: number };
const set = (next: OriginState) => {
  state = next;
  // 再読み込みしても出発地点を選び直さなくてよいように、このタブにだけ残す（約10m単位に丸める。タブを閉じると消える）
  const l = next.location;
  writeSession(
    ORIGIN_KEY,
    next.kind && l
      ? ({ kind: next.kind, label: next.label, latitude: Math.round(l.latitude * 1e4) / 1e4, longitude: Math.round(l.longitude * 1e4) / 1e4, timestamp: l.timestamp } satisfies SavedOrigin)
      : null
  );
  listeners.forEach((l) => l());
};
registerUserCacheReset(() => set(INITIAL));

/** 再読み込み後に、このタブで選んでいた出発地点を戻す（まだ何も選んでいないときだけ） */
export function restoreOrigin() {
  if (state.location) return;
  const saved = readSession<SavedOrigin>(ORIGIN_KEY);
  if (!saved || !isValidLatLng(saved.latitude, saved.longitude)) return;
  set({
    status: 'ready',
    kind: saved.kind,
    location: { latitude: saved.latitude, longitude: saved.longitude, accuracy: null, timestamp: saved.timestamp, source: 'last_known' },
    label: saved.label,
    error: null,
  });
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function getOriginSnapshot(): OriginState {
  return state;
}

export function useOrigin(): OriginState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

function geolocationAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;
}

async function permissionState(): Promise<PermissionState | null> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return p?.state ?? null;
  } catch {
    return null;
  }
}

let inFlight: Promise<boolean> | null = null;

/**
 * 現在地を取得して出発地点にする。
 * @param prompt false: すでに許可されている場合だけ取得する（ダイアログを出さない。ページを開いたとき用）
 */
export function locateCurrent(options: { prompt: boolean; force?: boolean }): Promise<boolean> {
  if (state.kind === 'custom' && !options.prompt) return Promise.resolve(true); // 指定した出発地を勝手に上書きしない
  const cached = state.kind === 'current' ? state.location : null;
  if (!options.force && cached && Date.now() - cached.timestamp <= REUSE_MS) return Promise.resolve(true);
  if (inFlight) return inFlight;
  if (!geolocationAvailable()) {
    if (options.prompt) set({ ...state, status: 'error', error: 'unsupported' });
    return Promise.resolve(false);
  }
  inFlight = (async () => {
    if (!options.prompt && (await permissionState()) !== 'granted') return false;
    set({ ...state, status: 'locating', error: null });
    const result = await new Promise<{ ok: true; location: CurrentLocation } | { ok: false; error: OriginError }>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const location = toCurrentLocation(
            { coords: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }, timestamp: pos.timestamp },
            'current',
            Date.now()
          );
          resolve(location ? { ok: true, location } : { ok: false, error: 'unavailable' });
        },
        (err) => resolve({ ok: false, error: err.code === err.PERMISSION_DENIED ? 'permission_denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable' }),
        // 数十〜100m 程度で十分（GPS を強く要求しない）。2分以内の位置があればそれを使う
        { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: 2 * 60_000 }
      );
    });
    if (result.ok) {
      set({ status: 'ready', kind: 'current', location: result.location, label: '現在地', error: null });
      return true;
    }
    // 失敗しても、指定済みの出発地・以前の現在地は残す
    set({ ...state, status: state.location ? 'ready' : 'error', error: result.error });
    return false;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 駅名・住所の検索で選んだ場所を出発地点にする */
export function setCustomOrigin(place: { name: string; latitude: number; longitude: number }) {
  if (!isValidLatLng(place.latitude, place.longitude)) return;
  set({
    status: 'ready',
    kind: 'custom',
    location: { latitude: place.latitude, longitude: place.longitude, accuracy: null, timestamp: Date.now(), source: 'current' },
    label: place.name,
    error: null,
  });
}

export function clearOrigin() {
  set(INITIAL);
}

// ---------------------------------------------------------------------------------------------
// 駅名・住所の検索（既存の resolve-place Edge Function。Google のキーはサーバー側のみ）
// ---------------------------------------------------------------------------------------------
export type OriginCandidate = { id: string; name: string; address: string; latitude: number; longitude: number };

export async function searchOriginPlaces(query: string, opts: ApiOptions): Promise<ApiResult<OriginCandidate[]>> {
  const q = query.trim();
  if (!q) return apiFail('invalid', 'empty query', '駅名や住所を入力してください。');
  if (q.length > 100) return apiFail('invalid', 'too long', '100文字以内で入力してください。');
  const backend = resolveBackend(opts.config);
  if (!backend) return apiFail('config', 'config');
  if (!opts.accessToken) return apiFail('unauthorized', 'no token');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/functions/v1/resolve-place`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: backend.anonKey, Authorization: `Bearer ${opts.accessToken}` },
        body: JSON.stringify({ query: q }),
      },
      20_000
    );
    const text = await res.text();
    if (res.status === 401 || res.status === 403) return apiFail('unauthorized', `HTTP ${res.status}`);
    if (!res.ok) return apiFail('server', `HTTP ${res.status} ${text.slice(0, 120)}`, '場所を検索できませんでした。時間をおいてもう一度お試しください。');
    const body = JSON.parse(text) as { candidates?: unknown };
    const out: OriginCandidate[] = [];
    for (const c of Array.isArray(body.candidates) ? body.candidates : []) {
      const v = (c ?? {}) as Record<string, unknown>;
      const lat = typeof v.latitude === 'number' ? v.latitude : null;
      const lng = typeof v.longitude === 'number' ? v.longitude : null;
      if (typeof v.name !== 'string' || lat === null || lng === null || !isValidLatLng(lat, lng)) continue;
      out.push({ id: String(v.provider_place_id ?? `${lat},${lng}`), name: v.name, address: typeof v.address === 'string' ? v.address : '', latitude: lat, longitude: lng });
    }
    return { ok: true, data: out };
  } catch (e) {
    return apiFail('network', isAbortError(e) ? 'timeout' : String(e));
  }
}
