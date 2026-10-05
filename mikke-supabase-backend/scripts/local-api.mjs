// Docker なしでアプリを動かして確認するためのローカル API（本番・ステージングには一切接続しない）。
//
// PGlite に supabase/migrations を適用し、モバイルアプリが使う範囲だけを Supabase 互換で返す:
//   /auth/v1     signup・パスワードでのログイン・更新・ログアウト・user（メール確認なし。ローカル専用の JWT）
//   /rest/v1     PostgREST の一部（select の別名・JSON パス・埋め込み、eq/neq/gt/gte/lt/lte/in/is/like/ilike、
//                order・limit・offset、GET/PATCH/DELETE/POST、rpc）。利用者のロールと JWT の claims で実行するので RLS・列権限が効く
//   /storage/v1  アップロード・署名付きURL・取得・削除（storage.objects の RLS で許可を判定し、ファイルは .local-api/ に置く）
//   /functions/v1 Edge Functions は動かさない（OpenAI・Google への外部通信と費用を避ける）。503 を返す
//   /local-admin/sql 確認用に SQL を管理者として実行する（運営の moderation.* など）。このPCからの接続かつ
//                x-local-admin: 1 ヘッダーのときだけ。アプリからは呼ばない
//
// 起動: npm run local:api   （既定で 0.0.0.0:54321。Android エミュレーターからは http://10.0.2.2:54321）
// --seed を付けると、テスト用アカウントと公開ルートを入れる（名前・写真はすべてローカル確認用。本番へは入れない）
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';

import { createLocalDb, root } from './local-db.mjs';

const PORT = Number(process.env.LOCAL_API_PORT ?? 54321);
const HOST = process.env.LOCAL_API_HOST ?? '0.0.0.0';
const JWT_SECRET = 'mikke-local-api-only';
export const LOCAL_ANON_KEY = 'mikke-local-anon-key';
const STORAGE_DIR = join(root, '.local-api', 'storage');
const TOKEN_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------------------------
// JWT（HS256・ローカル専用）
// ---------------------------------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------------------------------------
// DB（1本の PGlite を直列に使う。リクエストごとに利用者のロール・claims を付けたトランザクション）
// ---------------------------------------------------------------------------------------------
const db = await createLocalDb();
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
function asRole(claims, fn) {
  return serial(() =>
    db.transaction(async (tx) => {
      await tx.query(`set local role ${claims ? 'authenticated' : 'anon'}`);
      await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
        claims ? JSON.stringify(claims) : '',
        claims?.sub ?? '',
      ]);
      return fn(tx);
    })
  );
}
const asAdmin = (fn) => serial(() => db.transaction(fn));

// 外部キー（埋め込み select 用）
const FKS = (
  await db.query(`
    select c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as ref,
      (select array_agg(a.attname order by k.i) from unnest(c.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
      (select array_agg(a.attname order by k.i) from unnest(c.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as refcols
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public'`)
).rows.map((r) => ({ ...r, tbl: r.tbl.replace(/^public\./, ''), ref: r.ref.replace(/^public\./, '') }));

// ---------------------------------------------------------------------------------------------
// HTTP の土台
// ---------------------------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, body) {
    super(body?.message ?? String(status));
    this.status = status;
    this.body = body;
  }
}
function send(res, status, body, headers = {}) {
  if (body === undefined || status === 204) {
    res.writeHead(status, headers);
    return res.end();
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(buf);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, { code: 'PGRST102', message: 'Invalid JSON' });
  }
}
function claimsFrom(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const payload = verifyJwt(m[1]);
  if (!payload && m[1] !== LOCAL_ANON_KEY) throw new HttpError(401, { code: 'PGRST301', message: 'JWT expired or invalid' });
  return payload?.sub ? payload : null;
}
function pgError(e, claims) {
  const code = e?.code ?? '';
  const status =
    code === '42501' ? (claims ? 403 : 401)
    : code === '28000' ? 401
    : code === '23505' || code === '23503' ? 409
    : code === '42883' || code === '42P01' ? 404
    : code.startsWith('22') || code.startsWith('23') || code.startsWith('P0') || code === '42703' ? 400
    : 500;
  return new HttpError(status, { code, message: e?.message ?? String(e), details: e?.detail ?? null, hint: e?.hint ?? null });
}

// ---------------------------------------------------------------------------------------------
// /auth/v1
// ---------------------------------------------------------------------------------------------
const refreshTokens = new Map();
const hashPassword = (email, password) => createHash('sha256').update(`${email}:${password}:local`).digest('hex');

