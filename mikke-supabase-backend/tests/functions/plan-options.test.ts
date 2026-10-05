// Unit tests for supabase/functions/generate-plan-options/options.ts
// Run: npm run test:functions   (Node >= 23.6 strips TypeScript types natively)
// OpenAI is never called: generatePlanOptions() receives a mocked callAi.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AiCallResult } from "../../supabase/functions/generate-plan/plan.ts";
import {
  budgetFor,
  buildOptionsPayload,
  coarseOrigin,
  collectOptions,
  effectiveTravelMode,
  filterRowsByPlaceIds,
  generatePlanOptions,
  type OptionsInput,
  optionsSchema,
  parseOptionsRequest,
  parsePlaceIds,
  planCountFor,
  planWindow,
  searchRadiusKm,
  selectCandidates,
  storedConditions,
  toLegacyConditions,
  toPublicOption,
} from "../../supabase/functions/generate-plan-options/options.ts";
import { createPlanContext } from "../../supabase/functions/generate-plan/plan.ts";

// Saturday 2026-09-26 10:00 JST
const NOW = new Date("2026-09-26T01:00:00.000Z");
const ORIGIN = { latitude: 43.0687, longitude: 141.3508, accuracy_m: 40, captured_at: "2026-09-26T00:59:00.000Z" };

const conditions = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  origin: { type: "current_location", ...ORIGIN },
  duration_minutes: 180,
  budget_yen: 3000,
  transport_modes: ["walking", "train", "bus"],
  preferences: ["omakase"],
  saved_place_count: 5,
  created_at: NOW.toISOString(),
  ...overrides,
});

function input(overrides: Record<string, unknown> = {}): OptionsInput {
  const r = parseOptionsRequest({ conditions: conditions(overrides) }, NOW);
  assert.ok(r.ok, JSON.stringify(r));
  return r.input;
}

let seq = 0;
const row = (name: string, category: string, lat: number | null, lng: number | null, extra: Record<string, unknown> = {}) => ({
  saved_at: "2026-09-01T00:00:00Z",
  visited_status: "not_visited",
  places: {
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    name,
    category,
    address: `北海道札幌市 ${name}`,
    latitude: lat,
    longitude: lng,
    price_band: "under_1000",
    opening_hours: null,
    ...extra,
  },
});

// Around Sapporo station (all within ~2 km)
const CAFE = row("森のカフェ", "cafe", 43.0640, 141.3469);
const RAMEN = row("らーめん一番", "lunch", 43.0605, 141.3540);
const PARK = row("大通公園", "sightseeing", 43.0598, 141.3450, { price_band: "unknown" });
const SHOP = row("ステラ雑貨", "shopping", 43.0680, 141.3520, { price_band: "under_3000" });
const SWEETS = row("甘味処", "sweets", 43.0620, 141.3560);
const FIVE = [CAFE, RAMEN, PARK, SHOP, SWEETS];
const idOf = (r: typeof CAFE) => r.places.id;

/** Mock AI: answers with the given plans (place names → keys resolved from the payload). */
function aiFrom(build: (keyOf: (name: string) => string) => unknown) {
  const calls: { feedback: string | null }[] = [];
  const callAi = (args: { schema: unknown; payload: string; feedback: string | null }): Promise<AiCallResult> => {
    calls.push({ feedback: args.feedback });
    const payload = JSON.parse(args.payload);
    const keyOf = (name: string) => payload.candidates.find((c: { name: string }) => c.name === name)?.place_key ?? "c99";
    return Promise.resolve({ ok: true, text: JSON.stringify(build(keyOf)) });
  };
  return { callAi, calls };
}

const plan = (variant: string, title: string, items: [string, number][], keyOf: (n: string) => string) => ({
  variant,
  title,
  concept: `${title}のコンセプト`,
  summary: `${title}を楽しむプランです。`,
  items: items.map(([name, stay]) => ({ place_key: keyOf(name), stay_minutes: stay, reason: `${name}は保存していた場所です` })),
});

