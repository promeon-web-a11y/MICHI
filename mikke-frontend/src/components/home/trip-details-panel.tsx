"use client";

// 詳細設定のパネル（入力欄の横のボタンで開く）。スマホは画面下からのシート、PC は中央のパネル。
// <dialog> を使うので、Esc で閉じる・フォーカスを中に留める・閉じたらボタンへ戻す、はブラウザに任せる。
// よく使う条件を先に見せ、食事の制限・避けたいこと・さらに詳しい条件は折りたたんでおく。
// 入力の値は親（HomeExperience）が持つので、閉じても消えない。
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Locale } from "@/content/locale";
import type { TripDetailsCopy } from "@/content/site";
import {
  ALLERGY_OPTIONS,
  AVOID_OPTIONS,
  DESTINATION_OPTIONS,
  DIETARY_OPTIONS,
  ENABLED_CURRENCIES,
  FOOD_OPTIONS,
  GROUP_NEED_OPTIONS,
  INTEREST_OPTIONS,
  PACE_OPTIONS,
  SETTING_OPTIONS,
  SPOT_STYLE_OPTIONS,
  TRANSPORT_OPTIONS,
  TRAVELER_COUNT_MAX,
  TRAVELER_TYPE_OPTIONS,
  WALKING_OPTIONS,
  type CurrencyCode,
  type TripDetails,
} from "@/services/plan/trip-request";

import { ChevronRightIcon, CloseIcon, MinusIcon, PlusIcon } from "../icons";

const CHIP =
  "h-10 rounded-full border border-line-strong px-3.5 text-[13px] font-medium text-fg-sub transition-colors hover:border-fg-mute hover:text-fg aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-on-primary md:h-9";
// 入力欄の文字は 16px 以上（iPhone Safari が勝手に拡大しないように）
const INPUT =
  "h-11 w-full min-w-0 rounded-lg border border-line-strong bg-surface-2 px-3 text-base text-fg outline-none transition-colors placeholder:text-fg-mute focus:border-fg-mute md:text-sm";
const LABEL = "block text-[13px] font-medium text-fg-sub";
const TEXT_MAX = 60;

type ChipOption<T extends string> = { id: T; label: Record<Locale, string> };

