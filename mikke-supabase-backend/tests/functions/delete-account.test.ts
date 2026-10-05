// Unit tests for supabase/functions/delete-account/logic.ts
// Run: npm run test:functions
//
// Supabase Auth はモック。getUserId は「JWT → その JWT の本人」を返す Auth の性質を再現する。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  bearerToken,
  CONFIRM_VALUE,
  deleteAccount,
  type DeleteDeps,
  httpStatusFor,
  PHOTO_LIST_PAGE,
  PHOTO_REMOVE_CHUNK,
  type PhotoStorage,
  removeUserRoutePhotos,
  validateDeleteRequest,
} from "../../supabase/functions/delete-account/logic.ts";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKENS: Record<string, string> = { "jwt-a": USER_A, "jwt-b": USER_B };

function fakeAuth(options: { deleteResult?: Awaited<ReturnType<DeleteDeps["deleteUser"]>>; throwOnDelete?: boolean } = {}) {
  const users = new Set([USER_A, USER_B]);
  const deleted: string[] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const deps: DeleteDeps = {
    getUserId: async (jwt) => {
      const id = TOKENS[jwt];
      return id && users.has(id) ? id : null;
    },
    deleteUser: async (id) => {
      if (options.throwOnDelete) throw new Error("network down");
      if (options.deleteResult) return options.deleteResult;
      if (!users.has(id)) return { ok: false, notFound: true, detail: "404 User not found" };
      users.delete(id);
      deleted.push(id);
      return { ok: true };
    },
    log: (event, detail) => logs.push({ event, detail }),
  };
  return { deps, deleted, logs, users };
}

const body = { confirm: CONFIRM_VALUE };

describe("delete-account", () => {
  it("本人の JWT で本人だけを削除する", async () => {
    const f = fakeAuth();
    const r = await deleteAccount({ authorization: "Bearer jwt-a", body }, f.deps);
    assert.equal(r.status, "deleted");
    assert.equal(httpStatusFor(r.status), 200);
    assert.deepEqual(f.deleted, [USER_A]);
    assert.ok(f.users.has(USER_B), "他のユーザーは残る");
  });

  it("未ログイン（Authorization なし・形式不正・無効な JWT）は削除しない", async () => {
    for (const authorization of [null, "", "jwt-a", "Basic abc", "Bearer unknown-jwt"]) {
      const f = fakeAuth();
      const r = await deleteAccount({ authorization, body }, f.deps);
      assert.equal(r.status, "unauthorized", String(authorization));
      assert.equal(httpStatusFor(r.status), 401);
      assert.equal(f.deleted.length, 0);
    }
  });

  it("他人の user_id を本文で指定できない（本文に余計な項目があれば拒否）", async () => {
    for (const b of [
      { confirm: CONFIRM_VALUE, user_id: USER_B },
      { confirm: CONFIRM_VALUE, userId: USER_B },
      { confirm: CONFIRM_VALUE, email: "b@example.com" },
      { user_id: USER_B },
    ]) {
      const f = fakeAuth();
      const r = await deleteAccount({ authorization: "Bearer jwt-a", body: b }, f.deps);
      assert.equal(r.status, "invalid_request");
      assert.equal(f.deleted.length, 0);
    }
  });

  it("確認用の固定値がなければ削除しない（誤呼び出し防止）", async () => {
    for (const b of [null, {}, [], "delete", { confirm: "yes" }, { confirm: true }]) {
      const f = fakeAuth();
      const r = await deleteAccount({ authorization: "Bearer jwt-a", body: b }, f.deps);
      assert.equal(r.status, "invalid_request");
      assert.equal(f.deleted.length, 0);
    }
  });

  it("2回目のリクエスト（削除済み）は削除済みとして扱う", async () => {
    const f = fakeAuth({ deleteResult: { ok: false, notFound: true, detail: "404" } });
    const r = await deleteAccount({ authorization: "Bearer jwt-a", body }, f.deps);
    assert.equal(r.status, "deleted");
  });

  it("削除後の同じ JWT は本人確認で弾かれる", async () => {
    const f = fakeAuth();
    await deleteAccount({ authorization: "Bearer jwt-a", body }, f.deps);
    const r = await deleteAccount({ authorization: "Bearer jwt-a", body }, f.deps);
    assert.equal(r.status, "unauthorized");
    assert.deepEqual(f.deleted, [USER_A]);
  });

  it("削除の失敗・例外は error（500）。ログに user id・JWT を出さない", async () => {
    for (const f of [fakeAuth({ deleteResult: { ok: false, notFound: false, detail: "500 Database error deleting user" } }), fakeAuth({ throwOnDelete: true })]) {
      const r = await deleteAccount({ authorization: "Bearer jwt-a", body }, f.deps);
      assert.equal(r.status, "error");
      assert.equal(httpStatusFor(r.status), 500);
      const logged = JSON.stringify(f.logs);
      assert.ok(!logged.includes(USER_A) && !logged.includes("jwt-a"));
    }
  });

  it("本人確認の例外は error", async () => {
    const f = fakeAuth();
    f.deps.getUserId = async () => {
      throw new Error("auth down");
    };
    const r = await deleteAccount({ authorization: "Bearer jwt-a", body }, f.deps);
    assert.equal(r.status, "error");
    assert.equal(f.deleted.length, 0);
  });

  it("bearerToken / validateDeleteRequest", () => {
    assert.equal(bearerToken("Bearer abc"), "abc");
    assert.equal(bearerToken("bearer  abc "), "abc");
    assert.equal(bearerToken("Bearer a b"), null);
    assert.deepEqual(validateDeleteRequest({ confirm: CONFIRM_VALUE }), { ok: true });
  });

  it("index.ts: hard delete を使い、本文の user_id を読まない", async () => {
    const src = await readFile("supabase/functions/delete-account/index.ts", "utf8");
    assert.match(src, /admin\.auth\.admin\.deleteUser\(userId, false\)/);
    assert.doesNotMatch(src, /body\.(user_id|userId)|\buser_id\b.*body/);
    const config = await readFile("supabase/config.toml", "utf8");
    assert.match(config, /\[functions\.delete-account\]\s*\nverify_jwt = true/);
  });
});

