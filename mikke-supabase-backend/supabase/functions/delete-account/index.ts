import { createClient } from "npm:@supabase/supabase-js@2";

import { deleteAccount, httpStatusFor, makeResponse, removeUserRoutePhotos, ROUTE_PHOTO_BUCKET } from "./logic.ts";

// ログイン中の本人のアカウントを削除する（アプリの「アカウントを削除」）。
// - 本人確認: リクエストの JWT を anon key のクライアントで Supabase Auth に問い合わせて user id を確定する
//   （verify_jwt = true のゲートウェイ検証に加え、セッションが有効かもここで確認する）
// - 削除: Service Role Key の管理クライアントで auth.users を hard delete する。Service Role Key は
//   Edge Functions に標準で入る SUPABASE_SERVICE_ROLE_KEY を使い、モバイル・ログ・レスポンスには出さない
// - user_id はクライアントから受け取らない（本文は { confirm: "delete_my_account" } のみ）
// - 関連データの削除・匿名化は DB の既存 CASCADE / トリガーが1トランザクションで行う

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function log(event: string, detail: Record<string, unknown>) {
  // JWT・user_id・メールアドレスは出力しない
  console.log(JSON.stringify({ event, ...detail }));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, makeResponse("invalid_request", "method_not_allowed"));

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    log("delete_account_config_missing", {});
    return reply(500, makeResponse("error", "server_configuration_missing"));
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null; // validateDeleteRequest で invalid_request になる
  }

  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
  const userClient = createClient(supabaseUrl, anonKey, clientOptions);
  const admin = createClient(supabaseUrl, serviceRoleKey, clientOptions);

  const result = await deleteAccount(
    { authorization: request.headers.get("Authorization"), body },
    {
      getUserId: async (jwt) => {
        const { data, error } = await userClient.auth.getUser(jwt);
        if (error || !data.user) return null;
        return data.user.id;
      },
      deleteUser: async (userId) => {
        // v3: 投稿写真（route-photos/<user_id>/<post_id>/*）を先に消す。DB の行は CASCADE で消えるが Storage は消えないため。
        // 消し切れなくてもアカウント削除は続ける（ログに件数だけ残す。残ったフォルダーは
        // docs/account-deletion-runbook.md の「持ち主のいない投稿写真」の手順で運営が消す）
        try {
          await removeUserRoutePhotos(admin.storage.from(ROUTE_PHOTO_BUCKET), userId, log);
        } catch (e) {
          log("delete_account_photo_cleanup_threw", { message: String(e).slice(0, 120) });
        }
        // 第2引数 false = hard delete（soft delete では CASCADE が動かず個人データが残る）
        const { error } = await admin.auth.admin.deleteUser(userId, false);
        if (!error) return { ok: true };
        const status = (error as { status?: number }).status;
        return { ok: false, notFound: status === 404, detail: `${status ?? ""} ${error.message}` };
      },
      log,
    },
  );
  return reply(httpStatusFor(result.status), result);
});
