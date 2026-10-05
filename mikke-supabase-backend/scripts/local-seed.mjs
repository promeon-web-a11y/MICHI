// scripts/local-api.mjs --seed のテストデータ（ローカル確認専用。本番・ステージングへは入れない）。
// 店名・コメントはすべて「テスト」と分かる名前にし、デザイン参考資料のサンプル（店舗名・写真・件数・コメント）は使わない。
// 写真はアプリに同梱している v3 の画像（../mikke-mobile/assets/images/v3）を、ローカルの Storage にアップロードした扱いにする。
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { root } from './local-db.mjs';

export const SEED_PASSWORD = 'local-pass-1';
export const SEED_USERS = [
  { key: 'a', email: 'local-a@mikke.test', name: 'テスト投稿者A' },
  { key: 'b', email: 'local-b@mikke.test', name: 'テスト閲覧者B' },
];

const PLACES = [
  ['p1', 'テスト喫茶 1', 'cafe', 'テスト市 1-1'],
  ['p2', 'テスト公園 2', 'sightseeing', 'テスト市 2-2'],
  ['p3', 'テスト書店 3', 'shopping', 'テスト市 3-3'],
  ['p4', 'テストパン店 4', 'bakery', 'テスト市 4-4'],
  ['p5', 'テスト展望台 5', 'sightseeing', 'テスト市 5-5'],
  ['p6', 'テスト食堂 6', 'lunch', 'テスト市 6-6'],
];

const NOTE = (n) =>
  `ローカル確認用のコメント${n}です。写真の下に2〜3文の投稿者コメントが入ったときの行間と折り返しを確かめます。実際の店舗やおすすめではありません。`;

export async function seed({ createUser, asRole, asAdmin, storageDir }) {
  const users = {};
  for (const u of SEED_USERS) users[u.key] = { ...(await createUser(u.email, SEED_PASSWORD, u.name)), ...u };
  const places = {};
  await asAdmin(async (tx) => {
    for (const [key, name, category, address] of PLACES) {
      const r = await tx.query(
        `insert into public.places (provider, provider_place_id, name, category, address) values ('local', $1, $2, $3, $4) returning id`,
        [`local-${key}`, name, category, address]
      );
      places[key] = r.rows[0].id;
    }
    for (const u of Object.values(users)) {
      await tx.query(`update public.users set home_area = 'テスト地区' where id = $1`, [u.id]);
      for (const id of Object.values(places)) {
        await tx.query(`insert into public.saved_places (user_id, place_id, source_url, source_platform) values ($1, $2, 'https://example.com/local-test', 'other')`, [u.id, id]);
      }
    }
    // 地図で見る の確認用（検索URL。実在の店舗を指さない）
    await tx.query(`update public.places set maps_url = 'https://www.google.com/maps/search/?api=1&query=Mikke%20local%20test' where id = $1`, [places.p1]);
    // B は保存場所を2件だけにする（行きたいの追加・削除を確認するため）
    await tx.query(`delete from public.saved_places where user_id = $1 and place_id <> all($2::uuid[])`, [users.b.id, `{${places.p1},${places.p6}}`]);
  });

  const photoDir = join(root, '..', 'mikke-mobile', 'assets', 'images', 'v3');
  const photos = existsSync(photoDir) ? readdirSync(photoDir).filter((f) => f.endsWith('.jpg')).sort() : [];

  const routes = [
    { user: 'a', title: 'テストルート：喫茶と公園', area: 'テスト地区', genre: 'カフェ', theme: 'ひとり', budget: 3000, stops: ['p1', 'p2', 'p3'], times: ['10:30', '12:00', '14:15'] },
    { user: 'a', title: 'テストルート：パンと展望台', area: 'テスト地区', genre: '観光', theme: '友だち', budget: 5000, stops: ['p4', 'p5', 'p6'], times: ['09:00', '11:00', '12:30'] },
    { user: 'b', title: 'テストルート：食堂から喫茶へ', area: 'テスト北地区', genre: 'グルメ', theme: 'デート', budget: 3000, stops: ['p6', 'p1'], times: ['12:00', '14:00'] },
  ];
  let photoIndex = 0;
  for (const [i, r] of routes.entries()) {
    const u = users[r.user];
    const claims = { sub: u.id, role: 'authenticated' };
    if (r.user === 'b') {
      await asAdmin((tx) => tx.query(`insert into public.saved_places (user_id, place_id, source_url) select $1, x, 'https://example.com/local-test' from unnest($2::uuid[]) x on conflict do nothing`, [u.id, `{${r.stops.map((s) => places[s]).join(',')}}`]));
    }
    const items = r.stops.map((s, n) => ({ place_id: places[s], sequence: n + 1, stay_minutes: 45, selection_reason: 'ローカル確認用' }));
    const postId = await asRole(claims, async (tx) => {
      const plan = await tx.query(`select (public.create_generated_plan($1::jsonb, $2::jsonb, $3, 240, $4)).id as id`, [
        JSON.stringify({ source: 'mobile_plan_options', option: { set_id: `local-${i}`, title: r.title } }),
        JSON.stringify(items),
        items.length,
        r.budget,
      ]);
      await tx.query(`select public.accept_plan($1)`, [plan.rows[0].id]);
      const post = await tx.query(`select (public.create_visit_record($1, $2::uuid[], 'ローカル確認用の非公開メモ')).id as id`, [
        plan.rows[0].id,
        `{${r.stops.map((s) => places[s]).join(',')}}`,
      ]);
      return post.rows[0].id;
    });
    const stops = r.stops.map((s, n) => {
      let photoPath = null;
      if (photos.length && n !== 1) {
        const file = photos[photoIndex++ % photos.length];
        photoPath = `${u.id}/${postId}/${file}`;
        mkdirSync(join(storageDir, 'route-photos', u.id, postId), { recursive: true });
        copyFileSync(join(photoDir, file), join(storageDir, 'route-photos', u.id, postId, file));
      }
      return { sequence: n + 1, visited_time: r.times[n], action: `テストの立ち寄り${n + 1}`, note: NOTE(n + 1), photo_path: photoPath };
    });
    await asAdmin(async (tx) => {
      for (const s of stops) {
        if (s.photo_path) await tx.query(`insert into storage.objects (bucket_id, name, owner, created_at) values ('route-photos', $1, $2, now())`, [s.photo_path, u.id]);
      }
    });
    await asRole(claims, (tx) =>
      tx.query(`select public.update_route_post($1, $2::jsonb, true)`, [
        postId,
        JSON.stringify({
          title: r.title,
          lead: 'ローカル確認用のテストルートです。実在の店舗・おすすめではありません。',
          area: r.area,
          genre: r.genre,
          theme: r.theme,
          budget_yen: r.budget,
          duration_minutes: 240,
          cover_photo_path: stops.find((s) => s.photo_path)?.photo_path ?? null,
          stops,
        }),
      ])
    );
  }
  console.log(`seed: ${SEED_USERS.map((u) => u.email).join(' / ')}  password: ${SEED_PASSWORD}`);
}
