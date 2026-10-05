import { readFile, readdir, stat } from "node:fs/promises";

const requiredFiles = [
  "supabase/migrations/202609230001_initial_schema.sql",
  "supabase/migrations/202609240005_add_visit_confirmed_event_name.sql",
  "supabase/migrations/202609240006_secure_event_tracking.sql",
  "supabase/migrations/202609240007_analytics_kpi.sql",
  "supabase/migrations/202609280008_v3_route_posts.sql",
  "supabase/tests/003_route_posts.sql",
  "supabase/migrations/202609290009_v3_access_ugc.sql",
  "supabase/tests/004_route_access.sql",
  "supabase/tests/005_ugc_moderation.sql",
  "docs/moderation-runbook.md",
  "supabase/migrations/202609290010_v3_spots.sql",
  "supabase/tests/006_spots.sql",
  "supabase/migrations/202609290011_v3_route_photo_policy.sql",
  "supabase/functions/generate-plan/index.ts",
  "supabase/tests/001_schema_rls_events.sql",
  "supabase/tests/002_event_integrity_analytics.sql",
  "supabase/seed.sql",
  "src/mikke-backend.ts",
  "README.md",
];

for (const file of requiredFiles) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`missing_or_empty:${file}`);
}

const migrationDir = "supabase/migrations";
const migrationFiles = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
const migrations = Object.fromEntries(await Promise.all(
  migrationFiles.map(async (name) => [name, await readFile(`${migrationDir}/${name}`, "utf8")]),
));
const allMigrations = Object.values(migrations).join("\n");
const initial = migrations["202609230001_initial_schema.sql"];

for (const table of ["users", "places", "saved_places", "plans", "plan_items", "visits", "events"]) {
  if (!initial.includes(`create table if not exists public.${table}`)) throw new Error(`missing_table:${table}`);
  if (!initial.includes(`alter table public.${table} enable row level security`)) throw new Error(`missing_rls:${table}`);
}
for (const event of [
  "sign_up_completed", "url_submitted", "place_extraction_result", "place_saved",
  "place_removed", "plan_request_submitted", "plan_generated", "plan_generation_failed",
  "plan_accepted", "plan_regenerated", "visit_answered", "visit_confirmed",
]) {
  if (!allMigrations.includes(`'${event}'`)) throw new Error(`missing_event:${event}`);
}

// Every migration must keep begin/commit balanced.
for (const [name, sql] of Object.entries(migrations)) {
  if ((sql.match(/\bbegin;/g) ?? []).length !== (sql.match(/\bcommit;/g) ?? []).length) {
    throw new Error(`unbalanced_transaction:${name}`);
  }
}

// A newly added enum value cannot be used in the transaction that adds it, so the
// migration adding visit_confirmed must not do anything else.
const enumMigration = migrations["202609240005_add_visit_confirmed_event_name.sql"]
  .split("\n").filter((line) => !line.trim().startsWith("--") && line.trim() !== "");
if (enumMigration.length !== 1 || !enumMigration[0].includes("add value if not exists 'visit_confirmed'")) {
  throw new Error("enum_migration_must_only_add_visit_confirmed");
}

// Event integrity / analytics invariants.
const secure = migrations["202609240006_secure_event_tracking.sql"];
const analytics = migrations["202609240007_analytics_kpi.sql"];
const expectations = [
  [secure, "drop policy if exists events_update_own on public.events;", "events_update_own_not_dropped"],
  [secure, "revoke insert, update, delete, truncate, references, trigger on public.events from authenticated;", "events_writes_not_revoked"],
  [secure, "security definer", "track_event_not_definer"],
  [secure, "create unique index if not exists events_visit_confirmed_once", "visit_confirmed_not_deduplicated"],
  [analytics, "on delete set null", "events_user_fk_not_set_null"],
  [analytics, "add column if not exists is_internal", "is_internal_missing"],
  [analytics, "revoke all on schema analytics from PUBLIC, anon, authenticated;", "analytics_schema_exposed"],
  [analytics, "create or replace view analytics.kpi_totals", "kpi_totals_missing"],
  [analytics, "create or replace view analytics.kpi_daily", "kpi_daily_missing"],
  [analytics, "at time zone 'Asia/Tokyo'", "kpi_timezone_missing"],
];
for (const [sql, needle, error] of expectations) {
  if (!sql.includes(needle)) throw new Error(error);
}
if (/grant\s+[^;]*\bon\s+(schema\s+)?analytics/i.test(allMigrations)) {
  throw new Error("analytics_must_not_be_granted");
}

