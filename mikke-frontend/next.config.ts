import type { NextConfig } from "next";
import { SITE_INFO } from "./src/lib/siteInfo";

// アカウント削除依頼はサポート用メールで受け付けるため、Vercel本番ビルドで
// 窓口のメールアドレス（NEXT_PUBLIC_SUPPORT_EMAIL、未設定なら siteInfo.ts の既定値）が不正なら公開できないようにする
// （プレビュー・ローカルは警告のみ）。
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(SITE_INFO.supportEmail)) {
  const message =
    "サポート用メールアドレス（NEXT_PUBLIC_SUPPORT_EMAIL / siteInfo.ts）が不正です。お問い合わせ・アカウント削除の窓口が表示されません。";
  if (process.env.VERCEL_ENV === "production") throw new Error(message);
  console.warn(`[mikke] ${message}`);
}

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
