import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { Avatar } from "@/components/avatar";
import {
  ArrowRightIcon,
  BookmarkIcon,
  CalendarIcon,
  CardIcon,
  CautionIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  DotsIcon,
  HeartIcon,
  LeafIcon,
  LuggageIcon,
  MenuBookIcon,
  PinIcon,
  SpeechIcon,
  StarIcon,
  TransitIcon,
  UsersIcon,
  YenIcon,
} from "@/components/icons";
import { RouteMap } from "@/components/routes/route-map";
import { ShareButton } from "@/components/routes/share-button";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { IMAGES } from "@/content/images";
import { getRoutePlan, listRoutePlans, routeDirectionsUrl, stopMapUrl, type RoutePlan, type TravelerInfoKey } from "@/content/route-plans";
import { ROUTE_COPY, TRAVELER_INFO_LABELS } from "@/content/site";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const TRAVELER_INFO_ICONS: Record<TravelerInfoKey, IconType> = {
  englishMenu: MenuBookIcon,
  englishStaff: SpeechIcon,
  creditCard: CardIcon,
  reservation: CalendarIcon,
  vegetarian: LeafIcon,
  luggage: LuggageIcon,
};

const yen = (value: number) => `${ROUTE_COPY.about} ${value.toLocaleString("ja-JP")} ${ROUTE_COPY.yen}`;

export async function generateStaticParams() {
  return (await listRoutePlans()).map((plan) => ({ id: plan.id }));
}

export async function generateMetadata(props: PageProps<"/plans/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const plan = await getRoutePlan(id);
  return plan ? { title: plan.title, description: plan.lead } : {};
}

