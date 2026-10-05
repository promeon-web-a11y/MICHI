-- Mikke v3.0: 行った記録・公開ルート（みんなのルート）・いいね・行きたい・コメント・投稿写真・設定・生成回数
--
-- 方針
-- - 既存テーブル（users / places / plans / plan_items / visits）を起点にし、足りない分だけ追加する
-- - 「行った記録」と「公開ルート」は同じ route_posts の行（visibility = private → public）。重複テーブルを作らない
-- - クライアントの書き込みはすべて security definer の RPC（auth.uid() で本人を確定）。表への直接書き込みは
--   削除（本人の行のみ）以外は与えない（既存 plans / visits と同じ考え方）
-- - 他人の投稿は「公開済み」かつ「投稿者が みんな への表示をオンにしている」ときだけ読める
-- - 投稿写真は非公開バケット route-photos。パスは <user_id>/<post_id>/<file>。閲覧は署名付きURL
-- - 既存の KPI イベント・トリガーは変更しない
begin;

-- ---------------------------------------------------------------------------
-- 1. users: 設定（表示名・よく行く地域は既存列 display_name / home_area を使う）
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists show_posts_in_feed boolean not null default true,
  add column if not exists notify_weekend_hints boolean not null default false,
  add column if not exists notify_saved_updates boolean not null default false;

-- 既存行は検証しない（not valid）。新しい書き込みから長さを制限する
do $$ begin
  alter table public.users add constraint users_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 20) not valid;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.users add constraint users_home_area_length
    check (home_area is null or char_length(home_area) between 1 and 20) not valid;
exception when duplicate_object then null;
end $$;

grant update (show_posts_in_feed, notify_weekend_hints, notify_saved_updates) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. テーブル
-- ---------------------------------------------------------------------------
create table if not exists public.route_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- 記録のもとになった採用済みプラン（プランが消えても記録は残す）
  plan_id uuid references public.plans(id) on delete set null,
  title text not null default '今日のお出かけ' check (char_length(title) between 1 and 40),
  lead text check (lead is null or char_length(lead) <= 160),
  memory text check (memory is null or char_length(memory) <= 200),
  area text check (area is null or char_length(area) between 1 and 30),
  genre text check (genre is null or char_length(genre) between 1 and 20),
  theme text check (theme is null or char_length(theme) between 1 and 20),
  budget_yen integer check (budget_yen is null or budget_yen between 0 and 1000000),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  cover_photo_path text check (cover_photo_path is null or char_length(cover_photo_path) <= 300),
  visited_on date,
  published_at timestamptz,
  like_count integer not null default 0 check (like_count >= 0),
  wish_count integer not null default 0 check (wish_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((visibility = 'public') = (published_at is not null))
);

-- 1つのプランにつき記録は1件
create unique index if not exists route_posts_user_plan_once
  on public.route_posts (user_id, plan_id) where plan_id is not null;
create index if not exists idx_route_posts_public
  on public.route_posts (published_at desc) where visibility = 'public';
create index if not exists idx_route_posts_user_created
  on public.route_posts (user_id, created_at desc);

create table if not exists public.route_post_stops (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.route_posts(id) on delete cascade,
  -- plans は1〜4スポット（plan_items.sequence と同じ範囲）
  sequence integer not null check (sequence between 1 and 4),
  place_id uuid references public.places(id) on delete set null,
  name text not null check (char_length(name) between 1 and 80),
  category public.place_category,
  -- 本人が入力した行った時刻（任意）。移動時間・交通手段は保存しない
  visited_time time,
  action text check (action is null or char_length(action) between 1 and 40),
  note text check (note is null or char_length(note) <= 140),
  photo_path text check (photo_path is null or char_length(photo_path) <= 300),
  created_at timestamptz not null default now(),
  unique (post_id, sequence)
);
create index if not exists idx_route_post_stops_post on public.route_post_stops (post_id, sequence);

