-- Mikke v3 デザイン反映: お店・スポット（みつける）・スポットの いいね / 行きたい・立ち寄りのコメント
--
-- 方針（既存のエンティティを優先し、同じ目的の表を作らない）
-- - スポット = 既存の public.places。一覧に出すのは「見られる公開ルートの立ち寄り先」になっている場所だけ
--   （架空の店舗・営業時間・価格は作らない。写真は立ち寄りに投稿された写真を使う）
-- - スポットの「行きたい」= 既存の saved_places（保存した場所）。プラン作成・地図・保存一覧の「場所」にそのまま使える
-- - スポットの「いいね」だけが新しい状態なので place_likes を追加する（ルートのいいね route_likes とは別）
-- - ルートの各立ち寄りのコメント（route_post_stops.note）を 140 → 300 文字に広げる（2〜3文の投稿者コメント）
begin;

-- ---------------------------------------------------------------------------
-- 1. 立ち寄りのコメント
-- ---------------------------------------------------------------------------
alter table public.route_post_stops drop constraint if exists route_post_stops_note_check;
alter table public.route_post_stops add constraint route_post_stops_note_check
  check (note is null or char_length(note) <= 300);

-- ---------------------------------------------------------------------------
-- 2. スポットのいいね
-- ---------------------------------------------------------------------------
create table if not exists public.place_likes (
  user_id uuid not null references public.users(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);
create index if not exists idx_place_likes_place on public.place_likes (place_id);
create index if not exists idx_place_likes_user on public.place_likes (user_id, created_at desc);
alter table public.place_likes enable row level security;
-- 誰がいいねしたかは出さない。読み書きは RPC だけ
revoke all on public.place_likes from PUBLIC, anon, authenticated;

create index if not exists idx_route_post_stops_place on public.route_post_stops (place_id) where place_id is not null;

-- ---------------------------------------------------------------------------
-- 3. スポットを閲覧者に見せるか・表示用 JSON
-- ---------------------------------------------------------------------------
-- 見られるルート（公開、または自分の記録）の立ち寄り先 / 自分が保存・いいねした場所
create or replace function public.spot_visible(p_place_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    exists (
      select 1 from public.route_post_stops s
      join public.route_posts rp on rp.id = s.post_id
      where s.place_id = p_place_id
        and (rp.visibility = 'public' or rp.user_id = auth.uid())
        and public.can_view_route_post(rp.id)
    )
    or exists (select 1 from public.saved_places sp where sp.place_id = p_place_id and sp.user_id = auth.uid())
    or exists (select 1 from public.place_likes pl where pl.place_id = p_place_id and pl.user_id = auth.uid())
  );
$$;
revoke all on function public.spot_visible(uuid) from PUBLIC, anon, authenticated;

create or replace function public.spot_card(p_place_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with vis as (
    select rp.id as post_id, rp.area, rp.published_at, rp.created_at, s.photo_path, s.sequence
    from public.route_post_stops s
    join public.route_posts rp on rp.id = s.post_id
    where s.place_id = p_place_id
      and (rp.visibility = 'public' or rp.user_id = auth.uid())
      and public.can_view_route_post(rp.id)
  )
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'category', p.category,
    'address', nullif(p.address, ''),
    'maps_url', p.maps_url,
    -- エリアは、その場所を含むルートの投稿者が付けた地域（無ければ null。住所から推測しない）
    'area', (select v.area from vis v where v.area is not null order by coalesce(v.published_at, v.created_at) desc limit 1),
    'photo_path', (select v.photo_path from vis v where v.photo_path is not null order by coalesce(v.published_at, v.created_at) desc limit 1),
    'like_count', (select count(*) from public.place_likes pl where pl.place_id = p.id),
    'route_count', (select count(distinct v.post_id) from vis v),
    'liked', exists (select 1 from public.place_likes pl where pl.place_id = p.id and pl.user_id = auth.uid()),
    'wished', exists (select 1 from public.saved_places sp where sp.place_id = p.id and sp.user_id = auth.uid())
  )
  from public.places p
  where p.id = p_place_id;
$$;
revoke all on function public.spot_card(uuid) from PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. みつける「お店・スポット」一覧・詳細
-- ---------------------------------------------------------------------------
-- 見られる公開ルートに登場する場所だけ。並び順は いいね数 + 登場ルート数×2 → 新しく登場した順
create or replace function public.list_public_spots(
  p_query text default null,
  p_category text default null,
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
  if v_query is not null then
    v_pattern := '%' || replace(replace(replace(left(v_query, 50), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with vis as (
    select s.place_id, rp.id as post_id, rp.area, rp.published_at
    from public.route_post_stops s
    join public.route_posts rp on rp.id = s.post_id
    where s.place_id is not null and rp.visibility = 'public' and public.can_view_route_post(rp.id)
  ), agg as (
    select v.place_id, count(distinct v.post_id) as route_count, max(v.published_at) as last_at,
      string_agg(distinct v.area, ' ') as areas
    from vis v group by v.place_id
  ), ranked as (
    select a.place_id, a.last_at,
      (select count(*) from public.place_likes pl where pl.place_id = a.place_id) + 2 * a.route_count as score
    from agg a
    join public.places p on p.id = a.place_id
    where (p_category is null or p.category::text = p_category)
      and (v_pattern is null or p.name ilike v_pattern or p.address ilike v_pattern or coalesce(a.areas, '') ilike v_pattern)
    order by score desc, a.last_at desc, a.place_id
    limit least(greatest(coalesce(p_limit, 40), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select coalesce(jsonb_agg(public.spot_card(r.place_id) order by r.score desc, r.last_at desc, r.place_id), '[]'::jsonb)
  into v_result
  from ranked r;
  return v_result;
end;
$$;

-- スポット詳細。見られない場所は null
create or replace function public.get_spot(p_place_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if not public.spot_visible(p_place_id) then
    return null;
  end if;
  return public.spot_card(p_place_id) || jsonb_build_object(
    'photos', coalesce((
      select jsonb_agg(x.photo_path order by x.at desc)
      from (
        select s.photo_path, max(coalesce(rp.published_at, rp.created_at)) as at
        from public.route_post_stops s
        join public.route_posts rp on rp.id = s.post_id
        where s.place_id = p_place_id and s.photo_path is not null
          and (rp.visibility = 'public' or rp.user_id = auth.uid())
          and public.can_view_route_post(rp.id)
        group by s.photo_path
        order by at desc
        limit 6
      ) x
    ), '[]'::jsonb),
    -- この場所を含む公開ルート（ブロック・非表示・通報済みは can_view_route_post で除かれる）
    'routes', coalesce((
      select jsonb_agg(public.route_post_card(t.post) order by t.at desc)
      from (
        select distinct on (rp.id) rp as post, rp.published_at as at
        from public.route_post_stops s
        join public.route_posts rp on rp.id = s.post_id
        where s.place_id = p_place_id and rp.visibility = 'public' and public.can_view_route_post(rp.id)
        order by rp.id
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

-- いいねしたスポット（保存一覧の「いいね」）
create or replace function public.list_my_place_likes()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(public.spot_card(pl.place_id) order by pl.created_at desc), '[]'::jsonb)
  from public.place_likes pl
  where pl.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 5. スポットの いいね / 行きたい（状態指定で冪等。同じ人・場所・種類の操作は直列化）
-- ---------------------------------------------------------------------------
-- 行きたい = saved_places への追加・削除（保存一覧の「場所」、プラン作成の保存場所になる）
create or replace function public.set_place_reaction(p_place_id uuid, p_kind text, p_active boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_exists boolean;
  v_active boolean;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('like', 'wish') then
    raise exception 'invalid_reaction' using errcode = '22023';
  end if;
  if not public.spot_visible(p_place_id) then
    raise exception 'spot_not_found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('place_reaction:' || v_user_id || ':' || p_place_id || ':' || p_kind, 0));

  if p_kind = 'like' then
    v_exists := exists (select 1 from public.place_likes where user_id = v_user_id and place_id = p_place_id);
  else
    v_exists := exists (select 1 from public.saved_places where user_id = v_user_id and place_id = p_place_id);
  end if;
  v_active := coalesce(p_active, not v_exists);

  if v_active and not v_exists then
    if p_kind = 'like' then
      insert into public.place_likes (user_id, place_id) values (v_user_id, p_place_id) on conflict do nothing;
    else
      insert into public.saved_places (user_id, place_id, source_platform, source_url, confirmed_at)
      values (v_user_id, p_place_id, 'other', 'mikke://places/' || p_place_id::text, now())
      on conflict (user_id, place_id) do nothing;
    end if;
  elsif not v_active and v_exists then
    if p_kind = 'like' then
      delete from public.place_likes where user_id = v_user_id and place_id = p_place_id;
    else
      delete from public.saved_places where user_id = v_user_id and place_id = p_place_id;
    end if;
  end if;

  return jsonb_build_object(
    'kind', p_kind,
    'active', v_active,
    'liked', exists (select 1 from public.place_likes where user_id = v_user_id and place_id = p_place_id),
    'wished', exists (select 1 from public.saved_places where user_id = v_user_id and place_id = p_place_id),
    'like_count', (select count(*) from public.place_likes where place_id = p_place_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. ルート詳細: 立ち寄りごとに「行きたい」（自分の保存場所か）を返す
-- ---------------------------------------------------------------------------
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
        'photo_path', s.photo_path,
        'wished', s.place_id is not null and exists (
          select 1 from public.saved_places sp where sp.place_id = s.place_id and sp.user_id = auth.uid()
        )
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
-- 7. 関数の権限
-- ---------------------------------------------------------------------------
revoke all on function public.list_public_spots(text, text, integer, integer) from PUBLIC, anon;
revoke all on function public.get_spot(uuid) from PUBLIC, anon;
revoke all on function public.list_my_place_likes() from PUBLIC, anon;
revoke all on function public.set_place_reaction(uuid, text, boolean) from PUBLIC, anon;
grant execute on function public.list_public_spots(text, text, integer, integer) to authenticated;
grant execute on function public.get_spot(uuid) to authenticated;
grant execute on function public.list_my_place_likes() to authenticated;
grant execute on function public.set_place_reaction(uuid, text, boolean) to authenticated;

commit;
