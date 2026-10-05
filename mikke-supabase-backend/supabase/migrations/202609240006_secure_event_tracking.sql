begin;

-- ---------------------------------------------------------------------------
-- 1. events を利用者が直接書き換えられないようにする
-- ---------------------------------------------------------------------------
-- 202609230002 で track_event()（security invoker）の ON CONFLICT DO UPDATE を通すために
-- events への UPDATE 権限と events_update_own を追加したが、このポリシーは user_id しか
-- 見ていないため、利用者が PostgREST から自分の url_submitted 等を
-- `update({ name: 'plan_accepted' })` のように書き換え、主要KPIを水増しできた。
-- track_event() を security definer にして権限チェックを関数内で行うことで、
-- クライアントには events の SELECT（自分の行のみ）以外を一切与えない。
drop policy if exists events_update_own on public.events;
drop policy if exists events_insert_own on public.events;
revoke insert, update, delete, truncate, references, trigger on public.events from authenticated;

-- ---------------------------------------------------------------------------
-- 2. KPIの元になる表を RPC 以外から書き換えられないようにする
-- ---------------------------------------------------------------------------
-- Supabase は public スキーマの新規テーブルに anon/authenticated への全権限を既定で付与する。
-- 202609230001 は PUBLIC/anon からのみ revoke していたため、authenticated には
-- plans / plan_items / visits への INSERT・UPDATE が残り、RPC の検証を通らずに
-- 「生成済みPlan」「採用」「訪問」を直接作って plan_generated / plan_accepted /
-- visit_answered を偽装できた。正規の書き込みはすべて security definer の RPC
-- （create_generated_plan / accept_plan / answer_visit）が行うため、クライアントの
-- 直接書き込み権限を外しても既存機能には影響しない。
-- saved_places（削除・メモ更新などを直接行う可能性がある）と users / places は変更しない。
revoke insert, update, truncate, references, trigger on public.plans from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.plan_items from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.visits from authenticated;
revoke truncate, references, trigger on public.users, public.places, public.saved_places from authenticated;

-- ---------------------------------------------------------------------------
-- 3. track_event(): クライアント計測イベント専用の安全な入口
-- ---------------------------------------------------------------------------
-- - user_id は常に auth.uid()（引数では受け取らない）
-- - DBトリガーが記録する主要KPIイベント名は受け付けない
-- - properties はJSONオブジェクトのみ・サイズ上限あり
-- - 同じ p_event_id の再送は重複せず既存IDを返す。他人の event_id は拒否
create or replace function public.track_event(
  p_name public.event_name,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_properties jsonb default '{}'::jsonb,
  p_event_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_event_id uuid := coalesce(p_event_id, gen_random_uuid());
  v_properties jsonb := coalesce(p_properties, '{}'::jsonb);
  v_id uuid;
  v_owner uuid;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if p_name not in (
    'url_submitted',
    'place_extraction_result',
    'plan_request_submitted',
    'plan_generation_failed',
    'plan_regenerated'
  ) then
    raise exception 'event_name_not_client_trackable' using errcode = '42501';
  end if;
  if jsonb_typeof(v_properties) <> 'object' then
    raise exception 'event_properties_must_be_object' using errcode = '22023';
  end if;
  if length(v_properties::text) > 16384 then
    raise exception 'event_properties_too_large' using errcode = '22023';
  end if;
  if length(p_entity_type) > 64 then
    raise exception 'event_entity_type_too_long' using errcode = '22023';
  end if;

  insert into public.events (event_id, user_id, name, entity_type, entity_id, properties)
  values (v_event_id, v_user_id, p_name, p_entity_type, p_entity_id, v_properties)
  on conflict (event_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id, user_id into v_id, v_owner from public.events where event_id = v_event_id;
    if v_owner is distinct from v_user_id then
      raise exception 'event_id_conflict' using errcode = '42501';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.track_event(public.event_name, text, uuid, jsonb, uuid) from PUBLIC, anon;
grant execute on function public.track_event(public.event_name, text, uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. visit_confirmed: went=true が初めて成立した時だけ、Planごとに1回記録
-- ---------------------------------------------------------------------------
-- entity は plan（visits は (user_id, plan_id) で一意、plan は1ユーザーのもの）。
-- 回答を 行った→行かなかった→行った と変えても、下の部分ユニークインデックスにより
-- 同じ Plan の visit_confirmed は物理的に2件目を作れない。
create unique index if not exists events_visit_confirmed_once
  on public.events (entity_id)
  where name = 'visit_confirmed';

create or replace function public.emit_visit_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not new.went then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.went then
      return new;
    end if;
  end if;

  insert into public.events (user_id, name, entity_type, entity_id, properties)
  values (
    new.user_id,
    'visit_confirmed',
    'plan',
    new.plan_id,
    jsonb_build_object(
      'visit_id', new.id,
      'rating', new.rating,
      'visited_place_count', cardinality(new.visited_place_ids)
    )
  )
  on conflict (entity_id) where name = 'visit_confirmed' do nothing;

  return new;
end;
$$;

revoke all on function public.emit_visit_confirmed() from PUBLIC, anon, authenticated;

drop trigger if exists visits_event_visit_confirmed on public.visits;
create trigger visits_event_visit_confirmed
after insert or update on public.visits
for each row execute function public.emit_visit_confirmed();

-- 既存の「行った」回答を1回だけ補完（回答日時で記録、backfilled で区別可能）
insert into public.events (user_id, name, entity_type, entity_id, properties, occurred_at)
select
  v.user_id,
  'visit_confirmed',
  'plan',
  v.plan_id,
  jsonb_build_object(
    'visit_id', v.id,
    'rating', v.rating,
    'visited_place_count', cardinality(v.visited_place_ids),
    'backfilled', true
  ),
  v.answered_at
from public.visits v
where v.went
on conflict (entity_id) where name = 'visit_confirmed' do nothing;

commit;
