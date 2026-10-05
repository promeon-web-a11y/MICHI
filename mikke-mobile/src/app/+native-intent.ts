/**
 * OS から渡されたURL（ディープリンク / 共有Intent）を Expo Router のパスへ変換する。
 *
 * expo-sharing は他アプリからの共有時に `<scheme>://expo-sharing` でアプリを開く
 * （iOS: Share Extension → メインアプリ起動 / Android: ACTION_SEND の Intent）。
 * その場合は共有処理専用の /handle-share へ遷移させる。
 */
import { appLog } from '@/lib/logger';

const SHARE_INTENT_HOST = 'expo-sharing';
const HANDLE_SHARE_PATH = '/handle-share';

function isShareIntent(path: string): boolean {
  try {
    return new URL(path).hostname === SHARE_INTENT_HOST;
  } catch {
    // 相対パスなど URL として解釈できないもの。念のため文字列でも判定する
    return /^[a-z][a-z0-9+.-]*:\/\/expo-sharing(?:[/?#]|$)/i.test(path);
  }
}

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  try {
    if (isShareIntent(path)) {
      appLog.info(`共有Intentを検知 → ${HANDLE_SHARE_PATH}`, { path, initial });
      return HANDLE_SHARE_PATH;
    }
    return path;
  } catch (e) {
    appLog.error('Intent の解析に失敗しました。ホームへ遷移します', { path, initial, error: String(e) });
    return '/';
  }
}
