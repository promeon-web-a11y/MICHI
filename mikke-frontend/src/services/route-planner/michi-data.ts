// MICHI 独自データ（実際に旅行されたルート・コメント・いいね・行きたい・現地報告）を、推薦の材料として渡すための入口。
// いまはデータがまだ無いので、何も返さない実装（NO_MICHI_DATA）だけがある。データが無くても Route Planner は動く。
// データを使えるようになったら、このインターフェースを満たす実装を plan-route.ts の deps.michi に渡す（DB への接続は、そのときに承認を得て足す）。
// 注意: いいねが多い = 必ず推薦、にはしない。ここで返す値は AI への参考情報で、優先順位は守る条件・実行できるかどうかより下（prompts/route-planner.ts）。

/** 場所ごとの旅行者データ。報告には、新しさと件数を必ず持たせる（docs/ai-knowledge/06） */
export type MichiPlaceData = {
  /** この場所を含む公開ルートの数 */
  routeCount: number;
  likes: number;
  saves: number;
  wantToGo: number;
  /** 旅行者が実際に滞在した時間の中央値（分） */
  typicalStayMinutes: number | null;
  /** 現地報告（例: 英語メニュー、混雑）。古い報告と新しい報告を同じ重みで扱わない */
  reports: { topic: string; value: string; reportedAt: string; reportCount: number; confidence: "high" | "medium" | "low" }[];
};

/** 実際に旅行されたルート（候補として再利用するため）。場所は Google の Place ID の順番で持つ */
export type MichiRouteData = { routeId: string; placeIds: string[]; likes: number; saves: number };

export interface MichiDataProvider {
  /** 候補の場所について、旅行者データを返す。データが無い場所は、返す Map に入れない */
  placeData(placeIds: string[]): Promise<Map<string, MichiPlaceData>>;
  /** その地域で実際に旅行されたルートを返す。無ければ空 */
  routes(area: string): Promise<MichiRouteData[]>;
}

export const NO_MICHI_DATA: MichiDataProvider = {
  placeData: async () => new Map(),
  routes: async () => [],
};
