-- v3.0: 反応の冪等化・記録の付け直し・使われていない写真・通報・ブロック・運営対応（202609290009_v3_access_ugc.sql）
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(64);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', 'a@test.local', '', now(), '{}', '{"display_name":"Aさん"}', now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', 'b@test.local', '', now(), '{}', '{"display_name":"Bさん"}', now(), now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'authenticated', 'authenticated', 'c@test.local', '', now(), '{}', '{"display_name":"Cさん"}', now(), now());

insert into public.places (id, provider_place_id, name, category) values
  ('11111111-1111-4111-8111-111111111111', 'ugc-g1', 'UGC Cafe', 'cafe'),
  ('22222222-2222-4222-8222-222222222222', 'ugc-g2', 'UGC Park', 'sightseeing'),
  ('33333333-3333-4333-8333-333333333333', 'ugc-g3', 'UGC Books', 'shopping');
insert into public.saved_places (user_id, place_id, source_url)
select u, p, 'https://example.com/' || p
from unnest(array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']::uuid[]) u
cross join unnest(array['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']::uuid[]) p;

create temporary table ugc_ctx (k text primary key, v uuid) on commit drop;
grant all on ugc_ctx to authenticated;

-- A: 公開投稿（場所3）と、付け直し用の非公開記録（場所1・2）
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
insert into ugc_ctx values ('plan_pub', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"ugc-1","title":"A public"}}',
  '[{"place_id":"33333333-3333-4333-8333-333333333333","sequence":1,"stay_minutes":30,"selection_reason":"r"}]', 1, 60, 1000)).id);
select public.accept_plan((select v from ugc_ctx where k = 'plan_pub'));
insert into ugc_ctx values ('post_a', (public.create_visit_record((select v from ugc_ctx where k = 'plan_pub'), '{33333333-3333-4333-8333-333333333333}'::uuid[], null)).id);
select public.update_route_post((select v from ugc_ctx where k = 'post_a'), '{"title":"A public route"}', true);

insert into ugc_ctx values ('plan_rec', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"ugc-2","title":"A record"}}',
  '[{"place_id":"11111111-1111-4111-8111-111111111111","sequence":1,"stay_minutes":30,"selection_reason":"r"},
    {"place_id":"22222222-2222-4222-8222-222222222222","sequence":2,"stay_minutes":30,"selection_reason":"r"}]', 2, 60, 1000)).id);
select public.accept_plan((select v from ugc_ctx where k = 'plan_rec'));
insert into ugc_ctx values ('rec', (public.create_visit_record((select v from ugc_ctx where k = 'plan_rec'),
  '{11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222}'::uuid[], 'first')).id);

-- B: 公開投稿（場所3）
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
insert into ugc_ctx values ('plan_b', (public.create_generated_plan(
  '{"source":"mobile_plan_options","option":{"set_id":"ugc-3","title":"B public"}}',
  '[{"place_id":"33333333-3333-4333-8333-333333333333","sequence":1,"stay_minutes":30,"selection_reason":"r"}]', 1, 60, 1000)).id);
select public.accept_plan((select v from ugc_ctx where k = 'plan_b'));
insert into ugc_ctx values ('post_b', (public.create_visit_record((select v from ugc_ctx where k = 'plan_b'), '{33333333-3333-4333-8333-333333333333}'::uuid[], null)).id);
select public.update_route_post((select v from ugc_ctx where k = 'post_b'), '{"title":"B public route"}', true);

-- ---------------------------------------------------------------------------
-- いいね・行きたい（状態指定で冪等）
-- ---------------------------------------------------------------------------
select is((public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'like', true) ->> 'active')::boolean, true, 'like on');
select is((public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'like', true) ->> 'like_count')::integer, 1, 'second like-on (double tap) keeps count 1, no error');
select is((public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'like', false) ->> 'like_count')::integer, 0, 'like off');
select is((public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'like', false) ->> 'like_count')::integer, 0, 'second like-off keeps count 0');
select is((public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'wish') ->> 'active')::boolean, true, 'legacy toggle (2 args) still works');
select is((public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'wish') ->> 'wish_count')::integer, 0, 'legacy toggle turns it back off');