/** 所要時間・予算・移動手段・旅のスタイル（ヒーローのすぐ下に横1列で並べる） */
function SummaryRow({ plan }: { plan: RoutePlan }) {
  const items: { icon: IconType; label: string; value: string }[] = [
    { icon: ClockIcon, label: ROUTE_COPY.duration, value: plan.durationLabel },
    { icon: YenIcon, label: ROUTE_COPY.budget, value: yen(plan.budgetYen) },
    { icon: TransitIcon, label: ROUTE_COPY.transport, value: plan.transportLabel },
    { icon: UsersIcon, label: ROUTE_COPY.style, value: plan.styles.join("・") },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-line py-5 md:grid-cols-4">
      {items.map(({ icon: Icon, label, value }) => (
        <div key={label} className="flex items-center gap-3.5">
          <Icon className="shrink-0 text-fg" width={24} height={24} strokeWidth={1.4} />
          <div className="min-w-0">
            <dt className="text-xs text-fg-mute">{label}</dt>
            <dd className="text-sm font-bold">{value}</dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

function Timeline({ plan }: { plan: RoutePlan }) {
  return (
    <ol className="mt-3">
      {plan.stops.map((stop, index) => {
        const last = index === plan.stops.length - 1;
        const image = stop.image ? IMAGES[stop.image] : null;
        return (
          <li key={`${stop.time}-${stop.name}`} className="relative grid grid-cols-[32px_1fr] gap-x-4 md:grid-cols-[32px_60px_1fr] md:gap-x-5">
            {!last && <span className="absolute bottom-0 left-4 top-9 border-l border-dashed border-line-strong" aria-hidden="true" />}
            <span className="relative mt-4 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-on-primary">
              {index + 1}
            </span>
            <p className="hidden pt-[18px] text-[15px] font-medium tabular-nums md:block">{stop.time}</p>
            <div className={`relative flex items-start gap-5 py-3.5 ${last ? "" : "border-b border-line"}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium tabular-nums text-fg-sub md:hidden">{stop.time}</p>
                <h3 className="text-[17px] font-bold leading-snug">
                  <a
                    href={stopMapUrl(plan, stop)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${stop.name}（${ROUTE_COPY.openSpot}）`}
                    className="after:absolute after:inset-0"
                  >
                    {stop.name}
                  </a>
                </h3>
                <p className="mt-1 max-w-[440px] text-[13px] leading-relaxed text-fg-sub">{stop.description}</p>
                {stop.next && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-fg-sub">
                    <TransitIcon width={15} height={15} strokeWidth={1.5} />
                    {stop.next.label} {ROUTE_COPY.about}
                    {stop.next.minutes}分
                  </p>
                )}
              </div>
              {image && (
                <div className="relative hidden h-[82px] w-[168px] shrink-0 overflow-hidden rounded-md bg-surface-2 sm:block">
                  <Image src={image.src} alt={image.alt} fill sizes="168px" className="object-cover" />
                </div>
              )}
              <ChevronRightIcon className="shrink-0 self-center text-fg" width={18} height={18} strokeWidth={1.5} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** 右サイドパネルの枠（細い線で囲むだけ） */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line px-4 pb-4 pt-3.5">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

function Sidebar({ plan }: { plan: RoutePlan }) {
  const about: { icon: IconType; label: string; value: string }[] = [
    { icon: ClockIcon, label: ROUTE_COPY.totalDuration, value: plan.durationLabel },
    { icon: YenIcon, label: ROUTE_COPY.budget, value: yen(plan.budgetYen) },
    { icon: PinIcon, label: ROUTE_COPY.spots, value: `${plan.stops.length} ${ROUTE_COPY.spotsUnit}` },
    { icon: TransitIcon, label: ROUTE_COPY.transport, value: plan.transportLabel },
    { icon: UsersIcon, label: ROUTE_COPY.style, value: plan.styles.join("・") },
  ];
  return (
    <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h)+20px)] lg:self-start">
      <div className="space-y-2.5">
        <a
          href={routeDirectionsUrl(plan)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 items-center justify-center gap-2.5 rounded-full bg-primary text-[13px] font-bold text-on-primary transition-opacity hover:opacity-90"
        >
          {ROUTE_COPY.go}
          <ArrowRightIcon width={16} height={16} />
        </a>
        <Link
          href={`/?q=${encodeURIComponent(plan.prompt)}`}
          className="flex h-11 items-center justify-center gap-2.5 rounded-full bg-surface-2 text-[13px] font-medium transition-colors hover:bg-surface-3"
        >
          {ROUTE_COPY.customize}
          <ArrowRightIcon width={16} height={16} />
        </Link>
        {/* 保存はログイン機能の公開後に使えるようにする（いまは押せない） */}
        <button
          type="button"
          disabled
          title={ROUTE_COPY.comingSoon}
          className="flex h-11 w-full cursor-default items-center justify-center gap-2.5 rounded-full border border-line-strong text-[13px] font-medium"
        >
          <BookmarkIcon width={17} height={17} strokeWidth={1.5} />
          {ROUTE_COPY.save}
        </button>
      </div>

      <Panel title={ROUTE_COPY.aboutRoute}>
        <dl className="mt-3 space-y-2.5">
          {about.map(({ icon: Icon, label, value }) => (
            <div key={label} className="grid grid-cols-[18px_112px_1fr] items-center gap-x-4 text-xs">
              <Icon className="text-fg" width={18} height={18} strokeWidth={1.4} />
              <dt className="text-fg-sub">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title={ROUTE_COPY.travelerInfo}>
        <dl className="mt-2">
          {plan.travelerInfo.map((item) => {
            const Icon = TRAVELER_INFO_ICONS[item.key];
            return (
              <div key={item.key} className="grid grid-cols-[18px_1fr_132px] items-center gap-x-4 border-b border-line py-2 text-xs">
                <Icon className="text-fg" width={18} height={18} strokeWidth={1.4} />
                <dt className="text-fg-sub">{TRAVELER_INFO_LABELS[item.key]}</dt>
                <dd className="flex items-center gap-2.5 font-medium">
                  {item.status === "ok" ? (
                    <CheckCircleIcon className="shrink-0 text-positive" width={17} height={17} />
                  ) : (
                    <CautionIcon className="shrink-0 text-caution" width={17} height={17} strokeWidth={2} />
                  )}
                  {item.value}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-3 text-[11px] text-fg-mute">{ROUTE_COPY.travelerInfoNote(plan.reviewCount)}</p>
      </Panel>

      <section className="pt-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-bold">
            {ROUTE_COPY.comments} <span className="tabular-nums">({plan.reviewCount})</span>
          </h2>
          {/* コメントの投稿はログイン機能の公開後に使えるようにする（いまは押せない） */}
          <button
            type="button"
            disabled
            title={ROUTE_COPY.comingSoon}
            className="h-8 cursor-default rounded-full border border-line-strong px-3.5 text-xs font-medium"
          >
            {ROUTE_COPY.postComment}
          </button>
        </div>
        <ul className="mt-2">
          {plan.comments.map((comment) => (
            <li key={`${comment.author}-${comment.postedOn}`} className="grid grid-cols-[36px_1fr] gap-x-3 border-b border-line py-4 last:border-b-0">
              <Avatar name={comment.author} size={36} />
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 text-xs">
                  <span className="text-[13px] font-medium">{comment.author}</span>
                  <span className="tabular-nums text-fg-mute">{comment.postedOn}</span>
                  <span className="ml-auto flex items-center gap-1.5 tabular-nums">
                    <HeartIcon width={15} height={15} strokeWidth={1.5} />
                    {comment.likeCount}
                  </span>
                  <DotsIcon className="text-fg-sub" width={18} height={18} strokeWidth={2.4} />
                </div>
                {/* コメントは旅行者が書いた言語のまま表示する */}
                <p lang="en" className="mt-1.5 text-xs leading-[1.75] text-fg-sub">
                  {comment.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

export default async function RoutePlanPage(props: PageProps<"/plans/[id]">) {
  const { id } = await props.params;
  const plan = await getRoutePlan(id);
  if (!plan) notFound();
  const hero = IMAGES[plan.image];

  return (
    <>
      <SiteHeader />
      <main className="mx-auto grid max-w-[1360px] gap-x-9 gap-y-10 px-5 pb-16 md:px-10 lg:grid-cols-[minmax(0,1fr)_352px]">
        <article className="min-w-0">
          <header className="relative -mx-5 overflow-hidden md:-mx-10 lg:mr-0">
            <Image src={hero.src} alt={hero.alt} fill priority sizes="(min-width: 1024px) 70vw, 100vw" className="object-cover" />
            <div className="absolute inset-0 bg-gradient-to-r from-scrim/85 via-scrim/45 to-transparent" />
            <div className="relative px-5 pb-5 pt-6 md:px-10">
              <span className="rounded-full bg-fg/90 px-2.5 py-px text-xs font-medium text-background">{plan.region}</span>
              <h1 className="mt-3 max-w-[520px] text-[28px] font-bold leading-[1.3] md:text-[34px]">{plan.title}</h1>
              <p className="mt-3 max-w-[560px] text-[13px] leading-[1.75]">{plan.lead}</p>
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px]">
                <span className="flex items-center gap-3">
                  <Avatar name={plan.author} size={36} />
                  <span className="leading-tight">
                    <span className="block font-medium">{plan.author}</span>
                    <span className="block text-[11px] tabular-nums text-fg-sub">{plan.postedOn}</span>
                  </span>
                </span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <StarIcon width={18} height={18} strokeWidth={1.5} />
                  {plan.rating.toFixed(1)} ({plan.reviewCount}
                  {ROUTE_COPY.reviewsUnit})
                </span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <HeartIcon width={19} height={19} strokeWidth={1.5} />
                  <span className="sr-only">{ROUTE_COPY.like}</span>
                  {plan.likeCount}
                </span>
                <BookmarkIcon width={19} height={19} strokeWidth={1.5} aria-hidden="true" />
                <ShareButton title={plan.title} />
              </div>
            </div>
          </header>

          <SummaryRow plan={plan} />

          <div className="mt-5">
            <RouteMap stops={plan.stops} href={routeDirectionsUrl(plan)} />
          </div>

          <section aria-labelledby="schedule-title" className="mt-7">
            <h2 id="schedule-title" className="text-xl font-bold">
              {ROUTE_COPY.schedule}
            </h2>
            <Timeline plan={plan} />
          </section>
        </article>

        <div className="lg:pt-6">
          <Sidebar plan={plan} />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
