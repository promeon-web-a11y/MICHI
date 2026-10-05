/**
 * 現在地の型定義（Step 4-3）。/map と次工程の「今日どこ行く？」→ AIプラン生成で共有する。
 *
 * プライバシー: 現在地は端末上だけで扱う。Supabase への保存・分析イベントへの記録はしない。
 * プラン生成で送る場合は、その工程で toPlanOrigin() を使って明示的に送る。
 */

export type CurrentLocation = {
  latitude: number;
  longitude: number;
  /** 水平精度（メートル, 68%信頼半径）。端末が返さない場合 null */
  accuracy: number | null;
  /** 位置が測位された時刻（epoch ms） */
  timestamp: number;
  /** 直近のキャッシュ位置（last_known）か、今回測位した位置（current）か */
  source: 'current' | 'last_known';
};

export type LocationFailureReason =
  /** 権限が拒否された（再度たずねられる） */
  | 'permission_denied'
  /** 権限が拒否され、アプリからはもう聞けない（OS 設定での変更が必要） */
  | 'permission_blocked'
  /** 端末の位置情報サービスがオフ */
  | 'services_disabled'
  | 'timeout'
  /** 測位APIのエラー */
  | 'unavailable'
  /** 取得できたが座標が不正 */
  | 'invalid_coordinates'
  /** この環境（Web / 位置情報モジュールを含まないビルド）では使えない */
  | 'unsupported';

export type LocationResult =
  | { ok: true; location: CurrentLocation }
  | { ok: false; reason: LocationFailureReason; devDetail?: string };

export type CurrentLocationStatus = 'idle' | 'locating' | 'ready' | 'error';

export type CurrentLocationState = {
  status: CurrentLocationStatus;
  /** 最後に取得できた現在地（その後の取得失敗でも保持する） */
  location: CurrentLocation | null;
  /** 直近の取得失敗の理由（成功したら null） */
  error: LocationFailureReason | null;
};

/** 権限の状態（expo-location の PermissionResponse のうち使う部分） */
export type LocationPermission = {
  granted: boolean;
  canAskAgain: boolean;
};

/**
 * 位置情報の取得元。ネイティブは expo-location、Web / 古いビルドは未対応。
 * テストではモックを注入する。
 */
export type LocationProvider = {
  isAvailable: () => boolean;
  getPermission: () => Promise<LocationPermission>;
  requestPermission: () => Promise<LocationPermission>;
  hasServicesEnabled: () => Promise<boolean>;
  /** 条件を満たす直近の位置が無ければ null */
  getLastKnown: (options: { maxAgeMs: number; requiredAccuracyM: number }) => Promise<RawPosition | null>;
  getCurrent: () => Promise<RawPosition>;
};

/** 取得元が返す生の位置（expo-location の LocationObject と同じ形の必要部分） */
export type RawPosition = {
  coords: { latitude: unknown; longitude: unknown; accuracy?: unknown };
  timestamp?: unknown;
};

/** 次工程（AIプラン生成）へ渡す出発地の形 */
export type PlanOrigin = {
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  captured_at: string;
};
