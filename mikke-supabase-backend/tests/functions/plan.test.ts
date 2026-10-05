// Unit tests for supabase/functions/generate-plan/plan.ts
// Run: npm run test:functions   (Node >= 23.6 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AiCallResult,
  buildAiUserPayload,
  type Conditions,
  createPlanContext,
  estimateTravelMinutes,
  generateValidPlan,
  hoursOnDate,
  normalizedHoursStatus,
  planSchema,
  rankCandidates,
  schedulePlan,
  validatePlan,
  validateRequestedWindow,
  zonedToDate,
} from "../../supabase/functions/generate-plan/plan.ts";

// Real saved places from the production beta test that triggered ai_output_failed_validation.
const week = (open: string, close: string) =>
  Object.fromEntries(
    ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, [[open, close]]]),
  );
const PLACES = {
  ramen_gifu: {
    id: "670af997-980c-42a5-a8ee-ab51e1078049", name: "焼豚ラーメン三條", category: "lunch",
    address: "岐阜県羽島郡笠松町", latitude: 35.349543, longitude: 136.748869, price_band: "under_3000",
    opening_hours: { timezone: "Asia/Tokyo", weekly: week("11:00", "23:00") },
  },
  udon_ibaraki: {
    id: "d0717752-6be3-4a92-91bd-70d3a8054cca", name: "山田うどん食堂 茨城町店", category: "lunch",
    address: "茨城県東茨城郡茨城町", latitude: 36.261939, longitude: 140.38749, price_band: "under_1000",
    opening_hours: { timezone: "Asia/Tokyo", weekly: week("09:00", "21:00") },
  },
  burger_furano_closed_thu: {
    id: "84ac1923-f23a-421b-b2db-02cc31fe9fc6", name: "FURANO BURGER", category: "lunch",
    address: "北海道富良野市", latitude: 43.342771, longitude: 142.436299, price_band: "under_3000",
    opening_hours: {
      timezone: "Asia/Tokyo",
      weekly: Object.fromEntries(Object.entries(week("11:00", "16:00")).filter(([d]) => d !== "thursday")),
    },
  },
  cafe_sapporo: {
    id: "1a5f9a03-bc46-481d-b331-91c3e30e8a82", name: "Aux Bacchanales 札幌赤レンガテラス店", category: "cafe",
    address: "北海道札幌市中央区", latitude: 43.064023, longitude: 141.350267, price_band: "under_3000",
    opening_hours: { timezone: "Asia/Tokyo", weekly: week("11:00", "22:00") },
  },
  hamburg_sapporo: {
    id: "21ccd70e-f15b-4006-ab00-096ca0870b90", name: "シュシュウルフ札幌白石店", category: "cafe",
    address: "北海道札幌市白石区", latitude: 43.048132, longitude: 141.391948, price_band: "under_3000",
    opening_hours: {
      timezone: "Asia/Tokyo",
      weekly: Object.fromEntries(
        ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
          .map((d) => [d, [["11:00", "16:00"], ["17:30", "20:30"]]]),
      ),
    },
  },
};

// The exact request that failed in production (Thursday 2026-09-24, 09:00-14:40 JST).
const CONDITIONS: Conditions = {
  start_at: "2026-09-24T09:00:00+09:00",
  end_at: "2026-09-24T14:40:00+09:00",
  travel_mode: "public_transit",
  companion: "partner",
  budget_max: 3000,
  moods: [],
};

function rows(places = Object.values(PLACES)) {
  return places.map((p) => ({ saved_at: "2026-09-20T00:00:00Z", visited_status: "not_visited", places: p }));
}

function context(conditions = CONDITIONS) {
  const ctx = createPlanContext(rankCandidates(rows(), conditions), conditions);
  const keyOf = (id: string) => [...ctx.keyToCandidate.entries()].find(([, c]) => c.id === id)![0];
  return { ctx, keyOf };
}

const reason = "保存済みで条件に合うため";

