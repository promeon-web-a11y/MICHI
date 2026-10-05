-- Local development data only. Never run this file in production.
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '10000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'demo@mikke.local', '', now(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Mikke Demo"}', now(), now()
) on conflict (id) do nothing;

insert into public.places (
  id, provider, provider_place_id, name, category, address,
  latitude, longitude, opening_hours, price_band, maps_url, created_by
) values
  (
    '20000000-0000-0000-0000-000000000001', 'google', 'demo_sapporo_cafe',
    'Mikke Demo Cafe', 'cafe', '北海道札幌市中央区', 43.0618, 141.3545,
    '{"timezone":"Asia/Tokyo","weekly":{"monday":[["09:00","18:00"]],"tuesday":[["09:00","18:00"]],"wednesday":[["09:00","18:00"]],"thursday":[["09:00","18:00"]],"friday":[["09:00","18:00"]],"saturday":[["10:00","18:00"]],"sunday":[["10:00","18:00"]]}}',
    'under_3000', 'https://maps.google.com/?q=43.0618,141.3545',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '20000000-0000-0000-0000-000000000002', 'google', 'demo_sapporo_shop',
    'Mikke Demo Shop', 'shopping', '北海道札幌市中央区', 43.0580, 141.3507,
    '{"timezone":"Asia/Tokyo","weekly":{"monday":[["10:00","19:00"]],"tuesday":[["10:00","19:00"]],"wednesday":[["10:00","19:00"]],"thursday":[["10:00","19:00"]],"friday":[["10:00","19:00"]],"saturday":[["10:00","19:00"]],"sunday":[["10:00","19:00"]]}}',
    'under_5000', 'https://maps.google.com/?q=43.0580,141.3507',
    '10000000-0000-0000-0000-000000000001'
  )
on conflict (id) do nothing;

insert into public.saved_places (
  id, user_id, place_id, source_platform, source_url,
  extraction_confidence, confirmed_at
) values
  (
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'instagram', 'https://www.instagram.com/p/demo-cafe/', 0.940, now()
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    'instagram', 'https://www.instagram.com/p/demo-shop/', 0.910, now()
  )
on conflict (id) do nothing;
