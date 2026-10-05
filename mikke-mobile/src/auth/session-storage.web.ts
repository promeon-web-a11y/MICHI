/**
 * Web ではログイン状態を永続化しない（開発確認用。トークンをブラウザのストレージに置かない）。
 */
import type { StoredAuth } from './auth-session';

export const sessionStorage = {
  isAvailable: () => false,
  read: async (): Promise<StoredAuth | null> => null,
  write: async (_value: StoredAuth): Promise<void> => {},
  clear: async (): Promise<void> => {},
};
