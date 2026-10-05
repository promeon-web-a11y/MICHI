// PGlite（WASM の PostgreSQL）に Supabase の最小限の部品を用意し、supabase/migrations を適用する。
// scripts/db-test-local.mjs（DB テスト）と scripts/local-api.mjs（ローカル API）が共有する。本番には接続しない。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const migrationsDir = join(root, 'supabase', 'migrations');
export const testsDir = join(root, 'supabase', 'tests');

export const SUPABASE_STUB = String.raw`
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator noinherit login;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

-- Supabase は public に作られた表・関数・シーケンスへ anon / authenticated / service_role の全権限を既定で付ける
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
);

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
grant execute on all functions in schema storage to anon, authenticated, service_role;
`;

// pgTAP のうちテストが使う関数だけの互換実装。番号と失敗数はトランザクション内の設定値で数える
export const PGTAP_SHIM = String.raw`
create function extensions._tap(p_ok boolean, p_desc text, p_diag text default null) returns text
language plpgsql as $$
declare
  v_n integer := coalesce(nullif(current_setting('tap.n', true), ''), '0')::integer + 1;
  v_ok boolean := coalesce(p_ok, false);
begin
  perform set_config('tap.n', v_n::text, true);
  if not v_ok then
    perform set_config('tap.failed', (coalesce(nullif(current_setting('tap.failed', true), ''), '0')::integer + 1)::text, true);
  end if;
  return case when v_ok then 'ok ' else 'not ok ' end || v_n || ' - ' || coalesce(p_desc, '')
    || case when not v_ok and p_diag is not null then E'\n#   ' || p_diag else '' end;
end $$;

create function extensions.plan(p_count integer) returns text language plpgsql as $$
begin
  perform set_config('tap.planned', p_count::text, true);
  perform set_config('tap.n', '0', true);
  perform set_config('tap.failed', '0', true);
  return '1..' || p_count;
end $$;

create function extensions.finish() returns setof text language plpgsql as $$
declare
  v_planned integer := nullif(current_setting('tap.planned', true), '')::integer;
  v_n integer := coalesce(nullif(current_setting('tap.n', true), ''), '0')::integer;
begin
  if v_planned is not null and v_planned <> v_n then
    return next '# Looks like you planned ' || v_planned || ' tests but ran ' || v_n;
  end if;
end $$;

create function extensions.ok(p_ok boolean, p_desc text default null) returns text language sql as $$
  select extensions._tap(p_ok, p_desc)
$$;

create function extensions."is"(p_have anyelement, p_want anyelement, p_desc text default null) returns text
language sql as $$
  select extensions._tap(p_have is not distinct from p_want, p_desc,
    'have: ' || coalesce(p_have::text, 'NULL') || '  want: ' || coalesce(p_want::text, 'NULL'))
$$;

create function extensions.throws_ok(p_sql text, p_errcode char(5), p_errmsg text, p_desc text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return extensions._tap(false, p_desc, 'no exception was raised');
exception when others then
  if (p_errcode is null or sqlstate = p_errcode) and (p_errmsg is null or sqlerrm = p_errmsg) then
    return extensions._tap(true, p_desc);
  end if;
  return extensions._tap(false, p_desc,
    'caught: ' || sqlstate || ' ' || sqlerrm || '  wanted: ' || coalesce(p_errcode, '*') || ' ' || coalesce(p_errmsg, '*'));
end $$;

create function extensions.lives_ok(p_sql text, p_desc text default null) returns text language plpgsql as $$
begin
  execute p_sql;
  return extensions._tap(true, p_desc);
exception when others then
  return extensions._tap(false, p_desc, 'died: ' || sqlstate || ' ' || sqlerrm);
end $$;

create function extensions.has_table(p_schema name, p_table name, p_desc text default null) returns text
language sql as $$
  select extensions._tap(exists (
    select 1 from pg_catalog.pg_tables where schemaname = p_schema and tablename = p_table
  ), p_desc)
$$;

grant execute on all functions in schema extensions to anon, authenticated, service_role;
`;

export function listSql(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/** Supabase の部品 + すべての migration を適用した PGlite を返す */
export async function createLocalDb({ pgtap = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  if (pgtap) await db.exec(PGTAP_SHIM);
  for (const file of listSql(migrationsDir)) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (e) {
      throw new Error(`migration failed: ${file}
${e.message}`);
    }
  }
  return db;
}
