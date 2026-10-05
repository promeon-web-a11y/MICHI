// Docker なしで supabase/tests/*.sql を実行するローカル DB テスト。
//
// PGlite（WASM の PostgreSQL）に Supabase の最小限の部品（anon / authenticated / service_role ロール、
// public の既定権限、auth.users / auth.uid()、storage.buckets / storage.objects / storage.foldername()）を
// 用意してから supabase/migrations を順に適用し、pgTAP のうちテストで使う関数だけを互換実装で動かす。
//
// 本物の Supabase とは違う点（ステージングで実測が必要）:
// - PostgREST / Storage API / GoTrue は動かない。Data API の直接取得は「authenticated / anon ロールでの SELECT」で確認する
// - Postgres のバージョンは PGlite のもの（本番は 17 系）
//
// 使い方: npm run db:test:local [-- 003_route_posts.sql ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLocalDb, listSql, testsDir } from './local-db.mjs';

async function main() {
  const only = process.argv.slice(2);
  let db;
  try {
    db = await createLocalDb({ pgtap: true });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  let failedFiles = 0;
  let total = 0;
  for (const file of listSql(testsDir).filter((f) => only.length === 0 || only.includes(f))) {
    // pgtap 拡張は互換実装で置き換える
    const sql = readFileSync(join(testsDir, file), 'utf8')
      .replace(/create extension if not exists pgtap[^;]*;/gi, '');
    console.log(`# ${file}`);
    let lines = [];
    let error = null;
    try {
      const results = await db.exec(sql);
      for (const r of results) {
        for (const row of r.rows) {
          for (const v of Object.values(row)) {
            if (typeof v === 'string' && /^(ok|not ok|1\.\.|#)/.test(v)) lines.push(v);
          }
        }
      }
    } catch (e) {
      error = e;
      await db.exec('rollback').catch(() => {});
    }
    for (const l of lines) console.log(l);
    const planLine = lines.find((l) => l.startsWith('1..'));
    const planned = planLine ? Number(planLine.slice(3)) : null;
    const ran = lines.filter((l) => /^(ok|not ok) /.test(l)).length;
    const failed = lines.filter((l) => l.startsWith('not ok')).length;
    total += ran;
    if (error) console.log(`# ERROR after ${ran} tests: ${error.message}`);
    if (error || failed > 0 || (planned !== null && planned !== ran)) {
      failedFiles++;
      console.log(`# FAIL ${file}: ${failed} failed, ran ${ran}/${planned ?? '?'}`);
    } else {
      console.log(`# PASS ${file}: ${ran} tests`);
    }
  }
  await db.close();
  console.log(`# total ${total} tests, ${failedFiles} file(s) failed`);
  process.exit(failedFiles > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
