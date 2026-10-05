// Unit tests for supabase/functions/save-place/logic.ts
// Run: npm run test:functions   (Node >= 23.6 strips TypeScript types natively)
//
// 実DBは使わない。FakeDb は本番スキーマの以下の性質を再現したモック:
//   - places: unique (provider, provider_place_id) / save_place は ON CONFLICT DO NOTHING → 既存行を再利用
//   - saved_places: unique (user_id, place_id) / save_place は ON CONFLICT DO UPDATE（saved_at は据え置き、
//     updated_at は touch_updated_at トリガーで更新）
//   - RLS: saved_places は auth.uid() の行だけ見える / save_place は auth.uid() が null なら 28000
// DB レベルの一意性そのものは本番の制約が担保する（ここではその前提でのステータス判定を検証する）。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRpcArgs,
  captionFromText,
  classifyDbError,
  DbError,
  googleMapsUrl,
  httpStatusFor,
  mapCategory,
  mapSourcePlatform,
  type PlaceRow,
  type SaveDeps,
  savePlace,
  type SavedPlaceRow,
  type SaveRequest,
  validateSaveRequest,
  wasInserted,
} from "../../supabase/functions/save-place/logic.ts";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";

class FakeDb {
  places: PlaceRow[] = [];
  saved: (SavedPlaceRow & { source_caption: string | null })[] = [];
  rpcCalls: { user: string | null; args: { p_place: Record<string, unknown>; p_source: Record<string, unknown> } }[] = [];
  private clock = Date.parse("2026-09-26T00:00:00.000Z");
  private seq = 0;
  /** 次の DB 呼び出しを失敗させる */
  failNext: { op: string; error: DbError } | null = null;
  /** 事前確認の後で止める（同時実行の再現用） */
  gate: Promise<void> | null = null;

  private txTime() {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }
  private maybeFail(op: string) {
    if (this.failNext && this.failNext.op === op) {
      const e = this.failNext.error;
      this.failNext = null;
      throw e;
    }
  }

  /** そのユーザーの JWT で作った Supabase クライアント相当 */
  depsFor(user: string | null): SaveDeps {
    return {
      findPlace: async (gid) => {
        this.maybeFail("findPlace");
        const row = this.places.find((p) => p.provider === "google" && p.provider_place_id === gid) ?? null;
        if (this.gate) await this.gate;
        return row;
      },
      findSaved: async (placeId) => {
        this.maybeFail("findSaved");
        // RLS: 本人の行だけ見える
        return this.saved.find((s) => s.user_id === user && s.place_id === placeId) ?? null;
      },
      savePlaceRpc: async (args) => {
        this.maybeFail("rpc");
        this.rpcCalls.push({ user, args });
        if (!user) throw new DbError("authentication_required", "28000");
        const p = args.p_place;
        if (!p.provider_place_id) throw new DbError("provider_place_id_required", "22023");
        const now = this.txTime();
        // places: ON CONFLICT (provider, provider_place_id) DO NOTHING
        let place = this.places.find((x) => x.provider === p.provider && x.provider_place_id === p.provider_place_id);
        if (!place) {
          place = {
            id: `place-${++this.seq}`,
            provider: String(p.provider),
            provider_place_id: String(p.provider_place_id),
            name: String(p.name),
            category: String(p.category),
            address: String(p.address),
            latitude: p.latitude === null ? null : String(p.latitude), // numeric は文字列で返ることがある
            longitude: p.longitude === null ? null : String(p.longitude),
          };
          this.places.push(place);
        }
        // saved_places: ON CONFLICT (user_id, place_id) DO UPDATE
        const existing = this.saved.find((s) => s.user_id === user && s.place_id === place!.id);
        if (existing) {
          existing.source_url = String(args.p_source.source_url);
          existing.updated_at = now; // touch_updated_at
          return { ...existing };
        }
        const row = {
          id: `saved-${++this.seq}`,
          user_id: user,
          place_id: place.id,
          source_platform: String(args.p_source.source_platform),
          source_url: String(args.p_source.source_url),
          source_caption: (args.p_source.source_caption as string | null) ?? null,
          extraction_confidence: (args.p_source.extraction_confidence as number | null) ?? null,
          saved_at: now,
          updated_at: now,
        };
        this.saved.push(row);
        return { ...row };
      },
      loadPlace: async (placeId) => {
        this.maybeFail("loadPlace");
        return this.places.find((p) => p.id === placeId) ?? null;
      },
      now: () => new Date("2026-09-26T09:00:00.000Z"),
    };
  }
}