// generate-plan must log failed track_event calls instead of ignoring them.
const generatePlan = await readFile("supabase/functions/generate-plan/index.ts", "utf8");
if (!generatePlan.includes("track_event_failed")) throw new Error("generate_plan_event_errors_not_logged");
if ((generatePlan.match(/supabase\.rpc\("track_event"/g) ?? []).length !== 1) {
  throw new Error("generate_plan_track_event_must_go_through_recordEvent");
}

// generate-plan: the AI must not decide clock times, IDs are pinned by enum, and every plan
// passes the server-side scheduler + final gate before create_generated_plan.
const planLogic = await readFile("supabase/functions/generate-plan/plan.ts", "utf8");
for (const [needle, error] of [
  ["place_key: { type: \"string\", enum:", "plan_schema_must_pin_place_keys"],
  ["export function schedulePlan(", "plan_scheduler_missing"],
  ["export function validatePlan(", "plan_final_gate_missing"],
  ["MAX_LEG_TRAVEL_MINUTES", "plan_travel_feasibility_missing"],
  // end <= start must keep returning invalid_time_range (never relaxed).
  ["if (end <= start) return { ok: false, error: \"invalid_time_range\" };", "invalid_time_range_check_missing"],
  ["(?:Z|[+-]\\d{2}:\\d{2})$/", "request_time_offset_not_required"],
]) {
  if (!planLogic.includes(needle)) throw new Error(error);
}
const aiSchema = planLogic.slice(planLogic.indexOf("export function planSchema("), planLogic.indexOf("export const SYSTEM_PROMPT"));
if (/start_at|travel_minutes/.test(aiSchema)) throw new Error("ai_schema_must_not_ask_for_clock_times");
if (!generatePlan.includes("generateValidPlan(") || !generatePlan.includes("p_items: result.plan.items")) {
  throw new Error("generate_plan_must_save_only_validated_plan");
}
await stat("tests/functions/plan.test.ts");

// pgTAP plan() counts must match the assertions in each test file.
const testDir = "supabase/tests";
for (const name of (await readdir(testDir)).filter((file) => file.endsWith(".sql"))) {
  const tests = await readFile(`${testDir}/${name}`, "utf8");
  const declaredTests = Number(tests.match(/select plan\((\d+)\)/)?.[1]);
  const actualTests = (tests.match(/select (?:has_table|is|isnt|ok|lives_ok|throws_ok)\(/g) ?? []).length;
  if (declaredTests !== actualTests) throw new Error(`pgtap_count:${name}:${declaredTests}:${actualTests}`);
}

// delete-account must hard delete the caller only (soft delete leaves personal data; body user_id is never read).
const deleteAccountIndex = await readFile("supabase/functions/delete-account/index.ts", "utf8");
if (!deleteAccountIndex.includes("admin.auth.admin.deleteUser(userId, false)")) throw new Error("delete_account_not_hard_delete");
const deleteAccountLogic = await readFile("supabase/functions/delete-account/logic.ts", "utf8");
if (!deleteAccountLogic.includes('k !== "confirm"')) throw new Error("delete_account_accepts_extra_fields");
if (!/\[functions\.delete-account\]\r?\nverify_jwt = true/.test(await readFile("supabase/config.toml", "utf8"))) {
  throw new Error("delete_account_verify_jwt_missing");
}

// v3.0: 公開ルートは RLS と非公開の写真バケットで守る
const v3 = migrations["202609280008_v3_route_posts.sql"];
for (const table of ["route_posts", "route_post_stops", "route_likes", "route_wishes", "route_comments"]) {
  if (!v3.includes(`alter table public.${table} enable row level security`)) throw new Error(`missing_rls:${table}`);
}
if (!v3.includes("'route-photos', 'route-photos', false")) throw new Error("route_photos_bucket_must_be_private");
if (/grant\s+(insert|update)[^;]*on public\.route_/i.test(v3)) throw new Error("route_tables_must_not_grant_direct_writes");

// v3.0 追補: 他人の投稿の memory / plan_id / user_id を Data API から直接読ませない（列単位の SELECT）
const v3Access = migrations["202609290009_v3_access_ugc.sql"];
for (const [needle, error] of [
  ["revoke select on public.route_posts from authenticated;", "route_posts_table_select_not_revoked"],
  ["revoke select on public.route_comments from authenticated;", "route_comments_table_select_not_revoked"],
  ["alter table public.user_blocks enable row level security", "missing_rls:user_blocks"],
  ["alter table public.content_reports enable row level security", "missing_rls:content_reports"],
  ["revoke all on schema moderation from PUBLIC, anon, authenticated;", "moderation_schema_exposed"],
  ["pg_advisory_xact_lock(", "reaction_toggle_not_serialized"],
]) {
  if (!v3Access.includes(needle)) throw new Error(error);
}
const routePostsGrant = v3Access.match(/grant select \(([^)]*)\) on public\.route_posts to authenticated;/);
if (!routePostsGrant) throw new Error("route_posts_column_grant_missing");
for (const column of ["memory", "plan_id", "user_id", "hidden_reason", "hidden_at"]) {
  if (new RegExp(`\b${column}\b`).test(routePostsGrant[1])) throw new Error(`route_posts_private_column_granted:${column}`);
}
const commentsGrant = v3Access.match(/grant select \(([^)]*)\) on public\.route_comments to authenticated;/);
if (!commentsGrant || /\buser_id\b/.test(commentsGrant[1])) throw new Error("route_comments_user_id_granted");
// 以降の migration で表全体の SELECT を与え直さない
const afterAccess = migrationFiles
  .slice(migrationFiles.indexOf("202609290009_v3_access_ugc.sql") + 1)
  .map((f) => migrations[f])
  .join("\n");
