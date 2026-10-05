/**
 * ログイン状態の永続化（iOS Keychain / Android Keystore: expo-secure-store）。
 * Web では session-storage.web.ts が使われる（永続化しない）。
 *
 * 保存するのはリフレッシュトークンとメールアドレスだけ（小さい値。アクセストークンは保存しない）。
 * expo-secure-store は import した時点でネイティブモジュールを必須とするため静的 import しない。
 * 含まれていない古い Development Build では「保存できない（毎回ログイン）」として動き、落ちない。
 */
import { requireOptionalNativeModule } from 'expo';

import type { StoredAuth } from './auth-session';

type SecureStoreModule = typeof import('expo-secure-store');
let mod: SecureStoreModule | null | undefined;

function load(): SecureStoreModule | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = requireOptionalNativeModule('ExpoSecureStore') ? (require('expo-secure-store') as SecureStoreModule) : null;
  } catch {
    mod = null;
  }
  return mod;
}

const KEY = 'mikke.auth.v1';

export const sessionStorage = {
  isAvailable: () => load() !== null,
  async read(): Promise<StoredAuth | null> {
    const s = load();
    if (!s) return null;
    const raw = await s.getItemAsync(KEY);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return typeof v?.refreshToken === 'string' && v.refreshToken ? { refreshToken: v.refreshToken, email: typeof v.email === 'string' ? v.email : null } : null;
    } catch {
      return null;
    }
  },
  async write(value: StoredAuth): Promise<void> {
    const s = load();
    if (!s) return;
    // 端末のロック解除後のみ読める・この端末だけ（iCloud 等へ移さない）
    await s.setItemAsync(KEY, JSON.stringify(value), { keychainAccessible: s.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async clear(): Promise<void> {
    const s = load();
    if (!s) return;
    await s.deleteItemAsync(KEY);
  },
};
