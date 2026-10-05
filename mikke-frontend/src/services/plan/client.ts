// ブラウザから /api/plan を呼ぶ。画面のコンポーネントは fetch を直接書かず、この関数を使う。
import type { Locale } from "@/content/locale";

import type { TripRequest } from "./trip-request";
import type { PlanApiResponse, PlanErrorCode } from "./types";

const NETWORK_MESSAGE: Record<Locale, string> = {
  ja: "通信できませんでした。電波の良い場所で、もう一度お試しください。",
  en: "We couldn't connect. Please check your connection and try again.",
};

// サーバーが返すエラー文は日本語（generate-plan.ts の PLAN_ERROR_MESSAGES）。英語の画面では、同じ意味のこの文に置き換える
const ERROR_MESSAGES_EN: Record<PlanErrorCode, string> = {
  invalid_input: "Please describe your trip, or set a few trip details.",
  rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
  not_configured: "We can't create plans right now. Please try again later.",
  not_plannable: "We couldn't read that as a trip request. Try writing the area and what you want to do.",
  no_places: "We couldn't find places that match. Try a different area or different conditions.",
  ai_failed: "We couldn't build a plan this time. Please try again.",
  places_failed: "We couldn't get place information. Please wait a moment and try again.",
  not_feasible: "We couldn't build a route that meets all your conditions. Try relaxing the time, budget or things to avoid.",
};

/**
 * 文章と詳細設定をまとめた TripRequest を送る。
 * locale は画面の表示言語（エラー文の言語）。プランの文章の言語は、サーバーが依頼の内容から決める
 */
export async function requestTripPlan(request: TripRequest, signal?: AbortSignal, locale: Locale = "ja"): Promise<PlanApiResponse> {
  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripRequest: request }),
      signal,
    });
    const body = (await response.json()) as PlanApiResponse;
    if (body && typeof body === "object" && "ok" in body) {
      if (!body.ok && locale === "en") return { ...body, message: ERROR_MESSAGES_EN[body.error] ?? body.message };
      return body;
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
  }
  return { ok: false, error: "ai_failed", message: NETWORK_MESSAGE[locale] };
}
