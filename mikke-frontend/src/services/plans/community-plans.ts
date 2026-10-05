// 「みんなのプラン」の取得口。画面はこの関数だけを呼ぶ。
// いまは仮データを返す。公開ルートの投稿（Supabase の route_posts。src/core/routes/route-posts-client.ts）が
// 本番で使えるようになったら、この関数の中身を差し替えて CommunityPlan の形に変換する（画面側は変えない）。
// コメント・フォローなどを足すときも、この型に項目を追加していく。

import type { ImageKey } from "@/content/images";
import { MOCK_COMMUNITY_PLANS } from "@/content/community-plans.mock";
import type { TransportMode } from "@/services/plan/types";

export type CommunityPlan = {
  id: string;
  area: string;
  title: string;
  theme: string;
  budgetYen: number;
  durationLabel: string;
  transport: TransportMode;
  /** 立ち寄る場所（回る順） */
  stops: string[];
  savedCount: number;
  image: ImageKey;
  /** 「このプランで相談する」を押したときに Home の入力欄へ入れる文章 */
  prompt: string;
};

export async function listCommunityPlans(): Promise<CommunityPlan[]> {
  return MOCK_COMMUNITY_PLANS;
}
