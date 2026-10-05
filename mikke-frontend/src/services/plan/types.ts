// AI プラン（Home の入力欄 → /api/plan）の型。ブラウザとサーバーの両方から読むので、処理は置かない。

import type { Locale } from "@/content/locale";

export type TransportMode = "walk" | "public_transit" | "car";

/** ユーザーの文章から読み取った条件（書かれていない項目は null） */
export type PlanConditions = {
  area: string | null;
  budgetYen: number | null;
  partySize: number | null;
  companions: string | null;
  transport: TransportMode | null;
  durationMinutes: number | null;
  purpose: string | null;
};

/**
 * 情報の確かさ。AI の推測と、外部・実旅行者の情報を混ぜないための区分。
 * - verified: 公式情報などで MICHI が確認できたもの（v1 ではまだ無い）
 * - external: 外部 API（Google Places）の情報。MICHI は確認していない
 * - recent_report / historical: MICHI の旅行者の報告（新しいもの / 古いもの。v1 ではまだ無い）
 * - estimated: AI またはプログラムの見積もり
 * - unknown: 情報が無い（「問題ない」という意味ではない）
 */
export type EvidenceLevel = "verified" | "external" | "recent_report" | "historical" | "estimated" | "unknown";

export type StopEvidence = {
  openingHours: EvidenceLevel;
  cost: EvidenceLevel;
  travelTime: EvidenceLevel;
  /** アレルギー・食事の制限・バリアフリーに合うか。条件が設定されていないときは null */
  hardConstraints: EvidenceLevel | null;
};

export type PlanNotice = { code: string; message: string };

export type ValidationIssue = { code: string; severity: "fail" | "warning"; stop?: number };
export type ValidationStatus = "pass" | "warning" | "fail";

export type PlanStop = {
  placeId: string;
  name: string;
  /** Google の種別（例: カフェ）。無ければ null */
  category: string | null;
  description: string;
  address: string;
  mapsUrl: string | null;
  /** /api/place-photo 経由の URL（API キーをブラウザに渡さない）。写真が無ければ null */
  photoUrl: string | null;
  photoCredit: string | null;
  /** 到着時刻 "HH:MM" */
  arrival: string;
  stayMinutes: number;
  estimatedCostYen: number | null;
  /** 出発時刻 "HH:MM" */
  departure?: string;
  /** その日の営業時間（Google の情報。例: "11:00–22:00"）。取得できなかったときは null */
  openingHours?: string | null;
  /** この場所についての注意（確認できていないこと）。プログラムが決まった文で付ける。AI は書かない */
  notes?: string[];
  evidence?: StopEvidence;
};

/** stops[i] → stops[i + 1] の移動（直線距離からの目安） */
export type PlanLeg = {
  mode: TransportMode;
  minutes: number;
};

export type TripPlan = {
  /** プランの文章（タイトル・説明・場所の名前など）の言語。入力された文章の言語に合わせる */
  language: Locale;
  title: string;
  summary: string;
  conditions: PlanConditions;
  stops: PlanStop[];
  legs: PlanLeg[];
  startTime: string;
  endTime: string;
  totalCostYen: number | null;
  // ---- ここから Route Planner v1 で足した項目
  /** プランの日付 "YYYY-MM-DD"（営業時間はこの日の曜日で確かめた） */
  date?: string;
  currency?: "JPY";
  /** 最初の到着から最後の出発までの分数 */
  totalMinutes?: number;
  /** 指定が無かったので MICHI が仮に決めたこと */
  assumptions?: string[];
  /** 利用者が知っておくべき注意（確認できなかった安全性など） */
  warnings?: PlanNotice[];
  /** 文章と詳細設定、または設定同士の食い違いと、どちらを採ったか */
  conflicts?: PlanNotice[];
  /** 条件として受け取ったが、確かめる手段が無かったもの */
  unresolvedConstraints?: string[];
  validation?: { status: ValidationStatus; issues: ValidationIssue[] };
  planner?: { promptVersion: string; regenerations: number; llmCalls: number; timings: Record<string, number> };
};

export type PlanErrorCode =
  | "invalid_input"
  | "rate_limited"
  | "not_configured"
  | "not_plannable"
  | "no_places"
  | "ai_failed"
  | "places_failed"
  | "not_feasible";

export type PlanApiResponse =
  | { ok: true; plan: TripPlan }
  | { ok: false; error: PlanErrorCode; message: string };

export const PROMPT_MAX_LENGTH = 300;