const THREE_PLANS = (k: (n: string) => string) => ({
  plans: [
    plan("A", "カフェでのんびり", [["森のカフェ", 60], ["大通公園", 40]], k),
    plan("B", "グルメ中心", [["らーめん一番", 45], ["甘味処", 30]], k),
    // 雑貨(〜3000) + 公園(料金不明): 予算 3000 に収まる
    plan("C", "詰め込みプラン", [["ステラ雑貨", 30], ["大通公園", 20]], k),
  ],
});

// ---------------------------------------------------------------------------
describe("parseOptionsRequest（PlanConditions v1）", () => {
  it("1. 正常な PlanConditions を受け付ける", () => {
    const i = input();
    assert.equal(i.durationMinutes, 180);
    assert.equal(i.budgetYen, 3000);
    assert.deepEqual(i.transportModes, ["walking", "train", "bus"]);
    assert.deepEqual(i.preferences, ["omakase"]);
    assert.equal(i.startAt.toISOString(), "2026-09-26T01:00:00.000Z");
    assert.equal(i.endAt.toISOString(), "2026-09-26T04:00:00.000Z");
  });

  it("開始は次の5分刻み", () => {
    const w = planWindow(new Date("2026-09-26T01:02:10Z"), 60);
    assert.equal(w.start.toISOString(), "2026-09-26T01:05:00.000Z");
    assert.equal(w.end.toISOString(), "2026-09-26T02:05:00.000Z");
  });

  it("不正な条件は 400 用のエラー", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ version: 2 }, "unsupported_conditions_version"],
      [{ origin: { latitude: 999, longitude: 0 } }, "origin_required"],
      [{ origin: null }, "origin_required"],
      [{ duration_minutes: 10 }, "invalid_duration"],
      [{ duration_minutes: 90.5 }, "invalid_duration"],
      [{ budget_yen: -1 }, "invalid_budget"],
      [{ budget_yen: "3000" }, "invalid_budget"],
      [{ transport_modes: [] }, "invalid_transport_modes"],
      [{ transport_modes: ["plane"] }, "invalid_transport_modes"],
      [{ transport_modes: ["walking", "walking"] }, "invalid_transport_modes"],
      [{ preferences: [] }, "invalid_preferences"],
      [{ preferences: ["cafe", "eat", "active", "shopping"] }, "invalid_preferences"],
      [{ preferences: ["nightlife"] }, "invalid_preferences"],
    ];
    for (const [override, error] of cases) {
      assert.deepEqual(parseOptionsRequest({ conditions: conditions(override) }, NOW), { ok: false, error }, JSON.stringify(override));
    }
    assert.deepEqual(parseOptionsRequest(null, NOW), { ok: false, error: "invalid_body" });
    assert.deepEqual(parseOptionsRequest({}, NOW), { ok: false, error: "conditions_required" });
    assert.deepEqual(parseOptionsRequest({ conditions: conditions(), generation_sequence: 4 }, NOW), {
      ok: false,
      error: "generation_sequence_must_be_1_to_3",
    });
  });

  it("11・12. budget_yen null / 数値", () => {
    assert.equal(input({ budget_yen: null }).budgetYen, null);
    assert.equal(input({ budget_yen: 10000 }).budgetYen, 10000);
  });

  it("13・14. omakase は単独に正規化 / 複数 preferences は保持", () => {
    assert.deepEqual(input({ preferences: ["omakase", "cafe"] }).preferences, ["omakase"]);
    assert.deepEqual(input({ preferences: ["cafe", "eat"] }).preferences, ["eat", "cafe"]);
  });
});

