/**
 * A/B/C プランの表示用フォーマット（純粋関数）。
 * 時刻・移動はすべて「目安」。正確な経路・運賃・所要時間としては表示しない。
 */
import { CATEGORY_LABELS } from '../place/saved-places-client';

import { durationLabel } from './plan-conditions';
import type { PlanOption } from './plan-options-client';

/** 端末のタイムゾーンでの HH:mm（offsetMinutes はテスト用） */
export function formatClock(iso: string, offsetMinutes?: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const offset = offsetMinutes ?? -new Date(t).getTimezoneOffset();
  const d = new Date(t + offset * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 合計時間（目安） */
export function totalTimeText(option: Pick<PlanOption, 'estimated_total_minutes'>): string {
  return `約${durationLabel(Math.max(1, Math.round(option.estimated_total_minutes / 5) * 5))}`;
}

/** 予算の表示。料金情報が不足している場合は金額を断定しない */
export function budgetText(option: Pick<PlanOption, 'estimated_budget_yen' | 'budget_status'>): string {
  const yen = option.estimated_budget_yen;
  if (option.budget_status === 'unknown' || yen === null) return '料金情報なし';
  const amount = `〜${yen.toLocaleString('ja-JP')}円`;
  return option.budget_status === 'partial' ? `${amount}＋料金不明あり（目安）` : `${amount}（目安）`;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? 'その他';
}

/** カードに出す主な場所（最大3件） */
export function mainPlacesText(option: Pick<PlanOption, 'items'>): string {
  const names = option.items.slice(0, 3).map((i) => i.place_name);
  return names.join(' → ') + (option.items.length > 3 ? ' ほか' : '');
}

export function resultsHeadline(planCount: number): string {
  return planCount >= 3 ? '3つのプランをつくりました' : planCount === 2 ? '2つのプランをつくりました' : 'プランをつくりました';
}

export function noticeText(notice: 'few_candidates' | 'partial' | null, planCount: number): string | null {
  if (notice === 'few_candidates') {
    return `この条件で行ける保存場所が少ないため、${planCount}つのプランにしました。場所を保存するほど、プランの幅が広がります。`;
  }
  if (notice === 'partial') return '条件に合うプランが少なかったため、つくれたプランだけを表示しています。';
  return null;
}

export const TIME_DISCLAIMER = '時刻と移動は、直線距離から計算したおおよその目安です。「このプランにする」を押すと、実際の移動ルート・所要時間を確認できます。';