create table if not exists public.route_likes (
  user_id uuid not null references public.users(id) on delete cascade,
  post_id uuid not null references public.route_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists idx_route_likes_post on public.route_likes (post_id);

-- 「行きたい」（保存一覧の「行きたい」）
create table if not exists public.route_wishes (
  user_id uuid not null references public.users(id) on delete cascade,
  post_id uuid not null references public.route_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists idx_route_wishes_post on public.route_wishes (post_id);
create index if not exists idx_route_wishes_user on public.route_wishes (user_id, created_at desc);

create table if not exists public.route_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.route_posts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 100),
  created_at timestamptz not null default now()
);
create index if not exists idx_route_comments_post on public.route_comments (post_id, created_at);

drop trigger if exists route_posts_touch_updated_at on public.route_posts;
create trigger route_posts_touch_updated_at before update on public.route_posts
for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. 件数（いいね・行きたい・コメント）を行の追加/削除と同じトランザクションで更新
-- ---------------------------------------------------------------------------
create or replace function public.route_reaction_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
  v_delta integer := case when tg_op = 'INSERT' then 1 else -1 end;
begin
  if tg_table_name = 'route_likes' then
    update public.route_posts set like_count = greatest(0, like_count + v_delta) where id = v_post;
  elsif tg_table_name = 'route_wishes' then
    update public.route_posts set wish_count = greatest(0, wish_count + v_delta) where id = v_post;
  elsif tg_table_name = 'route_comments' then
    update public.route_posts set comment_count = greatest(0, comment_count + v_delta) where id = v_post;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.route_reaction_counts() from PUBLIC, anon, authenticated;

drop trigger if exists route_likes_count on public.route_likes;
create trigger route_likes_count after insert or delete on public.route_likes
for each row execute function public.route_reaction_counts();
drop trigger if exists route_wishes_count on public.route_wishes;
create trigger route_wishes_count after insert or delete on public.route_wishes
for each row execute function public.route_reaction_counts();
drop trigger if exists route_comments_count on public.route_comments;
create trigger route_comments_count after insert or delete on public.route_comments
for each row execute function public.route_reaction_counts();

-- ---------------------------------------------------------------------------
-- 4. 閲覧できるか（RLS・RPC・Storage で共通に使う）
-- ---------------------------------------------------------------------------
-- 他人の投稿: 公開済み かつ 投稿者が「自分の投稿を みんな に表示」をオン かつ 退会処理中でない
create or replace function public.can_view_route_post(p_post_id uuid)
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
        or (rp.visibility = 'public' and u.show_posts_in_feed and u.deleted_at is null)
      )
  );
$$;
revoke all on function public.can_view_route_post(uuid) from PUBLIC, anon;
grant execute on function public.can_view_route_post(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
alter table public.route_posts enable row level security;
alter table public.route_post_stops enable row level security;
alter table public.route_likes enable row level security;
alter table public.route_wishes enable row level security;
alter table public.route_comments enable row level security;

drop policy if exists route_posts_select_visible on public.route_posts;
create policy route_posts_select_visible on public.route_posts
for select to authenticated using (user_id = auth.uid() or public.can_view_route_post(id));
drop policy if exists route_posts_delete_own on public.route_posts;
create policy route_posts_delete_own on public.route_posts
for delete to authenticated using (user_id = auth.uid());

drop policy if exists route_post_stops_select_visible on public.route_post_stops;
create policy route_post_stops_select_visible on public.route_post_stops
for select to authenticated using (public.can_view_route_post(post_id));

drop policy if exists route_likes_select_own on public.route_likes;
create policy route_likes_select_own on public.route_likes
for select to authenticated using (user_id = auth.uid());

drop policy if exists route_wishes_select_own on public.route_wishes;
create policy route_wishes_select_own on public.route_wishes
for select to authenticated using (user_id = auth.uid());

drop policy if exists route_comments_select_visible on public.route_comments;
create policy route_comments_select_visible on public.route_comments
for select to authenticated using (public.can_view_route_post(post_id));
drop policy if exists route_comments_delete_own on public.route_comments;
create policy route_comments_delete_own on public.route_comments
for delete to authenticated using (user_id = auth.uid());

-- Supabase は public の新規テーブルに anon/authenticated の全権限を既定で付けるため、明示的に絞る
revoke all on public.route_posts, public.route_post_stops, public.route_likes,
  public.route_wishes, public.route_comments from PUBLIC, anon, authenticated;
grant select, delete on public.route_posts to authenticated;
grant select on public.route_post_stops to authenticated;
grant select on public.route_likes to authenticated;
grant select on public.route_wishes to authenticated;
grant select, delete on public.route_comments to authenticated;

-- ---------------------------------------------------------------------------
-- 6. 表示用の JSON（一覧カード・詳細）
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
    'is_mine', p_post.user_id = auth.uid()
  )
  from public.users u
  where u.id = p_post.user_id;