describe("移動手段・距離しきい値", () => {
  it("15. 複数 transport_modes → 最速の手段で到達範囲を決める", () => {
    assert.equal(effectiveTravelMode(["walking"]), "walk");
    assert.equal(effectiveTravelMode(["walking", "bus"]), "public_transit");
    assert.equal(effectiveTravelMode(["walking", "train", "car"]), "car");
    assert.equal(toLegacyConditions(input({ transport_modes: ["walking", "car"] })).travel_mode, "car");
  });

  it("所要時間に応じて直線距離の候補範囲を広げる（上限あり）", () => {
    assert.equal(searchRadiusKm("walk", 60), 1.5);
    assert.equal(searchRadiusKm("walk", 180), 4.5);
    assert.equal(searchRadiusKm("walk", 480), 5);
    assert.equal(searchRadiusKm("public_transit", 60), 5);
    assert.equal(searchRadiusKm("public_transit", 180), 15);
    assert.equal(searchRadiusKm("public_transit", 480), 30);
    assert.equal(searchRadiusKm("car", 180), 30);
    assert.equal(searchRadiusKm("car", 480), 50);
  });

  it("3時間では遠い Place を除外し、半日なら含める", () => {
    const otaru = row("小樽の店", "cafe", 43.1907, 140.9947); // ~32 km
    const tomakomai = row("苫小牧の店", "cafe", 42.6343, 141.6055); // ~52 km
    const short = selectCandidates([CAFE, otaru, tomakomai], input(), NOW);
    assert.deepEqual(short.candidates.map((c) => c.name), ["森のカフェ"]);
    assert.equal(short.stats.too_far, 2);
    const long = selectCandidates([CAFE, otaru, tomakomai], input({ duration_minutes: 480, transport_modes: ["car"] }), NOW);
    assert.deepEqual(long.candidates.map((c) => c.name).sort(), ["小樽の店", "森のカフェ"].sort());
  });
});

describe("selectCandidates", () => {
  it("座標なし・予算超過・定休日・非表示は除外、重複行は1件", () => {
    const closedSaturday = row("土曜休み", "cafe", 43.065, 141.35, {
      opening_hours: { timezone: "Asia/Tokyo", weekly: { monday: [["09:00", "18:00"]] } },
    });
    const noCoords = row("座標なし", "cafe", null, null);
    const expensive = row("高級店", "dinner", 43.065, 141.35, { price_band: "under_10000" });
    const dismissed = { ...row("非表示", "cafe", 43.065, 141.35), visited_status: "dismissed" };
    const r = selectCandidates([CAFE, CAFE, closedSaturday, noCoords, expensive, dismissed], input(), NOW);
    assert.deepEqual(r.candidates.map((c) => c.name), ["森のカフェ"]);
    assert.deepEqual(r.stats, { total: 5, dismissed: 1, no_coordinates: 1, too_far: 0, over_budget: 1, closed: 1, eligible: 1 });
    // budget null → 高級店も候補
    assert.equal(selectCandidates([expensive], input({ budget_yen: null }), NOW).candidates.length, 1);
  });

  it("preferences に合うカテゴリを優先", () => {
    const r = selectCandidates(FIVE, input({ preferences: ["shopping"] }), NOW);
    assert.equal(r.candidates[0].name, "ステラ雑貨");
  });

  it("planCountFor: 0/1/2/3件以上", () => {
    assert.deepEqual([0, 1, 2, 3, 12].map(planCountFor), [0, 1, 2, 3, 3]);
  });
});

describe("AI への入力", () => {
  it("候補キーだけを選べるスキーマ・住所や座標は渡さない", () => {
    const i = input();
    const { candidates } = selectCandidates(FIVE, i, NOW);
    const ctx = createPlanContext(candidates, toLegacyConditions(i));
    const schema = optionsSchema(ctx, 3) as any;
    assert.deepEqual(schema.properties.plans.items.properties.items.items.properties.place_key.enum, ["c1", "c2", "c3", "c4", "c5"]);
    assert.equal(schema.properties.plans.minItems, 3);
    assert.deepEqual(schema.properties.plans.items.properties.variant.enum, ["A", "B", "C"]);
    const payload = buildOptionsPayload(ctx, i, 3);
    const text = JSON.stringify(payload);
    assert.ok(!text.includes("北海道札幌市"), "住所を渡さない");
    assert.ok(!text.includes("43.0687") && !text.includes("141.3508"), "現在地の座標を渡さない");
    assert.equal(Object.keys(payload.travel_minutes_from_origin).length, 5);
    assert.deepEqual(payload.request.preferences, ["omakase"]);
  });
});