// ---------------------------------------------------------------------------
test("time zone conversion is exact for Asia/Tokyo", () => {
  assert.equal(zonedToDate("2026-09-24", 11 * 60, "Asia/Tokyo").toISOString(), "2026-09-24T02:00:00.000Z");
});

test("a weekday missing from a weekly table means closed (was treated as unknown before)", () => {
  assert.deepEqual(hoursOnDate(PLACES.burger_furano_closed_thu.opening_hours, "2026-09-24"), { status: "closed" });
  assert.equal(hoursOnDate(PLACES.burger_furano_closed_thu.opening_hours, "2026-09-25").status, "open");
  assert.deepEqual(hoursOnDate(null, "2026-09-24"), { status: "unknown" });
  assert.deepEqual(hoursOnDate({ timezone: "Asia/Tokyo", weekly: {} }, "2026-09-24"), { status: "unknown" });
});

test("normalizedHoursStatus keeps its previous meaning for full / partial coverage", () => {
  const h = PLACES.cafe_sapporo.opening_hours;
  assert.equal(normalizedHoursStatus(h, "2026-09-24T10:10:00+09:00", "2026-09-24T11:10:00+09:00", true), "closed");
  assert.equal(normalizedHoursStatus(h, "2026-09-24T10:10:00+09:00", "2026-09-24T11:10:00+09:00", false), "confirmed_open");
  assert.equal(normalizedHoursStatus(h, "2026-09-24T11:00:00+09:00", "2026-09-24T12:00:00+09:00", true), "confirmed_open");
});

test("rankCandidates drops the place that is closed on the requested day", () => {
  const { ctx } = context();
  assert.ok(![...ctx.keyToCandidate.values()].some((c) => c.id === PLACES.burger_furano_closed_thu.id));
  assert.equal(ctx.keyToCandidate.size, 4);
});

test("travel estimates make cross-prefecture hops impossible and same-city hops short", () => {
  const far = estimateTravelMinutes(PLACES.ramen_gifu, PLACES.cafe_sapporo, "public_transit")!;
  const near = estimateTravelMinutes(PLACES.cafe_sapporo, PLACES.hamburg_sapporo, "public_transit")!;
  assert.ok(far > 1000, `far=${far}`);
  assert.ok(near >= 5 && near <= 30, `near=${near}`);
  assert.equal(estimateTravelMinutes({ latitude: null, longitude: null }, PLACES.cafe_sapporo, "walk"), null);
});

test("AI payload gives per-date hours and server travel times, and the schema pins place keys", () => {
  const { ctx } = context();
  const payload = buildAiUserPayload(ctx);
  assert.equal(payload.request.start, "2026-09-24 09:00 (thursday)");
  const cafe = payload.candidates.find((c) => c.name.startsWith("Aux"))!;
  assert.deepEqual(cafe.open_hours["2026-09-24"], ["11:00-22:00"]);
  const keyOfName = (prefix: string) => payload.candidates.find((c) => c.name.startsWith(prefix))!.place_key;
  // Sapporo <-> Sapporo is listed; Sapporo <-> Gifu is unreachable and therefore omitted.
  assert.ok(payload.travel_minutes[keyOfName("Aux")][keyOfName("シュシュ")] > 0);
  assert.equal(payload.travel_minutes[keyOfName("Aux")][keyOfName("焼豚")], undefined);
  const schema = planSchema(ctx);
  assert.deepEqual(schema.properties.items.items.properties.place_key.enum, [...ctx.keyToCandidate.keys()]);
  assert.equal(schema.properties.items.maxItems, 4);
});

// ---------------------------------------------------------------------------
// Regression: the four production failures and the "valid" but impossible plan
// ---------------------------------------------------------------------------
test("production failure #1-#3 (Ibaraki udon then a place in Gifu/Sapporo) is rejected as impossible travel", () => {
  const { ctx, keyOf } = context();
  for (const second of [PLACES.cafe_sapporo, PLACES.ramen_gifu, PLACES.hamburg_sapporo]) {
    const result = schedulePlan({
      estimated_budget: 2500,
      items: [
        { place_key: keyOf(PLACES.udon_ibaraki.id), stay_minutes: 60, selection_reason: reason },
        { place_key: keyOf(second.id), stay_minutes: 60, selection_reason: reason },
      ],
    }, ctx);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.violations[0].code, "travel_too_long");
  }
});

