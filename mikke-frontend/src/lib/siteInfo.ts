// 規約・プライバシーポリシー・お問い合わせ・アカウント削除ページで使う運営者情報（公開情報の一元管理）。
// URL・メールアドレスが変わったときは、環境変数（Vercel）か、このファイルの既定値だけを変更する。
// - サポート用メールアドレス: アカウント削除依頼の窓口。環境変数 NEXT_PUBLIC_SUPPORT_EMAIL を優先する
//   （Vercel本番ビルドでは環境変数が未設定・不正だとビルドを止める。next.config.ts 参照）
// - 公開URL: 環境変数 NEXT_PUBLIC_SITE_URL を優先する（独自ドメインへ移行するときに変更）
// 「［…］」のままの項目は公開前に人間が確定する必要がある（未確定のまま画面にも［…］と表示される）。
const DEFAULT_SUPPORT_EMAIL = "satokazu.promeon@gmail.com";
const DEFAULT_SITE_URL = "https://mikke-frontend.vercel.app";

export const SITE_INFO = {
  serviceName: "Mikke",
  operatorName: "佐藤 和樹",
  // 個人運営のため住所は掲載せず、請求があった場合に開示する
  operatorAddress: "請求があった場合には、遅滞なく開示します",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL,
  siteUrl: (process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, ""),
  description: "SNSで見つけた気になる場所を保存して、AIがおでかけプランを提案するMikke",
  termsEnactedOn: "2026年9月27日",
  privacyEnactedOn: "2026年9月27日",
} as const;

export function isPlaceholder(value: string): boolean {
  return /［[^］]*］/.test(value);
}

// mailto リンクは、実際のメールアドレスが設定された場合だけ作る（仮の文字列へのリンクは作らない）。
export function supportMailto(subject?: string, body?: string): string | null {
  const email = SITE_INFO.supportEmail;
  if (isPlaceholder(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const params = [
    subject && `subject=${encodeURIComponent(subject)}`,
    body && `body=${encodeURIComponent(body)}`,
  ].filter(Boolean);
  return params.length ? `mailto:${email}?${params.join("&")}` : `mailto:${email}`;
}
