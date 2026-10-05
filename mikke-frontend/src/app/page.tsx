import type { Metadata } from "next";
import { headers } from "next/headers";

import { HomeExperience } from "@/components/home/home-experience";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { resolveLocale, type Locale } from "@/content/locale";
import { siteCopy } from "@/content/site";
import { PROMPT_MAX_LENGTH } from "@/services/plan/types";

// 表示言語: ?lang=en / ?lang=ja の指定を優先し、無ければブラウザの言語設定で決める（日本語のブラウザは日本語のまま）
async function homeLocale(props: PageProps<"/">): Promise<Locale> {
  const { lang } = await props.searchParams;
  return resolveLocale(lang, (await headers()).get("accept-language"));
}

export async function generateMetadata(props: PageProps<"/">): Promise<Metadata> {
  const locale = await homeLocale(props);
  // 日本語は layout.tsx の既定のまま
  if (locale === "ja") return {};
  const { brand } = siteCopy(locale);
  return {
    title: { absolute: `${brand.name} | ${brand.tagline}` },
    description: brand.description,
    openGraph: { title: brand.name, description: brand.description, siteName: brand.name, locale: "en_US", type: "website" },
  };
}

// Home は「AI 入力欄」が中心の画面。写真・おすすめなどは置かない（探すのは「みんなのプラン」の役割）。
// 英語のときだけ、入力欄の上にサービスの説明、下に入力例を出す（content/site.ts の SITE_COPY_EN）。
export default async function HomePage(props: PageProps<"/">) {
  // ルート詳細の「AIで自分向けに変更」から来たときは、そのルートの条件を入力欄に入れておく（?q=）
  const { q } = await props.searchParams;
  const initialPrompt = typeof q === "string" ? q.trim().slice(0, PROMPT_MAX_LENGTH) : "";
  const locale = await homeLocale(props);

  return (
    <>
      <SiteHeader locale={locale} languageSwitch />
      <main lang={locale}>
        <HomeExperience initialPrompt={initialPrompt} locale={locale} />
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}
