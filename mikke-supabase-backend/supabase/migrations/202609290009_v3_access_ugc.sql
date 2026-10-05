-- Mikke v3.0 追補: 直接取得の権限・反応の連打・写真の後片付け・通報/ブロック/運営対応
--
-- 1. route_posts / route_comments の SELECT を列単位にする
--    202609280008 は表全体の SELECT を authenticated に与えていたため、RLS で見られる行（他人の公開投稿）について
--    Data API から memory（本人だけのひと言）・plan_id・user_id を直接読めた。表示に必要な列だけを許可し、
--    本人向けの列は RPC（get_route_post / list_my_route_posts）だけで返す
-- 2. いいね・行きたい: 同じ人・同じ投稿・同じ種類の操作を直列化し、状態指定（p_active）で冪等にする
-- 3. 記録の付け直しで立ち寄りの時刻・写真・ひと言を消さない。使われていない自分の写真を列挙する RPC を追加
-- 4. 公開 UGC: 投稿・コメント・ユーザーの通報、ユーザーブロック、運営による非表示・投稿停止（moderation スキーマ）
begin;

-- ---------------------------------------------------------------------------
-- 1. 列単位の SELECT
-- ---------------------------------------------------------------------------
-- 本人でも memory / plan_id は直接読めない（RLS は行単位で、列を「本人の行だけ」に絞れないため）。
-- user_id も他人に見せない（投稿・コメントを利用者単位で名寄せできないように）。
-- RLS の条件式（user_id = auth.uid() など）は列権限なしで評価されるため、行の絞り込みは従来どおり
revoke select on public.route_posts from authenticated;
grant select (
  id, title, lead, area, genre, theme, budget_yen, duration_minutes, visibility, cover_photo_path,
  visited_on, published_at, like_count, wish_count, comment_count, created_at, updated_at
) on public.route_posts to authenticated;

revoke select on public.route_comments from authenticated;
grant select (id, post_id, body, created_at) on public.route_comments to authenticated;

-- ---------------------------------------------------------------------------
-- 2. 運営による非表示・投稿停止の列
-- ---------------------------------------------------------------------------
alter table public.route_posts
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_reason text;
alter table public.route_comments add column if not exists hidden_at timestamptz;
-- 投稿停止（公開・コメントができず、公開中の投稿・コメントもほかの人に表示しない）。利用者は更新できない
alter table public.users add column if not exists suspended_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. ブロック・通報
-- ---------------------------------------------------------------------------
create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists idx_user_blocks_blocked on public.user_blocks (blocked_id);

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  -- 退会しても通報の記録は残す（運営の対応履歴）。本人との紐づけだけ外す
  reporter_id uuid references public.users(id) on delete set null,
  target_type text not null check (target_type in ('post', 'comment', 'user')),
  -- 重複判定用: post → post_id / comment → comment_id / user → reported_user_id（参照先が消えても残す）
  target_key uuid not null,
  post_id uuid references public.route_posts(id) on delete set null,
  comment_id uuid references public.route_comments(id) on delete set null,
  reported_user_id uuid references public.users(id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'privacy', 'other')),
  detail text check (detail is null or char_length(detail) <= 500),
  -- 通報時点の内容（投稿者が後から編集・削除しても運営が確認できる）
  content_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  action_taken text check (action_taken is null or action_taken in ('dismiss', 'hide_content', 'suspend_user', 'hide_and_suspend')),
  moderator_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'open') = (resolved_at is null))
);
create unique index if not exists content_reports_open_once
  on public.content_reports (reporter_id, target_type, target_key) where status = 'open';
create index if not exists idx_content_reports_open on public.content_reports (created_at) where status = 'open';
create index if not exists idx_content_reports_reporter on public.content_reports (reporter_id, created_at desc);

alter table public.user_blocks enable row level security;
alter table public.content_reports enable row level security;
-- 読み書きは RPC だけ（通報者・通報先・ブロック相手の user_id を Data API に出さない）
revoke all on public.user_blocks, public.content_reports from PUBLIC, anon, authenticated;

-- 閲覧者と相手の間にブロックがあるか（どちら向きでも）
create or replace function public.viewer_blocked_with(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = p_other)
       or (b.blocker_id = p_other and b.blocked_id = auth.uid())
  );