test("pre-fix 'successful' plan (Gifu 11:00 -> Sapporo 12:40) is now rejected instead of saved", () => {
  const { ctx, keyOf } = context();
  const result = schedulePlan({
    estimated_budget: 3000,
    items: [
      { place_key: keyOf(PLACES.ramen_gifu.id), stay_minutes: 60, selection_reason: reason },
      { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 90, selection_reason: reason },
    ],
  }, ctx);
  assert.equal(result.ok, false);
});

test("the root cause (visiting before opening) can no longer happen: server waits for opening", () => {
  const { ctx, keyOf } = context();
  const result = schedulePlan({
    estimated_budget: 3000,
    items: [
      { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 60, selection_reason: reason },
      { place_key: keyOf(PLACES.hamburg_sapporo.id), stay_minutes: 60, selection_reason: reason },
    ],
  }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [first, second] = result.plan.items;
  assert.equal(first.start_at, "2026-09-24T02:00:00.000Z"); // 11:00 JST opening, not 09:00
  assert.ok(new Date(second.start_at).getTime() >= new Date(first.start_at).getTime() + (60 + second.travel_minutes) * 60_000);
  assert.deepEqual(validatePlan(result.plan, ctx), []);
});

// ---------------------------------------------------------------------------
// Intentional validation failures (schedulePlan)
// ---------------------------------------------------------------------------
test("schedulePlan rejects malformed or infeasible AI output", () => {
  const { ctx, keyOf } = context();
  const cafe = keyOf(PLACES.cafe_sapporo.id);
  const cases: Array<[string, unknown]> = [
    ["unknown_place", { estimated_budget: 0, items: [{ place_key: "c99", stay_minutes: 60, selection_reason: reason }] }],
    ["duplicate_place", { estimated_budget: 0, items: [
      { place_key: cafe, stay_minutes: 60, selection_reason: reason },
      { place_key: cafe, stay_minutes: 60, selection_reason: reason },
    ] }],
    ["invalid_stay_minutes", { estimated_budget: 0, items: [{ place_key: cafe, stay_minutes: 5, selection_reason: reason }] }],
    ["invalid_selection_reason", { estimated_budget: 0, items: [{ place_key: cafe, stay_minutes: 60, selection_reason: " " }] }],
    ["over_budget", { estimated_budget: 9000, items: [{ place_key: cafe, stay_minutes: 60, selection_reason: reason }] }],
    ["exceeds_time_window", { estimated_budget: 0, items: [{ place_key: cafe, stay_minutes: 240, selection_reason: reason }] }],
    ["no_items", { estimated_budget: 0, items: [] }],
    ["too_many_items", { estimated_budget: 0, items: Array.from({ length: 5 }, () => ({ place_key: cafe, stay_minutes: 15, selection_reason: reason })) }],
  ];
  for (const [code, output] of cases) {
    const result = schedulePlan(output as never, ctx);
    assert.equal(result.ok, false, code);
    assert.ok(!result.ok && result.violations.some((v) => v.code === code), `${code}: ${JSON.stringify(!result.ok && result.violations)}`);
  }
});

// rankCandidates would already drop these; they are fed to the scheduler directly to prove it refuses on its own.
function directContext(place: (typeof PLACES)[keyof typeof PLACES], conditions = CONDITIONS) {
  const candidate = {
    ...place, saved_at: "2026-09-20T00:00:00Z", score: 0, distance_km: null, hours_status: "unknown" as const,
  };
  return createPlanContext([candidate], conditions);
}

test("schedulePlan rejects a place on its closing day", () => {
  const ctx = directContext(PLACES.burger_furano_closed_thu);
  const result = schedulePlan({ estimated_budget: 0, items: [{ place_key: "c1", stay_minutes: 30, selection_reason: reason }] }, ctx);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.violations.some((v) => v.code === "not_open_during_visit"));
});