// ---------------------------------------------------------------------------
describe("generatePlanOptions（要件ケース）", () => {
  it("2・3・9. 3件以上 → A/B/C の3プラン、variant は一意、DB の正規データで再構築", async () => {
    const { callAi, calls } = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input(), FIVE, { callAi, now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(calls.length, 1);
    assert.deepEqual(r.options.map((o) => o.variant), ["A", "B", "C"]);
    const a = r.options[0];
    assert.equal(a.title, "カフェでのんびり");
    assert.equal(a.items[0].place_id, idOf(CAFE));
    assert.equal(a.items[0].place_name, "森のカフェ");
    assert.equal(a.items[0].address, "北海道札幌市 森のカフェ");
    assert.equal(a.items[0].latitude, 43.064);
    assert.equal(a.items[0].order, 1);
    assert.ok(a.items[0].travel_buffer_minutes > 0, "現在地からの移動バッファ");
    assert.ok(a.estimated_total_minutes <= 180);
    assert.equal(new Date(a.items[0].estimated_arrival_at).getTime(), NOW.getTime() + a.items[0].travel_buffer_minutes * 60_000);
    // DB 保存用の行（create_generated_plan の形）
    assert.equal(a.db_items[0].place_id, idOf(CAFE));
    assert.equal(a.db_items[0].sequence, 1);
  });

  it("4. 存在しない Place キーを含むプランは除外（他のプランは残す）", async () => {
    const { callAi } = aiFrom((k) => ({
      plans: [
        plan("A", "カフェ", [["森のカフェ", 60]], k),
        { ...plan("B", "架空", [["らーめん一番", 30]], k), items: [{ place_key: "c99", stay_minutes: 30, reason: "x" }] },
        plan("C", "買い物", [["ステラ雑貨", 30]], k),
      ],
    }));
    const r = await generatePlanOptions(input(), FIVE, { callAi, now: NOW, maxAttempts: 1 });
    assert.ok(r.ok);
    assert.deepEqual(r.options.map((o) => [o.variant, o.title]), [["A", "カフェ"], ["B", "買い物"]], "付け直した A/B");
    assert.ok(r.failedAttempts[0].violations.some((v) => v.code === "unknown_place"));
  });

  it("5. 同一プラン内の同じ Place の重複 → 重複より前の部分だけ残す", async () => {
    const { callAi } = aiFrom((k) => ({
      plans: [
        plan("A", "重複あり", [["森のカフェ", 30], ["大通公園", 30], ["森のカフェ", 30]], k),
        plan("B", "グルメ", [["らーめん一番", 45]], k),
        plan("C", "買い物", [["ステラ雑貨", 30]], k),
      ],
    }));
    const r = await generatePlanOptions(input(), FIVE, { callAi, now: NOW, maxAttempts: 1 });
    assert.ok(r.ok);
    assert.deepEqual(r.options[0].items.map((i) => i.place_name), ["森のカフェ", "大通公園"]);
  });

  it("プラン間で同じ Place の組み合わせは1つにまとめる（差別化）", async () => {
    const { callAi } = aiFrom((k) => ({
      plans: [
        plan("A", "カフェ", [["森のカフェ", 60], ["大通公園", 30]], k),
        plan("B", "順番違い", [["大通公園", 30], ["森のカフェ", 60]], k),
        plan("C", "グルメ", [["らーめん一番", 45]], k),
      ],
    }));
    const r = await generatePlanOptions(input(), FIVE, { callAi, now: NOW, maxAttempts: 1 });
    assert.ok(r.ok);
    assert.equal(r.options.length, 2);
    assert.ok(r.failedAttempts[0].violations.some((v) => v.code === "same_places_as_other_plan"));
  });

  it("10. 時間制約超過（3時間に滞在合計300分）→ 収まる部分だけ・全体が収まらなければ再試行", async () => {
    const { callAi, calls } = aiFrom((k) => ({
      plans: [
        plan("A", "長すぎ", [["森のカフェ", 120], ["大通公園", 120], ["らーめん一番", 60]], k),
        plan("B", "グルメ", [["らーめん一番", 45]], k),
        plan("C", "買い物", [["ステラ雑貨", 30]], k),
      ],
    }));
    const r = await generatePlanOptions(input(), FIVE, { callAi, now: NOW, maxAttempts: 2 });
    assert.ok(r.ok);
    for (const o of r.options) assert.ok(o.estimated_total_minutes <= 180, `${o.title}: ${o.estimated_total_minutes}`);
    assert.deepEqual(r.options[0].items.map((i) => i.place_name), ["森のカフェ"]);
    assert.equal(calls.length, 2, "違反があれば1回だけフィードバック付きで再試行");
    assert.ok(calls[1].feedback?.includes("exceeds_time_window"));
  });

  it("12. 予算あり: 既知の料金帯の合計で判定し、AI に金額を作らせない", async () => {
    const { callAi } = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input({ budget_yen: 3000 }), FIVE, { callAi, now: NOW });
    assert.ok(r.ok);
    const a = r.options[0]; // カフェ(〜1000) + 公園(不明)
    assert.equal(a.budget_status, "partial");
    assert.equal(a.estimated_budget_yen, 1000);
    assert.equal(a.within_budget, null, "料金不明を含むので判定しない");
    const b = r.options[1]; // ラーメン(〜1000) + 甘味(〜1000)
    assert.deepEqual([b.budget_status, b.estimated_budget_yen, b.within_budget], ["estimated", 2000, true]);
  });

  it("12b. 予算超過のプランは除外", async () => {
    const { callAi } = aiFrom((k) => ({
      plans: [
        plan("A", "予算オーバー", [["ステラ雑貨", 30], ["らーめん一番", 30]], k), // 3000 + 1000
        plan("B", "グルメ", [["らーめん一番", 45]], k),
        plan("C", "カフェ", [["森のカフェ", 45]], k),
      ],
    }));
    const r = await generatePlanOptions(input({ budget_yen: 3000 }), FIVE, { callAi, now: NOW, maxAttempts: 1 });
    assert.ok(r.ok);
    assert.ok(r.options.every((o) => o.within_budget !== false));
    assert.ok(r.failedAttempts[0].violations.some((v) => v.code === "over_budget"));
  });

  it("11. budget_yen null → 予算判定なし", async () => {
    const { callAi } = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input({ budget_yen: null }), FIVE, { callAi, now: NOW });
    assert.ok(r.ok);
    assert.ok(r.options.every((o) => o.within_budget === null));
  });

  it("budgetFor: 全て不明なら金額を出さない", () => {
    const i = input();
    const { candidates } = selectCandidates([PARK], i, NOW);
    assert.deepEqual(budgetFor(candidates, 3000), { knownSum: 0, estimated_budget_yen: null, budget_status: "unknown", within_budget: null });
  });

  it("営業時間: データがあれば confirmed_open、なければ unknown（作らない）", async () => {
    const open = row("営業中カフェ", "cafe", 43.066, 141.351, {
      opening_hours: { timezone: "Asia/Tokyo", weekly: { saturday: [["08:00", "20:00"]] } },
    });
    const { callAi } = aiFrom((k) => ({ plans: [plan("A", "x", [["営業中カフェ", 30]], k), plan("B", "y", [["森のカフェ", 30]], k), plan("C", "z", [["大通公園", 30]], k)] }));
    const r = await generatePlanOptions(input(), [open, CAFE, PARK], { callAi, now: NOW });
    assert.ok(r.ok);
    assert.equal(r.options[0].items[0].hours_status, "confirmed_open");
    assert.equal(r.options[1].items[0].hours_status, "unknown");
  });

  it("6. 保存 Place 0件 → no_saved_places（AI を呼ばない）", async () => {
    const { callAi, calls } = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input(), [], { callAi, now: NOW });
    assert.deepEqual([r.ok, !r.ok && r.error], [false, "no_saved_places"]);
    assert.equal(calls.length, 0);
  });

  it("候補不足（全部遠い）→ no_candidates（AI を呼ばない）", async () => {
    const { callAi, calls } = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input(), [row("東京", "cafe", 35.68, 139.76)], { callAi, now: NOW });
    assert.equal(!r.ok && r.error, "no_candidates");
    assert.equal(!r.ok && r.stats.too_far, 1);
    assert.equal(calls.length, 0);
  });

  it("7. 保存 Place 1件 → 1プランだけ（捏造しない）", async () => {
    let schemaSeen: any = null;
    const r = await generatePlanOptions(input(), [CAFE], {
      now: NOW,
      callAi: async ({ schema, payload }) => {
        schemaSeen = schema;
        const key = JSON.parse(payload).candidates[0].place_key;
        return { ok: true, text: JSON.stringify({ plans: [{ variant: "A", title: "カフェ", concept: "c", summary: "s", items: [{ place_key: key, stay_minutes: 60, reason: "r" }] }] }) };
      },
    });
    assert.ok(r.ok);
    assert.equal(r.planCount, 1);
    assert.equal(r.options.length, 1);
    assert.equal(schemaSeen.properties.plans.maxItems, 1);
  });

  it("8. 保存 Place 2件 → 2プランまで", async () => {
    const { callAi } = aiFrom((k) => ({ plans: [plan("A", "カフェ", [["森のカフェ", 60]], k), plan("B", "グルメ", [["らーめん一番", 45]], k)] }));
    const r = await generatePlanOptions(input(), [CAFE, RAMEN], { callAi, now: NOW });
    assert.ok(r.ok);
    assert.equal(r.planCount, 2);
    assert.deepEqual(r.options.map((o) => o.variant), ["A", "B"]);
  });

  it("16. OpenAI 失敗（再試行可）→ 2回試して ai_generation_failed", async () => {
    let n = 0;
    const r = await generatePlanOptions(input(), FIVE, {
      now: NOW,
      callAi: async () => {
        n++;
        return { ok: false, stage: "openai", error_code: "http_500", retryable: true };
      },
    });
    assert.equal(!r.ok && r.error, "ai_generation_failed");
    assert.equal(n, 2);
  });

  it("18. タイムアウト（再試行しない）→ ai_generation_failed", async () => {
    let n = 0;
    const r = await generatePlanOptions(input(), FIVE, {
      now: NOW,
      callAi: async () => {
        n++;
        return { ok: false, stage: "openai", error_code: "timeout", retryable: false };
      },
    });
    assert.equal(!r.ok && r.error, "ai_generation_failed");
    assert.equal(n, 1);
  });

  it("17. 不正な AI レスポンス（JSON でない・plans なし）→ ai_output_failed_validation", async () => {
    for (const text of ["not json", "{}", '{"plans": "x"}']) {
      const r = await generatePlanOptions(input(), FIVE, { now: NOW, callAi: async () => ({ ok: true, text }) });
      assert.equal(!r.ok && r.error, "ai_output_failed_validation", text);
    }
  });

  it("1回目が不正でも2回目が正しければ成功", async () => {
    let n = 0;
    const good = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input(), FIVE, {
      now: NOW,
      callAi: (args) => (++n === 1 ? Promise.resolve({ ok: true, text: "broken" }) : good.callAi(args)),
    });
    assert.ok(r.ok);
    assert.equal(r.attempts, 2);
    assert.equal(r.options.length, 3);
  });

  it("variant の重複・範囲外は除外", () => {
    const i = input();
    const { candidates } = selectCandidates(FIVE, i, NOW);
    const ctx = createPlanContext(candidates, toLegacyConditions(i));
    const keyOf = (name: string) => [...ctx.keyToCandidate.entries()].find(([, c]) => c.name === name)![0];
    const { valid, violations } = collectOptions({
      plans: [plan("A", "1", [["森のカフェ", 30]], keyOf), plan("A", "2", [["らーめん一番", 30]], keyOf), plan("D", "3", [["ステラ雑貨", 30]], keyOf)],
    }, ctx, i, 3);
    assert.equal(valid.length, 1);
    assert.equal(violations.filter((v) => v.code === "invalid_or_duplicate_variant").length, 2);
  });
});

