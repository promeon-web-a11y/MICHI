-- Step 3-4（save-place）本番確認用SQL。すべて読み取り専用（SELECT のみ）。
-- Supabase Dashboard > SQL Editor で実行する。データの変更・削除は行わない。

-- 1. 一意制約が本番DBに存在するか（2件返れば OK）
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'u'
  and conrelid in ('public.places'::regclass, 'public.saved_places'::regclass)
order by 1;
-- 期待: places UNIQUE (provider, provider_place_id) / saved_places UNIQUE (user_id, place_id)

-- 2. RLS が有効で、saved_places のポリシーが本人限定か
select relname, relrowsecurity from pg_class
where oid in ('public.places'::regclass, 'public.saved_places'::regclass);
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('places', 'saved_places')
order by tablename, policyname;
-- 期待: saved_places_all_own (ALL, user_id = auth.uid()) / places_read_authenticated / places_insert_own / places_update_own

-- 3. save_place RPC の定義が migration と同じか（security definer / auth.uid()）
select proname, prosecdef as security_definer
from pg_proc where proname = 'save_place' and pronamespace = 'public'::regnamespace;

-- 4. 重複が無いこと（どちらも 0 行なら OK）
select provider, provider_place_id, count(*) from public.places
group by 1, 2 having count(*) > 1;
select user_id, place_id, count(*) from public.saved_places
group by 1, 2 having count(*) > 1;

-- 5. アプリで保存したPlaceの確認（直近10件。自分のメールアドレスに置き換える）
select sp.saved_at, sp.updated_at, sp.source_platform, sp.source_url, sp.extraction_confidence,
       p.provider_place_id, p.name, p.address, p.latitude, p.longitude, p.category
from public.saved_places sp
join public.places p on p.id = sp.place_id
join public.users u on u.id = sp.user_id
where u.email = 'YOUR_EMAIL@example.com'
order by sp.saved_at desc
limit 10;

-- 6. place_saved イベントが保存1件につき1件だけ記録されているか（既存のDBトリガー）
select e.occurred_at, e.properties
from public.events e
join public.users u on u.id = e.user_id
where e.name = 'place_saved' and u.email = 'YOUR_EMAIL@example.com'
order by e.occurred_at desc
limit 10;
