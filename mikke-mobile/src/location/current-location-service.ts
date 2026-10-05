/**
 * 現在地の取得フローと共有ストア（Step 4-3）。
 * React / expo-location に依存しない（取得元 LocationProvider を注入して Node で単体テストする）。
 *
 * 方針:
 * - アプリ使用中のみ・必要な時だけ1回取得する（watch しない）
 * - 精度は Balanced（数十〜100m 程度）。「現在地周辺からお出かけプラン」に十分で、GPS を強く要求しない
 * - まず直近のキャッシュ位置（2分以内・精度500m以内）を使い、無ければ測位（15秒でタイムアウト）
 * - 取得済みで新しい（5分以内）なら再取得しない
 * - 座標は端末内だけで扱い、ログにも出さない
 */
import type {
  CurrentLocation,
  CurrentLocationState,
  LocationFailureReason,
  LocationProvider,
  LocationResult,
  PlanOrigin,
  RawPosition,
} from './current-location-types';

/** キャッシュ位置として使ってよい古さ */
export const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
/** キャッシュ位置として使ってよい精度（これより粗ければ測位し直す） */
export const LAST_KNOWN_REQUIRED_ACCURACY_M = 500;
/** 測位のタイムアウト（expo-location の getCurrentPositionAsync にはタイムアウトが無いため自前で切る） */
export const LOCATE_TIMEOUT_MS = 15_000;
/** 取得済みの現在地を再利用する期間（「現在地」ボタンで毎回測位しない） */
export const LOCATION_REUSE_MS = 5 * 60_000;

export const LOCATION_MESSAGES: Record<LocationFailureReason, string> = {
  permission_denied: '現在地を利用できません。位置情報を許可すると、現在地からプランを作成できます。',
  permission_blocked:
    '現在地を利用できません。位置情報を許可すると、現在地からプランを作成できます。端末の設定から Mikke の位置情報を許可してください。',
  services_disabled: '端末の位置情報サービスがオフになっています。オンにしてから再試行してください。',
  timeout: '現在地を取得できませんでした（時間切れ）。屋外や電波の良い場所で再試行してください。',
  unavailable: '現在地を取得できませんでした。しばらくしてから再試行してください。',
  invalid_coordinates: '現在地を取得できませんでした。しばらくしてから再試行してください。',
  unsupported: 'この環境では現在地を利用できません。',
};

export function isValidLatLng(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    // (0, 0) は取得失敗時の既定値であることがほとんど
    !(latitude === 0 && longitude === 0)
  );
}

/** 生の位置を検証して CurrentLocation にする。不正なら null */
export function toCurrentLocation(
  raw: RawPosition | null | undefined,
  source: CurrentLocation['source'],
  now: number
): CurrentLocation | null {
  if (!raw || typeof raw !== 'object' || !raw.coords) return null;
  const { latitude, longitude, accuracy } = raw.coords;
  if (!isValidLatLng(latitude, longitude)) return null;
  const acc = typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null;
  const ts = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) && raw.timestamp > 0 ? raw.timestamp : now;
  return { latitude: latitude as number, longitude: longitude as number, accuracy: acc, timestamp: ts, source };
}

