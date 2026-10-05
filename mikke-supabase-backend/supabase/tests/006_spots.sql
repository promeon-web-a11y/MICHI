-- v3 デザイン反映: お店・スポット・スポットの いいね / 行きたい・立ち寄りコメント（202609290010_v3_spots.sql）
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(37);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', 'a@test.local', '', now(), '{}', '{"display_name":"A"}', now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', 'b@test.local', '', now(), '{}', '{"display_name":"B"}', now(), now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'authenticated', 'authenticated', 'c@test.local', '', now(), '{}', '{"display_name":"C"}', now(), now());

insert into public.places (id, provider_place_id, name, category, address) values
  ('11111111-1111-4111-8111-111111111111', 'sp-g1', 'Spot Cafe', 'cafe', 'Test City 1'),
  ('22222222-2222-4222-8222-222222222222', 'sp-g2', 'Spot Park', 'sightseeing', 'Test City 2'),
  ('33333333-3333-4333-8333-333333333333', 'sp-g3', 'Private Spot', 'shopping', 'Test City 3');
insert into public.saved_places (user_id, place_id, source_url)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', p, 'https://example.com/' || p
from unnest(array['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']::uuid[]) p;

create temporary table sp_ctx (k text primary key, v uuid) on commit drop;
grant all on sp_ctx to anon, authenticated;

-- A: 場所1・2 の公開ルートと、場所3 の非公開の記録
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
insert into sp_ctx values ('plan_pub', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"sp-1","title":"pub"}}',
  '[{"place_id":"11111111-1111-4111-8111-111111111111","sequence":1,"stay_minutes":30,"selection_reason":"r"},
    {"place_id":"22222222-2222-4222-8222-222222222222","sequence":2,"stay_minutes":30,"selection_reason":"r"}]', 2, 60, 1000)).id);
select public.accept_plan((select v from sp_ctx where k = 'plan_pub'));
insert into sp_ctx values ('post', (public.create_visit_record((select v from sp_ctx where k = 'plan_pub'),
  '{11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222}'::uuid[], null)).id);
select public.update_route_post((select v from sp_ctx where k = 'post'), jsonb_build_object(
  'title', 'Public', 'area', '円山',
  'stops', jsonb_build_array(jsonb_build_object('sequence', 1, 'note', repeat('あ', 300),
    'photo_path', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from sp_ctx where k = 'post') || '/cafe.jpg'))
), true);
insert into sp_ctx values ('plan_priv', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"sp-2","title":"priv"}}',
  '[{"place_id":"33333333-3333-4333-8333-333333333333","sequence":1,"stay_minutes":30,"selection_reason":"r"}]', 1, 60, 1000)).id);
select public.accept_plan((select v from sp_ctx where k = 'plan_priv'));
select public.create_visit_record((select v from sp_ctx where k = 'plan_priv'), '{33333333-3333-4333-8333-333333333333}'::uuid[], null);

select is((select char_length(note) from public.route_post_stops where post_id = (select v from sp_ctx where k = 'post') and sequence = 1), 300,
  'stop comment accepts 300 characters');
select throws_ok($$select public.update_route_post((select v from sp_ctx where k = 'post'),
  jsonb_build_object('title', 'x', 'stops', jsonb_build_array(jsonb_build_object('sequence', 1, 'note', repeat('あ', 301)))), false)$$,
  '23514', null, 'stop comment over 300 characters is rejected');

-- ---------------------------------------------------------------------------
-- B: 一覧・詳細
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is(jsonb_array_length(public.list_public_spots()), 2, 'spots are the places of visible public routes only');
select ok(not exists (select 1 from jsonb_array_elements(public.list_public_spots()) e where e ->> 'name' = 'Private Spot'),
  'places of private records are not listed');
select is((select e ->> 'photo_path' from jsonb_array_elements(public.list_public_spots()) e where e ->> 'name' = 'Spot Cafe'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from sp_ctx where k = 'post') || '/cafe.jpg', 'spot photo comes from the posted stop photo');
select is((select e ->> 'area' from jsonb_array_elements(public.list_public_spots()) e where e ->> 'name' = 'Spot Cafe'), '円山', 'spot area comes from the route area');
select is((select e ->> 'photo_path' from jsonb_array_elements(public.list_public_spots()) e where e ->> 'name' = 'Spot Park'), null, 'no photo is invented');
select is(jsonb_array_length(public.list_public_spots(null, 'cafe')), 1, 'category filter');
select is(jsonb_array_length(public.list_public_spots('park')), 1, 'keyword filter');
select is(jsonb_array_length(public.list_public_spots('円山')), 2, 'keyword matches the route area');
select is(public.get_spot('33333333-3333-4333-8333-333333333333'), null, 'B cannot open a place only in A private record');
select is(jsonb_array_length(public.get_spot('11111111-1111-4111-8111-111111111111') -> 'routes'), 1, 'spot detail lists routes that include the place');
select is(jsonb_array_length(public.get_spot('11111111-1111-4111-8111-111111111111') -> 'photos'), 1, 'spot detail lists posted photos');

