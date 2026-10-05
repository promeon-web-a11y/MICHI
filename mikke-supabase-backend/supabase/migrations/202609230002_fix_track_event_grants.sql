begin;

-- track_event() is security invoker and uses `insert ... on conflict (event_id) do update`
-- for idempotent client-side event submission. Postgres requires UPDATE privilege on the
-- target table to plan this statement, even though the DO UPDATE branch only fires when a
-- caller intentionally resubmits the same p_event_id. Without this grant, every call to
-- track_event() (including the ones generate-plan issues for plan_request_submitted /
-- plan_generation_failed / plan_regenerated) fails with 42501 permission denied.
grant update on public.events to authenticated;

-- Scope that UPDATE capability the same way the rest of events is scoped: a user may only
-- ever touch their own rows, and only to their own user_id (no reassigning events).
drop policy if exists events_update_own on public.events;
create policy events_update_own on public.events
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

commit;
