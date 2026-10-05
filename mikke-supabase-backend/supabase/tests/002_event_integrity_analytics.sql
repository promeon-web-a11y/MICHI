begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(54);

-- ---------------------------------------------------------------------------
-- Schema / privileges
-- ---------------------------------------------------------------------------
select ok(
  exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'event_name' and e.enumlabel = 'visit_confirmed'),
  'event catalog contains visit_confirmed'
);
select is(
  (select confdeltype::text from pg_constraint where conname = 'events_user_id_fkey'),
  'n',
  'events.user_id is ON DELETE SET NULL so KPI history survives account deletion'
);
select ok(
  not has_table_privilege('authenticated', 'public.events', 'INSERT')
  and not has_table_privilege('authenticated', 'public.events', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.events', 'DELETE')
  and has_table_privilege('authenticated', 'public.events', 'SELECT'),
  'authenticated can only SELECT events (writes go through track_event / triggers)'
);
select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = 'events' and cmd <> 'SELECT'),
  0,
  'events has no insert/update/delete RLS policies left'
);
select ok(
  not has_table_privilege('authenticated', 'public.plans', 'INSERT')
  and not has_table_privilege('authenticated', 'public.plans', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.plan_items', 'INSERT')
  and not has_table_privilege('authenticated', 'public.visits', 'INSERT')
  and not has_table_privilege('authenticated', 'public.visits', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.visits', 'DELETE'),
  'plans / plan_items / visits can only be written through RPCs'
);
select ok(
  not has_column_privilege('authenticated', 'public.users', 'is_internal', 'UPDATE')
  and has_column_privilege('authenticated', 'public.users', 'display_name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.users', 'home_area', 'UPDATE'),
  'users can edit profile columns but not is_internal'
);
select ok(
  not has_schema_privilege('authenticated', 'analytics', 'USAGE')
  and not has_schema_privilege('anon', 'analytics', 'USAGE'),
  'analytics schema is not reachable by anon / authenticated'
);
select ok(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'track_event'),
  'track_event is security definer'
);

-- ---------------------------------------------------------------------------
-- Fixtures: C = regular user, D = regular user, E = internal/test account.
-- Everyone else already in this database (e.g. seed data) is marked internal inside
-- this rolled-back transaction so KPI assertions only see the fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'authenticated', 'authenticated',
   'c@test.local', '', now(), '{}', '{"display_name":"C"}', now(), now()),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'authenticated', 'authenticated',
   'd@test.local', '', now(), '{}', '{"display_name":"D"}', now(), now()),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'authenticated', 'authenticated',
   'e@test.local', '', now(), '{}', '{"display_name":"E"}', now(), now());

update public.users set is_internal = true
where id not in ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

-- ---------------------------------------------------------------------------
-- track_event hardening (user C)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);

select lives_ok(
  $$select public.save_place(
    '{"provider":"google","provider_place_id":"test-place-c","name":"C Cafe","category":"cafe","address":"Sapporo","latitude":43.06,"longitude":141.35,"price_band":"under_3000"}',
    '{"source_platform":"instagram","source_url":"https://instagram.com/p/c","extraction_confidence":0.9}'
  )$$,
  'user C can save a place'
);
select lives_ok(
  $$select public.track_event('url_submitted', null, null,
    '{"source_url":"https://instagram.com/p/c"}'::jsonb,
    'f0000000-0000-4000-8000-000000000001')$$,
  'track_event accepts a client event with an explicit event_id'
);
select is(
  public.track_event('url_submitted', null, null, '{}'::jsonb, 'f0000000-0000-4000-8000-000000000001'),
  (select id from public.events where event_id = 'f0000000-0000-4000-8000-000000000001'),
  'resubmitting the same event_id returns the existing event'
);
select is(
  (select count(*)::integer from public.events where name = 'url_submitted'),
  1,
  'resubmitting the same event_id does not create a duplicate'
);
select throws_ok(
  $$select public.track_event('plan_accepted')$$,
  '42501', null,
  'track_event rejects trigger-only KPI events (plan_accepted)'
);
select throws_ok(
  $$select public.track_event('visit_confirmed')$$,
  '42501', null,
  'track_event rejects trigger-only KPI events (visit_confirmed)'
);
select throws_ok(
  $$select public.track_event('url_submitted', null, null, '[1,2]'::jsonb)$$,
  '22023', null,
  'track_event rejects non-object properties'
);
select throws_ok(
  $$select public.track_event('url_submitted', null, null,
    jsonb_build_object('blob', repeat('x', 20000)))$$,
  '22023', null,
  'track_event rejects oversized properties'
);
select throws_ok(
  $$update public.events set name = 'plan_accepted' where name = 'url_submitted'$$,
  '42501', null,
  'user cannot rewrite own event into a KPI event'
);
select throws_ok(
  $$insert into public.events (user_id, name)
    values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'url_submitted')$$,
  '42501', null,
  'user cannot insert into events directly'
);
select throws_ok(
  $$delete from public.events$$,
  '42501', null,
  'user cannot delete events'
);
select throws_ok(
  $$insert into public.plans (user_id, status, generated_at)
    values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'generated', now())$$,
  '42501', null,
  'user cannot fabricate a generated plan without create_generated_plan'
);
select throws_ok(
  $$insert into public.visits (user_id, plan_id, went)
    values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', gen_random_uuid(), true)$$,
  '42501', null,
  'user cannot fabricate a visit without answer_visit'
);
select throws_ok(
  $$update public.users set is_internal = true where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$,
  '42501', null,
  'user cannot change own is_internal flag'
);
select lives_ok(
  $$update public.users set display_name = 'C2' where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$,
  'user can still update own display_name'
);
select throws_ok(
  $$select * from analytics.kpi_totals$$,
  '42501', null,
  'user cannot read KPI views'
);

