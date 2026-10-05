/**
 * アプリ共通のログ（開発ログ）。
 * - 開発ビルドでは console へ出力しつつ、実機の確認画面でも見られるようメモリ上に直近のログを保持する
 * - リリースビルドでは console へ出さない（端末ログに共有URL等を残さない）
 * - トークン・パスワード・APIキー・メールアドレスらしき値は、記録する前に伏せる（redactSecrets）
 *
 * React / expo に依存しない（Node で単体テスト）。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEntry = {
  id: number;
  at: string;
  level: LogLevel;
  message: string;
  detail?: string;
};

const MAX_ENTRIES = 200;
const PREFIX = '[Mikke]';

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

/** JSON 内でこのキーを持つ値は丸ごと伏せる */
const SECRET_KEYS = /("(?:access_token|refresh_token|accessToken|refreshToken|password|apikey|api_key|authorization|token)"\s*:\s*)"[^"]*"/gi;

/** ログに残す前に、秘密情報らしき値を伏せる */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_KEYS, '$1"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/eyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, '[jwt]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, 'sb_[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}

function stringifyDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function write(level: LogLevel, message: string, detail?: unknown) {
  const text = stringifyDetail(detail);
  const entry: LogEntry = {
    id: nextId++,
    at: new Date().toISOString(),
    level,
    message: redactSecrets(message),
    detail: text === undefined ? undefined : redactSecrets(text),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  // Node のテストでは __DEV__ が無い
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const args = entry.detail === undefined ? [PREFIX, entry.message] : [PREFIX, entry.message, entry.detail];
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else console.log(...args);
  }

  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // リスナー側の例外でログ出力元を落とさない
    }
  });
}

export const appLog = {
  info: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
};

export function getLogEntries(): readonly LogEntry[] {
  return entries.slice();
}

export function clearLogEntries() {
  entries.length = 0;
  listeners.forEach((listener) => listener());
}

export function subscribeLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