function Chips<T extends string>({
  label,
  options,
  selected,
  onToggle,
  locale,
  hideLabel = false,
}: {
  label: string;
  options: readonly ChipOption<T>[];
  selected: readonly T[];
  onToggle: (id: T) => void;
  locale: Locale;
  /** 見出しを画面に出さない（すぐ上に同じ見出しがあるとき）。読み上げには使う */
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <p id={id} className={hideLabel ? "sr-only" : LABEL}>
        {label}
      </p>
      <div role="group" aria-labelledby={id} className={`flex flex-wrap gap-2 ${hideLabel ? "" : "mt-2"}`}>
        {options.map((option) => (
          <button key={option.id} type="button" aria-pressed={selected.includes(option.id)} onClick={() => onToggle(option.id)} className={CHIP}>
            {option.label[locale]}
          </button>
        ))}
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  hideLabel = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={hideLabel ? "sr-only" : LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={TEXT_MAX * 3}
        autoComplete="off"
        className={`${INPUT} ${hideLabel ? "" : "mt-2"}`}
      />
    </div>
  );
}

function Section({ title, count, defaultOpen, children }: { title: string; count: number; defaultOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex h-[52px] w-full items-center justify-between gap-3 text-left text-sm font-bold"
      >
        <span>
          {title}
          {count > 0 && <span className="ml-2 text-xs font-medium tabular-nums text-accent">{count}</span>}
        </span>
        <ChevronRightIcon width={18} height={18} className={`shrink-0 text-fg-mute transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      <div id={id} hidden={!open} className="space-y-5 pb-6">
        {children}
      </div>
    </div>
  );
}

const toggleIn = <T extends string>(list: readonly T[], id: T): T[] => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
type ListKey = "destinations" | "interests" | "foods" | "transportation" | "dietary" | "allergies" | "avoid" | "groupNeeds";
type ChoiceKey = "travelerType" | "pace" | "walking" | "setting" | "spotStyle";
const filled = (...values: string[]) => values.filter((value) => value.trim() !== "").length;

export function TripDetailsPanel({
  open,
  details,
  count,
  locale,
  copy,
  submitLabel,
  canSubmit,
  onChange,
  onClear,
  onClose,
  onSubmit,
}: {
  open: boolean;
  details: TripDetails;
  /** 設定済みの条件の数（0 のときは「すべてクリア」を押せない） */
  count: number;
  locale: Locale;
  copy: TripDetailsCopy;
  submitLabel: string;
  canSubmit: boolean;
  /** 前の値から次の値を作る関数を渡す（続けて押しても、前の変更を取りこぼさない） */
  onChange: (update: (previous: TripDetails) => TripDetails) => void;
  onClear: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const timeId = useId();
  const dateId = useId();
  const budgetId = useId();
  const travelersId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const set = <K extends keyof TripDetails>(key: K, value: TripDetails[K]) => onChange((previous) => ({ ...previous, [key]: value }));
  /** 複数選べる項目: 押したものを足す／外す */
  const toggle = <K extends ListKey>(key: K, id: TripDetails[K][number]) =>
    onChange((previous) => ({ ...previous, [key]: toggleIn<string>(previous[key], id) }));
  /** 1つだけ選ぶ項目: もう一度押すと外れる */
  const pick = <K extends ChoiceKey>(key: K, id: NonNullable<TripDetails[K]>) =>
    onChange((previous) => ({ ...previous, [key]: previous[key] === id ? null : id }));
  const stepTravelers = (delta: number) =>
    onChange((previous) => {
      const next = (previous.travelerCount ?? 0) + delta;
      return { ...previous, travelerCount: next < 1 ? null : Math.min(TRAVELER_COUNT_MAX, next) };
    });

  const dietaryCount = details.dietary.length + details.allergies.length + filled(details.allergiesOther);
  const avoidCount = details.avoid.length + filled(details.avoidOther);
  const moreCount =
    details.groupNeeds.length +
    [details.walking, details.setting, details.spotStyle].filter(Boolean).length +
    filled(details.startingPoint, details.endingPoint, details.mustVisit);

  return (
    <dialog
      ref={dialogRef}
      lang={locale}
      aria-labelledby={titleId}
      onClose={onClose}
      // パネルの外（暗い部分）を押したら閉じる
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 m-0 mt-auto max-h-[90svh] w-full max-w-full flex-col overflow-hidden rounded-t-[20px] border border-line-strong bg-surface p-0 text-fg backdrop:bg-scrim/70 open:flex md:m-auto md:max-h-[84svh] md:max-w-[560px] md:rounded-[20px]"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line py-2 pl-5 pr-2">
        <h2 id={titleId} className="text-base font-bold">
          {copy.title}
        </h2>
        <button type="button" onClick={onClose} aria-label={copy.close} className="flex h-11 w-11 items-center justify-center text-fg-sub hover:text-fg">
          <CloseIcon width={22} height={22} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]">
        <p className="pt-4 text-[13px] leading-relaxed text-fg-mute">{copy.lead}</p>

        <div className="space-y-6 py-5">
          <div>
            <Chips
              label={copy.destination}
              options={DESTINATION_OPTIONS}
              selected={details.destinations}
              onToggle={(id) => toggle("destinations", id)}
              locale={locale}
            />
            <div className="mt-2">
              <TextField
                label={copy.destinationOther}
                hideLabel
                placeholder={copy.destinationOther}
                value={details.destinationOther}
                onChange={(value) => set("destinationOther", value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
            <div>
              <label htmlFor={dateId} className={LABEL}>
                {copy.date}
              </label>
              <input id={dateId} type="date" value={details.date} onChange={(e) => set("date", e.target.value)} className={`${INPUT} mt-2`} />
            </div>
            <div role="group" aria-labelledby={timeId}>
              <p id={timeId} className={LABEL}>
                {copy.time}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="time"
                  aria-label={copy.timeStart}
                  value={details.timeStart}
                  onChange={(e) => set("timeStart", e.target.value)}
                  className={INPUT}
                />
                <span className="text-fg-mute" aria-hidden="true">
                  –
                </span>
                <input type="time" aria-label={copy.timeEnd} value={details.timeEnd} onChange={(e) => set("timeEnd", e.target.value)} className={INPUT} />
              </div>
            </div>
          </div>

          <div>
            <div className="sm:w-[calc(50%-8px)]">
              <label htmlFor={budgetId} className={LABEL}>
                {copy.budget}
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  id={budgetId}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={10}
                  placeholder={copy.budgetPlaceholder}
                  value={details.budgetAmount}
                  onChange={(e) => set("budgetAmount", e.target.value.replace(/[^\d,]/g, ""))}
                  className={INPUT}
                />
                {/* 通貨が1つだけの間は、選ばせずに名前だけ出す */}
                {ENABLED_CURRENCIES.length > 1 ? (
                  <select
                    aria-label="Currency"
                    value={details.currency}
                    onChange={(e) => set("currency", e.target.value as CurrencyCode)}
                    className={`${INPUT} w-24 shrink-0`}
                  >
                    {ENABLED_CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="shrink-0 text-[13px] text-fg-sub">{details.currency}</span>
                )}
              </div>
            </div>
          </div>

          <div>
            <div role="group" aria-labelledby={travelersId}>
              <p id={travelersId} className={LABEL}>
                {copy.travelers}
              </p>
              <div className="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => stepTravelers(-1)}
                  disabled={details.travelerCount === null}
                  aria-label={copy.fewer}
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-line-strong text-fg transition-colors hover:border-fg-mute disabled:opacity-40"
                >
                  <MinusIcon width={16} height={16} />
                </button>
                <output aria-label={copy.travelersCount} className="w-10 text-center text-base font-bold tabular-nums">
                  {details.travelerCount ?? "–"}
                </output>
                <button
                  type="button"
                  onClick={() => stepTravelers(1)}
                  disabled={details.travelerCount === TRAVELER_COUNT_MAX}
                  aria-label={copy.more}
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-line-strong text-fg transition-colors hover:border-fg-mute disabled:opacity-40"
                >
                  <PlusIcon width={16} height={16} />
                </button>
              </div>
            </div>
            <div className="mt-3">
              <Chips
                label={copy.travelers}
                hideLabel
                options={TRAVELER_TYPE_OPTIONS}
                selected={details.travelerType ? [details.travelerType] : []}
                onToggle={(id) => pick("travelerType", id)}
                locale={locale}
              />
            </div>
          </div>
          <Chips
            label={copy.interests}
            options={INTEREST_OPTIONS}
            selected={details.interests}
            onToggle={(id) => toggle("interests", id)}
            locale={locale}
          />
          <Chips
            label={copy.food}
            options={FOOD_OPTIONS}
            selected={details.foods}
            onToggle={(id) => toggle("foods", id)}
            locale={locale}
          />
          <Chips
            label={copy.transportation}
            options={TRANSPORT_OPTIONS}
            selected={details.transportation}
            onToggle={(id) => toggle("transportation", id)}
            locale={locale}
          />
          <Chips
            label={copy.pace}
            options={PACE_OPTIONS}
            selected={details.pace ? [details.pace] : []}
            onToggle={(id) => pick("pace", id)}
            locale={locale}
          />
        </div>

        {/* 食事の制限とアレルギーは、好み（食べたいもの）とは別の場所・別のデータにする */}
        <Section title={copy.dietarySection} count={dietaryCount} defaultOpen={dietaryCount > 0}>
          <p className="text-[13px] leading-relaxed text-fg-mute">{copy.constraintNote}</p>
          <Chips
            label={copy.dietary}
            options={DIETARY_OPTIONS}
            selected={details.dietary}
            onToggle={(id) => toggle("dietary", id)}
            locale={locale}
          />
          <div>
            <Chips
              label={copy.allergies}
              options={ALLERGY_OPTIONS}
              selected={details.allergies}
              onToggle={(id) => toggle("allergies", id)}
              locale={locale}
            />
            <div className="mt-2">
              <TextField
                label={copy.allergiesOther}
                hideLabel
                placeholder={copy.allergiesOther}
                value={details.allergiesOther}
                onChange={(value) => set("allergiesOther", value)}
              />
            </div>
          </div>
        </Section>

        <Section title={copy.avoidSection} count={avoidCount} defaultOpen={avoidCount > 0}>
          <Chips
            label={copy.avoidSection}
            options={AVOID_OPTIONS}
            selected={details.avoid}
            onToggle={(id) => toggle("avoid", id)}
            locale={locale}
          />
          <TextField label={copy.avoidOther} hideLabel placeholder={copy.avoidOther} value={details.avoidOther} onChange={(value) => set("avoidOther", value)} />
        </Section>

        <Section title={copy.moreSection} count={moreCount} defaultOpen={moreCount > 0}>
          <Chips
            label={copy.walking}
            options={WALKING_OPTIONS}
            selected={details.walking ? [details.walking] : []}
            onToggle={(id) => pick("walking", id)}
            locale={locale}
          />
          <Chips
            label={copy.setting}
            options={SETTING_OPTIONS}
            selected={details.setting ? [details.setting] : []}
            onToggle={(id) => pick("setting", id)}
            locale={locale}
          />
          <Chips
            label={copy.spotStyle}
            options={SPOT_STYLE_OPTIONS}
            selected={details.spotStyle ? [details.spotStyle] : []}
            onToggle={(id) => pick("spotStyle", id)}
            locale={locale}
          />
          <div>
            <Chips
              label={copy.groupNeeds}
              options={GROUP_NEED_OPTIONS}
              selected={details.groupNeeds}
              onToggle={(id) => toggle("groupNeeds", id)}
              locale={locale}
            />
            <p className="mt-2 text-[13px] leading-relaxed text-fg-mute">{copy.groupNote}</p>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
            <TextField
              label={copy.startingPoint}
              placeholder={copy.placePlaceholder}
              value={details.startingPoint}
              onChange={(value) => set("startingPoint", value)}
            />
            <TextField
              label={copy.endingPoint}
              placeholder={copy.placePlaceholder}
              value={details.endingPoint}
              onChange={(value) => set("endingPoint", value)}
            />
          </div>
          <TextField label={copy.mustVisit} placeholder={copy.listPlaceholder} value={details.mustVisit} onChange={(value) => set("mustVisit", value)} />
        </Section>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <button
          type="button"
          onClick={onClear}
          disabled={count === 0}
          className="h-11 px-1 text-[13px] font-medium text-fg-sub underline-offset-4 hover:text-fg hover:underline disabled:opacity-40 disabled:hover:no-underline"
        >
          {copy.clear}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="h-11 rounded-full bg-primary px-6 text-sm font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {submitLabel}
        </button>
      </div>
    </dialog>
  );
}
