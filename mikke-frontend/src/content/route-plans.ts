// 「みんなのプラン」「ルート詳細」の取得口と型。画面はここの関数だけを呼ぶ。
// いまは表示確認用の仮データ（route-plans.mock.ts）を返す。公開ルートの投稿（Supabase の route_posts。
// src/core/routes/route-posts-client.ts）につなぐときは、この2つの関数の中身を差し替えて RoutePlan の形に変換する（画面側は変えない）。
// 旅行者向け情報・コメントは、いまのバックエンドに対応するデータが無いため、つないだ後も当面は仮データになる。

import type { ImageKey } from "./images";
import { MOCK_ROUTE_PLANS } from "./route-plans.mock";
import type { TRAVELER_INFO_LABELS } from "./site";

export type TravelerInfoKey = keyof typeof TRAVELER_INFO_LABELS;
/** ok: 問題なし（✓）　caution: 注意・場所による（△） */
export type TravelerInfoItem = { key: TravelerInfoKey; status: "ok" | "caution"; value: string };

/** 次の立ち寄り先までの移動（例: JR嵯峨野線 約15分） */
export type RouteLeg = { label: string; minutes: number };

export type RouteStop = {
  /** 到着時刻 "HH:MM" */
  time: string;
  name: string;
  description: string;
  image: ImageKey | null;
  latitude: number;
  longitude: number;
  next: RouteLeg | null;
};

export type RouteComment = { author: string; postedOn: string; body: string; likeCount: number };

export type RoutePlan = {
  id: string;
  /** カードと詳細の左上に出す地域（例: 京都） */
  region: string;
  title: string;
  lead: string;
  image: ImageKey;
  /** 日数（例: 1日、2泊3日） */
  daysLabel: string;
  durationLabel: string;
  /** 1人あたりの予算 */
  budgetYen: number;
  transportLabel: string;
  styles: string[];
  /** 絞り込み用（カテゴリーチップと一致する語） */
  tags: string[];
  author: string;
  postedOn: string;
  rating: number;
  /** 評価・コメント・旅行者向け情報のもとになった投稿の件数 */
  reviewCount: number;
  likeCount: number;
  stops: RouteStop[];
  travelerInfo: TravelerInfoItem[];
  comments: RouteComment[];
  /** 「AIで自分向けに変更」を押したときに Home の入力欄へ入れる文章 */
  prompt: string;
};

export async function listRoutePlans(): Promise<RoutePlan[]> {
  return MOCK_ROUTE_PLANS;
}

export async function getRoutePlan(id: string): Promise<RoutePlan | null> {
  return MOCK_ROUTE_PLANS.find((plan) => plan.id === id) ?? null;
}

/** カテゴリーチップ・検索語に合うか（地域・タグ・タイトル・立ち寄り先の名前を見る） */
export function matchesRoutePlan(plan: RoutePlan, chip: string | null, query: string): boolean {
  if (chip && plan.region !== chip && !plan.tags.includes(chip)) return false;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [plan.region, plan.title, plan.lead, ...plan.tags, ...plan.styles, ...plan.stops.map((stop) => stop.name)]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Google マップで、立ち寄り先を順にたどる経路を開く URL（API キーは使わない公開の URL） */
export function routeDirectionsUrl(plan: RoutePlan): string {
  const names = plan.stops.map((stop) => `${stop.name} ${plan.region}`);
  const params = new URLSearchParams({ api: "1", origin: names[0], destination: names[names.length - 1] });
  if (names.length > 2) params.set("waypoints", names.slice(1, -1).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function stopMapUrl(plan: RoutePlan, stop: RouteStop): string {
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: `${stop.name} ${plan.region}` }).toString()}`;
}