-- ---------------------------------------------------------------------------
-- いいね・行きたい（独立した状態・冪等）
-- ---------------------------------------------------------------------------
select is((public.set_place_reaction('11111111-1111-4111-8111-111111111111', 'like', true) ->> 'like_count')::integer, 1, 'like a spot');
select is((public.set_place_reaction('11111111-1111-4111-8111-111111111111', 'like', true) ->> 'like_count')::integer, 1, 'double like keeps 1');
select is((public.get_spot('11111111-1111-4111-8111-111111111111') ->> 'wished')::boolean, false, 'like does not add to wish list');
select is((public.set_place_reaction('11111111-1111-4111-8111-111111111111', 'wish', true) ->> 'wished')::boolean, true, 'wish a spot');
select is((select count(*)::integer from public.saved_places where place_id = '11111111-1111-4111-8111-111111111111'), 1,
  'wish is saved as a saved place (own row only visible)');
select is((select source_url from public.saved_places where place_id = '11111111-1111-4111-8111-111111111111'),
  'mikke://places/11111111-1111-4111-8111-111111111111', 'wish source is marked as Mikke');
select is((public.set_place_reaction('11111111-1111-4111-8111-111111111111', 'wish', true) ->> 'wished')::boolean, true, 'double wish is idempotent');
select is(
  (select (e ->> 'wished')::boolean from jsonb_array_elements(public.get_route_post((select v from sp_ctx where k = 'post')) -> 'stops') e where (e ->> 'sequence')::int = 1),
  true, 'route detail marks the wished stop');
select is(
  (select (e ->> 'wished')::boolean from jsonb_array_elements(public.get_route_post((select v from sp_ctx where k = 'post')) -> 'stops') e where (e ->> 'sequence')::int = 2),
  false, 'other stop is not wished');
select is(jsonb_array_length(public.list_my_place_likes()), 1, 'my liked spots');
select is((public.list_my_place_likes() -> 0 ->> 'liked')::boolean, true, 'liked spot card is marked liked');
select is((public.set_place_reaction('11111111-1111-4111-8111-111111111111', 'like', false) ->> 'liked')::boolean, false, 'unlike');
select is((public.get_spot('11111111-1111-4111-8111-111111111111') ->> 'wished')::boolean, true, 'unlike keeps the wish');
select throws_ok($$select public.set_place_reaction('33333333-3333-4333-8333-333333333333', 'like', true)$$,
  'P0002', 'spot_not_found', 'cannot like a place that is not visible');
select throws_ok($$select public.set_place_reaction('11111111-1111-4111-8111-111111111111', 'love', true)$$,
  '22023', 'invalid_reaction', 'unknown reaction kind');
select throws_ok($$select user_id from public.place_likes$$, '42501', null, 'place_likes are not readable via Data API');
select throws_ok($$insert into public.place_likes (user_id, place_id) values (auth.uid(), '22222222-2222-4222-8222-222222222222')$$,
  '42501', null, 'place_likes cannot be written directly');

-- ブロック・非公開化の反映
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select public.block_user((select v from sp_ctx where k = 'post'));
select is(jsonb_array_length(public.list_public_spots()), 0, 'spots of blocked users routes are hidden');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select public.unpublish_route_post((select v from sp_ctx where k = 'post'));
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is(jsonb_array_length(public.list_public_spots()), 0, 'unpublished route spots disappear from the list');
select ok(public.get_spot('11111111-1111-4111-8111-111111111111') is not null, 'a saved (wished) spot stays viewable for the saver');
select is(public.get_spot('11111111-1111-4111-8111-111111111111') ->> 'photo_path', null, 'photo of the unpublished route is no longer shown');
select is(jsonb_array_length(public.get_spot('11111111-1111-4111-8111-111111111111') -> 'routes'), 0, 'unpublished route is not linked');

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$select public.list_public_spots()$$, '42501', null, 'anon cannot list spots');
select throws_ok($$select public.get_spot('11111111-1111-4111-8111-111111111111')$$, '42501', null, 'anon cannot open a spot');

select * from finish();
rollback;
