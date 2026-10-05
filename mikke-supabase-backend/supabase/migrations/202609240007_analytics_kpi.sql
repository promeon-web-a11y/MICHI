begin;

-- ---------------------------------------------------------------------------
-- 1. 内部／テストアカウントのフラグ
-- ---------------------------------------------------------------------------
-- 開発者・テスト用アカウントを true にすると KPI 集計から除外される。
-- 設定は SQL Editor（管理者）からのみ:  update public.users set is_internal = true where email = '...';
alter table public.users add column if not exists is_internal boolean not null default false;

-- 利用者自身が is_internal を切り替えて集計から抜けたり混入したりできないよう、
-- users の UPDATE をテーブル単位から列単位に絞る（従来更新できた列はそのまま維持）。
revoke update on public.users from authenticated;
grant update (email, display_name, home_area, deleted_at, updated_at) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. 退会後も KPI 履歴を残す（個人は特定しない）
-- ---------------------------------------------------------------------------
-- 従来は users 削除で events も cascade 削除され、過去の登録数・保存数・訪問数が遡って減った。
-- user_id を NULL にして行は残し、削除前に properties を集計用の許可キーだけに絞り、
-- ユーザーID そのものである sign_up_completed の entity_id も消す。
-- 位置情報（condition_json.current_location）・自由記述（reason_not_went）・AI出力・
-- place_id・クライアント任意のプロパティは残らない。
-- 内部／テストアカウントの履歴は KPI に不要なので削除時にまとめて消す。
alter table public.events alter column user_id drop not null;
alter table public.events drop constraint if exists events_user_id_fkey;
alter table public.events
  add constraint events_user_id_fkey
  foreign key (user_id) references public.users(id) on delete set null;

create or replace function public.anonymize_events_before_user_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.is_internal then
    delete from public.events where user_id = old.id;
    return old;
  end if;

  update public.events e
  set
    properties = coalesce((
      select jsonb_object_agg(p.key, p.value)
      from jsonb_each(e.properties) as p(key, value)
      where p.key = any (array[
        'source_platform', 'confidence', 'candidate_count', 'generation_sequence',
        'generated_to_accept_seconds', 'went', 'rating', 'visited_place_count',
        'stage', 'error_code', 'item_count', 'backfilled'
      ])
    ), '{}'::jsonb),
    entity_id = case when e.entity_type = 'user' then null else e.entity_id end
  where e.user_id = old.id;

  return old;
end;
$$;

revoke all on function public.anonymize_events_before_user_delete() from PUBLIC, anon, authenticated;

drop trigger if exists users_anonymize_events_before_delete on public.users;
create trigger users_anonymize_events_before_delete
before delete on public.users
for each row execute function public.anonymize_events_before_user_delete();

-- ---------------------------------------------------------------------------
-- 3. 集計用ビュー（analytics スキーマ）
-- ---------------------------------------------------------------------------
-- ビューは所有者（postgres）権限で全ユーザーの events を読むため、API に公開しない
-- analytics スキーマに置き、anon / authenticated には一切権限を与えない。
-- 参照は Supabase SQL Editor（管理者）から行う。
create schema if not exists analytics;
revoke all on schema analytics from PUBLIC, anon, authenticated;
comment on schema analytics is 'KPI集計用。APIに公開しない（管理者のSQL Editorからのみ参照）';

-- KPI対象のイベント（内部アカウント除外、日付は Asia/Tokyo）。
-- user_id が NULL の行は退会済みの一般ユーザー（内部アカウントの履歴は削除時に消える）。
create or replace view analytics.kpi_events as
select
  e.id,
  e.name,
  e.user_id,
  e.entity_type,
  e.entity_id,
  e.properties,
  e.occurred_at,
  (e.occurred_at at time zone 'Asia/Tokyo')::date as occurred_date_jst
from public.events e
left join public.users u on u.id = e.user_id
where coalesce(u.is_internal, false) = false;

create or replace view analytics.kpi_totals as
with counts as (
  select
    count(*) filter (where name = 'sign_up_completed') as registered_users_total,
    count(*) filter (where name = 'sign_up_completed' and user_id is null) as deleted_users_total,
    count(*) filter (where name = 'place_saved') as places_saved_total,
    count(*) filter (where name = 'place_removed') as places_removed_total,
    count(*) filter (where name = 'plan_generated') as plans_generated_total,
    count(*) filter (where name = 'plan_generation_failed') as plan_generation_failures_total,
    count(*) filter (where name = 'plan_accepted') as plans_accepted_total,
    count(distinct entity_id) filter (where name = 'visit_answered') as visits_answered_total,
    count(*) filter (where name = 'visit_confirmed') as visits_confirmed_total
  from analytics.kpi_events
)
select
  (now() at time zone 'Asia/Tokyo') as as_of_jst,
  c.registered_users_total,
  c.deleted_users_total,
  (select count(*) from public.users u
    where not u.is_internal and u.deleted_at is null) as registered_users_current,
  c.places_saved_total,
  c.places_removed_total,
  (select count(*) from public.saved_places sp
    join public.users u on u.id = sp.user_id
    where not u.is_internal) as saved_places_current,
  c.plans_generated_total,
  c.plan_generation_failures_total,
  c.plans_accepted_total,
  c.visits_answered_total,
  c.visits_confirmed_total,
  round(c.plans_accepted_total::numeric / nullif(c.plans_generated_total, 0), 4) as plan_accept_rate,
  round(c.visits_confirmed_total::numeric / nullif(c.plans_accepted_total, 0), 4) as accepted_plan_visit_rate,
  round(c.visits_confirmed_total::numeric / nullif(c.plans_generated_total, 0), 4) as generated_plan_visit_rate
from counts c;

create or replace view analytics.kpi_daily as
with daily as (
  select
    occurred_date_jst as date_jst,
    count(*) filter (where name = 'sign_up_completed') as sign_ups,
    count(*) filter (where name = 'place_saved') as places_saved,
    count(*) filter (where name = 'place_removed') as places_removed,
    count(*) filter (where name = 'plan_generated') as plans_generated,
    count(*) filter (where name = 'plan_generation_failed') as plan_generation_failures,
    count(*) filter (where name = 'plan_accepted') as plans_accepted,
    count(*) filter (where name = 'visit_confirmed') as visits_confirmed,
    count(distinct user_id) as active_users
  from analytics.kpi_events
  group by occurred_date_jst
),
bounds as (
  select
    coalesce(min(date_jst), (now() at time zone 'Asia/Tokyo')::date) as first_day,
    greatest(coalesce(max(date_jst), (now() at time zone 'Asia/Tokyo')::date),
             (now() at time zone 'Asia/Tokyo')::date) as last_day
  from daily
),
days as (
  select generate_series(b.first_day, b.last_day, interval '1 day')::date as date_jst
  from bounds b
)
select
  d.date_jst,
  coalesce(x.sign_ups, 0) as sign_ups,
  coalesce(x.places_saved, 0) as places_saved,
  coalesce(x.places_removed, 0) as places_removed,
  coalesce(x.plans_generated, 0) as plans_generated,
  coalesce(x.plan_generation_failures, 0) as plan_generation_failures,
  coalesce(x.plans_accepted, 0) as plans_accepted,
  coalesce(x.visits_confirmed, 0) as visits_confirmed,
  coalesce(x.active_users, 0) as active_users,
  sum(coalesce(x.sign_ups, 0)) over (order by d.date_jst) as registered_users_cumulative
from days d
left join daily x on x.date_jst = d.date_jst;

revoke all on all tables in schema analytics from PUBLIC, anon, authenticated;

commit;
