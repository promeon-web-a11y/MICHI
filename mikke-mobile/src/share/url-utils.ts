/**
 * 共有URLの抽出・SNS判定・正規化。
 * React Native / expo に依存しない純粋関数のみを置く（Node の単体テスト対象）。
 */

export type ShareSource = 'instagram' | 'tiktok' | 'youtube' | 'web';

/**
 * http(s) URL の候補を拾う正規表現。
 * 空白・引用符・山括弧・日本語の全角記号で URL が終わるとみなす
 * （「この投稿をチェック！https://...」のように日本語と隣接するケースに対応）。
 */
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s<>"'`「」『』【】（）＜＞、。，．！？　]+/gi;

/** URL 末尾に付きがちな句読点・閉じ括弧（URL の一部ではない可能性が高いもの） */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/** 文字列を http / https の絶対URLとして解釈できれば URL オブジェクトを返す */
export function parseHttpUrl(value: string): URL | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // "https://foo" のようなドット無しホストは共有URLとしては不正扱い
    if (!url.hostname || !url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

function trimTrailingPunctuation(candidate: string): string {
  let result = candidate.replace(TRAILING_PUNCTUATION, '');
  // 閉じ括弧だけ削った結果、URL 内の対応する開き括弧が残るケース（Wikipedia 等）を戻す
  const opens = (candidate.match(/\(/g) ?? []).length;
  const closes = (result.match(/\)/g) ?? []).length;
  if (opens > closes && candidate.startsWith(result + ')')) {
    result += ')';
  }
  return result;
}

/**
 * テキスト中の HTTP / HTTPS URL をすべて抽出する（出現順・重複除去）。
 * URL が無い・入力が文字列でない場合は空配列。
 */
export function extractUrls(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const found: string[] = [];
  for (const match of text.matchAll(URL_CANDIDATE_PATTERN)) {
    const candidate = trimTrailingPunctuation(match[0]);
    if (parseHttpUrl(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/** hostname が domain 自身、またはそのサブドメインか */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const SOURCE_DOMAINS: Record<Exclude<ShareSource, 'web'>, string[]> = {
  instagram: ['instagram.com', 'instagr.am'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
};

/**
 * URL から共有元 SNS を判定する。
 * 判定できない・URL として不正な場合は 'web'。
 */
export function detectSource(url: string): ShareSource {
  const parsed = parseHttpUrl(url);
  if (!parsed) return 'web';
  const hostname = parsed.hostname.toLowerCase();
  for (const [source, domains] of Object.entries(SOURCE_DOMAINS) as [ShareSource, string[]][]) {
    if (domains.some((domain) => hostMatches(hostname, domain))) return source;
  }
  return 'web';
}

/** どのサイトでも投稿の同一性に関係しないトラッキング用パラメータ */
const COMMON_TRACKING_PARAMS = ['fbclid', 'gclid'];
const COMMON_TRACKING_PREFIXES = ['utm_'];

/**
 * SNS ごとの「共有時に付与されるだけで投稿の特定には使われない」パラメータ。
 * 投稿の特定に使われる可能性があるもの（YouTube の v / t / list、Instagram の img_index 等）は含めない。
 * 不明なパラメータは削除しない方針なので、追加は実際の共有URLで確認してから行うこと。
 */
const SOURCE_TRACKING_PARAMS: Record<ShareSource, string[]> = {
  instagram: ['igsh', 'igshid'],
  tiktok: [
    '_r',
    '_t',
    'is_from_webapp',
    'is_copy_url',
    'sender_device',
    'share_app_id',
    'share_link_id',
    'social_sharing',
    'tt_from',
    'u_code',
  ],
  youtube: ['si', 'feature'],
  web: [],
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function isRemovableParam(key: string, source: ShareSource): boolean {
  const lower = key.toLowerCase();
  if (COMMON_TRACKING_PARAMS.includes(lower)) return true;
  if (COMMON_TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return SOURCE_TRACKING_PARAMS[source].includes(lower);
}

export type NormalizeResult = {
  /** 正規化後のURL（正規化できない場合は入力をそのまま返す） */
  url: string;
  /** 削除したクエリパラメータ名 */
  removedParams: string[];
  /** 入力がURLとして解釈できなかった場合 false */
  ok: boolean;
};

/**
 * 共有URLを安全な範囲で正規化する（詳細版）。
 *
 * - スキーム・ホストの小文字化（URL の仕様上大文字小文字を区別しない部分のみ）
 * - 既知のトラッキングパラメータだけを削除
 * - パス・残りのクエリ・フラグメントは元のエンコードのまま保持する
 *   （URLSearchParams で再シリアライズするとエンコードが変わり得るため使わない）
 */
export function normalizeSharedUrlDetailed(input: string): NormalizeResult {
  const parsed = parseHttpUrl(input);
  if (!parsed) return { url: typeof input === 'string' ? input : '', removedParams: [], ok: false };
  // 認証情報付きURLは想定外なので一切触らない
  if (parsed.username || parsed.password) return { url: input.trim(), removedParams: [], ok: true };

  const source = detectSource(parsed.href);
  const removedParams: string[] = [];

  const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
  const keptPairs = rawQuery
    .split('&')
    .filter((pair) => pair.length > 0)
    .filter((pair) => {
      const key = safeDecode(pair.split('=')[0]);
      if (isRemovableParam(key, source)) {
        removedParams.push(key);
        return false;
      }
      return true;
    });

  const query = keptPairs.length > 0 ? `?${keptPairs.join('&')}` : '';
  const url = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${query}${parsed.hash}`;
  return { url, removedParams, ok: true };
}

/** 共有URLを安全な範囲で正規化する。正規化できない場合は入力をそのまま返す。 */
export function normalizeSharedUrl(input: string): string {
  return normalizeSharedUrlDetailed(input).url;
}