test("schedulePlan rejects a place that only opens after the requested window", () => {
  const conditions = { ...CONDITIONS, start_at: "2026-09-24T07:00:00+09:00", end_at: "2026-09-24T10:30:00+09:00" };
  const ctx = directContext(PLACES.cafe_sapporo, conditions);
  const result = schedulePlan({ estimated_budget: 0, items: [{ place_key: "c1", stay_minutes: 30, selection_reason: reason }] }, ctx);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.violations.some((v) => v.code === "exceeds_time_window"));
});

// ---------------------------------------------------------------------------
// Intentional validation failures (final DB gate, independent of the scheduler)
// ---------------------------------------------------------------------------
test("validatePlan (last gate before the DB) rejects tampered plans", () => {
  const { ctx, keyOf } = context();
  const good = schedulePlan({
    estimated_budget: 3000,
    items: [
      { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 60, selection_reason: reason },
      { place_key: keyOf(PLACES.hamburg_sapporo.id), stay_minutes: 60, selection_reason: reason },
    ],
  }, ctx);
  assert.ok(good.ok);
  if (!good.ok) return;
  const base = good.plan;
  const tamper = (fn: (p: typeof base) => void) => {
    const copy = structuredClone(base);
    fn(copy);
    return validatePlan(copy, ctx).map((v) => v.code);
  };
  assert.ok(tamper((p) => { p.items[0].start_at = "2026-09-24T01:10:00.000Z"; }).includes("not_open_during_visit")); // 10:10 JST
  assert.ok(tamper((p) => { p.items[0].place_id = "00000000-0000-4000-8000-000000000000"; }).includes("not_a_candidate"));
  assert.ok(tamper((p) => { p.items[1].place_id = p.items[0].place_id; }).includes("duplicate_place"));
  assert.ok(tamper((p) => { p.items[1].sequence = 5; }).includes("bad_sequence"));
  assert.ok(tamper((p) => { p.items[1].start_at = p.items[0].start_at; }).includes("overlap_or_insufficient_travel"));
  assert.ok(tamper((p) => { p.items[1].start_at = "2026-09-24T05:30:00.000Z"; }).includes("exceeds_time_window"));
  assert.ok(tamper((p) => { p.items[0].start_at = "2026-09-23T23:00:00.000Z"; }).includes("before_time_window"));
  assert.ok(tamper((p) => { p.estimated_budget = 5000; }).includes("over_budget"));
  assert.ok(tamper((p) => { p.items[0].stay_minutes = 10; }).includes("invalid_stay_minutes"));
  assert.ok(tamper((p) => { p.items = []; }).includes("item_count"));
  assert.ok(tamper((p) => {
    // Far-apart places whose times look fine on their own (the pre-fix blind spot).
    p.items[0].place_id = PLACES.ramen_gifu.id;
  }).length > 0);
});

// ---------------------------------------------------------------------------
// Retry orchestration
// ---------------------------------------------------------------------------
function scriptedAi(responses: AiCallResult[]) {
  const feedbacks: Array<string | null> = [];
  const call = async (feedback: string | null) => {
    feedbacks.push(feedback);
    return responses.shift()!;
  };
  return { call, feedbacks };
}

test("retry: an invalid first answer is rejected, fed back, and a valid second answer is accepted", async () => {
  const { ctx, keyOf } = context();
  const bad = JSON.stringify({ estimated_budget: 2500, items: [
    { place_key: keyOf(PLACES.udon_ibaraki.id), stay_minutes: 60, selection_reason: reason },
    { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 90, selection_reason: reason },
  ] });
  const good = JSON.stringify({ estimated_budget: 2500, items: [
    { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 90, selection_reason: reason },
  ] });
  const ai = scriptedAi([{ ok: true, text: bad }, { ok: true, text: good }]);
  const result = await generateValidPlan(ctx, ai.call, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.failedAttempts.length, 1);
  assert.equal(result.failedAttempts[0].violations[0].code, "travel_too_long");
  assert.equal(ai.feedbacks[0], null);
  assert.match(ai.feedbacks[1]!, /travel_too_long/);
});

