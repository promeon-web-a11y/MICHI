// ログインなしで使える API（/api/plan）の連続送信を抑える簡易な制限。サーバー専用。
// メモリ上の記録なので、サーバーレスではインスタンスごと・再起動までの制限になる（OpenAI / Google の費用が
// 際限なく増えるのを防ぐ最低限のガード）。厳密な制限が必要になったら、この関数の中身を外部ストアに差し替える。

type Window = { limit: number; windowMs: number };

const WINDOWS: Window[] = [
  { limit: 5, windowMs: 60_000 },
  { limit: 40, windowMs: 24 * 60 * 60_000 },
];
const MAX_KEYS = 5_000;

const hits = new Map<string, number[]>();

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 制限内なら記録して true。超えていたら false */
export function allowRequest(key: string, now = Date.now()): boolean {
  const longest = Math.max(...WINDOWS.map((w) => w.windowMs));
  const recent = (hits.get(key) ?? []).filter((t) => now - t < longest);
  if (WINDOWS.some((w) => recent.filter((t) => now - t < w.windowMs).length >= w.limit)) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > MAX_KEYS) {
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= longest)) hits.delete(k);
    }
  }
  return true;
}
