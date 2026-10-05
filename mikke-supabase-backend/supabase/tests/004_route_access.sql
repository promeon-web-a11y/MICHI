-- v3.0: Data API（PostgREST）からの直接取得の権限（202609290009_v3_access_ugc.sql）
-- PostgREST は利用者の JWT のロール（anon / authenticated）で SQL を実行するため、
-- ここでは同じロールでの SELECT / UPDATE / DELETE を「直接取得」として確認する。
-- 投稿者 A・別ユーザー B・未ログイン（anon）それぞれの 許可される取得 と 拒否される取得 を並べる。
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(49);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', 'a@test.local', '', now(), '{}', '{"display_name":"A"}', now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', 'b@test.local', '', now(), '{}', '{"display_name":"B"}', now(), now());

insert into public.places (id, provider_place_id, name, category) values
  ('11111111-1111-4111-8111-111111111111', 'acc-g1', 'Access Cafe', 'cafe'),
  ('22222222-2222-4222-8222-222222222222', 'acc-g2', 'Access Park', 'sightseeing');
insert into public.saved_places (user_id, place_id, source_url) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'https://example.com/1'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'https://example.com/2');

create temporary table acc_ctx (k text primary key, v uuid) on commit drop;
grant all on acc_ctx to anon, authenticated;

-- A: 採用済みプランを2つ作り、1つ目は非公開の記録、2つ目は公開する
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
insert into acc_ctx values ('plan_private', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"acc-1","title":"private walk"}}',
  '[{"place_id":"11111111-1111-4111-8111-111111111111","sequence":1,"stay_minutes":30,"selection_reason":"r"}]',
  1, 60, 1000)).id);
select public.accept_plan((select v from acc_ctx where k = 'plan_private'));
insert into acc_ctx values ('plan_public', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"acc-2","title":"public walk"}}',
  '[{"place_id":"22222222-2222-4222-8222-222222222222","sequence":1,"stay_minutes":30,"selection_reason":"r"}]',
  1, 60, 1000)).id);
select public.accept_plan((select v from acc_ctx where k = 'plan_public'));

insert into acc_ctx values ('post_private', (public.create_visit_record(
  (select v from acc_ctx where k = 'plan_private'), '{11111111-1111-4111-8111-111111111111}'::uuid[], 'secret memo A1')).id);
insert into acc_ctx values ('post_public', (public.create_visit_record(
  (select v from acc_ctx where k = 'plan_public'), '{22222222-2222-4222-8222-222222222222}'::uuid[], 'secret memo A2')).id);
select public.update_route_post((select v from acc_ctx where k = 'post_public'),
  jsonb_build_object('title', 'Public walk', 'area', '円山',
    'cover_photo_path', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_public') || '/cover.jpg'),
  true);

-- 写真（Storage の行。実ファイルは Storage API 側）
reset role;
insert into storage.objects (bucket_id, name, owner) values
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_public') || '/cover.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_private') || '/private.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
update public.route_post_stops set photo_path = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_private') || '/private.jpg'
where post_id = (select v from acc_ctx where k = 'post_private');

-- ---------------------------------------------------------------------------
-- 投稿者 A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select is((select count(*)::integer from public.route_posts), 2, 'A: direct select of display columns returns own public and private posts');
select is((select title from public.route_posts where id = (select v from acc_ctx where k = 'post_public')), 'Public walk', 'A: can read own title directly');
select throws_ok($$select memory from public.route_posts$$, '42501', null, 'A: direct select of memory is denied (even own)');
select throws_ok($$select plan_id from public.route_posts$$, '42501', null, 'A: direct select of plan_id is denied (even own)');
select throws_ok($$select * from public.route_posts$$, '42501', null, 'A: select * (PostgREST select=*) is denied');
select is(public.get_route_post((select v from acc_ctx where k = 'post_private')) ->> 'memory', 'secret memo A1', 'A: RPC detail still returns own private memory');
select is((public.get_route_post((select v from acc_ctx where k = 'post_private')) ->> 'plan_id')::uuid,
  (select v from acc_ctx where k = 'plan_private'), 'A: RPC detail still returns own plan_id');
select is(jsonb_array_length(public.list_my_route_posts()), 2, 'A: my posts list includes the private record');
select is((select count(*)::integer from public.route_post_stops), 2, 'A: can read own stops (private and public)');
select is((select count(*)::integer from storage.objects where bucket_id = 'route-photos'), 2, 'A: can see own photo objects');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_private') || '/new.jpg')$$,
  'A: can upload into own post folder (policy works without direct user_id access)');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999/x.jpg')$$,
  '42501', null, 'A: cannot upload into a folder of a post that is not own');