test("retry: two invalid answers end in a validation failure and nothing is returned for saving", async () => {
  const { ctx, keyOf } = context();
  const bad = JSON.stringify({ estimated_budget: 99999, items: [
    { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 60, selection_reason: reason },
  ] });
  const ai = scriptedAi([{ ok: true, text: bad }, { ok: true, text: bad }]);
  const result = await generateValidPlan(ctx, ai.call, 2);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.stage, "validation");
  assert.equal(!result.ok && result.error_code, "candidate_violation");
  assert.equal(result.attempts, 2);
  assert.ok(!("plan" in result));
});

test("fallback: when every attempt chains an unreachable place, the valid leading part of the AI plan is used", async () => {
  const { ctx, keyOf } = context();
  const far = JSON.stringify({ estimated_budget: 2500, items: [
    { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 60, selection_reason: reason },
    { place_key: keyOf(PLACES.ramen_gifu.id), stay_minutes: 60, selection_reason: reason },
  ] });
  const ai = scriptedAi([{ ok: true, text: far }, { ok: true, text: far }]);
  const result = await generateValidPlan(ctx, ai.call, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.truncatedFrom, 2);
  assert.equal(result.plan.items.length, 1);
  assert.equal(result.plan.items[0].place_id, PLACES.cafe_sapporo.id);
  assert.deepEqual(validatePlan(result.plan, ctx), []);
  assert.equal(result.failedAttempts.length, 2);
});

test("fallback never rescues a plan whose first stop is itself invalid", async () => {
  const conditions = { ...CONDITIONS, start_at: "2026-09-24T07:00:00+09:00", end_at: "2026-09-24T10:30:00+09:00" };
  const ctx = directContext(PLACES.cafe_sapporo, conditions); // opens 11:00, after the window
  const bad = JSON.stringify({ estimated_budget: 0, items: [{ place_key: "c1", stay_minutes: 30, selection_reason: reason }] });
  const ai = scriptedAi([{ ok: true, text: bad }, { ok: true, text: bad }]);
  const result = await generateValidPlan(ctx, ai.call, 2);
  assert.equal(result.ok, false);
});

test("retry: broken JSON is retried", async () => {
  const { ctx, keyOf } = context();
  const good = JSON.stringify({ estimated_budget: 1000, items: [
    { place_key: keyOf(PLACES.cafe_sapporo.id), stay_minutes: 60, selection_reason: reason },
  ] });
  const ai = scriptedAi([{ ok: true, text: "{not json" }, { ok: true, text: good }]);
  const result = await generateValidPlan(ctx, ai.call, 2);
  assert.equal(result.ok, true);
  assert.equal(result.failedAttempts[0].violations[0].code, "invalid_json");
});

test("retry: transient OpenAI errors are retried, permanent ones are not", async () => {
  const { ctx } = context();
  const transient = scriptedAi([
    { ok: false, stage: "openai", error_code: "http_500", retryable: true },
    { ok: false, stage: "openai", error_code: "timeout", retryable: true },
  ]);
  const r1 = await generateValidPlan(ctx, transient.call, 2);
  assert.equal(r1.ok, false);
  assert.equal(!r1.ok && r1.stage, "openai");
  assert.equal(transient.feedbacks.length, 2);

  const permanent = scriptedAi([{ ok: false, stage: "openai", error_code: "http_400", retryable: false }]);
  const r2 = await generateValidPlan(ctx, permanent.call, 2);
  assert.equal(r2.ok, false);
  assert.equal(permanent.feedbacks.length, 1);
});

