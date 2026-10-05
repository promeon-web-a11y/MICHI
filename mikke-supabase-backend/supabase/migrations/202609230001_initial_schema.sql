begin;

create extension if not exists pgcrypto;

do $$ begin
  create type public.place_category as enum (
    'cafe', 'lunch', 'dinner', 'sweets', 'bakery',
    'shopping', 'sightseeing', 'onsen', 'activity', 'other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.price_band as enum (
    'under_1000', 'under_3000', 'under_5000', 'under_10000', 'unknown'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.source_platform as enum (
    'instagram', 'tiktok', 'google_maps', 'web', 'other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.saved_place_status as enum (
    'not_visited', 'visited', 'dismissed'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.plan_status as enum (
    'generating', 'generated', 'accepted', 'failed', 'cancelled'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.visit_rating as enum ('good', 'normal', 'poor');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.event_name as enum (
    'sign_up_completed',
    'url_submitted',
    'place_extraction_result',
    'place_saved',
    'place_removed',
    'plan_request_submitted',
    'plan_generated',
    'plan_generation_failed',
    'plan_accepted',
    'plan_regenerated',
    'visit_answered'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  home_area text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'google',
  provider_place_id text not null,
  name text not null,
  category public.place_category not null default 'other',
  address text not null default '',
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  opening_hours jsonb,
  closed_days_text text,
  price_band public.price_band not null default 'unknown',
  maps_url text,
  official_url text,
  photo_url text,
  data_checked_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_place_id)
);

create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  source_platform public.source_platform not null default 'other',
  source_url text not null,
  source_caption text,
  user_note text,
  visited_status public.saved_place_status not null default 'not_visited',
  extraction_confidence numeric(4,3) check (
    extraction_confidence is null or extraction_confidence between 0 and 1
  ),
  confirmed_at timestamptz,
  last_refreshed_at timestamptz,
  saved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, place_id)
);

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  status public.plan_status not null default 'generating',
  condition_json jsonb not null default '{}'::jsonb,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  total_duration_minutes integer check (total_duration_minutes is null or total_duration_minutes >= 0),
  estimated_budget integer check (estimated_budget is null or estimated_budget >= 0),
  generation_sequence integer not null default 1 check (generation_sequence between 1 and 3),
  generated_at timestamptz,
  accepted_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'accepted') or accepted_at is not null)
);

create table if not exists public.plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete restrict,
  sequence integer not null check (sequence between 1 and 4),
  start_at timestamptz,
  stay_minutes integer not null check (stay_minutes > 0),
  travel_minutes integer check (travel_minutes is null or travel_minutes >= 0),
  travel_mode text,
  selection_reason text not null,
  created_at timestamptz not null default now(),
  unique (plan_id, sequence),
  unique (plan_id, place_id)
);

create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  plan_id uuid not null references public.plans(id) on delete cascade,
  went boolean not null,
  rating public.visit_rating,
  reason_not_went text,
  visited_place_ids uuid[] not null default '{}',
  answered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, plan_id),
  check ((went and reason_not_went is null) or (not went)),
  check ((not went and rating is null) or went)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null default gen_random_uuid() unique,
  user_id uuid not null references public.users(id) on delete cascade,
  name public.event_name not null,
  entity_type text,
  entity_id uuid,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_saved_places_user_saved_at
  on public.saved_places (user_id, saved_at desc);
create index if not exists idx_saved_places_user_status
  on public.saved_places (user_id, visited_status);
create index if not exists idx_places_category
  on public.places (category);
create index if not exists idx_places_location
  on public.places (latitude, longitude)
  where latitude is not null and longitude is not null;
create index if not exists idx_plans_user_created_at
  on public.plans (user_id, created_at desc);
create index if not exists idx_plans_user_status
  on public.plans (user_id, status);
create index if not exists idx_plan_items_plan_sequence
  on public.plan_items (plan_id, sequence);
create index if not exists idx_visits_user_answered_at
  on public.visits (user_id, answered_at desc);
create index if not exists idx_events_user_occurred_at
  on public.events (user_id, occurred_at desc);
create index if not exists idx_events_name_occurred_at
  on public.events (name, occurred_at desc);
create index if not exists idx_events_properties_gin
  on public.events using gin (properties);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at before update on public.users
