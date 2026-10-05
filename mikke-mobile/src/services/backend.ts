/**
 * Supabase への接続設定と、各 API クライアントが共有する HTTP の土台。
 *   API クライアント（place / plan / today / auth …）→ このファイル → Supabase（REST / Auth / Functions）
 *
 * React / expo に依存しない（Node の単体テストから fetch を注入して使う）。
 * モバイルに置くのは Supabase の URL と anon key（公開前提の値）だけ。service role は置かない。
 */

export type BackendConfig = { supabaseUrl: string | null; anonKey: string | null };

/** fetch の最小限の形（テストで差し替えるため） */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// EXPO_PUBLIC_* はビルド時に埋め込まれる公開値（参照はこの形のまま書く必要がある）
export const backendConfig: BackendConfig = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? null,
  anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? null,
};

/** Supabase の URL / anon key を検証して関数URL等を返す */
export function resolveBackend(config: BackendConfig): { baseUrl: string; anonKey: string } | null {
  const anonKey = config.anonKey?.trim();
  const raw = config.supabaseUrl?.trim();
  if (!raw || !anonKey) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { baseUrl: raw.replace(/\/+$/, ''), anonKey };
  } catch {
    return null;
  }
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'name' in e && ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError');
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