if (/grant\s+(select|all)\s+on\s+(table\s+)?public\.(route_posts|route_comments|content_reports|user_blocks)\b/i.test(afterAccess)) {
  throw new Error("v3_private_tables_regranted");
}
if (/grant\s+[^;]*\bon\s+(schema\s+|all\s+\w+\s+in\s+schema\s+)?moderation\b/i.test(allMigrations)) {
  throw new Error("moderation_must_not_be_granted");
}

// v3 スポット: いいねした人を Data API に出さない。行きたいは既存の saved_places を使う（同じ目的の表を増やさない）
const v3Spots = migrations["202609290010_v3_spots.sql"];
if (!v3Spots.includes("alter table public.place_likes enable row level security")) throw new Error("missing_rls:place_likes");
if (!v3Spots.includes("revoke all on public.place_likes from PUBLIC, anon, authenticated;")) throw new Error("place_likes_exposed");
if (/create table[^;]*place_wishes/i.test(allMigrations)) throw new Error("spot_wishes_must_use_saved_places");

// 写真アップロードのポリシーは route_posts.user_id を利用者の権限で直接読まない（0009 の列権限で常に拒否になるため）
const photoPolicy = migrations["202609290011_v3_route_photo_policy.sql"];
if (!photoPolicy.includes("public.owns_route_post_folder((storage.foldername(name))[2])")) throw new Error("route_photo_insert_policy_not_fixed");

console.log("static-check: OK");

