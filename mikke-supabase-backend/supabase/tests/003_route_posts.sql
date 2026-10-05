-- v3.0: 行った記録・公開ルート・反応・コメント・写真・生成回数（202609280008_v3_route_posts.sql）
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(24);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', 'a@test.local', '', now(), '{}', '{}', now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', 'b@test.local', '', now(), '{}', '{}', now(), now());

insert into public.places (id, provider_place_id, name, category) values
  ('11111111-1111-4111-8111-111111111111', 'v3-g1', 'v3 Cafe', 'cafe'),
  ('22222222-2222-4222-8222-222222222222', 'v3-g2', 'v3 Park', 'sightseeing');
insert into public.saved_places (user_id, place_id, source_url) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'https://example.com/1'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'https://example.com/2');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

create temporary table v3_ctx (plan_id uuid, post_id uuid) on commit drop;
grant all on v3_ctx to authenticated;
insert into v3_ctx (plan_id)
select (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"v3-set","title":"v3 walk"}}',
  '[{"place_id":"22222222-2222-4222-8222-222222222222","sequence":1,"stay_minutes":30,"selection_reason":"r"},
    {"place_id":"11111111-1111-4111-8111-111111111111","sequence":2,"stay_minutes":30,"selection_reason":"r"}]',
  2, 60, 1000)).id;
select public.accept_plan((select plan_id from v3_ctx));

select is((public.get_plan_generation_usage() ->> 'used')::integer, 1, 'usage counts one generation set this month');
select ok(public.get_plan_generation_usage() -> 'monthly_limit' = 'null'::jsonb, 'free limit is not invented (null)');

select throws_ok(
  $$select public.create_visit_record((select plan_id from v3_ctx), '{33333333-3333-4333-8333-333333333333}'::uuid[], null)$$,
  '42501', 'visited_place_not_in_plan', 'record rejects places outside the plan'
);
update v3_ctx set post_id = (public.create_visit_record(
  (select plan_id from v3_ctx), '{11111111-1111-4111-8111-111111111111}'::uuid[], 'memo')).id;
select is((select visibility from public.route_posts where id = (select post_id from v3_ctx)), 'private', 'new record is private');
select is((select went from public.visits where plan_id = (select plan_id from v3_ctx)), true, 'record also answers the visit');
select throws_ok($$insert into public.route_posts (user_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$,
  '42501', null, 'direct insert into route_posts is not allowed');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*)::integer from public.route_posts), 0, 'B cannot see A private record');
select is(public.get_route_post((select post_id from v3_ctx)), null, 'B gets null detail for private record');
select throws_ok($$select public.toggle_route_reaction((select post_id from v3_ctx), 'like')$$,
  'P0002', 'route_post_not_found', 'B cannot like a private record');
select throws_ok($$select public.update_route_post((select post_id from v3_ctx), '{"title":"x"}', true)$$,
  'P0002', 'route_post_not_found', 'B cannot publish A record');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok(
  $$select public.update_route_post((select post_id from v3_ctx),
    '{"title":"t","stops":[{"sequence":1,"photo_path":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/x/p.jpg"}]}', true)$$,
  '42501', 'invalid_photo_path', 'photos must be in the owner post folder'
);
select lives_ok(
  $$select public.update_route_post((select post_id from v3_ctx),
    '{"title":"v3 route","area":"円山","genre":"カフェ","theme":"ひとり","budget_yen":1500,
      "stops":[{"sequence":1,"visited_time":"10:30","action":"coffee","note":"good"}]}', true)$$,
  'owner publishes with explicit publish flag'
);

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is(jsonb_array_length(public.list_public_routes()), 1, 'published route is listed');
select is(jsonb_array_length(public.list_public_routes('v3 Cafe')), 1, 'keyword matches stop names');
select is(jsonb_array_length(public.list_public_routes(null, '円山', 1000)), 0, 'budget ceiling filters');
select is(public.list_public_routes() -> 0 ->> 'memory', null, 'private memo is not exposed to others');
select is((public.toggle_route_reaction((select post_id from v3_ctx), 'like') ->> 'like_count')::integer, 1, 'like increments count');
select is((public.toggle_route_reaction((select post_id from v3_ctx), 'like') ->> 'like_count')::integer, 0, 'second tap removes like');
select lives_ok($$select public.add_route_comment((select post_id from v3_ctx), 'nice')$$, 'B can comment on a public route');
select is((public.get_route_post((select post_id from v3_ctx)) ->> 'comment_count')::integer, 1, 'comment count is kept');
select is(((public.start_route_from_post((select post_id from v3_ctx))).status)::text, 'accepted', 'same order creates an accepted plan');
select is((public.get_plan_generation_usage() ->> 'used')::integer, 0, 'route copies are not counted as generations');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
update public.users set show_posts_in_feed = false where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is(jsonb_array_length(public.list_public_routes()), 0, 'hidden author posts are not listed');
select is(public.get_route_post((select post_id from v3_ctx)), null, 'hidden author posts are not readable by others');

reset role;
select * from finish();
rollback;
