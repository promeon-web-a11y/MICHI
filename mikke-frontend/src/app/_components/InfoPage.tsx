// 規約・プライバシー・お問い合わせ・アカウント削除ページの共通レイアウト。
// 全ページ共通のヘッダー・フッターを使い、長文を読みやすくする（未ログインでも表示できる静的ページ）。
import Link from "next/link";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export function InfoPage({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <div className="border-b border-line">
        <div className="mx-auto max-w-[860px] px-5 py-10 md:py-14">
          <h1 className="text-[28px] font-bold leading-tight md:text-4xl">{title}</h1>
          {meta && <div className="mt-3 text-sm text-fg-sub">{meta}</div>}
        </div>
      </div>
      <main className="mx-auto max-w-[860px] px-5 py-10 md:py-14">
        <article className="space-y-8 break-words text-[15px] leading-7 text-fg-sub">{children}</article>
      </main>
      <SiteFooter />
    </>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="border-l border-fg pl-3 text-base font-bold text-fg sm:text-lg">{title}</h2>
      {children}
    </section>
  );
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 marker:text-fg-mute">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

export function Numbered({ items }: { items: ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 marker:text-fg-mute">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ol>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm leading-6">{children}</div>
  );
}

export function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-fg underline underline-offset-2">
      {children}
    </Link>
  );
}