for each row execute function public.touch_updated_at();
drop trigger if exists places_touch_updated_at on public.places;
create trigger places_touch_updated_at before update on public.places
for each row execute function public.touch_updated_at();
drop trigger if exists saved_places_touch_updated_at on public.saved_places;
create trigger saved_places_touch_updated_at before update on public.saved_places
for each row execute function public.touch_updated_at();
drop trigger if exists plans_touch_updated_at on public.plans;
create trigger plans_touch_updated_at before update on public.plans
for each row execute function public.touch_updated_at();
drop trigger if exists visits_touch_updated_at on public.visits;
create trigger visits_touch_updated_at before update on public.visits
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  )
  on conflict (id) do nothing;

  insert into public.events (user_id, name, entity_type, entity_id)
  values (new.id, 'sign_up_completed', 'user', new.id)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.emit_domain_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_name public.event_name;
  v_entity_type text;
  v_entity_id uuid;
  v_properties jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'saved_places' and tg_op = 'INSERT' then
    v_user_id := new.user_id;
    v_name := 'place_saved';
    v_entity_type := 'saved_place';
    v_entity_id := new.id;
    v_properties := jsonb_build_object(
      'place_id', new.place_id,
      'source_platform', new.source_platform,
      'confidence', new.extraction_confidence
    );
  elsif tg_table_name = 'saved_places' and tg_op = 'DELETE' then
    v_user_id := old.user_id;
    v_name := 'place_removed';
    v_entity_type := 'saved_place';
    v_entity_id := old.id;
    v_properties := jsonb_build_object('place_id', old.place_id);
  elsif tg_table_name = 'plans' and tg_op = 'INSERT' and new.status = 'generated' then
    v_user_id := new.user_id;
    v_name := 'plan_generated';
    v_entity_type := 'plan';
    v_entity_id := new.id;
    v_properties := jsonb_build_object(
      'candidate_count', new.candidate_count,
      'generation_sequence', new.generation_sequence
    );
  elsif tg_table_name = 'plans' and tg_op = 'UPDATE'
    and old.accepted_at is null and new.accepted_at is not null then
    v_user_id := new.user_id;
    v_name := 'plan_accepted';
    v_entity_type := 'plan';
    v_entity_id := new.id;
    v_properties := jsonb_build_object(
      'generated_to_accept_seconds',
      greatest(0, extract(epoch from (new.accepted_at - coalesce(new.generated_at, new.created_at)))::integer)
    );
  elsif tg_table_name = 'visits' and tg_op in ('INSERT', 'UPDATE') then
    v_user_id := new.user_id;
    v_name := 'visit_answered';
    v_entity_type := 'visit';
    v_entity_id := new.id;
    v_properties := jsonb_build_object(
      'plan_id', new.plan_id,
      'went', new.went,
      'rating', new.rating,
      'reason_not_went', new.reason_not_went
    );
  else
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  insert into public.events (user_id, name, entity_type, entity_id, properties)
  values (v_user_id, v_name, v_entity_type, v_entity_id, v_properties);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists saved_places_event_insert on public.saved_places;
create trigger saved_places_event_insert after insert on public.saved_places
for each row execute function public.emit_domain_event();
drop trigger if exists saved_places_event_delete on public.saved_places;
create trigger saved_places_event_delete after delete on public.saved_places
for each row execute function public.emit_domain_event();
drop trigger if exists plans_event_insert on public.plans;
create trigger plans_event_insert after insert on public.plans
for each row execute function public.emit_domain_event();
drop trigger if exists plans_event_update on public.plans;
create trigger plans_event_update after update on public.plans
for each row execute function public.emit_domain_event();
drop trigger if exists visits_event_insert_update on public.visits;
create trigger visits_event_insert_update after insert or update on public.visits
for each row execute function public.emit_domain_event();

alter table public.users enable row level security;
alter table public.places enable row level security;
alter table public.saved_places enable row level security;
alter table public.plans enable row level security;
alter table public.plan_items enable row level security;
alter table public.visits enable row level security;
alter table public.events enable row level security;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users
for select using (id = auth.uid());
drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users
for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists places_read_authenticated on public.places;
create policy places_read_authenticated on public.places
for select to authenticated using (true);
drop policy if exists places_insert_own on public.places;
create policy places_insert_own on public.places
for insert to authenticated with check (created_by = auth.uid());
drop policy if exists places_update_own on public.places;
create policy places_update_own on public.places
for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists saved_places_all_own on public.saved_places;
create policy saved_places_all_own on public.saved_places
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists plans_all_own on public.plans;
create policy plans_all_own on public.plans
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists plan_items_select_own on public.plan_items;
create policy plan_items_select_own on public.plan_items
for select to authenticated using (
  exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid())
);
drop policy if exists plan_items_insert_own on public.plan_items;
create policy plan_items_insert_own on public.plan_items
for insert to authenticated with check (
  exists (
    select 1
    from public.plans p
    join public.saved_places sp on sp.user_id = p.user_id and sp.place_id = plan_items.place_id
    where p.id = plan_id and p.user_id = auth.uid()
  )
);
drop policy if exists plan_items_update_own on public.plan_items;
create policy plan_items_update_own on public.plan_items
for update to authenticated using (
  exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid())
) with check (
  exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid())
);
drop policy if exists plan_items_delete_own on public.plan_items;
create policy plan_items_delete_own on public.plan_items
for delete to authenticated using (
  exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid())
);

