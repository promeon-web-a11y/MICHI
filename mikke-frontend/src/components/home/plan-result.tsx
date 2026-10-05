// AI が作ったプランの表示（番号 → 時刻 → 場所 → 移動 を縦1列に並べる。ルート詳細の「旅のスケジュール」と同じ見た目）。
// 見出しやボタンの言語は、プランの文章の言語（plan.language）に合わせる。場所の名前・住所は受け取った値をそのまま出す。
import Image from "next/image";

import type { Locale } from "@/content/locale";
import { siteCopy, type SiteCopy } from "@/content/site";
import { conditionLabels, formatAbout, formatDuration, formatLeg, formatPartyNote, formatYen, listSeparator } from "@/services/plan/format";
import type { PlanLeg, PlanStop, TripPlan } from "@/services/plan/types";

import { CautionIcon, ClockIcon, ExternalIcon, PinIcon, TransitIcon, YenIcon } from "../icons";

type RowProps = { stop: PlanStop; index: number; leg: PlanLeg | undefined; last: boolean; locale: Locale; copy: SiteCopy["result"] };

function StopRow({ stop, index, leg, last, locale, copy: RESULT_COPY }: RowProps) {
  const meta = [
    stop.category,
    `${RESULT_COPY.stay} ${formatAbout(formatDuration(stop.stayMinutes, locale), locale)}`,
    // 0円は「無料」と言い切らず、金額を出さない（AI の見積もりで、入場料などの事実ではないため）
    stop.estimatedCostYen ? `${RESULT_COPY.estimate} ${formatYen(stop.estimatedCostYen)}` : null,
  ].filter(Boolean);
  return (
    <li className="relative grid grid-cols-[32px_1fr] gap-x-4 md:grid-cols-[32px_64px_1fr] md:gap-x-5">
      {!last && <span className="absolute bottom-0 left-4 top-9 border-l border-dashed border-line-strong" aria-hidden="true" />}
      <span className="relative mt-4 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-on-primary">
        {index + 1}
      </span>
      <p className="hidden pt-5 text-[15px] font-medium tabular-nums md:block">{stop.arrival}</p>
      <div className={`flex flex-col-reverse gap-3 py-4 md:flex-row md:gap-6 ${last ? "" : "border-b border-line"}`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums text-fg-sub md:hidden">{stop.arrival}</p>
          <h3 className="text-[17px] font-bold leading-snug">{stop.name}</h3>
          <p className="mt-1 text-[13px] text-fg-mute">{meta.join(listSeparator(locale))}</p>
          {stop.description && <p className="mt-1.5 text-sm leading-relaxed text-fg-sub">{stop.description}</p>}
          {stop.openingHours && (
            <p className="mt-1.5 text-[13px] tabular-nums text-fg-mute">
              {RESULT_COPY.hours}: {stop.openingHours}
            </p>
          )}
          {stop.notes?.map((note) => (
            <p key={note} className="mt-1.5 flex gap-1.5 text-[13px] leading-relaxed text-fg-sub">
              <CautionIcon className="mt-[3px] shrink-0 text-caution" width={14} height={14} />
              {note}
            </p>
          ))}
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-mute">{stop.address}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-fg-sub">
            {leg && (
              <span className="flex items-center gap-1.5">
                <TransitIcon width={15} height={15} />
                {formatLeg(leg, locale)}
              </span>
            )}
            {stop.mapsUrl && (
              <a
                href={stop.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-fg underline-offset-4 hover:underline"
              >
                {RESULT_COPY.openMap}
                <ExternalIcon width={13} height={13} />
              </a>
            )}
          </div>
        </div>
        {stop.photoUrl && (
          <div className="shrink-0">
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md bg-surface-2 md:aspect-auto md:h-[84px] md:w-[168px]">
              {/* /api/place-photo が Google の写真を中継する（最適化は通さない） */}
              <Image src={stop.photoUrl} alt="" fill sizes="(min-width: 768px) 168px, 100vw" unoptimized className="object-cover" />
            </div>
            {stop.photoCredit && (
              <p className="mt-1 truncate text-[10px] text-fg-mute md:w-[168px]">
                {RESULT_COPY.photo}: {stop.photoCredit}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function PlanResult({
  plan,
  busy,
  errorMessage,
  onRetry,
  onEdit,
}: {
  plan: TripPlan;
  busy: boolean;
  /** 作り直しに失敗したときの文言（ボタンの近くに出す） */
  errorMessage: string | null;
  onRetry: () => void;
  onEdit: () => void;
}) {
  // language が無いプラン（古い形）は日本語として表示する
  const locale: Locale = plan.language ?? "ja";
  const RESULT_COPY = siteCopy(locale).result;
  const labels = conditionLabels(plan.conditions, locale);
  const party = plan.conditions.partySize;
  const notices = [...(plan.warnings ?? []), ...(plan.conflicts ?? [])];
  const assumptions = plan.assumptions ?? [];
  const unresolved = plan.unresolvedConstraints ?? [];
  return (
    <section lang={locale} aria-labelledby="plan-title" className="border-t border-line">
      <div className="anim-fade-in mx-auto max-w-[920px] px-5 py-12 md:py-16">
        <p className="text-xs tracking-[0.2em] text-fg-mute">{RESULT_COPY.eyebrow}</p>
        <h2 id="plan-title" className="mt-3 text-[26px] font-bold leading-tight md:text-[34px]">
          {plan.title}
        </h2>
        {plan.summary && <p className="mt-3 text-sm text-fg-sub md:text-[15px]">{plan.summary}</p>}
        {/* 確認できていないこと・食い違いは、プランより先に見せる（文は Route Planner が決まった文で付ける。AI は書かない） */}
        {notices.length > 0 && (
          <div className="mt-5 rounded-lg border border-line-strong px-4 py-3">
            <p className="flex items-center gap-2 text-[13px] font-bold text-fg">
              <CautionIcon className="shrink-0 text-caution" width={17} height={17} />
              {RESULT_COPY.notices}
            </p>
            <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-fg-sub">
              {notices.map((notice) => (
                <li key={notice.code + notice.message}>{notice.message}</li>
              ))}
            </ul>
          </div>
        )}

        {labels.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {labels.map((label) => (
              <span key={label} className="rounded-full border border-line-strong px-3 py-0.5 text-[13px] text-fg-sub">
                {label}
              </span>
            ))}
          </div>
        )}

        <dl className="mt-7 flex flex-wrap gap-x-14 gap-y-4 border-y border-line py-4">
          <div className="flex items-center gap-3">
            <ClockIcon className="text-fg-sub" width={22} height={22} strokeWidth={1.5} />
            <div>
              <dt className="text-xs text-fg-mute">{RESULT_COPY.time}</dt>
              <dd className="text-[15px] font-bold tabular-nums">
                {plan.startTime} – {plan.endTime}
              </dd>
            </div>
          </div>
          {plan.totalCostYen !== null && (
            <div className="flex items-center gap-3">
              <YenIcon className="text-fg-sub" width={22} height={22} strokeWidth={1.5} />
              <div>
                <dt className="text-xs text-fg-mute">
                  {RESULT_COPY.budget}
                  {party ? formatPartyNote(party, locale) : ""}
                </dt>
                <dd className="text-[15px] font-bold tabular-nums">{formatAbout(formatYen(plan.totalCostYen), locale)}</dd>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <PinIcon className="text-fg-sub" width={22} height={22} strokeWidth={1.5} />
            <div>
              <dt className="text-xs text-fg-mute">{RESULT_COPY.stops}</dt>
              <dd className="text-[15px] font-bold tabular-nums">
                {plan.stops.length}
                {RESULT_COPY.stopsUnit}
              </dd>
            </div>
          </div>
        </dl>

        <h3 className="mt-9 text-xl font-bold">{RESULT_COPY.schedule}</h3>
        <ol className="mt-2">
          {plan.stops.map((stop, index) => (
            <StopRow
              key={stop.placeId}
              stop={stop}
              index={index}
              leg={plan.legs[index]}
              last={index === plan.stops.length - 1}
              locale={locale}
              copy={RESULT_COPY}
            />
          ))}
        </ol>

        {(assumptions.length > 0 || unresolved.length > 0) && (
          <div className="mt-8 grid gap-6 border-t border-line pt-6 text-[13px] leading-relaxed md:grid-cols-2">
            {assumptions.length > 0 && (
              <div>
                <p className="font-bold text-fg-sub">{RESULT_COPY.assumptions}</p>
                <ul className="mt-2 space-y-1.5 text-fg-mute">
                  {assumptions.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            )}
            {unresolved.length > 0 && (
              <div>
                <p className="font-bold text-fg-sub">{RESULT_COPY.unresolved}</p>
                <ul className="mt-2 space-y-1.5 text-fg-mute">
                  {unresolved.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <p className="mt-8 text-[13px] leading-relaxed text-fg-mute">{RESULT_COPY.disclaimer}</p>

        {errorMessage && (
          <p role="alert" className="mt-6 text-sm font-medium text-danger">
            {errorMessage}
          </p>
        )}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="h-11 rounded-full bg-primary px-7 text-sm font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? RESULT_COPY.retrying : RESULT_COPY.retry}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="h-11 rounded-full border border-line-strong px-7 text-sm font-bold transition-colors hover:border-fg"
          >
            {RESULT_COPY.edit}
          </button>
        </div>
      </div>
    </section>
  );
}
