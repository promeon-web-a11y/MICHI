// Home の AI 入力欄の送信先。依頼（TripRequest: 文章と詳細設定）を受け取り、実在する場所で組んだプランを返す。
// これまでの形（{ prompt }）も受け付ける（文章だけの TripRequest として扱う）。
// プランを作る処理は services/route-planner/plan-route.ts（Route Planner v1）。
// OpenAI / Google Places のキーはこのサーバー側の処理だけが使い、ブラウザには渡さない。
import { allowRequest, clientKey } from "@/services/rate-limit";
import { PLAN_ERROR_MESSAGES } from "@/services/plan/errors";
import { hasTripRequestContent, sanitizeTripRequest } from "@/services/plan/trip-request";
import { planRoute } from "@/services/route-planner/plan-route";
import { PROMPT_MAX_LENGTH, type PlanApiResponse, type PlanErrorCode } from "@/services/plan/types";

// AI を最大3回（文章の読み取り1回・ルート1回・作り直し1回）呼ぶため、既定より長く待てるようにする
export const maxDuration = 60;

const STATUS: Record<PlanErrorCode, number> = {
  invalid_input: 400,
  rate_limited: 429,
  not_configured: 503,
  not_plannable: 422,
  no_places: 422,
  ai_failed: 502,
  places_failed: 502,
  not_feasible: 422,
};

function reply(body: PlanApiResponse) {
  return Response.json(body, { status: body.ok ? 200 : STATUS[body.error], headers: { "Cache-Control": "no-store" } });
}

const failure = (error: PlanErrorCode) => reply({ ok: false, error, message: PLAN_ERROR_MESSAGES[error] });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("invalid_input");
  }
  const payload = body as { prompt?: unknown; tripRequest?: unknown } | null;
  // これまでの形（{ prompt }）は、文章だけの依頼として同じ検証に通す
  const legacyPrompt = typeof payload?.prompt === "string" ? payload.prompt : "";
  const input = payload?.tripRequest !== undefined ? payload.tripRequest : { natural_language_request: legacyPrompt };
  // 知らない選択肢や長すぎる文字は sanitizeTripRequest が捨てる。文章も設定も無ければ受け付けない
  const tripRequest = sanitizeTripRequest(input, PROMPT_MAX_LENGTH);
  if (!tripRequest || !hasTripRequestContent(tripRequest)) return failure("invalid_input");
  // 文章だけの依頼は、1文字では受け付けない（これまでと同じ）
  const detailsOnly = { ...tripRequest, natural_language_request: "" };
  if (tripRequest.natural_language_request.length < 2 && !hasTripRequestContent(detailsOnly)) return failure("invalid_input");

  if (!allowRequest(clientKey(request))) return failure("rate_limited");

  try {
    return reply(await planRoute(tripRequest));
  } catch (e) {
    console.error("[mikke] plan_internal_error", e instanceof Error ? e.name : "unknown");
    return failure("ai_failed");
  }
}