drop policy if exists visits_all_own on public.visits;
create policy visits_all_own on public.visits
for all to authenticated using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid())
);

drop policy if exists events_select_own on public.events;
create policy events_select_own on public.events
for select to authenticated using (user_id = auth.uid());
drop policy if exists events_insert_own on public.events;
create policy events_insert_own on public.events
for insert to authenticated with check (
  user_id = auth.uid()
  and name in (
    'url_submitted',
    'place_extraction_result',
    'plan_request_submitted',
    'plan_generation_failed',
    'plan_regenerated'
  )
);

create or replace function public.track_event(
  p_name public.event_name,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_properties jsonb default '{}'::jsonb,
  p_event_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;

  insert into public.events (event_id, user_id, name, entity_type, entity_id, properties)
  values (p_event_id, auth.uid(), p_name, p_entity_type, p_entity_id, coalesce(p_properties, '{}'::jsonb))
  on conflict (event_id) do update set event_id = excluded.event_id
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.save_place(
  p_place jsonb,
  p_source jsonb
)
returns public.saved_places
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_place_id uuid;
  v_saved public.saved_places;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if coalesce(p_place ->> 'provider_place_id', '') = '' then
    raise exception 'provider_place_id_required' using errcode = '22023';
  end if;
  if coalesce(p_place ->> 'name', '') = '' then
    raise exception 'place_name_required' using errcode = '22023';
  end if;
  if coalesce(p_source ->> 'source_url', '') = '' then
    raise exception 'source_url_required' using errcode = '22023';
  end if;

  insert into public.places (
    provider, provider_place_id, name, category, address, latitude, longitude,
    opening_hours, closed_days_text, price_band, maps_url, official_url,
    photo_url, data_checked_at, created_by
  ) values (
    coalesce(nullif(p_place ->> 'provider', ''), 'google'),
    p_place ->> 'provider_place_id',
    p_place ->> 'name',
    coalesce((p_place ->> 'category')::public.place_category, 'other'),
    coalesce(p_place ->> 'address', ''),
    nullif(p_place ->> 'latitude', '')::numeric,
    nullif(p_place ->> 'longitude', '')::numeric,
    p_place -> 'opening_hours',
    p_place ->> 'closed_days_text',
    coalesce((p_place ->> 'price_band')::public.price_band, 'unknown'),
    p_place ->> 'maps_url',
    p_place ->> 'official_url',
    p_place ->> 'photo_url',
    nullif(p_place ->> 'data_checked_at', '')::timestamptz,
    v_user_id
  )
  on conflict (provider, provider_place_id) do nothing
  returning id into v_place_id;

  if v_place_id is null then
    select id into v_place_id
    from public.places
    where provider = coalesce(nullif(p_place ->> 'provider', ''), 'google')
      and provider_place_id = p_place ->> 'provider_place_id';
  end if;

  insert into public.saved_places (
    user_id, place_id, source_platform, source_url, source_caption,
    user_note, extraction_confidence, confirmed_at, last_refreshed_at
  ) values (
    v_user_id,
    v_place_id,
    coalesce((p_source ->> 'source_platform')::public.source_platform, 'other'),
    p_source ->> 'source_url',
    p_source ->> 'source_caption',
    p_source ->> 'user_note',
    nullif(p_source ->> 'extraction_confidence', '')::numeric,
    coalesce(nullif(p_source ->> 'confirmed_at', '')::timestamptz, now()),
    nullif(p_source ->> 'last_refreshed_at', '')::timestamptz
  )
  on conflict (user_id, place_id) do update set
    source_platform = excluded.source_platform,
    source_url = excluded.source_url,
    source_caption = excluded.source_caption,
    user_note = coalesce(excluded.user_note, public.saved_places.user_note),
    extraction_confidence = excluded.extraction_confidence,
    confirmed_at = excluded.confirmed_at,
    last_refreshed_at = excluded.last_refreshed_at
  returning * into v_saved;

  return v_saved;
end;
$$;

create or replace function public.create_generated_plan(
  p_conditions jsonb,
  p_items jsonb,
  p_candidate_count integer,
  p_total_duration_minutes integer,
  p_estimated_budget integer,
  p_generation_sequence integer default 1
)
returns public.plans
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan public.plans;
  v_item jsonb;
  v_place_id uuid;
  v_sequence integer;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 4 then
    raise exception 'plan_items_must_contain_1_to_4_items' using errcode = '22023';
  end if;

  insert into public.plans (
    user_id, status, condition_json, candidate_count, total_duration_minutes,
    estimated_budget, generation_sequence, generated_at
  ) values (
    v_user_id, 'generated', coalesce(p_conditions, '{}'::jsonb),
    greatest(coalesce(p_candidate_count, 0), 0), p_total_duration_minutes,
    p_estimated_budget, p_generation_sequence, now()
  ) returning * into v_plan;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_place_id := (v_item ->> 'place_id')::uuid;
    v_sequence := (v_item ->> 'sequence')::integer;

    if not exists (
      select 1 from public.saved_places
      where user_id = v_user_id and place_id = v_place_id
    ) then
      raise exception 'plan_item_not_in_user_saved_places' using errcode = '42501';
    end if;

    insert into public.plan_items (
      plan_id, place_id, sequence, start_at, stay_minutes,
      travel_minutes, travel_mode, selection_reason
    ) values (
      v_plan.id,
      v_place_id,
      v_sequence,
      nullif(v_item ->> 'start_at', '')::timestamptz,
      (v_item ->> 'stay_minutes')::integer,
      nullif(v_item ->> 'travel_minutes', '')::integer,
      v_item ->> 'travel_mode',
      v_item ->> 'selection_reason'
    );
  end loop;

  return v_plan;
end;
$$;

create or replace function public.accept_plan(p_plan_id uuid)
returns public.plans
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans;
begin
  update public.plans
  set status = 'accepted', accepted_at = coalesce(accepted_at, now())
  where id = p_plan_id and user_id = auth.uid() and status in ('generated', 'accepted')
  returning * into v_plan;

  if v_plan.id is null then
    raise exception 'plan_not_found_or_not_acceptable' using errcode = 'P0002';
  end if;
  return v_plan;
end;
$$;

create or replace function public.answer_visit(
  p_plan_id uuid,
  p_went boolean,
  p_rating public.visit_rating default null,
  p_reason_not_went text default null,
  p_visited_place_ids uuid[] default '{}'
)
returns public.visits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visit public.visits;
begin
  if not exists (
    select 1 from public.plans
    where id = p_plan_id and user_id = auth.uid() and status = 'accepted'
  ) then
    raise exception 'accepted_plan_not_found' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_visited_place_ids, '{}')) as visited(place_id)
    where not exists (
      select 1
      from public.plan_items pi
      where pi.plan_id = p_plan_id and pi.place_id = visited.place_id
    )
  ) then
    raise exception 'visited_place_not_in_plan' using errcode = '42501';
  end if;

  insert into public.visits (
    user_id, plan_id, went, rating, reason_not_went, visited_place_ids, answered_at
  ) values (
    auth.uid(), p_plan_id, p_went,
    case when p_went then p_rating else null end,
    case when p_went then null else p_reason_not_went end,
    coalesce(p_visited_place_ids, '{}'), now()
  )
  on conflict (user_id, plan_id) do update set
    went = excluded.went,
    rating = excluded.rating,
    reason_not_went = excluded.reason_not_went,
    visited_place_ids = excluded.visited_place_ids,
    answered_at = excluded.answered_at
  returning * into v_visit;

  if p_went then
    update public.saved_places
    set visited_status = 'visited'
    where user_id = auth.uid() and place_id = any(coalesce(p_visited_place_ids, '{}'));
  end if;

  return v_visit;
