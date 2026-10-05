// /api/plan が返すエラー文（日本語）。英語の画面では services/plan/client.ts が同じ意味の文に置き換える。
import type { PlanErrorCode } from "./types";

export const PLAN_ERROR_MESSAGES: Record<PlanErrorCode, string> = {
  invalid_input: "行きたい場所や過ごし方を文章で書くか、詳細設定で条件を選んでください。",
  rate_limited: "短い時間に続けて送信されました。少し時間をおいてからお試しください。",
  not_configured: "ただいまプランを作成できません。時間をおいてもう一度お試しください。",
  not_plannable: "おでかけの相談として読み取れませんでした。行きたいエリアや過ごし方を書いてみてください。",
  no_places: "条件に合う場所が見つかりませんでした。エリアや条件を変えてお試しください。",
  ai_failed: "プランをうまく作れませんでした。もう一度お試しください。",
  places_failed: "場所の情報を取得できませんでした。少し時間をおいてお試しください。",
  not_feasible: "条件をすべて満たすプランを作れませんでした。時間・予算・避けたいことなどの条件をゆるめてお試しください。",
};
