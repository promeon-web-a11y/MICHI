import Link from "next/link";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="flex min-h-[calc(100svh-var(--header-h))] flex-col items-center justify-center px-5 text-center">
        <p className="text-xs tracking-[0.2em] text-fg-mute">404</p>
        <h1 className="mt-3 text-2xl font-bold md:text-3xl">ページが見つかりませんでした</h1>
        <p className="mt-4 text-sm text-fg-sub">URLが変わったか、ページが削除された可能性があります。</p>
        <Link href="/" className="mt-8 flex h-11 items-center rounded-full bg-primary px-7 text-sm font-bold text-on-primary transition-opacity hover:opacity-90">
          Homeへ戻る
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
