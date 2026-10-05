/**
 * みんなのルートの表示文言と、検索・投稿の選択肢（純粋関数。Node で単体テスト）。
 * 値が無いものは「未設定」と書き、推測した時間・金額を出さない。
 */
import type { RouteSort } from './route-posts-client';

/** 系統（投稿時に選ぶ。検索の「系統」と同じ値） */
export const ROUTE_GENRES = ['カフェ', 'グルメ', 'ラーメン', 'スイーツ', '自然', '観光', '買い物'] as const;
/** テーマ */
export const ROUTE_THEMES = ['デート', 'ひとり', '友だち', '家族'] as const;
/** 予算（投稿時: 使った金額の目安 / 検索: 上限） */
export const ROUTE_BUDGETS = [1000, 3000, 5000, 10000] as const;

export const SORT_OPTIONS: readonly { value: RouteSort; label: string }[] = [
  { value: 'recommended', label: 'おすすめ' },
  { value: 'likes', label: 'いいねが多い順' },
  { value: 'wishes', label: '保存が多い順' },
];

export const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

export function durationText(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return '時間未設定';
  if (minutes < 60) return `約${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m >= 30 ? `約${h}時間半` : `約${h}時間`;
}

export function budgetText(budget: number | null): string {
  return budget === null ? '費用未設定' : `〜${yen(budget)}`;
}

/** 選択肢（null = すべて）。area は実際に公開されているルートの地域 */
export function filterOptions(areas: string[]) {
  return {
    area: [{ value: null, label: '地域すべて' }, ...areas.map((a) => ({ value: a, label: a }))] as { value: string | null; label: string }[],
    budget: [{ value: null, label: '予算すべて' }, ...ROUTE_BUDGETS.map((b) => ({ value: b, label: `〜${yen(b)}` }))] as {
      value: number | null;
      label: string;
    }[],
    genre: [{ value: null, label: '系統すべて' }, ...ROUTE_GENRES.map((g) => ({ value: g, label: g }))] as { value: string | null; label: string }[],
    theme: [{ value: null, label: 'テーマすべて' }, ...ROUTE_THEMES.map((t) => ({ value: t, label: t }))] as { value: string | null; label: string }[],
  };
}

/** 日付（YYYY-MM-DD / ISO）→ 2026年9月28日 */
export function dateText(value: string | null): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : '';
}

/** 空状態の文言（条件で絞っているか・データがそもそも無いかを分ける） */
export function feedEmptyText(filtered: boolean): string {
  return filtered
    ? '条件に合うルートがありません。キーワードや地域・予算を変えてみてください。'
    : 'まだ公開されたルートがありません。お出かけを記録して、最初のルートを投稿してみませんか。';
}