select set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);
select throws_ok(
  $$select public.track_event('url_submitted', null, null, '{}'::jsonb,
    'f0000000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'track_event rejects another user''s event_id'
);

-- ---------------------------------------------------------------------------
-- visit_confirmed: once per plan, even when the answer is changed
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select lives_ok(
  $$select public.create_generated_plan(
    '{"start_at":"2026-09-24T13:00:00+09:00","end_at":"2026-09-24T16:00:00+09:00","travel_mode":"walk","companion":"alone","current_location":{"latitude":43.06,"longitude":141.35}}',
    jsonb_build_array(jsonb_build_object(
      'place_id', (select id from public.places where provider_place_id = 'test-place-c'),
      'sequence', 1, 'start_at', '2026-09-24T13:00:00+09:00',
      'stay_minutes', 60, 'travel_minutes', 0, 'travel_mode', 'walk',
      'selection_reason', '保存済みで条件に合うため'
    )), 1, 60, 2000, 1
  )$$,
  'user C can still create a generated plan through the RPC'
);
select lives_ok(
  $$select public.accept_plan((select id from public.plans order by created_at desc limit 1))$$,
  'user C can still accept the plan through the RPC'
);
select lives_ok(
  $$select public.answer_visit(
    (select id from public.plans order by created_at desc limit 1), false, null, '雨だったので', '{}'
  )$$,
  'user C answers "did not go"'
);
select is(
  (select count(*)::integer from public.events where name = 'visit_confirmed'),
  0,
  'visit_confirmed is not recorded for went=false'
);
select lives_ok(
  $$select public.answer_visit(
    (select id from public.plans order by created_at desc limit 1), true, 'good', null,
    array[(select id from public.places where provider_place_id = 'test-place-c')]
  )$$,
  'user C changes the answer to "went"'
);
select is(
  (select count(*)::integer from public.events where name = 'visit_confirmed'),
  1,
  'visit_confirmed is recorded when went=true first holds'
);
select lives_ok(
  $$select public.answer_visit(
    (select id from public.plans order by created_at desc limit 1), false, null, null, '{}'
  )$$,
  'user C changes the answer back to "did not go"'
);
select lives_ok(
  $$select public.answer_visit(
    (select id from public.plans order by created_at desc limit 1), true, 'normal', null, '{}'
  )$$,
  'user C changes the answer to "went" again'
);
select is(
  (select count(*)::integer from public.events where name = 'visit_confirmed'),
  1,
  'visit_confirmed is not duplicated by answer changes'
);
select is(
  (select count(*)::integer from public.events where name = 'visit_answered'),
  4,
  'visit_answered keeps every answer as history'
);
select is(
  (select entity_id from public.events where name = 'visit_confirmed'),
  (select id from public.plans order by created_at desc limit 1),
  'visit_confirmed is keyed by the plan'
);

-- Internal account E produces activity that must not reach the KPIs.
select set_config('request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true);
select lives_ok(
  $$select public.save_place(
    '{"provider":"google","provider_place_id":"test-place-e","name":"E Shop","category":"shopping"}',
    '{"source_platform":"web","source_url":"https://example.com/e"}'
  )$$,
  'internal user E can use the app normally'
);

reset role;

-- ---------------------------------------------------------------------------
-- KPI views
-- ---------------------------------------------------------------------------
select is(
  (select registered_users_total::integer from analytics.kpi_totals),
  2,
  'kpi_totals counts registered users excluding internal accounts'
);
select is(
  (select places_saved_total::integer from analytics.kpi_totals),
  1,
  'kpi_totals counts saves excluding internal accounts'
);
select is(
  (select row(plans_generated_total, plans_accepted_total, visits_answered_total, visits_confirmed_total)::text
   from analytics.kpi_totals),
  '(1,1,1,1)',
  'kpi_totals counts generated / accepted / answered / confirmed'
);
select is(
  (select row(plan_accept_rate, accepted_plan_visit_rate)::text from analytics.kpi_totals),
  '(1.0000,1.0000)',
  'kpi_totals computes accept and visit rates'
);
select is(
  (select row(sign_ups, places_saved, plans_generated, plans_accepted, visits_confirmed)::text
   from analytics.kpi_daily where date_jst = (now() at time zone 'Asia/Tokyo')::date),
  '(2,1,1,1,1)',
  'kpi_daily has today''s (Asia/Tokyo) numbers'
);
select is(
  (select sum(plans_generated)::integer from analytics.kpi_daily),
  (select plans_generated_total::integer from analytics.kpi_totals),
  'kpi_daily adds up to kpi_totals'
);

insert into public.events (event_id, user_id, name, occurred_at)
values ('f0000000-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'url_submitted', '2026-09-23T15:30:00Z');
select is(
  (select k.occurred_date_jst from analytics.kpi_events k
   join public.events e on e.id = k.id
   where e.event_id = 'f0000000-0000-4000-8000-000000000002'),
  '2026-09-24'::date,
  'KPI dates use Asia/Tokyo (15:30 UTC counts as the next day)'
);

-- ---------------------------------------------------------------------------
-- Account deletion keeps anonymized KPI history
-- ---------------------------------------------------------------------------
create temporary table _c_event_ids as
select id from public.events where user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

select lives_ok(
  $$delete from auth.users where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$,
  'deleting regular user C succeeds'
);
select is(
  (select count(*)::integer from public.events where id in (select id from _c_event_ids)),
  (select count(*)::integer from _c_event_ids),
  'user C''s events are kept after account deletion'
);
select is(
  (select count(*)::integer from public.events
   where id in (select id from _c_event_ids) and user_id is not null),
  0,
  'kept events no longer reference the deleted user'
);
select is(
  (select count(*)::integer from public.events
   where id in (select id from _c_event_ids)
     and (properties ?| array['reason_not_went', 'condition_json', 'source_url', 'place_id',
                             'plan_id', 'visit_id', 'generated_raw', 'candidate_ids'])),
  0,
  'free text, location, URLs and IDs are stripped from kept events'
);
select is(
  (select count(*)::integer from public.events
   where id in (select id from _c_event_ids) and entity_type = 'user' and entity_id is not null),
  0,
  'sign-up events no longer carry the deleted user id'
);
select is(
  (select row(registered_users_total, deleted_users_total, places_saved_total,
              plans_generated_total, plans_accepted_total, visits_confirmed_total)::text
   from analytics.kpi_totals),
  '(2,1,1,1,1,1)',
  'KPI totals are unchanged after the account deletion'
);
select is(
  (select registered_users_current::integer from analytics.kpi_totals),
  1,
  'current registered users drops to 1'
);

create temporary table _e_event_ids as
select id from public.events where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
select lives_ok(
  $$delete from auth.users where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'$$,
  'deleting internal user E succeeds'
);
select is(
  (select count(*)::integer from public.events where id in (select id from _e_event_ids)),
  0,
  'internal account history is removed instead of becoming anonymous KPI data'
);
select is(
  (select registered_users_total::integer from analytics.kpi_totals),
  2,
  'deleting an internal account does not change KPIs'
);

select * from finish();
rollback;