$$;
revoke all on function public.route_post_card(public.route_posts) from PUBLIC, anon, authenticated;

-- みんなのルート一覧（キーワード・地域・予算上限・系統・テーマは AND。並び順は recommended / likes / wishes）
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
    -- LIKE の特殊文字を無効化して部分一致
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
          -- おすすめ: 反応数（行きたいは2倍）を公開からの日数で減衰（14日）。同点は新しい順
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
      and u.show_posts_in_feed
      and u.deleted_at is null
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

-- 絞り込みの「地域」の選択肢（実際に公開されているルートの地域だけ）
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
    where rp.visibility = 'public' and u.show_posts_in_feed and u.deleted_at is null and rp.area is not null
      and auth.uid() is not null
  ) a;
$$;

-- ルート詳細（日記）。見られない投稿は null
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
        where rc.post_id = v_post.id
        order by rc.created_at desc
        limit 100
      ) c
    ), '[]'::jsonb)
  );
end;
$$;

-- 自分の記録・投稿（非公開の行った記録も含む）
create or replace function public.list_my_route_posts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(public.route_post_card(rp) order by rp.created_at desc), '[]'::jsonb)
  from public.route_posts rp
  where rp.user_id = auth.uid();
$$;

-- 保存一覧の「行きたい」（まだ見られる投稿だけ）
create or replace function public.list_my_route_wishes()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(public.route_post_card(rp) order by w.created_at desc), '[]'::jsonb)
  from public.route_wishes w
  join public.route_posts rp on rp.id = w.post_id
  where w.user_id = auth.uid() and public.can_view_route_post(rp.id);
$$;

-- ---------------------------------------------------------------------------
-- 7. 行った記録（非公開）: 採用済みプランから、実際に行った場所だけを選んで保存
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

  -- 既存の訪問回答（KPI の正本）にも反映する。これまでの「行った」は消さずに足す
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
    insert into public.route_post_stops (post_id, sequence, place_id, name, category)
    values (v_post.id, v_seq, v_item.place_id, left(v_item.name, 80), v_item.category);
  end loop;

  return v_post;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. 投稿の編集・公開（本人のみ。公開は p_publish = true の明示操作だけ）
