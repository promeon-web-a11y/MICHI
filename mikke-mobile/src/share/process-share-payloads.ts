/**
 * expo-sharing から受け取った Payload を解析し、URL抽出・正規化・SNS判定を行う。
 * expo-sharing は型のみ参照し、実行時には依存しない（Node で単体テスト可能にするため）。
 */
import type { ResolvedSharePayload, SharePayload } from 'expo-sharing';

import {
  detectSource,
  extractUrls,
  normalizeSharedUrlDetailed,
  parseHttpUrl,
  type ShareSource,
} from './url-utils';

export type AnalyzedPayloadItem = {
  index: number;
  shareType: string | null;
  mimeType: string | null;
  /** 受信した value（テキスト本文 / URL / ファイルURI） */
  value: string | null;
  /** getResolvedSharedPayloadsAsync() で得られた情報（取得できた場合のみ） */
  contentType: string | null;
  contentUri: string | null;
  contentMimeType: string | null;
  urls: string[];
};

export type ShareAnalysis = {
  payloadCount: number;
  items: AnalyzedPayloadItem[];
  /** テキスト系 Payload の本文（URL共有のみの場合は null） */
  receivedText: string | null;
  /** 全 Payload から抽出したURL（出現順・重複なし） */
  urls: string[];
  /** Mikke が処理対象とするURL */
  primaryUrl: string | null;
  normalizedUrl: string | null;
  removedParams: string[];
  source: ShareSource | null;
  warnings: string[];
  errors: string[];
};

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function analyzeItem(
  raw: unknown,
  resolved: unknown,
  index: number,
  warnings: string[]
): AnalyzedPayloadItem {
  const payload = (raw && typeof raw === 'object' ? raw : {}) as Partial<SharePayload>;
  const resolvedPayload = (resolved && typeof resolved === 'object' ? resolved : {}) as Partial<
    ResolvedSharePayload
  >;

  if (!raw || typeof raw !== 'object') {
    warnings.push(`payload[${index}] がオブジェクトではありません: ${String(raw)}`);
  }

  const shareType = asOptionalString(payload.shareType);
  const value = asOptionalString(payload.value);
  const contentUri = asOptionalString(resolvedPayload.contentUri);

  const urls: string[] = [];
  const add = (url: string) => {
    if (!urls.includes(url)) urls.push(url);
  };

  if (value) {
    // shareType が 'url' でも前後に空白や文章が付いてくる場合があるので、まず単体URLとして判定し、
    // ダメならテキストとして抽出する
    if (parseHttpUrl(value)) add(value.trim());
    else extractUrls(value).forEach(add);
  } else {
    warnings.push(`payload[${index}] の value が空です (shareType=${shareType ?? 'なし'})`);
  }

  // Webページ共有では contentUri に URL が入る場合がある
  if (contentUri && parseHttpUrl(contentUri)) add(contentUri);

  return {
    index,
    shareType,
    mimeType: asOptionalString(payload.mimeType),
    value,
    contentType: asOptionalString(resolvedPayload.contentType),
    contentUri,
    contentMimeType: asOptionalString(resolvedPayload.contentMimeType),
    urls,
  };
}

/**
 * 共有 Payload を解析する。どんな入力でも例外を投げず、問題は warnings / errors に積む。
 *
 * @param payloads getSharedPayloads() の結果
 * @param resolvedPayloads getResolvedSharedPayloadsAsync() の結果（取得失敗・未取得なら空配列）
 */
export function processSharePayloads(
  payloads: unknown,
  resolvedPayloads: unknown = []
): ShareAnalysis {
  const warnings: string[] = [];
  const errors: string[] = [];

  const list: unknown[] = Array.isArray(payloads) ? payloads : [];
  if (!Array.isArray(payloads)) {
    errors.push(`payloads が配列ではありません: ${typeof payloads}`);
  }
  const resolvedList: unknown[] = Array.isArray(resolvedPayloads) ? resolvedPayloads : [];

  const items: AnalyzedPayloadItem[] = [];
  list.forEach((raw, index) => {
    try {
      items.push(analyzeItem(raw, resolvedList[index], index, warnings));
    } catch (e) {
      errors.push(`payload[${index}] の解析に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const urls: string[] = [];
  for (const item of items) {
    for (const url of item.urls) if (!urls.includes(url)) urls.push(url);
  }

  const texts = items
    .filter((item) => item.value && item.shareType !== 'url' && !item.shareType?.match(/^(image|video|audio|file)$/))
    .map((item) => item.value as string);
  const receivedText = texts.length > 0 ? texts.join('\n') : null;

  if (list.length === 0) {
    warnings.push('共有 Payload が空です');
  } else if (urls.length === 0) {
    warnings.push('共有データに HTTP / HTTPS URL が含まれていません');
  } else if (urls.length > 1) {
    warnings.push(`URL が ${urls.length} 件見つかりました。SNS の URL を優先し、無ければ先頭を使用します`);
  }

  // shareType='url' の Payload → SNS の URL → 先頭 の優先順で処理対象を決める
  const urlTyped = items.find((item) => item.shareType === 'url' && item.urls.length > 0)?.urls[0];
  const firstSns = urls.find((url) => detectSource(url) !== 'web');
  const primaryUrl = urlTyped ?? firstSns ?? urls[0] ?? null;

  let normalizedUrl: string | null = null;
  let removedParams: string[] = [];
  let source: ShareSource | null = null;
  if (primaryUrl) {
    const normalized = normalizeSharedUrlDetailed(primaryUrl);
    if (!normalized.ok) errors.push(`URL を正規化できませんでした: ${primaryUrl}`);
    normalizedUrl = normalized.url;
    removedParams = normalized.removedParams;
    source = detectSource(normalizedUrl);
  }

  return {
    payloadCount: list.length,
    items,
    receivedText,
    urls,
    primaryUrl,
    normalizedUrl,
    removedParams,
    source,
    warnings,
    errors,
  };
}
