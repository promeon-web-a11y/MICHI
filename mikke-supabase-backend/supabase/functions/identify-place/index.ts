import { createClient } from "npm:@supabase/supabase-js@2";

import {
  buildOpenAiRequestBody,
  buildPlacesRequestBody,
  getOpenAiOutputText,
  type GooglePlace,
  identifyPlace,
  type IdentifyInput,
  normalizeInput,
  PLACES_FIELD_MASK,
  redactSecrets,
  UpstreamError,
} from "./logic.ts";

// モバイルの共有データ（URL / text / source）から実在Placeを特定する。
// OpenAI で店名・エリア等の候補を構造化抽出 → Google Places API (New) Text Search → サーバー側で照合・判定。
// OpenAI / Google のAPIキーはこの関数の中でのみ使用し、クライアントには一切渡さない。
// DBへの保存は行わない（Step 3-4 で save_place と接続する）。
// 既存の extract-place-candidates / resolve-place（mikke-frontend が使用中）は変更していない。

const OPENAI_TIMEOUT_MS = 25_000;
const PLACES_TIMEOUT_MS = 10_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function log(event: string, detail: Record<string, unknown>) {
  // 共有テキスト本文・APIキーは出力しない（件数・状態・エラーコードのみ）
  console.log(JSON.stringify({ event, ...detail }));
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function callOpenAi(input: IdentifyInput, apiKey: string, model: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildOpenAiRequestBody(input, model)),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch (e) {
    throw new UpstreamError(isTimeout(e) ? "ai_timeout" : "ai_network_error", redactSecrets(String(e)));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new UpstreamError("ai_request_failed", `HTTP ${response.status} ${redactSecrets(detail)}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UpstreamError("ai_response_invalid");
  }
  const output = getOpenAiOutputText(payload);
  if ("error" in output) throw new UpstreamError(output.error);
  return output.text;
}

async function searchPlaces(query: string, apiKey: string): Promise<GooglePlace[]> {
  let response: Response;
  try {
    response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(buildPlacesRequestBody(query)),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
  } catch (e) {
    throw new UpstreamError(isTimeout(e) ? "places_timeout" : "places_network_error", redactSecrets(String(e)));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new UpstreamError("places_request_failed", `HTTP ${response.status} ${redactSecrets(detail)}`);
  }
  try {
    const payload = await response.json();
    return Array.isArray(payload?.places) ? payload.places : [];
  } catch {
    throw new UpstreamError("places_response_invalid");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return reply(401, { error: "authentication_required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  // 専用モデルを指定しなければ既存の OPENAI_PLAN_MODEL を使う（追加Secret不要）
  const model = Deno.env.get("OPENAI_IDENTIFY_MODEL") || Deno.env.get("OPENAI_PLAN_MODEL");
  const googlePlacesApiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!supabaseUrl || !anonKey || !openAiKey || !model || !googlePlacesApiKey) {
    log("identify_place_config_missing", {
      supabase: !!supabaseUrl && !!anonKey, openai_key: !!openAiKey, model: !!model, google_key: !!googlePlacesApiKey,
    });
    return reply(500, { error: "server_configuration_missing" });
  }

  // ログイン済みユーザーのみ（既存 Edge Function と同じ方式。API コストの無制限な消費を防ぐ）
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return reply(401, { error: "invalid_session" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  const input = normalizeInput(body);
  if (!input) return reply(400, { error: "invalid_body" });

  try {
    const result = await identifyPlace(input, {
      extract: (i) => callOpenAi(i, openAiKey, model),
      searchPlaces: (query) => searchPlaces(query, googlePlacesApiKey),
      log,
    });
    return reply(result.status === "error" ? 502 : 200, result);
  } catch (e) {
    log("identify_place_internal_error", { detail: redactSecrets(String(e)) });
    return reply(500, { error: "internal_error" });
  }
});
