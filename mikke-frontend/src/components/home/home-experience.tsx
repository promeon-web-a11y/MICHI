"use client";

// Home のファーストビュー（黒い余白の中に AI 入力欄を1つだけ置く）と、送信後のプラン表示。
// 入力欄の横のボタンで「詳細設定」（trip-details-panel.tsx）を開ける。文章だけ・設定だけ・両方のどれでも送れる。
// 送るときは、文章と設定を TripRequest（services/plan/trip-request.ts）にまとめる。設定の値はこの画面の中だけで持ち、保存しない。
// API の呼び出しは services/plan/client.ts に任せ、ここは入力と表示の状態だけを持つ。
// 文言に説明（intro）・入力例（examples）・送信ボタンの文字（sendLabel）がある言語では、それらも出す（いまは英語だけ）。
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { Locale } from "@/content/locale";
import { siteCopy } from "@/content/site";
import { requestTripPlan } from "@/services/plan/client";
import { listSeparator } from "@/services/plan/format";
import {
  buildTripRequest,
  emptyTripDetails,
  hasTripRequestContent,
  summarizeTripRequest,
  type TripDetails,
  type TripRequest,
} from "@/services/plan/trip-request";
import { PROMPT_MAX_LENGTH, type TripPlan } from "@/services/plan/types";

import { SendIcon, SparkleIcon, TuneIcon } from "../icons";
import { PlanResult } from "./plan-result";
import { TripDetailsPanel } from "./trip-details-panel";

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

const PLACEHOLDER_INTERVAL_MS = 4500;
const THINKING_STEP_MS = 2800;
/** 入力欄の下に名前を出す条件の数（残りは「+3」のように数だけ出す） */
const SUMMARY_VISIBLE = 3;

