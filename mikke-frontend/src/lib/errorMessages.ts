// Edge Function / RPC が返すエラーコードを、画面に表示する日本語メッセージへ変換するだけの
// 表示用ユーティリティ。エラーの発生・送信・ハンドリングのロジックは一切変更しない。
//
// 画面には常にここで作った分かりやすいメッセージだけを表示し、内部のエラーコードや
// スタックトレースなどの詳細はここで console.warn に出すだけに留める（開発者はブラウザのコンソールから原因を追える）。
// console.error にすると、画面内で処理済みのエラーでも Next.js 開発モードのエラー画面が開いてしまうため使わない。

import { TimeoutError } from "./withTimeout";

// 明確な原因が分かっているものだけ、個別の文言を用意する。
const MESSAGES: Record<string, string> = {
  authentication_required: "ログインが必要です。もう一度ログインしてください。",
  invalid_session: "セッションの有効期限が切れました。再度ログインしてください。",
  invalid_json: "送信内容に問題がありました。もう一度お試しください。",
  url_required: "Instagram投稿URLを入力してください。",
  caption_required: "投稿文を貼り付けてください。",
  query_required: "検索キーワードを入力してください。",
  server_configuration_missing: "サーバー側の設定に問題があります。しばらくしてから再度お試しください。",
  provider_place_id_required: "店舗情報が不足しています。候補を選び直してください。",
  place_name_required: "店名を入力してください。",
  source_url_required: "Instagram投稿URLを入力してください。",
  // プラン作成: AIの提案がサーバーの検証（営業時間・移動時間・予算など）を2回とも通らなかった。
  ai_output_failed_validation:
    "条件に合うプランを作れませんでした。もう一度お試しいただくか、時間帯・移動手段・予算を変えてお試しください。",
  no_candidates: "条件に合う保存済みの場所がありません。条件を変えるか、場所を保存してからお試しください。",
  // プラン作成の日時。通常は送信前に画面側で検証するため、ここに来るのは画面の検証をすり抜けた場合のみ。
  invalid_time_range: "終了時間は開始時間より後に設定してください。",
  invalid_time_format: "日時の形式が正しくありません。カレンダーから選び直してください。",
  time_range_too_long: "プランの時間は24時間以内で設定してください。",
  time_range_in_past: "終了時間が過去になっています。これからの時間を設定してください。",
  required_conditions_missing: "開始日時と終了日時を入力してください。",
  plan_save_failed: "プランの保存に失敗しました。もう一度お試しください。",
  candidate_query_failed: "保存済みの場所を読み込めませんでした。もう一度お試しください。",
};

// AI解析（OpenAI呼び出し）由来のエラーコード。内部の詳細は見せず、まとめて1つの文言にする。
const AI_ERROR_CODES = [
  "ai_extraction_failed",
  "ai_response_incomplete",
  "ai_output_missing_or_refused",
  "ai_output_invalid_json",
  "ai_generation_failed",
];

// Google Places呼び出し由来のエラーコード。同様に内部詳細は見せない。
const PLACES_ERROR_CODES = ["google_places_request_failed"];

function isNetworkError(raw: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed|net::/i.test(raw);
}

/**
 * @param error 発生したエラー（Error / unknown）
 * @param fallback 個別の文言が無い場合に表示する、呼び出し元の文脈に応じたメッセージ
 */
export function toFriendlyErrorMessage(
  error: unknown,
  fallback = "予期しないエラーが発生しました。しばらくしてからもう一度お試しください。",
): string {
  const raw = error instanceof Error ? error.message : String(error);

  // 開発者向け: 画面には出さず、コンソールにのみ原因を残す。
  console.warn("[mikke] operation failed:", error);

  if (error instanceof TimeoutError || raw.includes("request_timeout")) {
    return "通信がタイムアウトしました。しばらくしてから再度お試しください。";
  }
  if (isNetworkError(raw)) {
    return "通信に失敗しました。ネットワーク環境をご確認のうえ、再度お試しください。";
  }
  if (AI_ERROR_CODES.some((code) => raw.includes(code))) {
    return "AI解析に失敗しました。時間をおいて再度お試しください。";
  }
  if (PLACES_ERROR_CODES.some((code) => raw.includes(code))) {
    return "場所情報の検索に失敗しました。再度お試しください。";
  }
  for (const key of Object.keys(MESSAGES)) {
    if (raw.includes(key)) return MESSAGES[key];
  }
  return fallback;
}