class TimeoutError extends Error {
  constructor() {
    super('location_timeout');
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * 現在地を1回取得する。例外は投げない。
 * @param options.prompt true: 未許可なら権限ダイアログを出す / false: 許可済みの場合だけ取得（ダイアログを出さない）
 */
export async function acquireCurrentLocation(
  provider: LocationProvider,
  options: { prompt: boolean; timeoutMs?: number; now?: () => number }
): Promise<LocationResult> {
  const now = options.now ?? Date.now;
  if (!provider.isAvailable()) return { ok: false, reason: 'unsupported' };

  // 1. 権限（アプリ使用中のみ）
  let permission;
  try {
    permission = await provider.getPermission();
    if (!permission.granted && options.prompt && permission.canAskAgain) {
      permission = await provider.requestPermission();
    }
  } catch (e) {
    return { ok: false, reason: 'unavailable', devDetail: `permission: ${describe(e)}` };
  }
  if (!permission.granted) {
    return { ok: false, reason: permission.canAskAgain ? 'permission_denied' : 'permission_blocked' };
  }

  // 2. 端末の位置情報サービス
  try {
    if (!(await provider.hasServicesEnabled())) return { ok: false, reason: 'services_disabled' };
  } catch {
    // 判定できなければ測位を試す（失敗すれば下で unavailable になる）
  }

  // 3. 直近のキャッシュ位置（速い・電池を使わない）
  try {
    const last = await provider.getLastKnown({
      maxAgeMs: LAST_KNOWN_MAX_AGE_MS,
      requiredAccuracyM: LAST_KNOWN_REQUIRED_ACCURACY_M,
    });
    const location = toCurrentLocation(last, 'last_known', now());
    if (location && now() - location.timestamp <= LAST_KNOWN_MAX_AGE_MS) return { ok: true, location };
  } catch {
    // キャッシュ位置が取れなくても測位に進む
  }

  // 4. 測位（タイムアウト付き）
  let raw: RawPosition;
  try {
    raw = await withTimeout(provider.getCurrent(), options.timeoutMs ?? LOCATE_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof TimeoutError) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'unavailable', devDetail: describe(e) };
  }
  const location = toCurrentLocation(raw, 'current', now());
  if (!location) return { ok: false, reason: 'invalid_coordinates' };
  return { ok: true, location };
}

// ---------------------------------------------------------------------------------------------
// 共有ストア（/map と次工程で同じ現在地を使う）
// ---------------------------------------------------------------------------------------------

export const INITIAL_LOCATION_STATE: CurrentLocationState = { status: 'idle', location: null, error: null };

export function createCurrentLocationStore(deps: {
  provider: LocationProvider;
  now?: () => number;
  timeoutMs?: number;
  /** 開発ログ用。座標は渡さない */
  onResult?: (summary: { ok: boolean; reason?: LocationFailureReason; source?: string; accuracy?: number | null; devDetail?: string }) => void;
}) {
  const now = deps.now ?? Date.now;
  let state: CurrentLocationState = INITIAL_LOCATION_STATE;
  let inFlight: Promise<LocationResult> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: CurrentLocationState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  /**
   * 現在地を取得する。新しい現在地があれば再取得しない。同時呼び出しは1本にまとめる。
   * @param options.prompt 未許可なら権限ダイアログを出すか
   * @param options.force キャッシュを使わず取得し直す
   */
  function locate(options: { prompt: boolean; force?: boolean }): Promise<LocationResult> {
    const cached = state.location;
    if (!options.force && cached && now() - cached.timestamp <= LOCATION_REUSE_MS) {
      if (state.status !== 'ready') set({ ...state, status: 'ready', error: null });
      return Promise.resolve({ ok: true, location: cached });
    }
    if (inFlight) return inFlight;

    set({ ...state, status: 'locating' });
    const promise = acquireCurrentLocation(deps.provider, { prompt: options.prompt, timeoutMs: deps.timeoutMs, now })
      .then((result) => {
        if (result.ok) {
          set({ status: 'ready', location: result.location, error: null });
          deps.onResult?.({ ok: true, source: result.location.source, accuracy: result.location.accuracy });
        } else {
          // 失敗しても以前の現在地は残す（古い位置でも地図の参考にはなる）
          set({ status: 'error', location: state.location, error: result.reason });
          deps.onResult?.({ ok: false, reason: result.reason, devDetail: result.devDetail });
        }
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = promise;
    return promise;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    locate,
    /** 現在地を破棄する（ログアウト時など） */
    clear() {
      set(INITIAL_LOCATION_STATE);
    },
  };
}

export type CurrentLocationStore = ReturnType<typeof createCurrentLocationStore>;

/** 次工程（AIプラン生成）へ渡す出発地に変換する。送信はその工程で明示的に行う */
export function toPlanOrigin(location: CurrentLocation): PlanOrigin {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy_m: location.accuracy === null ? null : Math.round(location.accuracy),
    captured_at: new Date(location.timestamp).toISOString(),
  };
}