export function HomeExperience({ initialPrompt, locale = "ja" }: { initialPrompt: string; locale?: Locale }) {
  const { home: HOME_COPY, thinking: THINKING_COPY } = siteCopy(locale);
  const PROMPT_PLACEHOLDERS = HOME_COPY.placeholders;
  const [prompt, setPrompt] = useState(initialPrompt);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [details, setDetails] = useState<TripDetails>(emptyTripDetails);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  // 最後に送信した依頼（「別のプランを考えてもらう」で同じ条件をもう一度送る）
  const submittedRef = useRef<TripRequest | null>(null);

  const loading = status.kind === "loading";
  // 文章と詳細設定をまとめた、いま送れる依頼
  const request = useMemo(() => buildTripRequest(prompt, details, locale), [prompt, details, locale]);
  const summary = useMemo(() => summarizeTripRequest(request, locale), [request, locale]);
  const canSubmit = hasTripRequestContent(request);

  useEffect(() => {
    const timer = setInterval(() => setPlaceholderIndex((i) => (i + 1) % PROMPT_PLACEHOLDERS.length), PLACEHOLDER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [PROMPT_PLACEHOLDERS.length]);

  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => setStepIndex((i) => Math.min(i + 1, THINKING_COPY.steps.length - 1)), THINKING_STEP_MS);
    return () => clearInterval(timer);
  }, [loading, THINKING_COPY.steps.length]);

  // 入力欄の高さを文章の量に合わせる
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  useEffect(() => {
    if (plan) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [plan]);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function submit(value: TripRequest | null) {
    if (!value || loading) return;
    // 文章も詳細設定も空のときだけ、入力を促す
    if (!hasTripRequestContent(value)) {
      setStatus({ kind: "error", message: HOME_COPY.emptyHint });
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    submittedRef.current = value;
    setStepIndex(0);
    setStatus({ kind: "loading" });
    try {
      const result = await requestTripPlan(value, controller.signal, locale);
      if (result.ok) {
        setPlan(result.plan);
        setStatus({ kind: "idle" });
      } else {
        setStatus({ kind: "error", message: result.message });
      }
    } catch {
      // 画面を離れたときの中断。何も表示しない
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(request);
  }

  /** 入力を促す案内が出ていたら消す（文章を書く・条件を選ぶ、のどちらかをしたとき） */
  function clearEmptyHint() {
    if (status.kind === "error" && status.message === HOME_COPY.emptyHint) setStatus({ kind: "idle" });
  }

  function changePrompt(value: string) {
    setPrompt(value);
    clearEmptyHint();
  }

  function changeDetails(update: (previous: TripDetails) => TripDetails) {
    setDetails(update);
    clearEmptyHint();
  }

  function submitFromDetails() {
    setDetailsOpen(false);
    void submit(request);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter で送信（Shift+Enter は改行。日本語入力の変換確定の Enter では送らない）
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(request);
    }
  }

  function editConditions() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    inputRef.current?.focus({ preventScroll: true });
  }

  /** 入力例を入力欄に入れる（送信はしない。内容を見て、直してから送れるようにする） */
  function fillExample(text: string) {
    changePrompt(text);
    inputRef.current?.focus();
  }

  const { intro, sendLabel, examples, details: DETAILS_COPY } = HOME_COPY;
  const detailsLabel = summary.length > 0 ? `${DETAILS_COPY.open} (${DETAILS_COPY.countLabel(summary.length)})` : DETAILS_COPY.open;
  const summaryText =
    summary.slice(0, SUMMARY_VISIBLE).join(listSeparator(locale)) + (summary.length > SUMMARY_VISIBLE ? ` +${summary.length - SUMMARY_VISIBLE}` : "");

  return (
    <>
      {/* 入力欄を画面の中央より少し上に置く。上下の余白はデザインそのものなので、説明と入力例のほかは足さない */}
      <section className="flex min-h-[calc(100svh-var(--header-h))] flex-col items-center justify-center px-5 pb-[9svh]">
        {intro ? (
          <div className="w-full max-w-[540px] pb-7 pt-10 text-center">
            <p className="text-xs tracking-[0.2em] text-fg-mute">{intro.eyebrow}</p>
            <h1 className="mt-3 text-[26px] font-bold leading-tight md:text-[32px]">{intro.headline}</h1>
            <p className="mt-4 text-sm leading-relaxed text-fg-sub md:text-[15px]">{intro.lead}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-mute">{intro.note}</p>
          </div>
        ) : (
          <div className="h-20" aria-hidden="true" />
        )}

        <div className="ai-field w-full max-w-[540px]">
          {/* 送信ボタンに文字を出す言語では、ボタンを入力欄の下の段に置く（狭い画面でも入力欄の幅を保つ） */}
          <form onSubmit={onSubmit} className={`flex items-end py-[9px] pr-[9px] ${sendLabel ? "flex-wrap justify-end gap-3 pl-5" : "gap-2 pl-4 sm:gap-3 sm:pl-5"}`}>
            <SparkleIcon className={`shrink-0 text-accent ${sendLabel ? "mt-[9px] self-start" : "mb-[9px]"}`} width={20} height={20} strokeWidth={1.6} />
            <label htmlFor="mikke-prompt" className="sr-only">
              {HOME_COPY.promptLabel}
            </label>
            <textarea
              id="mikke-prompt"
              ref={inputRef}
              value={prompt}
              onChange={(e) => changePrompt(e.target.value)}
              onKeyDown={onKeyDown}
              rows={sendLabel ? 2 : 1}
              maxLength={PROMPT_MAX_LENGTH}
              enterKeyHint="send"
              placeholder={PROMPT_PLACEHOLDERS[placeholderIndex % PROMPT_PLACEHOLDERS.length]}
              disabled={loading}
              className={`max-h-40 resize-none bg-transparent py-[7px] text-base leading-6 text-fg outline-none placeholder:text-fg-sub disabled:opacity-60 md:text-[15px] ${sendLabel ? "min-w-0 shrink grow basis-[calc(100%-44px)]" : "flex-1"}`}
            />
            {/* 詳細設定を開くボタン（送信ボタンのすぐ隣）。条件を設定してあるときは、その数を出す。
                2つのボタンは間を詰めて並べ、狭い画面でも入力欄の幅を残す */}
            <div className={`flex shrink-0 items-center ${sendLabel ? "gap-2" : "gap-0.5"}`}>
              {sendLabel ? (
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  disabled={loading}
                  aria-haspopup="dialog"
                  aria-label={detailsLabel}
                  className="flex h-[38px] shrink-0 items-center justify-center gap-2 rounded-full border border-line-strong px-3.5 text-[13px] font-medium text-fg-sub transition-colors hover:border-fg-mute hover:text-fg disabled:opacity-60"
                >
                  <TuneIcon width={16} height={16} strokeWidth={1.6} />
                  {DETAILS_COPY.button}
                  {summary.length > 0 && <span className="tabular-nums text-accent">· {summary.length}</span>}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  disabled={loading}
                  aria-haspopup="dialog"
                  aria-label={detailsLabel}
                  className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-fg-sub transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60"
                >
                  <TuneIcon width={17} height={17} strokeWidth={1.6} />
                  {summary.length > 0 && (
                    <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none tabular-nums text-on-primary">
                      {summary.length}
                    </span>
                  )}
                </button>
              )}
              {/* 文章も設定も空のときは、押すと入力を促す案内を出す（押せない見た目にはするが、無反応にはしない） */}
              {sendLabel ? (
                <button
                  type="submit"
                  disabled={loading}
                  aria-disabled={!canSubmit}
                  className="flex h-[38px] shrink-0 items-center justify-center gap-2 rounded-full bg-surface-3 px-4 text-[13px] font-bold text-fg transition-colors hover:bg-line-strong disabled:opacity-60 disabled:hover:bg-surface-3 aria-disabled:opacity-60 aria-disabled:hover:bg-surface-3"
                >
                  {sendLabel}
                  <SendIcon width={15} height={15} strokeWidth={1.4} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={loading}
                  aria-disabled={!canSubmit}
                  aria-label={HOME_COPY.send}
                  className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg transition-colors hover:bg-line-strong disabled:hover:bg-surface-3 aria-disabled:hover:bg-surface-3"
                >
                  <SendIcon width={17} height={17} strokeWidth={1.4} />
                </button>
              )}
            </div>
          </form>
        </div>

        {/* 詳細設定を閉じていても、設定してある条件が分かるようにする（押すと詳細設定が開く） */}
        {summary.length > 0 && (
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            disabled={loading}
            aria-label={detailsLabel}
            className="mt-3 max-w-full truncate px-2 text-[13px] text-fg-sub underline-offset-4 transition-colors hover:text-fg hover:underline disabled:opacity-60 sm:max-w-[540px]"
          >
            {summaryText}
          </button>
        )}

        <div className={`mt-5 w-full max-w-[540px] text-center ${examples.length > 0 ? "" : "h-20"}`} aria-live="polite">
          {loading && (
            <div className="anim-fade-in" role="status">
              <p className="text-sm text-fg">{THINKING_COPY.title}</p>
              <div className="mx-auto mt-3 h-px w-40 overflow-hidden bg-line">
                <div className="thinking-line h-full w-1/3 bg-accent" />
              </div>
              <p className="mt-3 text-[13px] text-fg-mute">{THINKING_COPY.steps[stepIndex]}</p>
            </div>
          )}
          {status.kind === "error" && (
            <p role="alert" className="anim-fade-in text-sm text-fg-sub">
              {status.message}
            </p>
          )}
        </div>

        {examples.length > 0 && !loading && (
          <div className={`w-full max-w-[540px] ${status.kind === "error" ? "mt-5" : ""}`}>
            <p className="text-xs tracking-[0.12em] text-fg-mute">{HOME_COPY.examplesLabel}</p>
            <ul className="mt-2 space-y-2">
              {examples.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => fillExample(example)}
                    className="w-full rounded-lg border border-line px-4 py-2.5 text-left text-[13px] leading-relaxed text-fg-sub transition-colors hover:border-line-strong hover:text-fg"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <TripDetailsPanel
        open={detailsOpen}
        details={details}
        count={summary.length}
        locale={locale}
        copy={DETAILS_COPY}
        submitLabel={HOME_COPY.send}
        canSubmit={canSubmit && !loading}
        onChange={changeDetails}
        onClear={() => changeDetails(emptyTripDetails)}
        onClose={() => setDetailsOpen(false)}
        onSubmit={submitFromDetails}
      />

      <div ref={resultRef} className="scroll-mt-[var(--header-h)]">
        {plan && (
          <PlanResult
            plan={plan}
            busy={loading}
            errorMessage={status.kind === "error" ? status.message : null}
            onRetry={() => void submit(submittedRef.current)} onEdit={editConditions}
          />
        )}
      </div>
    </>
  );
}
