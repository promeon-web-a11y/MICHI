/**
 * 公開ページ（利用規約・プライバシーポリシー・お問い合わせ・アカウント削除の案内）の URL を一元管理する。
 * ページ本体は mikke-frontend（Web）にあり、アプリからはアプリ内ブラウザで開く。
 *
 * Web の URL は環境変数 EXPO_PUBLIC_WEB_BASE_URL（公開して問題ない値）で変更できる。
 * 未設定・不正なら DEFAULT_WEB_BASE_URL を使う（EAS Build で環境変数を入れ忘れてもリンクが切れないように）。
 * 独自ドメインへ移行するときは、環境変数かこの既定値だけを変更する。
 * React Native に依存しない（Node で単体テストする）。
 */
export const DEFAULT_WEB_BASE_URL = 'https://mikke-frontend.vercel.app';

export const PUBLIC_PAGES = {
  terms: { path: '/terms', label: '利用規約' },
  privacy: { path: '/privacy', label: 'プライバシーポリシー' },
  contact: { path: '/contact', label: 'お問い合わせ' },
  accountDelete: { path: '/account/delete', label: 'アカウント削除について' },
} as const;

export type PublicPageKey = keyof typeof PUBLIC_PAGES;

/** https の URL だけを受け付け、末尾の / を除く。不正なら既定値 */
export function resolveWebBaseUrl(raw: string | null | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_WEB_BASE_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.search || url.hash) return DEFAULT_WEB_BASE_URL;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_WEB_BASE_URL;
  }
}

// process.env.EXPO_PUBLIC_* はビルド時に埋め込まれる（参照はこの形のまま書く必要がある）
export const WEB_BASE_URL = resolveWebBaseUrl(process.env.EXPO_PUBLIC_WEB_BASE_URL);

export function publicPageUrl(key: PublicPageKey, baseUrl: string = WEB_BASE_URL): string {
  return `${baseUrl}${PUBLIC_PAGES[key].path}`;
}