async function sessionFor(user) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwt({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + TOKEN_TTL_SECONDS });
  const refreshToken = randomBytes(24).toString('base64url');
  refreshTokens.set(refreshToken, user.id);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: TOKEN_TTL_SECONDS,
    expires_at: now + TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' },
  };
}
export async function createUser(email, password, displayName) {
  const id = randomUUID();
  await asAdmin((tx) =>
    tx.query(
      `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, 'authenticated', 'authenticated', $2, $3, now(), '{}', $4, now(), now())`,
      [id, email, hashPassword(email, password), JSON.stringify(displayName ? { display_name: displayName } : {})]
    )
  );
  return { id, email };
}
async function findUser(where, value) {
  const r = await asAdmin((tx) => tx.query(`select id, email, encrypted_password from auth.users where ${where} = $1`, [value]));
  return r.rows[0] ?? null;
}

async function handleAuth(req, res, url) {
  const path = url.pathname.replace(/^\/auth\/v1\//, '');
  if (req.method === 'GET' && path === 'user') {
    const claims = claimsFrom(req);
    if (!claims) throw new HttpError(401, { code: 'no_authorization', msg: 'no user' });
    const user = await findUser('id', claims.sub);
    if (!user) throw new HttpError(404, { code: 'user_not_found', msg: 'User not found' });
    return send(res, 200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' });
  }
  if (req.method !== 'POST') throw new HttpError(405, { msg: 'method not allowed' });
  const body = await readJson(req);
  if (path === 'signup') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || password.length < 6) throw new HttpError(422, { code: 'weak_password', error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
    if (await findUser('email', email)) throw new HttpError(422, { code: 'user_already_exists', error_code: 'user_already_exists', msg: 'User already registered' });
    return send(res, 200, await sessionFor(await createUser(email, password)));
  }
  if (path === 'token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const user = await findUser('email', email);
      if (!user || user.encrypted_password !== hashPassword(email, String(body.password ?? ''))) {
        throw new HttpError(400, { error: 'invalid_grant', error_code: 'invalid_credentials', error_description: 'Invalid login credentials' });
      }
      return send(res, 200, await sessionFor(user));
    }
    if (grant === 'refresh_token') {
      const userId = refreshTokens.get(String(body.refresh_token ?? ''));
      const user = userId ? await findUser('id', userId) : null;
      if (!user) throw new HttpError(400, { error: 'invalid_grant', error_code: 'refresh_token_not_found', error_description: 'Invalid Refresh Token' });
      refreshTokens.delete(String(body.refresh_token));
      return send(res, 200, await sessionFor(user));
    }
  }
  if (path === 'logout') return send(res, 204);
  throw new HttpError(404, { msg: `auth endpoint not available locally: ${path}` });
}

// ---------------------------------------------------------------------------------------------
// /rest/v1（PostgREST の一部）
// ---------------------------------------------------------------------------------------------
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const ident = (s) => {
  if (!IDENT.test(s)) throw new HttpError(400, { code: 'PGRST100', message: `invalid identifier: ${s}` });
  return `"${s}"`;
};
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
/** col / col->a->>b → SQL 式と、PostgREST と同じ出力名 */
function pathExpr(alias, key) {
  const parts = key.split(/(->>|->)/);
  let sql = `${alias}.${ident(parts[0])}`;
  let name = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const k = parts[i + 1];
    if (!/^[\w-]+$/.test(k)) throw new HttpError(400, { code: 'PGRST100', message: `invalid json path: ${key}` });
    sql += ` ${parts[i]} ${/^\d+$/.test(k) ? k : `'${k}'`}`;
    name = k;
  }
  return { sql, name };
}
let aliasSeq = 0;
function selectList(table, alias, select) {
  const items = splitTop(select || '*');
  return items.map((item) => {
    const embed = /^(?:(\w+):)?(\w+)(?:!\w+)?\((.*)\)$/s.exec(item);
    if (embed) {
      const [, as, target, inner] = embed;
      const ea = `e${++aliasSeq}`;
      const cols = selectList(target, ea, inner).join(', ');
      const up = FKS.find((f) => f.tbl === table && f.ref === target);
      if (up) {
        const cond = up.cols.map((c, i) => `${ea}.${ident(up.refcols[i])} = ${alias}.${ident(c)}`).join(' and ');
        return `(select to_jsonb(x) from (select ${cols} from public.${ident(target)} ${ea} where ${cond} limit 1) x) as ${ident(as ?? target)}`;
      }
      const down = FKS.find((f) => f.tbl === target && f.ref === table);
      if (down) {
        const cond = down.cols.map((c, i) => `${ea}.${ident(c)} = ${alias}.${ident(down.refcols[i])}`).join(' and ');
        return `(select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${cols} from public.${ident(target)} ${ea} where ${cond}) x) as ${ident(as ?? target)}`;
      }
      throw new HttpError(400, { code: 'PGRST200', message: `no relationship between ${table} and ${target}` });
    }
    if (item === '*') return `${alias}.*`;
    const col = /^(?:(\w+):)?(.+?)(?:::\w+)?$/.exec(item);
    const { sql, name } = pathExpr(alias, col[2]);
    return `${sql} as ${ident(col[1] ?? name)}`;
  });
}
function pgArray(values) {
  return `{${values.map((v) => (v === null ? 'NULL' : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`;
}
function whereClause(url, alias, params) {
  const conds = [];
  for (const [key, raw] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(key)) continue;
    let value = raw;
    let not = false;
    if (value.startsWith('not.')) {
      not = true;
      value = value.slice(4);
    }
    const dot = value.indexOf('.');
    const op = value.slice(0, dot);
    const arg = value.slice(dot + 1);
    const { sql } = pathExpr(alias, key);
    let cond;
    const p = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    switch (op) {
      case 'eq': cond = `${sql} = ${p(arg)}`; break;
      case 'neq': cond = `${sql} <> ${p(arg)}`; break;
      case 'gt': cond = `${sql} > ${p(arg)}`; break;
      case 'gte': cond = `${sql} >= ${p(arg)}`; break;
      case 'lt': cond = `${sql} < ${p(arg)}`; break;
      case 'lte': cond = `${sql} <= ${p(arg)}`; break;
      case 'like': cond = `${sql} like ${p(arg.replace(/\*/g, '%'))}`; break;
      case 'ilike': cond = `${sql} ilike ${p(arg.replace(/\*/g, '%'))}`; break;
      case 'is': cond = `${sql} is ${{ null: 'null', true: 'true', false: 'false' }[arg] ?? 'null'}`; break;
      case 'in': {
        const list = arg.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        cond = `${sql} = any(${p(pgArray(list))})`;
        break;
      }
      default:
        throw new HttpError(400, { code: 'PGRST100', message: `unsupported operator: ${op}` });
    }
    conds.push(not ? `not (${cond})` : cond);
  }
  return conds.length ? `where ${conds.join(' and ')}` : '';
}
function orderClause(url, alias) {
  const order = url.searchParams.get('order');
  if (!order) return '';
  return `order by ${order
    .split(',')
    .map((part) => {
      const [key, ...mods] = part.split('.');
      const { sql } = pathExpr(alias, key);
      const dir = mods.includes('desc') ? 'desc' : 'asc';
      const nulls = mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : '';
      return `${sql} ${dir}${nulls}`;
    })
    .join(', ')}`;
}
function limitClause(url) {
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');
  return `${limit ? `limit ${Number(limit) | 0}` : ''} ${offset ? `offset ${Number(offset) | 0}` : ''}`;
}
function toParam(v, type) {
  if (v === null || v === undefined) return null;
  if (type?.endsWith('[]') && Array.isArray(v)) return pgArray(v);
  if (type === 'jsonb' || type === 'json' || typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function handleRpc(req, res, url, claims) {
  const name = url.pathname.replace(/^\/rest\/v1\/rpc\//, '');
  ident(name);
  const args = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
  const keys = Object.keys(args);
  const candidates = await asAdmin((tx) =>
    tx.query(
      `select p.proargnames as names, p.pronargs as nargs, p.pronargdefaults as ndefaults, p.proretset as retset, t.typtype, t.typname,
         array(select format_type(x, null) from unnest(p.proargtypes::oid[]) x) as types
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
       where n.nspname = 'public' and p.proname = $1`,
      [name]
    )
  );
  const fn = candidates.rows.find((f) => {
    const names = (f.names ?? []).slice(0, f.nargs);
    const required = names.slice(0, f.nargs - f.ndefaults);
    return keys.every((k) => names.includes(k)) && required.every((k) => keys.includes(k));
  });
  if (!fn) throw new HttpError(404, { code: 'PGRST202', message: `Could not find the function public.${name}(${keys.join(', ')})` });
  const params = [];
  const call = `public.${ident(name)}(${keys
    .map((k) => {
      const type = fn.types[fn.names.indexOf(k)];
      params.push(toParam(args[k], type));
      return `${ident(k)} => $${params.length}::${type}`;
    })
    .join(', ')})`;
  const sql = fn.retset
    ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from ${call} r`
    : fn.typtype === 'c'
      ? `select to_jsonb(r) as v from ${call} r`
      : fn.typname === 'void'
        ? `select ${call}, null::jsonb as v`
        : `select to_jsonb(${call}) as v`;
  try {
    const r = await asRole(claims, (tx) => tx.query(sql, params));
    const v = r.rows[0]?.v ?? null;
    return send(res, 200, JSON.stringify(v));
  } catch (e) {
    throw pgError(e, claims);
  }
}

async function handleTable(req, res, url, claims) {
  const table = url.pathname.replace(/^\/rest\/v1\//, '');
  ident(table);
  const alias = 't';
  const params = [];
  const prefer = String(req.headers.prefer ?? '');
  const wantRows = prefer.includes('return=representation');
  const select = url.searchParams.get('select') ?? '*';
  let sql;
  let status = 200;
  if (req.method === 'GET') {
    const where = whereClause(url, alias, params);
    sql = `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from (select ${selectList(table, alias, select).join(', ')} from public.${ident(table)} ${alias} ${where} ${orderClause(url, alias)} ${limitClause(url)}) r`;
  } else if (req.method === 'PATCH' || req.method === 'POST') {
    const body = await readJson(req);
    const rows = Array.isArray(body) ? body : [body];
    let mutation;
    if (req.method === 'PATCH') {
      const sets = Object.entries(rows[0]).map(([k, v]) => {
        params.push(toParam(v));
        return `${ident(k)} = $${params.length}`;
      });
      const where = whereClause(url, alias, params);
      mutation = `update public.${ident(table)} ${alias} set ${sets.join(', ')} ${where} returning ${alias}.*`;
    } else {
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const values = rows.map(
        (r) =>
          `(${cols
            .map((c) => {
              params.push(toParam(r[c]));
              return `$${params.length}`;
            })
            .join(', ')})`
      );
      mutation = `insert into public.${ident(table)} (${cols.map(ident).join(', ')}) values ${values.join(', ')} returning *`;
      status = 201;
    }
    sql = wantRows
      ? `with m as (${mutation}) select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from (select ${selectList(table, alias, select).join(', ')} from m ${alias}) r`
      : `with m as (${mutation}) select null::jsonb as v`;
  } else if (req.method === 'DELETE') {
    const where = whereClause(url, alias, params);
    sql = `with m as (delete from public.${ident(table)} ${alias} ${where} returning 1) select null::jsonb as v`;
  } else throw new HttpError(405, { message: 'method not allowed' });
  try {
    const r = await asRole(claims, (tx) => tx.query(sql, params));
    const v = r.rows[0]?.v ?? null;
    if (req.method === 'GET' || wantRows) return send(res, status, JSON.stringify(v ?? []));
    return send(res, status === 201 ? 201 : 204);
  } catch (e) {
    throw pgError(e, claims);
  }
}

// ---------------------------------------------------------------------------------------------
// /storage/v1
// ---------------------------------------------------------------------------------------------
const fileOf = (bucket, name) => join(STORAGE_DIR, bucket, ...name.split('/'));
const signFor = (bucket, name, exp) => createHmac('sha256', JWT_SECRET).update(`${bucket}/${name}:${exp}`).digest('base64url');

async function handleStorage(req, res, url, claims) {
  const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\//, ''));
  // 署名付きURLの取得（認証ヘッダー不要）
  let m = /^object\/sign\/([^/]+)\/(.+)$/.exec(path);
  if (req.method === 'GET' && m) {
    const [, bucket, name] = m;
    const token = url.searchParams.get('token') ?? '';
    const [exp, sig] = token.split('.');
    if (!sig || Number(exp) * 1000 < Date.now() || sig !== signFor(bucket, name, exp)) throw new HttpError(400, { statusCode: '400', error: 'InvalidSignature', message: 'invalid signature' });
    const file = fileOf(bucket, name);
    if (!existsSync(file)) throw new HttpError(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
    return res.end(readFileSync(file));
  }
  if (!claims) throw new HttpError(400, { statusCode: '403', error: 'Unauthorized', message: 'Invalid JWT' });
  m = /^object\/sign\/([^/]+)$/.exec(path);
  if (req.method === 'POST' && m) {
    const bucket = m[1];
    const body = await readJson(req);
    const expiresIn = Math.min(Number(body.expiresIn) || 3600, 7 * 24 * 3600);
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    const visible = await asRole(claims, (tx) =>
      tx.query(`select name from storage.objects where bucket_id = $1 and name = any($2::text[])`, [bucket, pgArray(paths)])
    );
    const ok = new Set(visible.rows.map((r) => r.name));
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    return send(
      res,
      200,
      paths.map((p) =>
        ok.has(p)
          ? { path: p, signedURL: `/object/sign/${bucket}/${p.split('/').map(encodeURIComponent).join('/')}?token=${exp}.${signFor(bucket, p, exp)}`, error: null }
          : { path: p, signedURL: null, error: 'Either the object does not exist or you do not have access to it' }
      )
    );
  }
  m = /^object\/([^/]+)\/(.+)$/.exec(path);
  if (req.method === 'POST' && m) {
    const [, bucket, name] = m;
    const bytes = await readBody(req);
    const type = String(req.headers['content-type'] ?? 'application/octet-stream');
    // バケットの設定は Storage API と同じく管理側で読む（storage.buckets は利用者には RLS で見えない）
    const limits = (await asAdmin((tx) => tx.query(`select file_size_limit, allowed_mime_types from storage.buckets where id = $1`, [bucket]))).rows[0];
    if (!limits) throw new HttpError(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    if (limits.file_size_limit && bytes.length > Number(limits.file_size_limit)) throw new HttpError(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
    if (limits.allowed_mime_types && !limits.allowed_mime_types.includes(type)) throw new HttpError(415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
    try {
      await asRole(claims, async (tx) => {
        await tx.query(`insert into storage.objects (bucket_id, name, owner, metadata) values ($1, $2, $3, $4)`, [bucket, name, claims.sub, JSON.stringify({ mimetype: type, size: bytes.length })]);
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const err = pgError(e, claims);
      throw new HttpError(err.status === 409 ? 409 : 403, { statusCode: String(err.status), error: 'Unauthorized', message: 'new row violates row-level security policy' });
    }
    mkdirSync(dirname(fileOf(bucket, name)), { recursive: true });
    writeFileSync(fileOf(bucket, name), bytes);
    return send(res, 200, { Key: `${bucket}/${name}` });
  }
  m = /^object\/([^/]+)$/.exec(path);
  if (req.method === 'DELETE' && m) {
    const bucket = m[1];
    const body = await readJson(req);
    const prefixes = Array.isArray(body.prefixes) ? body.prefixes.map(String) : [];
    const r = await asRole(claims, (tx) =>
      tx.query(`delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name`, [bucket, pgArray(prefixes)])
    );
    for (const row of r.rows) rmSync(fileOf(bucket, row.name), { force: true });
    return send(res, 200, r.rows.map((row) => ({ name: row.name, bucket_id: bucket })));
  }
  throw new HttpError(404, { statusCode: '404', error: 'not_found', message: `storage endpoint not available locally: ${path}` });
}

// ---------------------------------------------------------------------------------------------
// サーバー
// ---------------------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();
  let claims = null;
  try {
    if (url.pathname === '/' || url.pathname === '/health') return send(res, 200, { ok: true, local: true });
    if (url.pathname === '/local-admin/sql' && req.method === 'POST') {
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
      if (!loopback || req.headers['x-local-admin'] !== '1') throw new HttpError(403, { message: 'local admin only' });
      const { sql, params } = await readJson(req);
      try {
        const r = await asAdmin((tx) => tx.query(String(sql), Array.isArray(params) ? params : []));
        return send(res, 200, { rows: r.rows });
      } catch (e) {
        throw pgError(e, null);
      }
    }
    if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url);
    claims = claimsFrom(req);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return await handleRpc(req, res, url, claims);
    if (url.pathname.startsWith('/rest/v1/')) return await handleTable(req, res, url, claims);
    if (url.pathname.startsWith('/storage/v1/')) return await handleStorage(req, res, url, claims);
    if (url.pathname.startsWith('/functions/v1/')) {
      return send(res, 503, { status: 'error', code: 'local_unavailable', message: 'Edge Functions はローカル API では動かしません（外部 API の費用・鍵を使わないため）' });
    }
    throw new HttpError(404, { message: 'not found' });
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, { message: String(e?.message ?? e) });
    send(res, err.status, err.body);
  } finally {
    if (process.env.LOCAL_API_LOG !== '0') {
      console.log(`${req.method} ${url.pathname}${url.pathname.startsWith('/rest/v1/rpc') ? '' : url.search.slice(0, 80)} → ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

if (process.argv.includes('--seed')) {
  const { seed } = await import('./local-seed.mjs');
  await seed({ createUser, asRole, asAdmin, storageDir: STORAGE_DIR, sessionFor });
}

server.listen(PORT, HOST, () => {
  console.log(`Mikke local API: http://localhost:${PORT}  (Android エミュレーター: http://10.0.2.2:${PORT})`);
  console.log(`anon key: ${LOCAL_ANON_KEY}   本番・ステージングには接続しません`);
});