-- コメント（B → A の投稿）
insert into ugc_ctx values ('comment_b', (public.add_route_comment((select v from ugc_ctx where k = 'post_a'), 'B comment') ->> 'id')::uuid);
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
insert into ugc_ctx values ('comment_c', (public.add_route_comment((select v from ugc_ctx where k = 'post_a'), 'C comment') ->> 'id')::uuid);

-- ---------------------------------------------------------------------------
-- 記録の付け直し・使われていない写真
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select public.update_route_post((select v from ugc_ctx where k = 'rec'), jsonb_build_object(
  'title', 'rec',
  'cover_photo_path', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p1.jpg',
  'stops', jsonb_build_array(
    jsonb_build_object('sequence', 1, 'visited_time', '10:00', 'note', 'n1', 'photo_path', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p1.jpg'),
    jsonb_build_object('sequence', 2, 'visited_time', '12:30', 'action', 'walk', 'note', 'n2', 'photo_path', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p2.jpg')
  )), false);

reset role;
insert into storage.objects (bucket_id, name, owner, created_at) values
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p1.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '1 hour'),
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p2.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '1 hour'),
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/failed-old.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '1 hour'),
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/uploading-now.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now()),
  ('route-photos', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999/deleted-post.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select is(public.list_unused_route_photos((select v from ugc_ctx where k = 'rec')),
  array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/failed-old.jpg'],
  'unused photos of a post: only the old unreferenced upload (fresh uploads and used photos are kept)');
select is(cardinality(public.list_unused_route_photos()), 2, 'unused photos across own posts include a deleted post folder');

-- 場所2だけで付け直す
select public.create_visit_record((select v from ugc_ctx where k = 'plan_rec'), '{22222222-2222-4222-8222-222222222222}'::uuid[], 'second');
select is((select count(*)::integer from public.route_post_stops where post_id = (select v from ugc_ctx where k = 'rec')), 1, 're-record keeps only the chosen place');
select is(
  (select jsonb_build_object('t', to_char(visited_time, 'HH24:MI'), 'a', action, 'n', note) from public.route_post_stops where post_id = (select v from ugc_ctx where k = 'rec')),
  '{"t":"12:30","a":"walk","n":"n2"}'::jsonb, 're-record keeps time, action and note of the kept place');
select is((public.get_route_post((select v from ugc_ctx where k = 'rec')) ->> 'cover_photo_path'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p2.jpg', 'cover moves to the remaining photo');
select is(public.list_unused_route_photos((select v from ugc_ctx where k = 'rec')),
  array[
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/failed-old.jpg',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || (select v from ugc_ctx where k = 'rec') || '/p1.jpg'
  ], 'photo of the removed place becomes unused');
select is(public.get_route_post((select v from ugc_ctx where k = 'rec')) ->> 'memory', 'second', 'memory is updated on re-record');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is(cardinality(public.list_unused_route_photos((select v from ugc_ctx where k = 'rec'))), 0, 'B cannot list A photos');

-- ---------------------------------------------------------------------------
-- 通報
-- ---------------------------------------------------------------------------
select throws_ok($$select public.report_route_content('post', 'bad', (select v from ugc_ctx where k = 'post_a'))$$,
  '22023', 'invalid_report_reason', 'unknown reason is rejected');
select throws_ok($$select public.report_route_content('post', 'spam', (select v from ugc_ctx where k = 'post_b'))$$,
  '22023', 'invalid_report_own_content', 'cannot report own post');
select throws_ok($$select public.report_route_content('comment', 'spam', null, (select v from ugc_ctx where k = 'comment_b'))$$,
  '22023', 'invalid_report_own_content', 'cannot report own comment');
select throws_ok($$select public.report_route_content('post', 'spam', (select v from ugc_ctx where k = 'rec'))$$,
  'P0002', 'route_content_not_found', 'cannot report a post that is not visible (private record)');
select throws_ok($$select public.report_route_content('post', 'spam', (select v from ugc_ctx where k = 'post_a'), null, repeat('x', 501))$$,
  '22023', 'invalid_report_detail', 'detail over 500 chars is rejected');

select is((public.report_route_content('post', 'spam', (select v from ugc_ctx where k = 'post_a'), null, '宣伝です') ->> 'already_reported')::boolean,
  false, 'B reports A post');
select throws_ok($$select id from public.content_reports$$, '42501', null, 'reports are not readable via Data API');
select throws_ok($$insert into public.content_reports (reporter_id, target_type, target_key, reason) values (auth.uid(), 'post', gen_random_uuid(), 'spam')$$,
  '42501', null, 'reports cannot be inserted directly');
select is(public.get_route_post((select v from ugc_ctx where k = 'post_a')), null, 'reported post is hidden for the reporter');
select ok(not exists (select 1 from jsonb_array_elements(public.list_public_routes()) e where (e ->> 'id')::uuid = (select v from ugc_ctx where k = 'post_a')),
  'reported post is not in the reporter feed');

select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select ok(public.get_route_post((select v from ugc_ctx where k = 'post_a')) is not null, 'others still see the reported post until moderation');
select is((public.report_route_content('comment', 'harassment', null, (select v from ugc_ctx where k = 'comment_b')) ->> 'already_reported')::boolean,
  false, 'C reports B comment');
select is((public.report_route_content('comment', 'harassment', null, (select v from ugc_ctx where k = 'comment_b')) ->> 'already_reported')::boolean,
  true, 'second report of the same comment is deduplicated');
select ok(not (public.get_route_post((select v from ugc_ctx where k = 'post_a')) -> 'comments' @> jsonb_build_array(jsonb_build_object('body', 'B comment'))),
  'reported comment is hidden for the reporter');
select is((select count(*)::integer from public.route_comments where id = (select v from ugc_ctx where k = 'comment_b')), 0,
  'reported comment is hidden for the reporter in direct select too');
select is((public.report_route_content('user', 'harassment', null, (select v from ugc_ctx where k = 'comment_b')) ->> 'already_reported')::boolean,
  false, 'C reports user B via the comment');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select ok(public.get_route_post((select v from ugc_ctx where k = 'post_a')) -> 'comments' @> jsonb_build_array(jsonb_build_object('body', 'B comment')),
  'post author still sees the comment until moderation');

-- ---------------------------------------------------------------------------
-- ブロック
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select throws_ok($$select public.block_user(null, (select v from ugc_ctx where k = 'comment_c'))$$, '22023', 'invalid_block_self', 'cannot block self');
select is(public.block_user((select v from ugc_ctx where k = 'post_a')) ->> 'name', 'Aさん', 'C blocks A via the post');
select is(public.get_route_post((select v from ugc_ctx where k = 'post_a')), null, 'blocker cannot see the blocked user post');
select ok(not exists (select 1 from jsonb_array_elements(public.list_public_routes()) e where (e ->> 'id')::uuid = (select v from ugc_ctx where k = 'post_a')),
  'blocked user post is not in the blocker feed');
select throws_ok($$select public.toggle_route_reaction((select v from ugc_ctx where k = 'post_a'), 'like', true)$$,
  'P0002', 'route_post_not_found', 'blocker cannot react to the blocked user post');
select is(jsonb_array_length(public.list_blocked_users()), 1, 'blocked list has one entry');
select ok(not (public.list_blocked_users() -> 0 ? 'blocked_id'), 'blocked list does not expose user_id');
select throws_ok($$select id from public.user_blocks$$, '42501', null, 'blocks are not readable via Data API');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select ok(not (public.get_route_post((select v from ugc_ctx where k = 'post_a')) -> 'comments' @> jsonb_build_array(jsonb_build_object('body', 'C comment'))),
  'blocked user (A) no longer sees the blocker comment');

select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select is(public.unblock_user((public.list_blocked_users() -> 0 ->> 'id')::uuid), true, 'C unblocks A');
select ok(public.get_route_post((select v from ugc_ctx where k = 'post_a')) is not null, 'after unblocking, the post is visible again');

-- ---------------------------------------------------------------------------
-- 運営（SQL Editor = postgres）の確認と対処
-- ---------------------------------------------------------------------------
select throws_ok($$select * from moderation.report_queue$$, '42501', null, 'authenticated cannot read the moderation queue');
select throws_ok($$select moderation.resolve_report(gen_random_uuid(), 'dismiss')$$, '42501', null, 'authenticated cannot resolve reports');
select throws_ok($$update public.users set suspended_at = null where id = auth.uid()$$, '42501', null, 'users cannot change suspended_at');

reset role;
select is((select count(*)::integer from moderation.report_queue), 3, 'queue shows the 3 open reports');
select is(moderation.resolve_report(
  (select report_id from moderation.report_queue where target_type = 'post'), 'hide_content', 'spam confirmed'), 1, 'hide the reported post');
select is(moderation.resolve_report(
  (select report_id from moderation.report_queue where target_type = 'user'), 'suspend_user', 'harassment'), 1, 'suspend the reported user');
select is(moderation.resolve_report(
  (select report_id from moderation.report_queue where target_type = 'comment'), 'dismiss'), 1, 'dismiss the comment report');
select is((select count(*)::integer from moderation.report_queue), 0, 'queue is empty after handling');
select is((select count(*)::integer from public.content_reports where status = 'actioned'), 2, 'two reports are actioned');
select throws_ok($$select moderation.resolve_report((select id from public.content_reports limit 1), 'dismiss')$$,
  'P0001', 'report_not_open', 'a closed report cannot be resolved again');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select is(public.get_route_post((select v from ugc_ctx where k = 'post_a')), null, 'hidden post is not visible to others');
select is(public.get_route_post((select v from ugc_ctx where k = 'post_b')), null, 'suspended user public post is not visible to others');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((public.get_route_post((select v from ugc_ctx where k = 'post_a')) ->> 'hidden_by_moderation')::boolean, true, 'author sees own post flagged as hidden');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select throws_ok($$select public.add_route_comment((select v from ugc_ctx where k = 'post_b'), 'x')$$,
  '42501', 'account_restricted', 'suspended user cannot comment');
select throws_ok($$select public.update_route_post((select v from ugc_ctx where k = 'post_b'), '{"title":"x"}', true)$$,
  '42501', 'account_restricted', 'suspended user cannot publish or edit public posts');
select is((public.get_route_post((select v from ugc_ctx where k = 'post_b')) ->> 'is_mine')::boolean, true, 'suspended user still sees own posts');

reset role;
select is(moderation.restore('user', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), true, 'restore the suspended user');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select lives_ok($$select public.update_route_post((select v from ugc_ctx where k = 'post_b'), '{"title":"B again"}', false)$$, 'restored user can edit again');

-- 自分のコメントの直接削除（アプリの「削除」）は列権限の変更後も動く
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
delete from public.route_comments where id = (select v from ugc_ctx where k = 'comment_c');
reset role;
select is((select count(*)::integer from public.route_comments where id = (select v from ugc_ctx where k = 'comment_c')), 0, 'author can delete own comment directly');
select is((select count(*)::integer from public.route_comments where id = (select v from ugc_ctx where k = 'comment_b')), 1, 'others comment remains');

-- 退会: 通報の記録は残り、本人との紐づけだけ外れる
delete from auth.users where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
delete from public.users where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select is((select count(*)::integer from public.content_reports), 3, 'reports remain after the reporter/reported user is deleted');
select is((select count(*)::integer from public.content_reports where reporter_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' or reported_user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0, 'deleted user is unlinked from reports');

select * from finish();
rollback;
