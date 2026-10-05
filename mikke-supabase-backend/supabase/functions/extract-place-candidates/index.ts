import { createClient } from "npm:@supabase/supabase-js@2";

// ユーザーが貼り付けたInstagram投稿のURL＋キャプション文から、
// 店名候補・エリア候補・カテゴリ候補をOpenAIで抽出する。
// Instagram側のAPIは一切使わない（キャプションはユーザー入力のテキストとして扱うだけ）。
// ここでは候補を複数返すだけで、店舗を1件に確定する処理は行わない。
// 実際の店舗照合は既存の resolve-place（Google Places）が担当し、
// 保存は既存の save_place RPC がそのまま担当する。

type ExtractRequest = {
  url: string;
  caption: string;
};

type ExtractResult = {
  store_name_candidates: string[];
  area_candidates: string[];
  category_candidates: string[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function getOutputText(payload: any): string | null {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return null;
}

const extractSchema = {
  type: "object",
  additionalProperties: false,
  required: ["store_name_candidates", "area_candidates", "category_candidates"],
  properties: {
    store_name_candidates: {
      type: "array",
      minItems: 0,
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 60 },
    },
    area_candidates: {
      type: "array",
      minItems: 0,
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 60 },
    },
    category_candidates: {
      type: "array",
      minItems: 0,
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 30 },
    },
  },
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return reply(401, { error: "authentication_required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_PLAN_MODEL");
  if (!supabaseUrl || !anonKey || !openAiKey || !model) {
    return reply(500, { error: "server_configuration_missing" });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return reply(401, { error: "invalid_session" });

  let body: ExtractRequest;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  if (!body.url || typeof body.url !== "string") {
    return reply(400, { error: "url_required" });
  }
  if (!body.caption || typeof body.caption !== "string" || body.caption.trim().length === 0) {
    return reply(400, { error: "caption_required" });
  }

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "You read a social media caption (mostly Japanese) about a place someone visited or wants to visit. "
              + "Extract plausible candidates for: the store/venue name, the area or neighborhood, and the category "
              + "(e.g. カフェ, ラーメン, 居酒屋). Only extract what is actually stated or clearly implied in the "
              + "caption or its hashtags. Never invent a specific name that is not grounded in the text. "
              + "A store name candidate must be a specific proper noun (an actual brand or shop name) written in the "
              + "caption, never a generic category description alone (for example 'カフェ', 'お店', '焼き鳥屋さん', "
              + "'ラーメン屋' by themselves are NOT store names) - when only a generic description is given, leave "
              + "store_name_candidates empty and put the descriptive word in category_candidates instead. "
              + "When you do extract a store name, return the clean name only: strip any trailing or leading "
              + "Japanese particle or connector that is not part of the actual name, such as 'の', 'で', 'にある', "
              + "'という', 'って', 'ってお店', 'さん' (e.g. from 'きのとやの大通公園店' extract 'きのとや大通公園店', not "
              + "'きのとやの大通公園店'). "
              + "If nothing plausible is found for a field, return an empty array for it. "
              + "Return candidates in the original language as written (do not translate).",
          }],
        },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: JSON.stringify({ url: body.url, caption: body.caption }),
          }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "mikke_place_extraction",
          strict: true,
          schema: extractSchema,
        },
      },
    }),
  });

  if (!aiResponse.ok) {
    const detail = await aiResponse.text();
    return reply(502, { error: "ai_extraction_failed", detail: detail.slice(0, 300) });
  }

  const aiPayload = await aiResponse.json();
  const outputText = getOutputText(aiPayload);
  if (aiPayload.status && aiPayload.status !== "completed") {
    return reply(502, { error: "ai_response_incomplete" });
  }
  if (!outputText) {
    return reply(502, { error: "ai_output_missing_or_refused" });
  }

  let result: ExtractResult;
  try {
    result = JSON.parse(outputText);
  } catch {
    return reply(502, { error: "ai_output_invalid_json" });
  }

  return reply(200, {
    store_name_candidates: result.store_name_candidates ?? [],
    area_candidates: result.area_candidates ?? [],
    category_candidates: result.category_candidates ?? [],
  });
});