-- ---------------------------------------------------------------------------
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
  if jsonb_typeof(coalesce(p_post, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_post' using errcode = '22023';
  end if;
  if v_title is null then
    raise exception 'title_required' using errcode = '22023';
  end if;

  -- 写真は本人のこの投稿のフォルダーのものだけ
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

-- 公開をやめる（非公開の記録に戻す。いいね・コメントは残す）
create or replace function public.unpublish_route_post(p_post_id uuid)
returns public.route_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.route_posts;
begin
  update public.route_posts set visibility = 'private', published_at = null
  where id = p_post_id and user_id = auth.uid()
  returning * into v_post;
  if v_post.id is null then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;
  return v_post;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. いいね・行きたい・コメント
-- ---------------------------------------------------------------------------
create or replace function public.toggle_route_reaction(p_post_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
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

  if p_kind = 'like' then
    delete from public.route_likes where user_id = v_user_id and post_id = p_post_id;
    v_active := not found;
    if v_active then
      insert into public.route_likes (user_id, post_id) values (v_user_id, p_post_id);
    end if;
  else
    delete from public.route_wishes where user_id = v_user_id and post_id = p_post_id;
    v_active := not found;
    if v_active then
      insert into public.route_wishes (user_id, post_id) values (v_user_id, p_post_id);
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
-- 10. 公開ルートからプランへ
-- ---------------------------------------------------------------------------
-- 「同じ順番で行く」: 公開ルートの立ち寄り順で自分の採用済みプランを作る（今日のプラン・訪問記録にそのまま使える）。
-- 時刻・滞在・移動は作らない（start_at / travel は null、stay_minutes は plan_items の制約上の既定値）。
create or replace function public.start_route_from_post(p_post_id uuid)
returns public.plans
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_post public.route_posts;
  v_plan public.plans;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if not public.can_view_route_post(p_post_id) then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;
  select * into v_post from public.route_posts where id = p_post_id;
  if v_post.visibility <> 'public' and v_post.user_id <> v_user_id then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.route_post_stops where post_id = p_post_id and place_id is not null;
  if v_count = 0 then
    raise exception 'route_has_no_places' using errcode = '22023';
  end if;

  insert into public.plans (
    user_id, status, condition_json, candidate_count, generation_sequence, generated_at
  ) values (
    v_user_id, 'generated',
    jsonb_build_object(
      'source', 'mobile_route_copy',
      'version', 1,
      'based_on_route_post_id', v_post.id,
      'option', jsonb_build_object('title', v_post.title, 'concept', 'みんなのルートと同じ順番')
    ),
    v_count, 1, now()
  ) returning * into v_plan;

  insert into public.plan_items (plan_id, place_id, sequence, stay_minutes, selection_reason)
  select v_plan.id, s.place_id, row_number() over (order by s.sequence), 30,
    'みんなのルート「' || v_post.title || '」の' || s.sequence || 'か所目'
  from (
    select distinct on (place_id) place_id, sequence
    from public.route_post_stops
    where post_id = p_post_id and place_id is not null
    order by place_id, sequence
  ) s
  order by s.sequence;

  update public.plans set status = 'accepted', accepted_at = now() where id = v_plan.id returning * into v_plan;
  return v_plan;
end;
$$;

-- 「今日向けに調整」: 公開ルートの場所を自分の保存場所に加え、その場所の ID を返す
-- （その ID を generate-plan-options の place_ids に渡して、元ルートの場所から新しい提案を作る）
create or replace function public.save_route_places(p_post_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if not public.can_view_route_post(p_post_id) then
    raise exception 'route_post_not_found' using errcode = 'P0002';
  end if;
  select array_agg(distinct place_id) into v_ids
  from public.route_post_stops where post_id = p_post_id and place_id is not null;
  if coalesce(cardinality(v_ids), 0) = 0 then
    raise exception 'route_has_no_places' using errcode = '22023';
  end if;
  insert into public.saved_places (user_id, place_id, source_platform, source_url, confirmed_at)
  select v_user_id, x, 'other', 'mikke://routes/' || p_post_id::text, now()
  from unnest(v_ids) as x
  on conflict (user_id, place_id) do nothing;
  return v_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. 今月のルート生成回数（サーバーを正本とする）
-- ---------------------------------------------------------------------------
-- 1回の「プランをつくる」で最大3件の plans ができるため、set_id（無い場合は plan id）単位で数える。
-- 月の区切りは日本時間の1日 0:00。「同じ順番で行く」（mobile_route_copy）は生成に数えない。
-- 無料枠の上限は未確定のため monthly_limit は null（決まったらこの関数だけを変える）。
create or replace function public.get_plan_generation_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  v_end timestamptz := (date_trunc('month', now() at time zone 'Asia/Tokyo') + interval '1 month') at time zone 'Asia/Tokyo';
  v_limit integer := null;
  v_used integer;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  select count(distinct coalesce(condition_json -> 'option' ->> 'set_id', id::text)) into v_used
  from public.plans
  where user_id = auth.uid()
    and created_at >= v_start and created_at < v_end
    and coalesce(condition_json ->> 'source', '') <> 'mobile_route_copy';
  return jsonb_build_object(
    'used', v_used,
    'monthly_limit', v_limit,
    'remaining', case when v_limit is null then null else greatest(0, v_limit - v_used) end,
    'period_start', v_start,
    'period_end', v_end,
    'timezone', 'Asia/Tokyo'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. 関数の権限
-- ---------------------------------------------------------------------------
revoke all on function public.list_public_routes(text, text, integer, text, text, text, integer, integer) from PUBLIC, anon;
revoke all on function public.list_public_route_areas() from PUBLIC, anon;
revoke all on function public.get_route_post(uuid) from PUBLIC, anon;
revoke all on function public.list_my_route_posts() from PUBLIC, anon;
revoke all on function public.list_my_route_wishes() from PUBLIC, anon;
revoke all on function public.create_visit_record(uuid, uuid[], text) from PUBLIC, anon;
revoke all on function public.update_route_post(uuid, jsonb, boolean) from PUBLIC, anon;
revoke all on function public.unpublish_route_post(uuid) from PUBLIC, anon;
revoke all on function public.toggle_route_reaction(uuid, text) from PUBLIC, anon;
revoke all on function public.add_route_comment(uuid, text) from PUBLIC, anon;
revoke all on function public.start_route_from_post(uuid) from PUBLIC, anon;
revoke all on function public.save_route_places(uuid) from PUBLIC, anon;
revoke all on function public.get_plan_generation_usage() from PUBLIC, anon;

grant execute on function public.list_public_routes(text, text, integer, text, text, text, integer, integer) to authenticated;
grant execute on function public.list_public_route_areas() to authenticated;
grant execute on function public.get_route_post(uuid) to authenticated;
grant execute on function public.list_my_route_posts() to authenticated;
grant execute on function public.list_my_route_wishes() to authenticated;
grant execute on function public.create_visit_record(uuid, uuid[], text) to authenticated;
grant execute on function public.update_route_post(uuid, jsonb, boolean) to authenticated;
grant execute on function public.unpublish_route_post(uuid) to authenticated;
grant execute on function public.toggle_route_reaction(uuid, text) to authenticated;
grant execute on function public.add_route_comment(uuid, text) to authenticated;
grant execute on function public.start_route_from_post(uuid) to authenticated;
grant execute on function public.save_route_places(uuid) to authenticated;
grant execute on function public.get_plan_generation_usage() to authenticated;

-- ---------------------------------------------------------------------------
-- 13. 投稿写真（Storage）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('route-photos', 'route-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 公開ルートの写真（表紙または立ち寄りの写真として使われているもの）か
create or replace function public.route_photo_is_visible(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.route_posts rp
    where rp.cover_photo_path = p_name and public.can_view_route_post(rp.id)
  ) or exists (
    select 1 from public.route_post_stops s
    where s.photo_path = p_name and public.can_view_route_post(s.post_id)
  );
$$;
revoke all on function public.route_photo_is_visible(text) from PUBLIC, anon;
grant execute on function public.route_photo_is_visible(text) to authenticated;

drop policy if exists route_photos_select on storage.objects;
create policy route_photos_select on storage.objects
for select to authenticated using (
  bucket_id = 'route-photos'
  and ((storage.foldername(name))[1] = auth.uid()::text or public.route_photo_is_visible(name))
);
drop policy if exists route_photos_insert_own on storage.objects;
create policy route_photos_insert_own on storage.objects
for insert to authenticated with check (
  bucket_id = 'route-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.route_posts rp
    where rp.id::text = (storage.foldername(name))[2] and rp.user_id = auth.uid()
  )
);
drop policy if exists route_photos_update_own on storage.objects;
create policy route_photos_update_own on storage.objects
for update to authenticated using (
  bucket_id = 'route-photos' and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id = 'route-photos' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists route_photos_delete_own on storage.objects;
create policy route_photos_delete_own on storage.objects
for delete to authenticated using (
  bucket_id = 'route-photos' and (storage.foldername(name))[1] = auth.uid()::text
);

commit;