select throws_ok($$update public.route_posts set title = 'x'$$, '42501', null, 'A: direct update is denied (RPC only)');
select throws_ok($$insert into public.route_comments (post_id, user_id, body) values ((select v from acc_ctx where k = 'post_public'), auth.uid(), 'x')$$,
  '42501', null, 'A: direct comment insert is denied (RPC only)');

-- ---------------------------------------------------------------------------
-- 別ユーザー B
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);

select is((select count(*)::integer from public.route_posts), 1, 'B: direct select returns only the public post');
select is((select id from public.route_posts), (select v from acc_ctx where k = 'post_public'), 'B: the visible row is the public one');
select throws_ok($$select memory from public.route_posts$$, '42501', null, 'B: direct select of memory is denied');
select throws_ok($$select plan_id from public.route_posts$$, '42501', null, 'B: direct select of plan_id is denied');
select throws_ok($$select user_id from public.route_posts$$, '42501', null, 'B: direct select of author user_id is denied');
select throws_ok($$select * from public.route_posts$$, '42501', null, 'B: select * is denied');
select throws_ok($$select id from public.route_posts where memory like '%secret%'$$, '42501', null, 'B: filtering by memory (side channel) is denied');
select is(public.get_route_post((select v from acc_ctx where k = 'post_public')) ->> 'memory', null, 'B: RPC detail hides memory');
select is(public.get_route_post((select v from acc_ctx where k = 'post_public')) ->> 'plan_id', null, 'B: RPC detail hides plan_id');
select is(public.get_route_post((select v from acc_ctx where k = 'post_private')), null, 'B: RPC detail of private record is null');
select is(jsonb_array_length(public.list_public_routes()), 1, 'B: public feed shows the public post');
select ok(not (public.list_public_routes() -> 0 ? 'memory' and public.list_public_routes() -> 0 ->> 'memory' is not null), 'B: feed card has no memory');
select is((select count(*)::integer from public.route_post_stops where post_id = (select v from acc_ctx where k = 'post_private')), 0, 'B: stops of private record are not readable');
select is((select count(*)::integer from public.route_post_stops where post_id = (select v from acc_ctx where k = 'post_public')), 1, 'B: stops of public post are readable');
select is((select count(*)::integer from storage.objects where bucket_id = 'route-photos'), 1, 'B: only the public post photo object is visible');
select is((select name from storage.objects where bucket_id = 'route-photos'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_public') || '/cover.jpg', 'B: the visible photo is the public cover');
delete from public.route_posts where id = (select v from acc_ctx where k = 'post_public');
select is((select count(*)::integer from public.route_posts where id = (select v from acc_ctx where k = 'post_public')), 1, 'B: direct delete of A post removes nothing');
delete from storage.objects where bucket_id = 'route-photos';
select is((select count(*)::integer from storage.objects where bucket_id = 'route-photos'), 1, 'B: direct delete of A photo objects removes nothing');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from acc_ctx where k = 'post_public') || '/evil.jpg')$$,
  '42501', null, 'B: cannot upload into A folder');
select is((select count(*)::integer from public.users), 1, 'B: users table shows only own row');

select lives_ok($$select public.add_route_comment((select v from acc_ctx where k = 'post_public'), 'nice')$$, 'B: can comment on the public post via RPC');
select is((select body from public.route_comments), 'nice', 'B: comment body is readable directly');
select throws_ok($$select user_id from public.route_comments$$, '42501', null, 'B: commenter user_id is not readable directly');
select lives_ok($$select public.toggle_route_reaction((select v from acc_ctx where k = 'post_public'), 'like')$$, 'B: can like via RPC');
select is((select count(*)::integer from public.route_likes), 1, 'B: sees own like');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select count(*)::integer from public.route_likes), 0, 'A: does not see who liked (other users likes rows)');
select throws_ok($$select user_id from public.route_comments$$, '42501', null, 'A: commenter user_id is not readable directly either');

-- ---------------------------------------------------------------------------
-- 未ログイン（anon）
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);

select throws_ok($$select id from public.route_posts$$, '42501', null, 'anon: route_posts is denied');
select throws_ok($$select id from public.route_post_stops$$, '42501', null, 'anon: route_post_stops is denied');
select throws_ok($$select id from public.route_comments$$, '42501', null, 'anon: route_comments is denied');
select throws_ok($$select post_id from public.route_likes$$, '42501', null, 'anon: route_likes is denied');
select throws_ok($$select id from public.users$$, '42501', null, 'anon: users is denied');
select throws_ok($$select public.list_public_routes()$$, '42501', null, 'anon: list_public_routes RPC is denied');
select throws_ok($$select public.get_route_post((select v from acc_ctx where k = 'post_public'))$$, '42501', null, 'anon: get_route_post RPC is denied');
select is((select count(*)::integer from storage.objects where bucket_id = 'route-photos'), 0, 'anon: no photo objects are visible');

select * from finish();
rollback;
