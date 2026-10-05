import type { Metadata } from "next";
import Image from "next/image";

import { PlansBrowser } from "@/components/plans/plans-browser";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { IMAGES } from "@/content/images";
import { listRoutePlans } from "@/content/route-plans";
import { PLANS_COPY } from "@/content/site";

export const metadata: Metadata = {
  title: PLANS_COPY.title,
  description: "実際に旅した人たちのルートを、行き先やテーマから探せます。",
};

// このページは Home と違って写真を使う（ほかの旅行者のルートを「探す」ためのページなので）。
export default async function PlansPage() {
  const plans = await listRoutePlans();
  const hero = IMAGES.kyotoYasaka;
  return (
    <>
      <SiteHeader />
      <main>
        <section className="relative h-[240px] overflow-hidden md:h-[290px]">
          <Image src={hero.src} alt="" fill priority sizes="100vw" className="object-cover object-[center_42%]" />
          <div className="absolute inset-0 bg-gradient-to-r from-scrim/75 via-scrim/25 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-background to-transparent" />
          <div className="relative mx-auto max-w-[1360px] px-5 pt-12 md:px-10 md:pt-16">
            <h1 className="text-[32px] font-bold leading-tight md:text-[40px]">{PLANS_COPY.title}</h1>
            <p className="mt-4 text-[15px] leading-[1.75] md:text-lg">
              {PLANS_COPY.lead.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-[1360px] px-5 pb-16 md:px-10">
          <PlansBrowser plans={plans} />
          <p className="mt-10 text-xs text-fg-mute">{PLANS_COPY.sampleNote}</p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
