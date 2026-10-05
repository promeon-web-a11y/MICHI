// プランの表示用の整形（画面のコンポーネントから使う。処理はここにまとめる）。
// locale を省くと日本語（これまでと同じ表示）。
import type { Locale } from "@/content/locale";

import type { PlanConditions, PlanLeg, TransportMode } from "./types";

export const PLAN_TRANSPORT_LABELS: Record<TransportMode, string> = {
  walk: "徒歩",
  public_transit: "電車・バス",
  car: "車",
};

const PLAN_TRANSPORT_LABELS_EN: Record<TransportMode, string> = {
  walk: "Walk",
  public_transit: "Train / bus",
  car: "Car",
};

/** 項目を横に並べるときの区切り */
export const listSeparator = (locale: Locale = "ja"): string => (locale === "en" ? " · " : "・");

export const formatYen = (yen: number): string => `¥${yen.toLocaleString("ja-JP")}`;

export function formatDuration(minutes: number, locale: Locale = "ja"): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (locale === "en") {
    if (minutes < 60) return `${minutes} min`;
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  }
  if (minutes < 60) return `${minutes}分`;
  return rest ? `${hours}時間${rest}分` : `${hours}時間`;
}

/** 目安の値であることを示す（約1時間 / about 1 hr） */
export const formatAbout = (value: string, locale: Locale = "ja"): string => (locale === "en" ? `about ${value}` : `約${value}`);

/** 予算の目安が何人分か（見出しの後ろに付ける） */
export function formatPartyNote(partySize: number, locale: Locale = "ja"): string {
  if (locale === "en") return ` (for ${partySize} ${partySize === 1 ? "person" : "people"})`;
  return `（${partySize}人分）`;
}

export function formatLeg(leg: PlanLeg, locale: Locale = "ja"): string {
  if (locale === "en") return `${PLAN_TRANSPORT_LABELS_EN[leg.mode]}, ${formatAbout(formatDuration(leg.minutes, locale), locale)}`;
  return `${PLAN_TRANSPORT_LABELS[leg.mode]} 約${leg.minutes}分`;
}

/** 読み取った条件を、結果の上に並べる短いラベルにする（書かれていない項目は出さない） */
export function conditionLabels(conditions: PlanConditions, locale: Locale = "ja"): string[] {
  const en = locale === "en";
  const labels: string[] = [];
  if (conditions.area) labels.push(conditions.area);
  if (conditions.companions) labels.push(conditions.companions);
  else if (conditions.partySize) labels.push(en ? `${conditions.partySize} ${conditions.partySize === 1 ? "person" : "people"}` : `${conditions.partySize}人`);
  if (conditions.budgetYen) labels.push(`${en ? "Budget" : "予算"} ${formatYen(conditions.budgetYen)}`);
  if (conditions.transport) {
    const labelsByMode = en ? PLAN_TRANSPORT_LABELS_EN : PLAN_TRANSPORT_LABELS;
    labels.push(conditions.transport === "public_transit" ? (en ? "No car" : "車なし") : labelsByMode[conditions.transport]);
  }
  if (conditions.durationMinutes) labels.push(formatDuration(conditions.durationMinutes, locale));
  return labels;
}