$$;
revoke all on function public.viewer_blocked_with(uuid) from PUBLIC, anon;
grant execute on function public.viewer_blocked_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. 閲覧できるか（非表示・投稿停止・ブロック・自分が通報した投稿を除く）
-- ---------------------------------------------------------------------------
-- p_include_own_reported = true は「自分が通報したために見えなくなった」ものだけを見える扱いにする
-- （通報の直後に同じ相手をブロック・通報するときの対象特定用。アプリの表示には使わない）
create or replace function public.route_post_visible(p_post_id uuid, p_include_own_reported boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.route_posts rp
    join public.users u on u.id = rp.user_id
    where rp.id = p_post_id
      and (
        rp.user_id = auth.uid()
        or (
          rp.visibility = 'public'
          and rp.hidden_at is null
          and u.show_posts_in_feed
          and u.deleted_at is null
          and u.suspended_at is null
          and not public.viewer_blocked_with(rp.user_id)
          and (p_include_own_reported or not exists (
            select 1 from public.content_reports r
            where r.reporter_id = auth.uid() and r.target_type = 'post' and r.post_id = rp.id
          ))
        )
      )
  );
$$;
revoke all on function public.route_post_visible(uuid, boolean) from PUBLIC, anon, authenticated;

create or replace function public.can_view_route_post(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.route_post_visible(p_post_id, false);
$$;

-- コメントを閲覧者に見せるか（投稿を見られることは呼び出し側で確認する）
create or replace function public.route_comment_visible(p_comment_id uuid, p_include_own_reported boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.route_comments rc
    join public.users u on u.id = rc.user_id
    where rc.id = p_comment_id
      and (
        rc.user_id = auth.uid()
        or (
          rc.hidden_at is null
          and u.deleted_at is null
          and u.suspended_at is null
          and not public.viewer_blocked_with(rc.user_id)
          and (p_include_own_reported or not exists (
            select 1 from public.content_reports r
            where r.reporter_id = auth.uid() and r.target_type = 'comment' and r.comment_id = rc.id
          ))
        )
      )
  );
$$;
revoke all on function public.route_comment_visible(uuid, boolean) from PUBLIC, anon, authenticated;

create or replace function public.can_view_route_comment(p_comment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.route_comment_visible(p_comment_id, false);
$$;
revoke all on function public.can_view_route_comment(uuid) from PUBLIC, anon;
grant execute on function public.can_view_route_comment(uuid) to authenticated;

drop policy if exists route_comments_select_visible on public.route_comments;
create policy route_comments_select_visible on public.route_comments
-- 自分のコメントは、投稿が非表示・ブロック中でも自分で削除できるように常に対象にする（DELETE には SELECT のポリシーも適用される）
for select to authenticated using (user_id = auth.uid() or (public.can_view_route_post(post_id) and public.can_view_route_comment(id)));

-- ---------------------------------------------------------------------------
-- 5. 表示用 JSON・一覧・詳細（非表示・ブロック・通報の反映）
-- ---------------------------------------------------------------------------
create or replace function public.route_post_card(p_post public.route_posts)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_post.id,
    'title', p_post.title,
    'lead', p_post.lead,
    'area', p_post.area,
    'genre', p_post.genre,
    'theme', p_post.theme,
    'budget_yen', p_post.budget_yen,
    'duration_minutes', p_post.duration_minutes,
    'visibility', p_post.visibility,
    'published_at', p_post.published_at,
    'created_at', p_post.created_at,
    'visited_on', p_post.visited_on,
    'memory', case when p_post.user_id = auth.uid() then p_post.memory else null end,
    'cover_photo_path', coalesce(
      p_post.cover_photo_path,
      (select s.photo_path from public.route_post_stops s
        where s.post_id = p_post.id and s.photo_path is not null order by s.sequence limit 1)
    ),
    'stop_names', coalesce(
      (select jsonb_agg(s.name order by s.sequence) from public.route_post_stops s where s.post_id = p_post.id),
      '[]'::jsonb
    ),
    'author_name', coalesce(nullif(btrim(u.display_name), ''), 'Mikke ユーザー'),
    'like_count', p_post.like_count,
    'wish_count', p_post.wish_count,
    'comment_count', p_post.comment_count,
    'liked', exists (select 1 from public.route_likes l where l.post_id = p_post.id and l.user_id = auth.uid()),
    'wished', exists (select 1 from public.route_wishes w where w.post_id = p_post.id and w.user_id = auth.uid()),
    'is_mine', p_post.user_id = auth.uid(),
    -- 本人にだけ: 運営が非表示にした投稿か
    'hidden_by_moderation', p_post.user_id = auth.uid() and p_post.hidden_at is not null
  )
  from public.users u
  where u.id = p_post.user_id;
$$;
revoke all on function public.route_post_card(public.route_posts) from PUBLIC, anon, authenticated;

create or replace function public.list_public_routes(
  p_query text default null,
  p_area text default null,
  p_max_budget integer default null,
  p_genre text default null,
  p_theme text default null,
  p_sort text default 'recommended',
  p_limit integer default 40,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if p_sort not in ('recommended', 'likes', 'wishes') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if v_query is not null then
    v_pattern := '%' || replace(replace(replace(left(v_query, 50), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  select coalesce(jsonb_agg(public.route_post_card(t.post) order by t.ord), '[]'::jsonb)
  into v_result
  from (
    select rp as post,
      row_number() over (
        order by
          case when p_sort = 'likes' then rp.like_count end desc nulls last,
          case when p_sort = 'wishes' then rp.wish_count end desc nulls last,
          case when p_sort = 'recommended' then
            (rp.like_count + 2 * rp.wish_count + 1)
              * exp(-greatest(0, extract(epoch from (now() - rp.published_at)) / 86400.0) / 14.0)
          end desc nulls last,
          rp.published_at desc,
          rp.id
      ) as ord
    from public.route_posts rp
    join public.users u on u.id = rp.user_id
    where rp.visibility = 'public'
      and rp.hidden_at is null
      and u.show_posts_in_feed
      and u.deleted_at is null
      and u.suspended_at is null
      and not public.viewer_blocked_with(rp.user_id)
      and not exists (
        select 1 from public.content_reports r
        where r.reporter_id = auth.uid() and r.target_type = 'post' and r.post_id = rp.id
      )
      and (p_area is null or rp.area = p_area)
      and (p_max_budget is null or (rp.budget_yen is not null and rp.budget_yen <= p_max_budget))
      and (p_genre is null or rp.genre = p_genre)
      and (p_theme is null or rp.theme = p_theme)
      and (
        v_pattern is null
        or rp.title ilike v_pattern
        or rp.area ilike v_pattern
        or rp.lead ilike v_pattern
        or rp.genre ilike v_pattern
        or rp.theme ilike v_pattern
        or exists (select 1 from public.route_post_stops s where s.post_id = rp.id and s.name ilike v_pattern)
      )
    order by ord
    limit least(greatest(coalesce(p_limit, 40), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) t;

  return v_result;
end;
$$;

create or replace function public.list_public_route_areas()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(area order by area), '[]'::jsonb)
  from (
    select distinct rp.area
    from public.route_posts rp
    join public.users u on u.id = rp.user_id
    where rp.visibility = 'public' and rp.hidden_at is null
      and u.show_posts_in_feed and u.deleted_at is null and u.suspended_at is null
      and rp.area is not null
      and auth.uid() is not null
  ) a;
$$;

create or replace function public.get_route_post(p_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.route_posts;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if not public.can_view_route_post(p_post_id) then
    return null;
  end if;
  select * into v_post from public.route_posts where id = p_post_id;

  return public.route_post_card(v_post) || jsonb_build_object(
    'plan_id', case when v_post.user_id = auth.uid() then v_post.plan_id else null end,
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sequence', s.sequence,
        'place_id', s.place_id,
        'name', s.name,
        'category', s.category,
        'visited_time', to_char(s.visited_time, 'HH24:MI'),
        'action', s.action,
        'note', s.note,
        'photo_path', s.photo_path
      ) order by s.sequence)
      from public.route_post_stops s where s.post_id = v_post.id
    ), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(c.item order by c.created_at)
      from (
        select rc.created_at, jsonb_build_object(
          'id', rc.id,
          'body', rc.body,
          'created_at', rc.created_at,
          'author_name', coalesce(nullif(btrim(u.display_name), ''), 'Mikke ユーザー'),
          'is_mine', rc.user_id = auth.uid()
        ) as item
        from public.route_comments rc
        join public.users u on u.id = rc.user_id
        where rc.post_id = v_post.id and public.can_view_route_comment(rc.id)
        order by rc.created_at desc
        limit 100
      ) c
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 記録の付け直し: 残す場所の時刻・行動・ひと言・写真を引き継ぐ
-- ---------------------------------------------------------------------------
create or replace function public.create_visit_record(
  p_plan_id uuid,
  p_place_ids uuid[],
  p_memory text default null
)
returns public.route_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan public.plans;
  v_post public.route_posts;
  v_existing_ids uuid[];
  v_memory text := nullif(btrim(coalesce(p_memory, '')), '');
  v_seq integer := 0;
  v_item record;
  v_old jsonb := '{}'::jsonb;
  v_prev jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  select * into v_plan from public.plans where id = p_plan_id and user_id = v_user_id and status = 'accepted';
  if v_plan.id is null then
    raise exception 'accepted_plan_not_found' using errcode = 'P0002';
  end if;
  if coalesce(cardinality(p_place_ids), 0) = 0 then
    raise exception 'visited_places_required' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_place_ids) as v(place_id)
    where not exists (select 1 from public.plan_items pi where pi.plan_id = p_plan_id and pi.place_id = v.place_id)
  ) then
    raise exception 'visited_place_not_in_plan' using errcode = '42501';
  end if;
  if v_memory is not null and char_length(v_memory) > 200 then
    raise exception 'memory_too_long' using errcode = '22023';
  end if;

  select visited_place_ids into v_existing_ids from public.visits where user_id = v_user_id and plan_id = p_plan_id;
  perform public.answer_visit(
    p_plan_id, true, null, null,
    array(select distinct x from unnest(coalesce(v_existing_ids, '{}') || p_place_ids) as x)
  );

  select * into v_post from public.route_posts where user_id = v_user_id and plan_id = p_plan_id for update;
  if v_post.id is not null then
    if v_post.visibility = 'public' then
      raise exception 'record_already_published' using errcode = '22023';
    end if;
    -- 付け直しでも、残す場所に入力済みの内容は引き継ぐ（外した場所の写真は list_unused_route_photos で片付ける）
    select coalesce(jsonb_object_agg(s.place_id::text, jsonb_build_object(
      'visited_time', s.visited_time, 'action', s.action, 'note', s.note, 'photo_path', s.photo_path
    )), '{}'::jsonb)
    into v_old
    from public.route_post_stops s where s.post_id = v_post.id and s.place_id is not null;
    delete from public.route_post_stops where post_id = v_post.id;
    update public.route_posts set memory = v_memory where id = v_post.id returning * into v_post;
  else
    insert into public.route_posts (user_id, plan_id, title, memory, visited_on)
    values (
      v_user_id, p_plan_id,
      coalesce(nullif(left(v_plan.condition_json -> 'option' ->> 'title', 40), ''), '今日のお出かけ'),
      v_memory,
      (coalesce(v_plan.accepted_at, now()) at time zone 'Asia/Tokyo')::date
    )
    returning * into v_post;
  end if;

  for v_item in
    select pi.place_id, pl.name, pl.category
    from public.plan_items pi
    join public.places pl on pl.id = pi.place_id
    where pi.plan_id = p_plan_id and pi.place_id = any(p_place_ids)
    order by pi.sequence
  loop
    v_seq := v_seq + 1;
    v_prev := v_old -> v_item.place_id::text;
    insert into public.route_post_stops (post_id, sequence, place_id, name, category, visited_time, action, note, photo_path)
    values (
      v_post.id, v_seq, v_item.place_id, left(v_item.name, 80), v_item.category,
      (v_prev ->> 'visited_time')::time, v_prev ->> 'action', v_prev ->> 'note', v_prev ->> 'photo_path'
    );
  end loop;

  -- 表紙が外した場所の写真なら、残った最初の写真に差し替える
  update public.route_posts rp set cover_photo_path = (
    select s.photo_path from public.route_post_stops s
    where s.post_id = rp.id and s.photo_path is not null order by s.sequence limit 1
  )
  where rp.id = v_post.id
    and rp.cover_photo_path is not null
    and not exists (select 1 from public.route_post_stops s where s.post_id = rp.id and s.photo_path = rp.cover_photo_path);

  select * into v_post from public.route_posts where id = v_post.id;
  return v_post;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. 投稿停止中は公開・コメントできない
-- ---------------------------------------------------------------------------
create or replace function public.assert_not_suspended()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.users where id = auth.uid() and suspended_at is not null) then
    raise exception 'account_restricted' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.assert_not_suspended() from PUBLIC, anon, authenticated;

create or replace function public.update_route_post(
  p_post_id uuid,
  p_post jsonb,
  p_publish boolean default false
)
returns public.route_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_post public.route_posts;
  v_prefix text;
  v_stop jsonb;
  v_seq integer;
  v_time text;
  v_photo text;
  v_cover text;
  v_title text := nullif(btrim(coalesce(p_post ->> 'title', '')), '');
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  select * into v_post from public.route_posts where id = p_post_id and user_id = v_user_id for update;
  if v_post.id is null then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;
  if p_publish or v_post.visibility = 'public' then
    perform public.assert_not_suspended();
  end if;
  if jsonb_typeof(coalesce(p_post, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_post' using errcode = '22023';
  end if;
  if v_title is null then
    raise exception 'title_required' using errcode = '22023';
  end if;

  v_prefix := v_user_id::text || '/' || v_post.id::text || '/';
  v_cover := nullif(p_post ->> 'cover_photo_path', '');
  if v_cover is not null and left(v_cover, char_length(v_prefix)) <> v_prefix then
    raise exception 'invalid_photo_path' using errcode = '42501';
  end if;

  update public.route_posts set
    title = v_title,
    lead = nullif(btrim(coalesce(p_post ->> 'lead', '')), ''),
    area = nullif(btrim(coalesce(p_post ->> 'area', '')), ''),
    genre = nullif(btrim(coalesce(p_post ->> 'genre', '')), ''),
    theme = nullif(btrim(coalesce(p_post ->> 'theme', '')), ''),
    budget_yen = nullif(p_post ->> 'budget_yen', '')::integer,
    duration_minutes = nullif(p_post ->> 'duration_minutes', '')::integer,
    cover_photo_path = v_cover,
    visibility = case when p_publish then 'public' else visibility end,
    published_at = case when p_publish then coalesce(published_at, now()) else published_at end
  where id = v_post.id
  returning * into v_post;

  if jsonb_typeof(p_post -> 'stops') = 'array' then
    for v_stop in select value from jsonb_array_elements(p_post -> 'stops')
    loop
      v_seq := nullif(v_stop ->> 'sequence', '')::integer;
      v_time := nullif(v_stop ->> 'visited_time', '');
      v_photo := nullif(v_stop ->> 'photo_path', '');
      if v_time is not null and v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'invalid_visited_time' using errcode = '22023';
      end if;
      if v_photo is not null and left(v_photo, char_length(v_prefix)) <> v_prefix then
        raise exception 'invalid_photo_path' using errcode = '42501';
      end if;
      update public.route_post_stops set
        visited_time = v_time::time,
        action = nullif(btrim(coalesce(v_stop ->> 'action', '')), ''),
        note = nullif(btrim(coalesce(v_stop ->> 'note', '')), ''),
        photo_path = v_photo
      where post_id = v_post.id and sequence = v_seq;
      if not found then
        raise exception 'stop_not_found' using errcode = '22023';
      end if;
    end loop;
  end if;

  return v_post;
end;
$$;

create or replace function public.add_route_comment(p_post_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_comment public.route_comments;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  perform public.assert_not_suspended();
  if char_length(v_body) not between 1 and 100 then
    raise exception 'invalid_comment' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.route_posts where id = p_post_id and visibility = 'public'
  ) or not public.can_view_route_post(p_post_id) then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;
  insert into public.route_comments (post_id, user_id, body) values (p_post_id, v_user_id, v_body)
  returning * into v_comment;
  return jsonb_build_object(
    'id', v_comment.id,
    'body', v_comment.body,
    'created_at', v_comment.created_at,
    'author_name', coalesce((select nullif(btrim(display_name), '') from public.users where id = v_user_id), 'Mikke ユーザー'),
    'is_mine', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. いいね・行きたい: 直列化 + 状態指定（p_active）で冪等
-- ---------------------------------------------------------------------------
-- p_active = null は従来どおりの切り替え。true / false はその状態にする（二重送信しても結果が同じ）
drop function if exists public.toggle_route_reaction(uuid, text);
create or replace function public.toggle_route_reaction(p_post_id uuid, p_kind text, p_active boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_exists boolean;
  v_active boolean;
  v_post public.route_posts;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if p_kind not in ('like', 'wish') then
    raise exception 'invalid_reaction' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.route_posts where id = p_post_id and visibility = 'public'
  ) or not public.can_view_route_post(p_post_id) then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;

  -- 同じ人・同じ投稿・同じ種類の同時操作を順番に処理する（主キー重複のエラーにしない）
  perform pg_advisory_xact_lock(hashtextextended('route_reaction:' || v_user_id || ':' || p_post_id || ':' || p_kind, 0));

  if p_kind = 'like' then
    v_exists := exists (select 1 from public.route_likes where user_id = v_user_id and post_id = p_post_id);
  else
    v_exists := exists (select 1 from public.route_wishes where user_id = v_user_id and post_id = p_post_id);
  end if;
  v_active := coalesce(p_active, not v_exists);

  if v_active and not v_exists then
    if p_kind = 'like' then
      insert into public.route_likes (user_id, post_id) values (v_user_id, p_post_id) on conflict do nothing;
    else
      insert into public.route_wishes (user_id, post_id) values (v_user_id, p_post_id) on conflict do nothing;
    end if;
  elsif not v_active and v_exists then
    if p_kind = 'like' then
      delete from public.route_likes where user_id = v_user_id and post_id = p_post_id;
    else
      delete from public.route_wishes where user_id = v_user_id and post_id = p_post_id;
    end if;
  end if;

  select * into v_post from public.route_posts where id = p_post_id;
  return jsonb_build_object(
    'kind', p_kind,
    'active', v_active,
    'like_count', v_post.like_count,
    'wish_count', v_post.wish_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. 使われていない自分の写真（アップロード後に保存できなかった・差し替えた・付け直しで外した・投稿を消した）
-- ---------------------------------------------------------------------------
-- Storage のファイルは SQL では消せないため、パスを返してアプリが Storage API（本人の JWT）で消す。
-- アップロード直後〜保存までの写真を消さないよう、10分以上前のものだけを返す
create or replace function public.list_unused_route_photos(p_post_id uuid default null)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(o.name order by o.name), '{}'::text[])
  from (
    select o.name
    from storage.objects o
    where o.bucket_id = 'route-photos'
      and auth.uid() is not null
      and (storage.foldername(o.name))[1] = auth.uid()::text
      and (p_post_id is null or (storage.foldername(o.name))[2] = p_post_id::text)
      and o.created_at < now() - interval '10 minutes'
      and not exists (
        select 1 from public.route_posts rp where rp.user_id = auth.uid() and rp.cover_photo_path = o.name
      )
      and not exists (
        select 1 from public.route_post_stops s join public.route_posts rp on rp.id = s.post_id
        where rp.user_id = auth.uid() and s.photo_path = o.name
      )
    order by o.name
    limit 200
  ) o;
$$;

-- ---------------------------------------------------------------------------
-- 10. 通報・ブロック（利用者の操作。すべて RPC）
-- ---------------------------------------------------------------------------
-- 対象の特定: コメントは p_comment_id、投稿は p_post_id。ユーザーの通報・ブロックは、そのユーザーの投稿かコメントから指定する
-- （アプリには他人の user_id を渡さないため）
create or replace function public.resolve_ugc_target(p_post_id uuid, p_comment_id uuid)
returns table (post_id uuid, comment_id uuid, author_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment public.route_comments;
begin
  if p_comment_id is not null then
    select * into v_comment from public.route_comments where id = p_comment_id;
    if v_comment.id is null
      or not public.route_post_visible(v_comment.post_id, true)
      or not public.route_comment_visible(v_comment.id, true) then
      raise exception 'route_content_not_found' using errcode = 'P0002';
    end if;
    return query select v_comment.post_id, v_comment.id, v_comment.user_id;
  elsif p_post_id is not null then
    if not public.route_post_visible(p_post_id, true) then
      raise exception 'route_content_not_found' using errcode = 'P0002';
    end if;
    return query select rp.id, null::uuid, rp.user_id from public.route_posts rp where rp.id = p_post_id;
  else
    raise exception 'invalid_report_target' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.resolve_ugc_target(uuid, uuid) from PUBLIC, anon, authenticated;

create or replace function public.report_route_content(
  p_target_type text,
  p_reason text,
  p_post_id uuid default null,
  p_comment_id uuid default null,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
  v_target record;
  v_key uuid;
  v_existing uuid;
  v_snapshot jsonb;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if p_target_type is null or p_target_type not in ('post', 'comment', 'user') then
    raise exception 'invalid_report_target' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('spam', 'harassment', 'inappropriate', 'privacy', 'other') then
    raise exception 'invalid_report_reason' using errcode = '22023';
  end if;
  if v_detail is not null and char_length(v_detail) > 500 then
    raise exception 'invalid_report_detail' using errcode = '22023';
  end if;
  if (p_target_type = 'post' and (p_post_id is null or p_comment_id is not null))
    or (p_target_type = 'comment' and p_comment_id is null) then
    raise exception 'invalid_report_target' using errcode = '22023';
  end if;

  select * into v_target from public.resolve_ugc_target(p_post_id, p_comment_id);
  if v_target.author_id = v_user_id then
    raise exception 'invalid_report_own_content' using errcode = '22023';
  end if;

  v_key := case p_target_type when 'post' then v_target.post_id when 'comment' then v_target.comment_id else v_target.author_id end;

  select id into v_existing from public.content_reports
  where reporter_id = v_user_id and target_type = p_target_type and target_key = v_key and status = 'open';
  if v_existing is not null then
    return jsonb_build_object('id', v_existing, 'already_reported', true);
  end if;

  -- いたずら・大量通報の抑止（24時間で20件まで）
  if (select count(*) from public.content_reports where reporter_id = v_user_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'invalid_report_too_many' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'author_name', coalesce(nullif(btrim(u.display_name), ''), 'Mikke ユーザー'),
    'post', (
      select jsonb_build_object(
        'title', rp.title, 'lead', rp.lead, 'area', rp.area, 'genre', rp.genre, 'theme', rp.theme,
        'cover_photo_path', rp.cover_photo_path, 'published_at', rp.published_at,
        'stops', coalesce((
          select jsonb_agg(jsonb_build_object('name', s.name, 'action', s.action, 'note', s.note, 'photo_path', s.photo_path) order by s.sequence)
          from public.route_post_stops s where s.post_id = rp.id
        ), '[]'::jsonb)
      )
      from public.route_posts rp where rp.id = v_target.post_id
    ),
    'comment', (
      select jsonb_build_object('body', rc.body, 'created_at', rc.created_at)
      from public.route_comments rc where rc.id = v_target.comment_id
    )
  )
  into v_snapshot
  from public.users u where u.id = v_target.author_id;

  insert into public.content_reports (
    reporter_id, target_type, target_key, post_id, comment_id, reported_user_id, reason, detail, content_snapshot
  ) values (
    v_user_id, p_target_type, v_key, v_target.post_id, v_target.comment_id, v_target.author_id, p_reason, v_detail,
    coalesce(v_snapshot, '{}'::jsonb)
  )
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.content_reports
    where reporter_id = v_user_id and target_type = p_target_type and target_key = v_key and status = 'open';
    return jsonb_build_object('id', v_id, 'already_reported', true);
  end if;
  return jsonb_build_object('id', v_id, 'already_reported', false);
end;
$$;

create or replace function public.block_user(p_post_id uuid default null, p_comment_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_target record;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  select * into v_target from public.resolve_ugc_target(p_post_id, p_comment_id);
  if v_target.author_id = v_user_id then
    raise exception 'invalid_block_self' using errcode = '22023';
  end if;
  insert into public.user_blocks (blocker_id, blocked_id) values (v_user_id, v_target.author_id)
  on conflict (blocker_id, blocked_id) do nothing;
  return jsonb_build_object(
    'blocked', true,
    'name', coalesce((select nullif(btrim(display_name), '') from public.users where id = v_target.author_id), 'Mikke ユーザー')
  );
end;
$$;

-- ブロックした相手（相手の user_id は返さない。解除はブロックの id で行う）
create or replace function public.list_blocked_users()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'name', coalesce(nullif(btrim(u.display_name), ''), 'Mikke ユーザー'),
    'blocked_at', b.created_at
  ) order by b.created_at desc), '[]'::jsonb)
  from public.user_blocks b
  join public.users u on u.id = b.blocked_id
  where b.blocker_id = auth.uid();
$$;

create or replace function public.unblock_user(p_block_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  delete from public.user_blocks where id = p_block_id and blocker_id = auth.uid();
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. 関数の権限
-- ---------------------------------------------------------------------------
revoke all on function public.toggle_route_reaction(uuid, text, boolean) from PUBLIC, anon;
revoke all on function public.list_unused_route_photos(uuid) from PUBLIC, anon;
revoke all on function public.report_route_content(text, text, uuid, uuid, text) from PUBLIC, anon;
revoke all on function public.block_user(uuid, uuid) from PUBLIC, anon;
revoke all on function public.list_blocked_users() from PUBLIC, anon;
revoke all on function public.unblock_user(uuid) from PUBLIC, anon;
grant execute on function public.toggle_route_reaction(uuid, text, boolean) to authenticated;
grant execute on function public.list_unused_route_photos(uuid) to authenticated;
grant execute on function public.report_route_content(text, text, uuid, uuid, text) to authenticated;
grant execute on function public.block_user(uuid, uuid) to authenticated;
grant execute on function public.list_blocked_users() to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. 運営の確認・対処（Supabase Dashboard の SQL Editor から。Data API には出さない）
-- ---------------------------------------------------------------------------
create schema if not exists moderation;
revoke all on schema moderation from PUBLIC, anon, authenticated;

-- 未対応の通報（古い順）。同じ対象への未対応件数と、対象の現在の状態を並べる
create or replace view moderation.report_queue as
select
  r.id as report_id,
  r.created_at,
  now() - r.created_at as waiting,
  r.target_type,
  r.reason,
  r.detail,
  (select count(*) from public.content_reports r2
    where r2.status = 'open' and r2.target_type = r.target_type and r2.target_key = r.target_key) as open_reports_for_target,
  r.post_id,
  r.comment_id,
  r.reported_user_id,
  r.content_snapshot,
  rp.visibility as post_visibility,
  rp.hidden_at as post_hidden_at,
  rc.hidden_at as comment_hidden_at,
  u.suspended_at as user_suspended_at
from public.content_reports r
left join public.route_posts rp on rp.id = r.post_id
left join public.route_comments rc on rc.id = r.comment_id
left join public.users u on u.id = r.reported_user_id
where r.status = 'open'
order by r.created_at;

-- 通報に対処し、同じ対象への未対応の通報をまとめて閉じる。戻り値は閉じた件数
--   dismiss          : 問題なし（何もしない）
--   hide_content     : 投稿・コメントを非表示（本人には「運営により非表示」と表示）
--   suspend_user     : 投稿停止（公開・コメント不可。公開中の投稿・コメントもほかの人に表示しない）
--   hide_and_suspend : 両方
create or replace function moderation.resolve_report(p_report_id uuid, p_action text, p_note text default null)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_report public.content_reports;
  v_count integer;
begin
  select * into v_report from public.content_reports where id = p_report_id for update;
  if v_report.id is null or v_report.status <> 'open' then
    raise exception 'report_not_open';
  end if;
  if p_action not in ('dismiss', 'hide_content', 'suspend_user', 'hide_and_suspend') then
    raise exception 'invalid_action';
  end if;

  if p_action in ('hide_content', 'hide_and_suspend') then
    if v_report.target_type = 'post' and v_report.post_id is not null then
      update public.route_posts set hidden_at = coalesce(hidden_at, now()), hidden_reason = v_report.reason
      where id = v_report.post_id;
    elsif v_report.target_type = 'comment' and v_report.comment_id is not null then
      update public.route_comments set hidden_at = coalesce(hidden_at, now()) where id = v_report.comment_id;
    elsif p_action = 'hide_content' then
      raise exception 'nothing_to_hide';
    end if;
  end if;
  if p_action in ('suspend_user', 'hide_and_suspend') then
    if v_report.reported_user_id is null then
      raise exception 'user_not_found';
    end if;
    update public.users set suspended_at = coalesce(suspended_at, now()) where id = v_report.reported_user_id;
  end if;

  update public.content_reports set
    status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end,
    action_taken = p_action,
    moderator_note = p_note,
    resolved_at = now()
  where status = 'open' and target_type = v_report.target_type and target_key = v_report.target_key;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 異議申し立てなどで元に戻す（p_target_type: post / comment / user）
create or replace function moderation.restore(p_target_type text, p_id uuid)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_target_type = 'post' then
    update public.route_posts set hidden_at = null, hidden_reason = null where id = p_id;
  elsif p_target_type = 'comment' then
    update public.route_comments set hidden_at = null where id = p_id;
  elsif p_target_type = 'user' then
    update public.users set suspended_at = null where id = p_id;
  else
    raise exception 'invalid_target_type';
  end if;
  return found;
end;
$$;

revoke all on all tables in schema moderation from PUBLIC, anon, authenticated;
revoke all on all functions in schema moderation from PUBLIC, anon, authenticated;

commit;