end;
$$;

revoke all on function public.track_event(public.event_name, text, uuid, jsonb, uuid) from PUBLIC, anon;
revoke all on function public.save_place(jsonb, jsonb) from PUBLIC, anon;
revoke all on function public.create_generated_plan(jsonb, jsonb, integer, integer, integer, integer) from PUBLIC, anon;
revoke all on function public.accept_plan(uuid) from PUBLIC, anon;
revoke all on function public.answer_visit(uuid, boolean, public.visit_rating, text, uuid[]) from PUBLIC, anon;

grant execute on function public.track_event(public.event_name, text, uuid, jsonb, uuid) to authenticated;
grant execute on function public.save_place(jsonb, jsonb) to authenticated;
grant execute on function public.create_generated_plan(jsonb, jsonb, integer, integer, integer, integer) to authenticated;
grant execute on function public.accept_plan(uuid) to authenticated;
grant execute on function public.answer_visit(uuid, boolean, public.visit_rating, text, uuid[]) to authenticated;

revoke all on public.users, public.places, public.saved_places, public.plans,
  public.plan_items, public.visits, public.events from PUBLIC, anon;
grant select, update on public.users to authenticated;
grant select on public.places to authenticated;
grant select, delete on public.saved_places to authenticated;
grant select on public.plans to authenticated;
grant select on public.plan_items to authenticated;
grant select on public.visits to authenticated;
grant select, insert on public.events to authenticated;

commit;
