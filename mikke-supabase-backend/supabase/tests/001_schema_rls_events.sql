begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(33);

select has_table('public', 'users', 'users table exists');
select has_table('public', 'places', 'places table exists');
select has_table('public', 'saved_places', 'saved_places table exists');
select has_table('public', 'plans', 'plans table exists');
select has_table('public', 'plan_items', 'plan_items table exists');
select has_table('public', 'visits', 'visits table exists');
select has_table('public', 'events', 'events table exists');

select is(
  (select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in
     ('users','places','saved_places','plans','plan_items','visits','events') and c.relrowsecurity),
  7,
  'RLS is enabled on all application tables'
);
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in
     ('track_event','save_place','create_generated_plan','accept_plan','answer_visit')),
  5,
  'five backend RPCs exist'
);
select is(
  (select count(*)::integer from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'event_name'),
  12,
  'event catalog contains 12 fixed names'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'authenticated', 'authenticated',
   'a@test.local', '', now(), '{}', '{"display_name":"A"}', now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'authenticated', 'authenticated',
   'b@test.local', '', now(), '{}', '{"display_name":"B"}', now(), now());

select is((select count(*)::integer from public.users where id in
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')), 2,
  'auth trigger creates profiles');
select is((select count(*)::integer from public.events where name = 'sign_up_completed'
  and user_id in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')), 2,
  'auth trigger records sign-up events');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select lives_ok(
  $$select public.save_place(
    '{"provider":"google","provider_place_id":"test-place-1","name":"Test Cafe","category":"cafe","address":"Sapporo","latitude":43.06,"longitude":141.35,"price_band":"under_3000"}',
    '{"source_platform":"instagram","source_url":"https://instagram.com/p/test","extraction_confidence":0.9}'
  )$$,
  'user A can save a place through RPC'
);
select is((select count(*)::integer from public.events where name = 'place_saved'), 1,
  'place_saved is recorded automatically');
select is((select count(*)::integer from public.saved_places), 1,
  'user A can see own saved place');

-- Regression test: client-side events (and generate-plan lifecycle events) must be
-- recordable through track_event(). Since 202609240006 it is security definer, so this
-- works without granting authenticated any INSERT/UPDATE privilege on public.events.
select lives_ok(
  $$select public.track_event('url_submitted', 'saved_place', null, '{"source":"test"}'::jsonb)$$,
  'user A can call track_event via RPC (client-side event)'
);
select is((select count(*)::integer from public.events where name = 'url_submitted'), 1,
  'track_event inserts the requested event');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*)::integer from public.saved_places), 0,
  'user B cannot see user A saved place');
with deleted as (delete from public.saved_places returning id)
select is((select count(*)::integer from deleted), 0,
  'user B cannot delete user A saved place');
select is((select count(*)::integer from public.places where provider_place_id = 'test-place-1'), 1,
  'authenticated users can read canonical place data');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select lives_ok(
  $$select public.create_generated_plan(
    '{"start_at":"2026-09-24T13:00:00+09:00","end_at":"2026-09-24T16:00:00+09:00","travel_mode":"walk","companion":"alone"}',
    jsonb_build_array(jsonb_build_object(
      'place_id', (select id from public.places where provider_place_id = 'test-place-1'),
      'sequence', 1, 'start_at', '2026-09-24T13:00:00+09:00',
      'stay_minutes', 60, 'travel_minutes', 0, 'travel_mode', 'walk',
      'selection_reason', '保存済みで条件に合うため'
    )), 1, 60, 2000, 1
  )$$,
  'user A can create a generated plan'
);
select is((select count(*)::integer from public.plans where status = 'generated'), 1,
  'generated plan is stored');
select is((select count(*)::integer from public.plan_items), 1,
  'plan items are stored');
select is((select count(*)::integer from public.events where name = 'plan_generated'), 1,
  'plan_generated is recorded automatically');

select lives_ok(
  $$select public.accept_plan((select id from public.plans order by created_at desc limit 1))$$,
  'user A can accept own plan'
);
select is((select count(*)::integer from public.events where name = 'plan_accepted'), 1,
  'plan_accepted is recorded automatically');
select lives_ok(
  $$select public.answer_visit(
    (select id from public.plans order by created_at desc limit 1), true, 'good', null,
    array[(select id from public.places where provider_place_id = 'test-place-1')]
  )$$,
  'user A can answer visit for accepted plan'
);
select is((select count(*)::integer from public.visits where went), 1,
  'visit answer is stored');
select is((select count(*)::integer from public.events where name = 'visit_answered'), 1,
  'visit_answered is recorded automatically');
select is((select count(*)::integer from public.saved_places where visited_status = 'visited'), 1,
  'visited place status is updated');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*)::integer from public.plans), 0,
  'user B cannot see user A plans');
select is((select count(*)::integer from public.events), 1,
  'user B sees only own sign-up event');

reset role;

-- Regression test: deleting a user cascades to saved_places, whose AFTER DELETE trigger
-- used to try inserting a fresh 'place_removed' event for a user_id that, by that point in
-- the cascade, no longer exists in public.users -- violating events_user_id_fkey and
-- blocking the delete entirely. User A owns a saved place, so this exercises that path.
select lives_ok(
  $$delete from auth.users where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  'deleting a user with saved places cascades without violating events_user_id_fkey'
);

select * from finish();
rollback;