// Supabase Storage の list / remove を再現する（list は1回 limit 件まで。フォルダーは id: null で返る）
function fakeStorage(files: string[], options: { failRemoveTimes?: number; failListPrefix?: string } = {}) {
  const objects = new Set(files);
  const listCalls: { prefix: string; offset: number }[] = [];
  const removeSizes: number[] = [];
  let failRemove = options.failRemoveTimes ?? 0;
  const storage: PhotoStorage = {
    list: async (prefix, { limit, offset }) => {
      listCalls.push({ prefix, offset });
      if (options.failListPrefix === prefix) return { data: null, error: { message: "list failed" } };
      const entries = new Map<string, string | null>();
      for (const path of objects) {
        if (!path.startsWith(prefix + "/")) continue;
        const rest = path.slice(prefix.length + 1).split("/");
        entries.set(rest[0], rest.length > 1 ? null : "file-id");
      }
      const sorted = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b));
      return { data: sorted.slice(offset, offset + limit).map(([name, id]) => ({ name, id })), error: null };
    },
    remove: async (paths) => {
      removeSizes.push(paths.length);
      if (failRemove > 0) {
        failRemove--;
        return { error: { message: "remove failed" } };
      }
      for (const path of paths) objects.delete(path);
      return { error: null };
    },
  };
  return { storage, objects, listCalls, removeSizes };
}

function photosFor(user: string, posts: number, perPost: number) {
  const out: string[] = [];
  for (let p = 0; p < posts; p++) {
    for (let f = 0; f < perPost; f++) out.push(`${user}/post-${String(p).padStart(5, "0")}/photo-${f}.jpg`);
  }
  return out;
}

describe("delete-account: 投稿写真の削除", () => {
  it("投稿フォルダーが1000件を超えても、すべての写真を消す（他人の写真は残す）", async () => {
    const mine = photosFor(USER_A, 2500, 3);
    const others = photosFor(USER_B, 3, 2);
    const f = fakeStorage([...mine, ...others, `${USER_A}/stray.jpg`]);
    const logs: { event: string; detail: Record<string, unknown> }[] = [];
    const r = await removeUserRoutePhotos(f.storage, USER_A, (event, detail) => logs.push({ event, detail }));
    assert.equal(r.complete, true);
    assert.equal(r.removed, 2500 * 3 + 1);
    assert.deepEqual([...f.objects].sort(), others.sort(), "本人の写真だけが消え、他人の写真は残る");
    const topOffsets = f.listCalls.filter((c) => c.prefix === USER_A).map((c) => c.offset);
    assert.deepEqual(topOffsets, [0, PHOTO_LIST_PAGE, 2 * PHOTO_LIST_PAGE], "フォルダー一覧を最後までページングする");
    assert.ok(f.removeSizes.every((n) => n <= PHOTO_REMOVE_CHUNK), "削除は小分けにする");
    assert.ok(!JSON.stringify(logs).includes(USER_A), "ログに user_id を出さない");
  });

  it("1つの投稿フォルダーに1000件を超えるファイルがあっても消す", async () => {
    const f = fakeStorage(photosFor(USER_A, 1, 1500));
    const r = await removeUserRoutePhotos(f.storage, USER_A, () => {});
    assert.equal(r.removed, 1500);
    assert.equal(f.objects.size, 0);
  });

  it("削除の一時的な失敗は1回だけ再試行する", async () => {
    const f = fakeStorage(photosFor(USER_A, 2, 2), { failRemoveTimes: 1 });
    const r = await removeUserRoutePhotos(f.storage, USER_A, () => {});
    assert.equal(r.complete, true);
    assert.equal(f.objects.size, 0);
  });

  it("消し切れない・一覧が取れないときは complete: false で件数を記録する", async () => {
    const f = fakeStorage(photosFor(USER_A, 2, 2), { failRemoveTimes: 99 });
    const logs: string[] = [];
    const r = await removeUserRoutePhotos(f.storage, USER_A, (event) => logs.push(event));
    assert.deepEqual({ complete: r.complete, failed: r.failed }, { complete: false, failed: 4 });
    assert.ok(logs.includes("delete_account_photo_cleanup_incomplete"));

    const g = fakeStorage(photosFor(USER_A, 1, 1), { failListPrefix: USER_A });
    const r2 = await removeUserRoutePhotos(g.storage, USER_A, () => {});
    assert.equal(r2.complete, false);
    assert.equal(g.objects.size, 1);
  });

  it("写真が無いユーザーでも問題なく終わる", async () => {
    const f = fakeStorage([]);
    const r = await removeUserRoutePhotos(f.storage, USER_A, () => {});
    assert.deepEqual(r, { listed: 0, removed: 0, failed: 0, complete: true });
  });
});
