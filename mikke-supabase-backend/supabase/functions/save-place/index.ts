import { createClient } from "npm:@supabase/supabase-js@2";

import {
  DbError,
  httpStatusFor,
  makeResponse,
  type PlaceRow,
  savePlace,
  type SavedPlaceRow,
  validateSaveRequest,
} from "./logic.ts";

// identify-place で特定した（またはユーザーが候補から選んだ）Place を、ログインユーザーの保存Placeとして登録する。
// 書き込みは既存の save_place RPC（security definer / auth.uid()）で行う。
// Supabase クライアントはリクエストの JWT のまま作成し、Service Role Key は使わない（RLS が常に効く）。
// user_id はクライアントから受け取らない。

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function log(event: string, detail: Record<string, unknown>) {
  // 共有本文・JWT・user_id は出力しない
  console.log(JSON.stringify({ event, ...detail }));
}

const PLACE_COLUMNS = "id, provider, provider_place_id, name, category, address, latitude, longitude";
const SAVED_COLUMNS = "id, user_id, place_id, source_platform, source_url, extraction_confidence, saved_at, updated_at";

function toDbError(error: { message?: string; code?: string } | null): DbError {
  return new DbError(error?.message ?? "db_error", error?.code ?? null);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, makeResponse("invalid_request", "method_not_allowed"));

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return reply(401, makeResponse("unauthorized", "authentication_required"));

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    log("save_place_config_missing", {});
    return reply(500, makeResponse("error", "server_configuration_missing"));
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // JWT からユーザーを確定（本文の user_id は使わない）
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return reply(401, makeResponse("unauthorized", "invalid_session"));
  const userId = authData.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(400, makeResponse("invalid_request", "invalid_json"));
  }
  const validation = validateSaveRequest(body);
  if (!validation.ok) return reply(400, makeResponse("invalid_request", validation.code));

  try {
    const result = await savePlace(validation.value, {
      findPlace: async (googlePlaceId) => {
        const { data, error } = await supabase
          .from("places")
          .select(PLACE_COLUMNS)
          .eq("provider", "google")
          .eq("provider_place_id", googlePlaceId)
          .maybeSingle();
        if (error) throw toDbError(error);
        return (data as PlaceRow | null) ?? null;
      },
      findSaved: async (placeId) => {
        const { data, error } = await supabase
          .from("saved_places")
          .select(SAVED_COLUMNS)
          .eq("user_id", userId)
          .eq("place_id", placeId)
          .maybeSingle();
        if (error) throw toDbError(error);
        return (data as SavedPlaceRow | null) ?? null;
      },
      savePlaceRpc: async (args) => {
        const { data, error } = await supabase.rpc("save_place", args);
        if (error) throw toDbError(error);
        return data as SavedPlaceRow;
      },
      loadPlace: async (placeId) => {
        const { data, error } = await supabase.from("places").select(PLACE_COLUMNS).eq("id", placeId).maybeSingle();
        if (error) throw toDbError(error);
        return (data as PlaceRow | null) ?? null;
      },
      log,
    });
    return reply(httpStatusFor(result.status), result);
  } catch (e) {
    log("save_place_internal_error", { message: String(e).slice(0, 200) });
    return reply(500, makeResponse("error", "internal_error"));
  }
});
