"use client";

// 「みんなのプラン」の検索欄・カテゴリーチップ・一覧。
// データはページ側で取得して渡し、ここでは受け取った一覧を画面の中で絞り込むだけ（サーバーへの問い合わせはしない）。
import { useState } from "react";

import { matchesRoutePlan, type RoutePlan } from "@/content/route-plans";
import { PLAN_CHIPS, PLANS_COPY } from "@/content/site";

import { SearchIcon } from "../icons";
import { PlanCard } from "./plan-card";

const CHIP =
  "h-9 shrink-0 rounded-full border border-line-strong px-4 text-[13px] font-medium text-fg transition-colors hover:border-fg aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-on-primary";

export function PlansBrowser({ plans }: { plans: RoutePlan[] }) {
  const [chip, setChip] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const visible = plans.filter((plan) => matchesRoutePlan(plan, chip, query));
  const filtering = chip !== null || query.trim() !== "";

  return (
    <>
      {/* 検索欄はヒーロー写真の下端に重ねる */}
      <form role="search" onSubmit={(e) => e.preventDefault()} className="relative z-10 mx-auto -mt-7 w-full max-w-[700px]">
        <label htmlFor="plans-search" className="sr-only">
          {PLANS_COPY.searchLabel}
        </label>
        <SearchIcon className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-fg" width={20} height={20} strokeWidth={1.5} />
        <input
          id="plans-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={PLANS_COPY.searchPlaceholder}
          className="h-[52px] w-full rounded-full border border-line-strong bg-surface-2 pl-[52px] pr-6 text-base text-fg outline-none transition-colors placeholder:text-fg-sub focus:border-fg-mute md:text-sm"
        />
      </form>

      <div
        className="no-scrollbar -mx-5 mt-7 flex gap-2.5 overflow-x-auto px-5 md:mx-0 md:flex-wrap md:justify-center md:px-0"
        role="group"
        aria-label={PLANS_COPY.filterLabel}
      >
        <button type="button" onClick={() => setChip(null)} aria-pressed={chip === null} className={CHIP}>
          {PLANS_COPY.all}
        </button>
        {PLAN_CHIPS.map((name) => (
          <button key={name} type="button" onClick={() => setChip(name)} aria-pressed={chip === name} className={CHIP}>
            {name}
          </button>
        ))}
      </div>

      <div className="mt-9 flex items-baseline gap-4">
        <h2 className="text-xl font-bold">{filtering ? PLANS_COPY.results : PLANS_COPY.popular}</h2>
        {filtering && (
          <p className="text-[13px] tabular-nums text-fg-mute" aria-live="polite">
            {visible.length}
            {PLANS_COPY.countUnit}
          </p>
        )}
      </div>

      {visible.length > 0 ? (
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      ) : (
        <p className="mt-5 border-t border-line py-14 text-center text-sm text-fg-sub">{PLANS_COPY.empty}</p>
      )}
    </>
  );
}