// ---------------------------------------------------------------------------
// Request time window (invalid_time_range and friends)
// ---------------------------------------------------------------------------
test("requested window: valid JST ranges are accepted", () => {
  const now = new Date("2026-09-24T09:00:00+09:00");
  const ok = (s: string, e: string) => validateRequestedWindow(s, e, now);
  assert.equal(ok("2026-09-24T10:00:00+09:00", "2026-09-24T15:00:00+09:00").ok, true); // 10:00〜15:00
  assert.equal(ok("2026-09-24T09:00:00+09:00", "2026-09-24T12:00:00+09:00").ok, true); // 現在〜3時間後
  assert.equal(ok("2026-09-24T23:00:00+09:00", "2026-09-25T01:00:00+09:00").ok, true); // 23:00〜翌01:00
  assert.equal(ok("2026-09-24T10:00+09:00", "2026-09-24T15:00+09:00").ok, true); // seconds optional
});

test("requested window: JST and UTC notations of the same instant are equivalent", () => {
  const now = new Date("2026-09-24T09:00:00+09:00");
  const jst = validateRequestedWindow("2026-09-24T10:00:00+09:00", "2026-09-24T15:00:00+09:00", now);
  const utc = validateRequestedWindow("2026-09-24T01:00:00Z", "2026-09-24T06:00:00.000Z", now);
  assert.ok(jst.ok && utc.ok);
  if (jst.ok && utc.ok) {
    assert.equal(jst.start.getTime(), utc.start.getTime());
    assert.equal(jst.end.getTime(), utc.end.getTime());
  }
  // 23:00 JST on the 24th is 14:00 UTC on the same date; 01:00 JST on the 25th is 16:00 UTC on the 24th.
  const midnight = validateRequestedWindow("2026-09-24T23:00:00+09:00", "2026-09-25T01:00:00+09:00", now);
  assert.ok(midnight.ok);
  if (midnight.ok) {
    assert.equal(midnight.start.toISOString(), "2026-09-24T14:00:00.000Z");
    assert.equal(midnight.end.toISOString(), "2026-09-24T16:00:00.000Z");
  }
});

test("requested window: invalid_time_range is still returned for start == end and start > end", () => {
  const now = new Date("2026-09-24T09:00:00+09:00");
  const err = (s: string, e: string) => {
    const r = validateRequestedWindow(s, e, now);
    return r.ok ? "ok" : r.error;
  };
  assert.equal(err("2026-09-24T12:00:00+09:00", "2026-09-24T12:00:00+09:00"), "invalid_time_range"); // 開始＝終了
  assert.equal(err("2026-09-24T15:00:00+09:00", "2026-09-24T10:00:00+09:00"), "invalid_time_range"); // 開始＞終了
  assert.equal(err("2026-09-24T23:00:00+09:00", "2026-09-24T01:00:00+09:00"), "invalid_time_range"); // 翌日にし忘れ
});

test("requested window: malformed, offset-less, too long and past windows are rejected", () => {
  const now = new Date("2026-09-24T21:00:00+09:00");
  const err = (s: unknown, e: unknown) => {
    const r = validateRequestedWindow(s, e, now);
    return r.ok ? "ok" : r.error;
  };
  assert.equal(err("2026-09-25T10:00:00", "2026-09-25T15:00:00"), "invalid_time_format"); // no offset (would be read as UTC)
  assert.equal(err("10:00+09:00", "15:00+09:00"), "invalid_time_format"); // time only, no date
  assert.equal(err("2026-09-25T10:00:00+09:00", "+09:00"), "invalid_time_format"); // cleared field
  assert.equal(err("2026-02-30T10:00:00+09:00", "2026-02-30T12:00:00+09:00"), "invalid_time_format"); // no such date
  assert.equal(err(null, 5), "invalid_time_format");
  assert.equal(err("2026-09-25T07:40:00+09:00", "2026-09-27T09:40:00+09:00"), "time_range_too_long");
  assert.equal(err("2026-09-24T08:00:00+09:00", "2026-09-24T10:00:00+09:00"), "time_range_in_past"); // 当日の過去時刻
});
