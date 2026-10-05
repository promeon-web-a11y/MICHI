begin;

-- Deleting a user cascades: public.users -> saved_places (on delete cascade) and
-- public.users -> events (on delete cascade) both fire at once. saved_places' AFTER DELETE
-- trigger tries to record a fresh 'place_removed' event for that user_id, but by that point
-- the public.users row is already gone (the parent row is removed before its cascade
-- actions run), so the insert violates events_user_id_fkey and the whole delete fails.
-- This blocks any future "delete my account" flow for a user who has ever saved a place.
--
-- Fix: skip recording the event when the owning user no longer exists (only possible
-- during this kind of cascading delete) - logging it would be pointless anyway, since that
-- event would be cascade-deleted along with the rest of the user's data immediately after.
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
  v_matched boolean := false;
begin
  if tg_table_name = 'saved_places' then
    if tg_op = 'INSERT' then
      v_user_id := new.user_id;
      v_name := 'place_saved';
      v_entity_type := 'saved_place';
      v_entity_id := new.id;
      v_properties := jsonb_build_object(
        'place_id', new.place_id,
        'source_platform', new.source_platform,
        'confidence', new.extraction_confidence
      );
      v_matched := true;
    elsif tg_op = 'DELETE' then
      v_user_id := old.user_id;
      v_name := 'place_removed';
      v_entity_type := 'saved_place';
      v_entity_id := old.id;
      v_properties := jsonb_build_object('place_id', old.place_id);
      v_matched := true;
    end if;
  elsif tg_table_name = 'plans' then
    if tg_op = 'INSERT' and new.status = 'generated' then
      v_user_id := new.user_id;
      v_name := 'plan_generated';
      v_entity_type := 'plan';
      v_entity_id := new.id;
      v_properties := jsonb_build_object(
        'candidate_count', new.candidate_count,
        'generation_sequence', new.generation_sequence
      );
      v_matched := true;
    elsif tg_op = 'UPDATE' and old.accepted_at is null and new.accepted_at is not null then
      v_user_id := new.user_id;
      v_name := 'plan_accepted';
      v_entity_type := 'plan';
      v_entity_id := new.id;
      v_properties := jsonb_build_object(
        'generated_to_accept_seconds',
        greatest(0, extract(epoch from (new.accepted_at - coalesce(new.generated_at, new.created_at)))::integer)
      );
      v_matched := true;
    end if;
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
    v_matched := true;
  end if;

  if v_matched and not exists (select 1 from public.users where id = v_user_id) then
    v_matched := false;
  end if;

  if not v_matched then
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

commit;