describe("保存・プライバシー", () => {
  it("condition_json に正確な座標を入れない（約1km精度）", () => {
    assert.deepEqual(coarseOrigin(ORIGIN), { latitude: 43.07, longitude: 141.35 });
    const stored = storedConditions(input(), { set_id: "s", variant: "A", title: "t", concept: "c", summary: "s", budget_status: "partial" });
    const text = JSON.stringify(stored);
    assert.ok(!text.includes("43.0687") && !text.includes("141.3508"));
    assert.equal(stored.option.variant, "A");
  });

  it("クライアントへの応答に DB 保存用の内部データを含めない", async () => {
    const { callAi } = aiFrom(THREE_PLANS);
    const r = await generatePlanOptions(input(), FIVE, { callAi, now: NOW });
    assert.ok(r.ok);
    const pub = toPublicOption(r.options[0], "plan-1");
    assert.equal(pub.plan_id, "plan-1");
    assert.ok(!("db_items" in pub));
  });
});

describe("v3: place_ids（今日向けに調整）", () => {
  const ID1 = "11111111-1111-4111-8111-111111111111";
  const ID2 = "22222222-2222-4222-8222-222222222222";
  it("未指定は null、UUID の配列だけ受け付ける", () => {
    assert.deepEqual(parsePlaceIds(undefined), { ok: true, ids: null });
    assert.deepEqual(parsePlaceIds([ID1, ID1.toUpperCase()]), { ok: true, ids: [ID1] });
    assert.deepEqual(parsePlaceIds([]), { ok: false });
    assert.deepEqual(parsePlaceIds(["x"]), { ok: false });
    assert.deepEqual(parsePlaceIds(Array.from({ length: 21 }, () => ID1)), { ok: false });
  });
  it("parseOptionsRequest が place_ids と元ルートを受け取り、条件の保存に元ルートだけを残す", () => {
    const r = parseOptionsRequest({ conditions: conditions(), place_ids: [ID1], based_on_route_post_id: ID2 }, NOW);
    assert.ok(r.ok);
    assert.deepEqual(r.input.placeIds, [ID1]);
    const stored = storedConditions(r.input, { set_id: "s", variant: "A", title: "t", concept: "c", summary: "s", budget_status: "partial" });
    assert.equal((stored as Record<string, unknown>).based_on_route_post_id, ID2);
    assert.deepEqual(parseOptionsRequest({ conditions: conditions(), place_ids: "x" }, NOW), { ok: false, error: "invalid_place_ids" });
    assert.deepEqual(parseOptionsRequest({ conditions: conditions(), based_on_route_post_id: 1 }, NOW), { ok: false, error: "invalid_based_on_route_post_id" });
  });
  it("候補行を指定した場所だけに絞る（null なら全件）", () => {
    const rows = [{ places: { id: ID1 } }, { places: { id: ID2 } }, { places: null }];
    assert.equal(filterRowsByPlaceIds(rows, null).length, 3);
    assert.deepEqual(filterRowsByPlaceIds(rows, [ID2]), [{ places: { id: ID2 } }]);
  });
});