const body = (overrides: Record<string, unknown> = {}) => ({
  place: {
    google_place_id: PLACE_ID,
    name: "スターバックス コーヒー 札幌グランドホテル店",
    formatted_address: "日本、〒060-0001 北海道札幌市中央区北１条西４丁目２−２",
    latitude: 43.0628,
    longitude: 141.3527,
    primary_type: "coffee_shop",
    types: ["coffee_shop", "cafe", "food"],
    business_status: "OPERATIONAL",
  },
  share: {
    source: "instagram",
    url: "https://www.instagram.com/p/abc/",
    text: "札幌のスターバックス コーヒー 札幌グランドホテル店でコーヒー https://www.instagram.com/p/abc/?igsh=secret",
  },
  identification: { status: "confirmed", confidence: 0.98, selected_by_user: false },
  ...overrides,
});

function req(overrides: Record<string, unknown> = {}): SaveRequest {
  const r = validateSaveRequest(body(overrides));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

// ---------------------------------------------------------------------------------------------
describe("validateSaveRequest", () => {
  it("正常な confirmed リクエスト", () => {
    const r = req();
    assert.equal(r.place.google_place_id, PLACE_ID);
    assert.equal(r.share.source, "instagram");
    assert.equal(r.identification.confidence, 0.98);
    assert.deepEqual(r.warnings, []);
  });

  it("10. Google Place ID なし・不正は拒否", () => {
    for (const id of [undefined, "", "  ", 123, "short", "has space in id!!", "x".repeat(301)]) {
      const r = validateSaveRequest(body({ place: { ...body().place, google_place_id: id } }));
      assert.equal(r.ok, false, String(id));
    }
    assert.deepEqual(validateSaveRequest(body({ place: undefined })), { ok: false, code: "place_required" });
  });

  it("Place 名なし・座標不正は拒否", () => {
    assert.deepEqual(validateSaveRequest(body({ place: { ...body().place, name: " " } })), { ok: false, code: "place_name_required" });
    assert.deepEqual(validateSaveRequest(body({ place: { ...body().place, latitude: 91 } })), { ok: false, code: "location_invalid" });
    assert.deepEqual(validateSaveRequest(body({ place: { ...body().place, longitude: null } })), { ok: false, code: "location_invalid" });
    assert.deepEqual(validateSaveRequest(body({ place: { ...body().place, latitude: "43" } })), { ok: false, code: "location_invalid" });
  });

  it("5. needs_review はユーザー選択なしでは保存不可", () => {
    assert.deepEqual(
      validateSaveRequest(body({ identification: { status: "needs_review", confidence: 0.5 } })),
      { ok: false, code: "user_selection_required" },
    );
    assert.equal(validateSaveRequest(body({ identification: { status: "needs_review", confidence: 0.5, selected_by_user: true } })).ok, true);
  });

  it("11. not_found / insufficient_information / error / 不明は保存不可", () => {
    for (const status of ["not_found", "insufficient_information", "error", "saved", undefined]) {
      assert.deepEqual(validateSaveRequest(body({ identification: { status, selected_by_user: true } })), { ok: false, code: "not_saveable_status" });
    }
  });

  it("9. user_id を送っても読まない（warnings に記録するだけ）", () => {
    const r = validateSaveRequest({ ...body(), user_id: USER_B, place: { ...body().place, user_id: USER_B } });
    assert.ok(r.ok);
    assert.ok(r.ok && r.value.warnings.includes("client_user_id_ignored"));
    assert.ok(r.ok && !JSON.stringify(r.value.place).includes(USER_B));
  });

  it("不正な共有URLは無視・source 不明は unknown・confidence は 0〜1 に丸め", () => {
    const r = req({ share: { source: "facebook", url: "javascript:alert(1)", text: null }, identification: { status: "confirmed", confidence: 1.7 } });
    assert.equal(r.share.source, "unknown");
    assert.equal(r.share.url, null);
    assert.ok(r.warnings.includes("share_url_invalid_ignored"));
    assert.equal(r.identification.confidence, 1);
  });

  it("オブジェクト以外は拒否", () => {
    for (const b of [null, "x", 1, []]) assert.deepEqual(validateSaveRequest(b), { ok: false, code: "invalid_body" });
  });
});

describe("既存テーブルへのマッピング", () => {
  it("mapCategory: primary_type 優先・resolve-place と同じ規則", () => {
    assert.equal(mapCategory("coffee_shop", ["coffee_shop", "food"]), "cafe");
    assert.equal(mapCategory("ramen_restaurant", ["ramen_restaurant", "restaurant"]), "dinner");
    assert.equal(mapCategory(null, ["bakery", "cafe"]), "bakery");
    assert.equal(mapCategory("dessert_shop", []), "sweets");
    assert.equal(mapCategory("lodging", ["lodging"]), "other");
  });

  it("mapSourcePlatform: 既存 enum に無い youtube / unknown は other", () => {
    assert.equal(mapSourcePlatform("instagram"), "instagram");
    assert.equal(mapSourcePlatform("tiktok"), "tiktok");
    assert.equal(mapSourcePlatform("web"), "web");
    assert.equal(mapSourcePlatform("youtube"), "other");
    assert.equal(mapSourcePlatform("unknown"), "other");
  });

  it("buildRpcArgs: 既存カラムだけ・キャプションから URL を除く", () => {
    const { p_place, p_source, warnings } = buildRpcArgs(req(), new Date("2026-09-26T09:00:00.000Z"));
    assert.deepEqual(Object.keys(p_place).sort(), ["address", "category", "data_checked_at", "latitude", "longitude", "name", "provider", "provider_place_id"]);
    assert.equal(p_place.provider, "google");
    assert.equal(p_place.provider_place_id, PLACE_ID);
    assert.equal(p_source.source_url, "https://www.instagram.com/p/abc/");
    assert.equal(p_source.source_caption, "札幌のスターバックス コーヒー 札幌グランドホテル店でコーヒー");
    assert.ok(!String(p_source.source_caption).includes("igsh"));
    assert.deepEqual(warnings, []);
    assert.ok(!("user_id" in p_place) && !("user_id" in p_source));
  });

  it("テキストのみの共有は source_url を Google Maps URL で補う", () => {
    const { p_source, warnings } = buildRpcArgs(req({ share: { source: "unknown", url: null, text: "森彦" } }), new Date());
    assert.equal(p_source.source_url, googleMapsUrl("スターバックス コーヒー 札幌グランドホテル店", PLACE_ID));
    assert.match(String(p_source.source_url), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=.+&query_place_id=ChIJ/);
    assert.equal(p_source.source_platform, "other");
    assert.deepEqual(warnings, ["source_url_fallback_google_maps"]);
  });

  it("captionFromText", () => {
    assert.equal(captionFromText(null), null);
    assert.equal(captionFromText("https://a.com/x"), null);
    assert.equal(captionFromText("あ".repeat(3000))?.length, 2000);
  });
});

describe("wasInserted / classifyDbError / httpStatusFor", () => {
  it("INSERT は saved_at == updated_at、ON CONFLICT UPDATE は異なる", () => {
    const base = { id: "s", user_id: USER_A, place_id: "p", source_platform: "instagram", source_url: "u", extraction_confidence: null };
    assert.equal(wasInserted({ ...base, saved_at: "2026-09-26T00:00:00.123456+00:00", updated_at: "2026-09-26T00:00:00.123456+00:00" }), true);
    assert.equal(wasInserted({ ...base, saved_at: "2026-09-26T00:00:00.1+00:00", updated_at: "2026-09-26T00:00:05.2+00:00" }), false);
  });

  it("DB エラーの分類", () => {
    assert.deepEqual(classifyDbError(new DbError("authentication_required", "28000")), { status: "unauthorized", reason: "authentication_required" });
    assert.deepEqual(classifyDbError(new DbError("JWT expired", "PGRST301")), { status: "unauthorized", reason: "authentication_required" });
    assert.deepEqual(classifyDbError(new DbError("provider_place_id_required", "22023")), { status: "invalid_request", reason: "db_rejected_input" });
    assert.deepEqual(classifyDbError(new DbError("fk", "23503")), { status: "error", reason: "user_profile_missing" });
    assert.deepEqual(classifyDbError(new DbError("connection reset", "08006")), { status: "error", reason: "db_error" });
    assert.deepEqual(classifyDbError(new Error("fetch failed")), { status: "error", reason: "db_error" });
  });

  it("HTTP ステータス", () => {
    assert.equal(httpStatusFor("saved"), 200);
    assert.equal(httpStatusFor("already_saved"), 200);
    assert.equal(httpStatusFor("unauthorized"), 401);
    assert.equal(httpStatusFor("invalid_request"), 400);
    assert.equal(httpStatusFor("error"), 500);
  });
});

// ---------------------------------------------------------------------------------------------
// 要件のテストケース
// ---------------------------------------------------------------------------------------------
describe("savePlace: 要件ケース（FakeDb）", () => {
  it("1. confirmed Place の新規保存 → saved（places / saved_places を1件ずつ作成）", async () => {
    const db = new FakeDb();
    const r = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(r.status, "saved");
    assert.equal(r.message, "保存しました");
    assert.equal(r.place_reused, false);
    assert.equal(r.place?.google_place_id, PLACE_ID);
    assert.equal(r.place?.latitude, 43.0628); // numeric 文字列 → number
    assert.equal(r.place?.category, "cafe");
    assert.equal(db.places.length, 1);
    assert.equal(db.saved.length, 1);
    assert.equal(db.saved[0].user_id, USER_A);
    assert.equal(db.saved[0].source_platform, "instagram");
    assert.equal(db.saved[0].extraction_confidence, 0.98);
  });

  it("2. 既存 places の再利用（別ユーザーが先に保存済み）", async () => {
    const db = new FakeDb();
    await savePlace(req(), db.depsFor(USER_B));
    const r = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(r.status, "saved");
    assert.equal(r.place_reused, true);
    assert.equal(db.places.length, 1, "places は増えない");
    assert.equal(db.saved.length, 2, "ユーザーごとに1件");
    assert.equal(r.place?.place_id, db.places[0].id);
  });

  it("3・4. 同じ Place を2回保存 → already_saved、重複なし、既存の保存内容を上書きしない", async () => {
    const db = new FakeDb();
    const first = await savePlace(req(), db.depsFor(USER_A));
    const second = await savePlace(
      req({ share: { source: "tiktok", url: "https://www.tiktok.com/@x/video/1", text: "また行きたい" } }),
      db.depsFor(USER_A),
    );
    assert.equal(first.status, "saved");
    assert.equal(second.status, "already_saved");
    assert.equal(second.message, "すでに保存されています");
    assert.equal(second.saved_place?.id, first.saved_place?.id);
    assert.equal(db.places.length, 1);
    assert.equal(db.saved.length, 1);
    assert.equal(db.rpcCalls.length, 1, "保存済みなら RPC を呼ばない");
    assert.equal(db.saved[0].source_url, "https://www.instagram.com/p/abc/", "初回の共有元が残る");
  });

  it("6. needs_review 候補をユーザーが選択 → saved", async () => {
    const db = new FakeDb();
    const r = await savePlace(
      req({
        place: { ...body().place, google_place_id: "ChIJ_selected_candidate_2", name: "スターバックス コーヒー 札幌駅前店" },
        identification: { status: "needs_review", confidence: 0.62, selected_by_user: true },
      }),
      db.depsFor(USER_A),
    );
    assert.equal(r.status, "saved");
    assert.equal(db.places[0].provider_place_id, "ChIJ_selected_candidate_2");
    assert.equal(db.saved[0].extraction_confidence, 0.62);
  });

  it("7. 未ログイン（auth.uid() が null）→ unauthorized、何も作らない", async () => {
    const db = new FakeDb();
    const r = await savePlace(req(), db.depsFor(null));
    assert.equal(r.status, "unauthorized");
    assert.equal(r.message, "ログインが必要です");
    assert.equal(db.places.length, 0);
    assert.equal(db.saved.length, 0);
  });

  it("8. 不正/期限切れ JWT で PostgREST が拒否 → unauthorized", async () => {
    const db = new FakeDb();
    db.failNext = { op: "findPlace", error: new DbError("JWT expired", "PGRST301") };
    const r = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(r.status, "unauthorized");
    assert.equal(db.rpcCalls.length, 0);
  });

  it("9. 他ユーザーの user_id を送っても本人（JWT のユーザー）として保存", async () => {
    const db = new FakeDb();
    const v = validateSaveRequest({ ...body(), user_id: USER_B });
    assert.ok(v.ok);
    if (!v.ok) return;
    const r = await savePlace(v.value, db.depsFor(USER_A));
    assert.equal(r.status, "saved");
    assert.equal(db.saved[0].user_id, USER_A);
    assert.ok(!db.saved.some((s) => s.user_id === USER_B));
    assert.ok(r.warnings.includes("client_user_id_ignored"));
    assert.ok(!JSON.stringify(db.rpcCalls).includes(USER_B), "RPC 引数に user_id を渡さない");
  });

  it("9b. 他ユーザーの保存済みは見えない（RLS）→ 自分用に新規保存", async () => {
    const db = new FakeDb();
    await savePlace(req(), db.depsFor(USER_B));
    const r = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(r.status, "saved");
    assert.notEqual(r.saved_place?.id, db.saved[0].id);
  });

  it("11. DB エラー（事前確認 / RPC / 入力拒否）→ error / invalid_request、クラッシュしない", async () => {
    const db = new FakeDb();
    db.failNext = { op: "rpc", error: new DbError("could not connect", "08006") };
    const a = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(a.status, "error");
    assert.equal(a.message, "保存できませんでした");
    assert.deepEqual(a.error, { code: "db_error" });
    assert.ok(!JSON.stringify(a).includes("could not connect"), "DB の詳細はクライアントに返さない");

    // 事前確認（保存済みチェック）の失敗 → 書き込まずに error
    const db2 = new FakeDb();
    await savePlace(req(), db2.depsFor(USER_B)); // places を作っておき findSaved まで進ませる
    db2.failNext = { op: "findSaved", error: new DbError("canceling statement due to statement timeout", "57014") };
    const b = await savePlace(req(), db2.depsFor(USER_A));
    assert.equal(b.status, "error");
    assert.equal(db2.rpcCalls.length, 1, "USER_A の RPC は呼ばれない");

    const db3 = new FakeDb();
    db3.failNext = { op: "rpc", error: new DbError("bad enum", "22P02") };
    const c = await savePlace(req(), db3.depsFor(USER_A));
    assert.equal(c.status, "invalid_request");

    const d = await savePlace(req(), { ...new FakeDb().depsFor(USER_A), savePlaceRpc: async () => null as unknown as SavedPlaceRow });
    assert.equal(d.status, "error");
    assert.equal(d.reason, "rpc_returned_no_row");
  });

  it("11b. 保存後の places 再読込に失敗しても保存結果は返す", async () => {
    const db = new FakeDb();
    db.failNext = { op: "loadPlace", error: new DbError("x", "08006") };
    const r = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(r.status, "saved");
    assert.equal(r.place?.name, "スターバックス コーヒー 札幌グランドホテル店");
  });

  it("11c. users プロフィール未作成（FK 違反）→ error(user_profile_missing)", async () => {
    const db = new FakeDb();
    db.failNext = { op: "rpc", error: new DbError("violates foreign key constraint", "23503") };
    const r = await savePlace(req(), db.depsFor(USER_A));
    assert.equal(r.status, "error");
    assert.equal(r.reason, "user_profile_missing");
  });

  it("12. 同時保存: 両方が事前確認をすり抜けても 1件のみ作成、片方は already_saved", async () => {
    const db = new FakeDb();
    let release!: () => void;
    db.gate = new Promise((resolve) => (release = resolve));
    const p1 = savePlace(req(), db.depsFor(USER_A));
    const p2 = savePlace(req(), db.depsFor(USER_A));
    await new Promise((r) => setTimeout(r, 5)); // 両方が findPlace で待機（どちらも「未保存」と判断）
    db.gate = null;
    release();
    const results = await Promise.all([p1, p2]);
    assert.equal(db.rpcCalls.length, 2, "両方 RPC まで到達");
    assert.equal(db.places.length, 1, "places は unique で1件");
    assert.equal(db.saved.length, 1, "saved_places は unique で1件");
    assert.deepEqual(results.map((r) => r.status).sort(), ["already_saved", "saved"]);
    const late = results.find((r) => r.status === "already_saved")!;
    assert.equal(late.reason, "already_saved_concurrently");
    assert.ok(late.warnings.includes("concurrent_save_detected"));
    assert.equal(results[0].saved_place?.id, results[1].saved_place?.id);
  });

  it("12b. 同時に10回保存しても 1件", async () => {
    const db = new FakeDb();
    const results = await Promise.all(Array.from({ length: 10 }, () => savePlace(req(), db.depsFor(USER_A))));
    assert.equal(db.saved.length, 1);
    assert.equal(db.places.length, 1);
    assert.equal(results.filter((r) => r.status === "saved").length, 1);
    assert.equal(results.filter((r) => r.status === "already_saved").length, 9);
  });
});
