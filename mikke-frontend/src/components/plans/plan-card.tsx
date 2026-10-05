// 「みんなのプラン」のカード1枚。押すとルート詳細（/plans/[id]）を開く。
// 色を持つのは写真だけ。カード自体は黒〜濃いグレーと細い線で組む。
import Image from "next/image";
import Link from "next/link";

import { IMAGES } from "@/content/images";
import type { RoutePlan } from "@/content/route-plans";
import { PLANS_COPY } from "@/content/site";

import { Avatar } from "../avatar";
import { BookmarkIcon, ClockIcon, HeartIcon, YenIcon } from "../icons";

export function PlanCard({ plan }: { plan: RoutePlan }) {
  const image = IMAGES[plan.image];
  return (
    <article className="relative flex flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-line-strong">
      <div className="relative aspect-[16/10] overflow-hidden bg-surface-2">
        <Image
          src={image.src}
          alt={image.alt}
          fill
          sizes="(min-width: 1280px) 320px, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
          className="object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-surface to-transparent" />
        <span className="absolute left-3.5 top-3.5 rounded-full bg-fg/90 px-2.5 py-px text-xs font-medium text-background">{plan.region}</span>
      </div>

      <div className="-mt-9 flex flex-1 flex-col px-4 pb-4">
        <h3 className="relative line-clamp-2 min-h-[3.25rem] text-[17px] font-bold leading-[1.55]">
          {/* カード全体を押せるようにする（after でカードいっぱいに広げる） */}
          <Link href={`/plans/${plan.id}`} className="after:absolute after:-inset-x-4 after:-bottom-40 after:-top-60">
            {plan.title}
          </Link>
        </h3>

        <div className="mt-3 flex items-center gap-5 text-[13px] tabular-nums text-fg-sub">
          <span className="flex items-center gap-1.5">
            <ClockIcon width={15} height={15} strokeWidth={1.5} />
            {plan.daysLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <YenIcon width={15} height={15} strokeWidth={1.5} />
            {plan.budgetYen.toLocaleString("ja-JP")}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <HeartIcon width={16} height={16} strokeWidth={1.5} />
            <span className="sr-only">{PLANS_COPY.likes}</span>
            {plan.likeCount}
          </span>
        </div>

        <div className="mt-4 flex items-center justify-between text-[13px]">
          <span className="flex items-center gap-2.5">
            <Avatar name={plan.author} size={28} />
            {plan.author}
          </span>
          {/* 保存はログイン機能の公開後に使えるようにする。いまは目印だけ */}
          <BookmarkIcon className="text-fg-sub" width={20} height={20} strokeWidth={1.5} />
        </div>
      </div>
    </article>
  );
}
