import type { Metadata, Viewport } from "next";
import { Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";
import { BRAND } from "@/content/site";
import { SITE_INFO } from "@/lib/siteInfo";

// 日本語の本文を読みやすく表示できるゴシック体（ビルド時に取得して自サイトから配信される）
const zenKaku = Zen_Kaku_Gothic_New({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-zen",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_INFO.siteUrl),
  title: { default: `${BRAND.name} | ${BRAND.tagline}`, template: `%s | ${BRAND.name}` },
  description: BRAND.description,
  applicationName: BRAND.name,
  formatDetection: { telephone: false },
  openGraph: {
    title: BRAND.name,
    description: BRAND.description,
    siteName: BRAND.name,
    locale: "ja_JP",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${zenKaku.variable} h-full scroll-smooth antialiased`} data-theme="black">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
