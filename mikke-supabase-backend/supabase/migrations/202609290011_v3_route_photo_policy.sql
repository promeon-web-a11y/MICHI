-- Mikke v3 追補: 投稿写真のアップロード権限の修正
--
-- 202609290009 で route_posts.user_id を authenticated から直接読めなくした（列単位の SELECT）ため、
-- 202609280008 の Storage ポリシー route_photos_insert_own（利用者の権限で route_posts.user_id を参照する）が
-- 常に「権限なし」になり、本人の投稿フォルダーへの写真アップロードが RLS で拒否されていた。
-- 本人の投稿かどうかは security definer の関数で確かめる（user_id は利用者に見せないまま）。
begin;

create or replace function public.owns_route_post_folder(p_post_folder text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.route_posts rp
    where rp.id::text = p_post_folder and rp.user_id = auth.uid()
  );
$$;
revoke all on function public.owns_route_post_folder(text) from PUBLIC, anon;
grant execute on function public.owns_route_post_folder(text) to authenticated;

drop policy if exists route_photos_insert_own on storage.objects;
create policy route_photos_insert_own on storage.objects
for insert to authenticated with check (
  bucket_id = 'route-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.owns_route_post_folder((storage.foldername(name))[2])
);

commit;
