import type { Metadata } from "next";

import { ContactForm } from "@/components/contact/contact-form";
import { FaqList } from "@/components/contact/faq-list";
import { PageHero } from "@/components/page-hero";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { FAQ_ITEMS } from "@/content/faq";

export const metadata: Metadata = {
  title: "Q&A・お問い合わせ",
  description: "MICHIのよくある質問と、お問い合わせフォームです。",
};

export default function ContactPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero
          eyebrow="Q&A / Contact"
          title="Q&A・お問い合わせ"
          lead="よくある質問をまとめました。解決しない場合は、下のフォームからご連絡ください。"
        />

        <div className="mx-auto max-w-[860px] px-5 py-12 md:py-20">
          <section aria-labelledby="faq-title">
            <h2 id="faq-title" className="text-xl font-bold md:text-2xl">
              よくある質問
            </h2>
            <div className="mt-6">
              <FaqList items={FAQ_ITEMS} />
            </div>
          </section>

          <section aria-labelledby="contact-title" className="mt-16 md:mt-24">
            <h2 id="contact-title" className="text-xl font-bold md:text-2xl">
              お問い合わせ
            </h2>
            <p className="mt-3 text-sm text-fg-sub">不具合のご報告、店舗情報の修正、アカウントについてなど、お気軽にご連絡ください。</p>
            <div className="mt-8 rounded-lg border border-line p-5 md:p-8">
              <ContactForm />
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
