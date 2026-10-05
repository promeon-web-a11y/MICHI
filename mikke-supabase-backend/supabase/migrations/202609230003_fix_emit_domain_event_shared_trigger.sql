begin;

-- emit_domain_event() is shared by saved_places / plans / visits, three tables with
-- different columns. The previous version tested `tg_table_name = 'plans' and ... and
-- new.status = 'generated'` as one compound boolean condition. When this same trigger
-- function fires for a table that has no `status` column (visits), Postgres raises
-- `record "new" has no field "status"`, because a table-specific field reference must not
-- share a single boolean expression with the tg_table_name guard for a *different* table.
-- Nesting the field access inside its own `if tg_table_name = 'plans' then ...` block
-- (instead of one flat `elsif` condition per table) keeps each table's field access fully
-- isolated, which is the safe, standard pattern for a trigger function shared by several
-- differently-shaped tables.
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
