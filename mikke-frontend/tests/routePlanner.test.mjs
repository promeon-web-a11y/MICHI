// Tests for src/services/route-planner（MICHI Route Planner v1）   Run: npm test
// AI と地図検索は、決まった値を返すものに差し替える（外部 API は呼ばない・費用はかからない）。
// 確かめるのは、プログラム側の処理: 条件の整理、検索語、候補のふるい分け、時刻の計算、検証、作り直しの回数、結果に付ける注意。
import "./helpers/ts-hooks.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const { planRoute, MAX_REGENERATIONS } = await import("../src/services/route-planner/plan-route.ts");
const { ACTIVE_PROMPTS } = await import("../src/services/route-planner/prompts/index.ts");
const { buildTripRequest, emptyTripDetails } = await import("../src/services/plan/trip-request.ts");
const { dayHours } = await import("../src/services/route-planner/candidates.ts");

// 2026-10-06（火）08:00 日本時間
const NOW = new Date("2026-10-05T23:00:00Z");
const request = (text, details = {}, language = "en") => buildTripRequest(text, { ...emptyTripDetails(), ...details }, language);

/** 毎日 open〜close に営業 */
const daily = (open, close) => Array.from({ length: 7 }, (_, day) => ({ openDay: day, openMinute: open * 60, closeDay: day, closeMinute: close * 60 }));
let serial = 0;
const place = (name, category, extra = {}) => {
  serial++;
  return {
    id: `g${serial}`,
    name,
    category,
    address: "Test address",
    // 互いに数百メートルの距離に置く
    latitude: 35.68 + (serial % 5) * 0.003,
    longitude: 139.76 + (serial % 3) * 0.003,
    mapsUrl: null,
    rating: 4.2,
    ratingCount: 100,
    priceLevel: null,
    photoName: null,
    photoCredit: null,
    openingPeriods: daily(10, 21),
    wheelchairEntrance: null,
    ...extra,
  };
};

/** 検索語（場所の種類の部分）ごとに返す場所 */
const PLACES = {
  ラーメン: [place("麺屋テスト", "Ramen restaurant"), place("らーめん二番", "Ramen restaurant"), place("とんこつ亭", "Ramen restaurant")],
  "アニメ ショップ": [place("アニメ館", "Hobby store"), place("Manga Tower", "Book store")],
  海鮮: [place("海鮮市場食堂", "Seafood restaurant"), place("かに道場", "Crab restaurant")],
  寿司: [place("寿司テスト", "Sushi restaurant")],
  ランチ: [place("定食屋あおい", "Japanese restaurant"), place("海鮮丼まる", "Seafood restaurant"), place("とんかつ山", "Tonkatsu restaurant"), place("Green Table", "Restaurant")],
  観光スポット: [place("中央公園", "Park", { openingPeriods: null }), place("市立博物館", "Museum"), place("展望タワー", "Observation deck")],
  カフェ: [place("喫茶ひだまり", "Cafe"), place("Bar & Cafe Moon", "Bar")],
  文化体験: [place("茶道体験の家", "Cultural center"), place("伝統工芸館", "Museum")],
  ご当地グルメ: [place("郷土の味", "Japanese restaurant"), place("居酒屋はなれ", "Izakaya restaurant")],
  浅草寺: [place("浅草寺", "Buddhist temple", { openingPeriods: daily(6, 17) })],
};

/** 差し替え用の依存。planner は、AI に渡された入力（JSON）から立ち寄りを返す関数 */
function makeDeps({ reading = null, planner = null, places = PLACES, searchFails = false } = {}) {
  const calls = { ai: [], searches: [], logs: [] };
  const defaultPlanner = (input) => ({
    title: "Test route",
    concept: "A test route.",
    start_time: null,
    stops: input.candidates.slice(0, input.limits.max_stops).map((c) => ({ id: c.id, stay_minutes: 60, reason: `Stop for ${c.found_for}.`, estimated_cost_yen: 1000 })),
    unmet_requests: [],
  });
  return {
    calls,
    deps: {
      callAi: async (args) => {
        const input = JSON.parse(args.user);
        calls.ai.push({ schemaName: args.schemaName, system: args.system, input });
        if (args.schemaName === ACTIVE_PROMPTS.interpreter.schemaName) {
          const base = {
            plannable: true, area: null, duration_minutes: null, budget_yen: null, party_size: null, start_time: null, transport: [], pace: null,
            wanted_foods: [], rejected_foods: [], wanted_interests: [], rejected_interests: [], allergies: [], dietary_restrictions: [],
            other_exclusions: [], search_keywords: [],
          };
          return { ok: true, text: JSON.stringify({ ...base, ...reading }) };
        }
        const plannerCalls = calls.ai.filter((c) => c.schemaName === ACTIVE_PROMPTS.planner.schemaName).length;
        return { ok: true, text: JSON.stringify((planner ?? defaultPlanner)(input, plannerCalls)) };
      },
      searchPlaces: async (query) => {
        calls.searches.push(query);
        if (searchFails) return { ok: false, code: "http_500" };
        const keyword = query.split(" ").slice(1).join(" ");
        return { ok: true, places: places[keyword] ?? [] };
      },
      michi: { placeData: async () => new Map(), routes: async () => [] },
      now: () => NOW,
      log: (entry) => calls.logs.push(entry),
      prompts: ACTIVE_PROMPTS,
    },
  };
}

const plannerCalls = (calls) => calls.ai.filter((c) => c.schemaName === ACTIVE_PROMPTS.planner.schemaName);
const interpretCalls = (calls) => calls.ai.filter((c) => c.schemaName === ACTIVE_PROMPTS.interpreter.schemaName);
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const allText = (plan) => JSON.stringify([plan.title, plan.summary, plan.stops.map((s) => [s.description, s.notes]), plan.warnings, plan.assumptions, plan.unresolvedConstraints]);

test("CASE 1: チャットだけ（relaxed day in Tokyo）でルートを作る。文章は AI が項目に読み取る", async () => {
  const { deps, calls } = makeDeps({ reading: { area: "東京", pace: "relaxed" } });
  const result = await planRoute(request("Give me a relaxed day in Tokyo."), deps);
  assert.equal(result.ok, true);
  assert.equal(interpretCalls(calls).length, 1);
  assert.equal(plannerCalls(calls).length, 1);
  // 文章の読み取りには、文章だけを渡す（詳細設定は渡さない）
  assert.deepEqual(Object.keys(interpretCalls(calls)[0].input), ["message", "output_language"]);
  assert.ok(calls.searches.every((q) => q.startsWith("東京 ")));
  assert.equal(result.plan.conditions.area, "東京");
  assert.equal(plannerCalls(calls)[0].input.traveler_message, "Give me a relaxed day in Tokyo.");
});

test("CASE 2: 詳細設定だけ（文章なし）でルートを作る。AI の呼び出しは1回で、条件は構造のまま渡す", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(
    request("", { destinations: ["tokyo"], budgetAmount: "15000", travelerType: "couple", foods: ["ramen"], interests: ["anime"], transportation: ["train"] }),
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(calls.ai.length, 1, "文章が無いときは、読み取りの呼び出しをしない");
  assert.equal(result.plan.planner.llmCalls, 1);
  assert.ok(calls.searches.includes("東京 ラーメン"));
  assert.ok(calls.searches.includes("東京 アニメ ショップ"));
  const input = plannerCalls(calls)[0].input;
  assert.equal(input.traveler_message, null);
  assert.deepEqual(input.soft_preferences.foods, ["Ramen"]);
  assert.deepEqual(input.soft_preferences.interests, ["Anime"]);
  assert.equal(input.hard_constraints.budget_yen, 15000);
  assert.equal(input.context.traveler_type, "Couple");
  assert.equal(input.party_size, 2);
  assert.ok(result.plan.stops.length >= 2);
  // 出力の形
  for (const stop of result.plan.stops) {
    assert.match(stop.arrival, /^\d\d:\d\d$/);
    assert.match(stop.departure, /^\d\d:\d\d$/);
    assert.ok(minutes(stop.arrival) < minutes(stop.departure));
    assert.ok(stop.evidence);
  }
  assert.equal(result.plan.currency, "JPY");
  assert.equal(result.plan.planner.promptVersion, "route-planner-v1");
  assert.ok(["pass", "warning"].includes(result.plan.validation.status));
});

test("CASE 3: チャット＋詳細設定を統合する", async () => {
  const { deps, calls } = makeDeps({ reading: { search_keywords: [] } });
  const result = await planRoute(
    request("Somewhere locals like.", { destinations: ["kyoto"], interests: ["culture", "food"], transportation: ["walking"], spotStyle: "local" }),
    deps,
  );
  assert.equal(result.ok, true);
  const input = plannerCalls(calls)[0].input;
  assert.equal(input.traveler_message, "Somewhere locals like.");
  assert.deepEqual(input.soft_preferences.interests, ["Culture", "Food"]);
  assert.equal(input.context.transport, "walk");
  assert.ok(calls.searches.includes("京都 文化体験"));
  // 「地元の人が行く場所」は確かめる手段が無いので、そう明記する
  assert.ok(result.plan.unresolvedConstraints.some((t) => t.startsWith("Local spots")));
});

test("CASE 4: 甲殻類アレルギー＋海鮮の好み → アレルギーを優先し、食い違いを記録する", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(request("", { destinations: ["tokyo"], foods: ["seafood", "ramen"], allergies: ["shellfish"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(!calls.searches.includes("東京 海鮮"), "海鮮の店は探さない");
  assert.ok(result.plan.conflicts.some((c) => c.code === "preference_vs_restriction" && c.message.includes("Seafood")));
  const input = plannerCalls(calls)[0].input;
  assert.deepEqual(input.soft_preferences.foods, ["Ramen"]);
  assert.deepEqual(input.hard_constraints.allergies, ["Shellfish"]);
  // ほかの検索に混ざった海鮮の店も、AI には渡さない
  assert.ok(input.candidates.every((c) => !/海鮮|かに|Seafood|Crab/.test(`${c.name} ${c.kind}`)));
  // 安全だとは言わない。確認できていないことを、必ず出す
  assert.ok(result.plan.warnings.some((w) => w.code === "hard_constraints_unverified" && w.message.includes("could not verify")));
  assert.ok(result.plan.stops.every((s) => s.evidence.hardConstraints === "unknown"));
  assert.ok(!/allergy[- ]safe|safe for/i.test(allText(result.plan)));
});

test("CASE 4b: 文章で海鮮を希望＋設定で甲殻類アレルギー → アレルギーを優先する", async () => {
  const { deps, calls } = makeDeps({ reading: { wanted_foods: ["seafood"] } });
  const result = await planRoute(request("I want seafood.", { destinations: ["tokyo"], allergies: ["shellfish"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(!calls.searches.includes("東京 海鮮"));
  assert.ok(result.plan.conflicts.some((c) => c.code === "message_vs_restriction"));
  assert.deepEqual(plannerCalls(calls)[0].input.soft_preferences.foods, []);
});

test("CASE 5: 豚肉なし＋ラーメンの好み → 明らかな豚の店は外し、ラーメンは「確認できていない」注意つきで残す", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(request("", { destinations: ["tokyo"], foods: ["ramen"], dietary: ["no_pork"] }), deps);
  assert.equal(result.ok, true);
  const input = plannerCalls(calls)[0].input;
  assert.ok(input.candidates.every((c) => !/とんこつ|とんかつ/.test(c.name)), "とんこつ・とんかつは候補から外す");
  const ramen = input.candidates.filter((c) => c.found_for === "Ramen");
  assert.ok(ramen.length > 0);
  assert.ok(ramen.every((c) => c.caution === "pork_possible"), "ラーメンは安全と判定せず、注意を付ける");
  const ramenStop = result.plan.stops.find((s) => s.name === "麺屋テスト");
  assert.ok(ramenStop.notes.some((n) => n.includes("could not verify")));
  assert.equal(ramenStop.evidence.hardConstraints, "unknown");
  assert.ok(result.plan.warnings.some((w) => w.code === "hard_constraints_unverified" && w.message.includes("No pork")));
});

test("CASE 6: 予算 ¥10,000 → 見積もりの合計が超えるルートは出さない", async () => {
  const costs = [6000, 5000, 3000, 1000];
  const { deps } = makeDeps({
    planner: (input) => ({
      title: "t", concept: "c", start_time: null, unmet_requests: [],
      stops: input.candidates.slice(0, 4).map((c, i) => ({ id: c.id, stay_minutes: 60, reason: "r", estimated_cost_yen: costs[i] })),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], budgetAmount: "10000", pace: "packed" }), deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.totalCostYen <= 10000, `合計 ${result.plan.totalCostYen}`);
  assert.ok(result.plan.stops.length < 4, "高い立ち寄りを外して収める");
});

test("CASE 6b: 外しても予算に収まらないときは、作り直しを1回だけ行い、それでも駄目なら出さない", async () => {
  const { deps, calls } = makeDeps({
    planner: (input) => ({
      title: "t", concept: "c", start_time: null, unmet_requests: [],
      stops: input.candidates.slice(0, 2).map((c) => ({ id: c.id, stay_minutes: 60, reason: "r", estimated_cost_yen: 9000 })),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], budgetAmount: "10000" }), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_feasible");
  assert.equal(plannerCalls(calls).length, 1 + MAX_REGENERATIONS, "作り直しは上限まで");
  assert.equal(MAX_REGENERATIONS, 1);
  // 作り直しのときは、問題を伝える
  assert.ok(plannerCalls(calls)[1].input.previous_attempt.problems.some((p) => p.includes("budget")));
  assert.equal(calls.logs[0].validation, "fail");
});

test("CASE 7: 10:00〜15:00 → 15:00 を大きく超えない", async () => {
  const { deps } = makeDeps({
    planner: (input) => ({
      title: "t", concept: "c", start_time: "09:00", unmet_requests: [],
      stops: input.candidates.slice(0, 5).map((c) => ({ id: c.id, stay_minutes: 120, reason: "r", estimated_cost_yen: null })),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], timeStart: "10:00", timeEnd: "15:00", pace: "packed" }), deps);
  assert.equal(result.ok, true);
  assert.equal(result.plan.startTime, "10:00", "開始は指定の時刻（AI の提案は使わない）");
  assert.ok(minutes(result.plan.endTime) <= 15 * 60 + 10, `終了 ${result.plan.endTime}`);
  // 時刻の順番
  result.plan.stops.forEach((stop, i) => {
    if (i > 0) assert.ok(minutes(stop.arrival) >= minutes(result.plan.stops[i - 1].departure));
  });
});

test("CASE 8: Relaxed → 立ち寄りを詰め込まない（多くても3か所、滞在は45分以上）", async () => {
  const { deps, calls } = makeDeps({
    planner: (input) => ({
      title: "t", concept: "c", start_time: null, unmet_requests: [],
      stops: input.candidates.slice(0, 6).map((c) => ({ id: c.id, stay_minutes: 20, reason: "r", estimated_cost_yen: 500 })),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], pace: "relaxed" }), deps);
  assert.equal(result.ok, true);
  assert.equal(plannerCalls(calls)[0].input.limits.max_stops, 3);
  assert.ok(result.plan.stops.length <= 3);
  assert.ok(result.plan.stops.every((s) => s.stayMinutes >= 45));
});

test("CASE 9: 営業時間を取得できない → 「営業中」と作らず、分からないまま出す", async () => {
  const unknown = Object.fromEntries(Object.entries(PLACES).map(([k, list]) => [k, list.map((p) => ({ ...p, openingPeriods: null }))]));
  const { deps, calls } = makeDeps({ places: unknown });
  const result = await planRoute(request("", { destinations: ["tokyo"], foods: ["ramen"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(plannerCalls(calls)[0].input.candidates.every((c) => c.open === "unknown"));
  assert.ok(result.plan.stops.every((s) => s.openingHours === null && s.evidence.openingHours === "unknown"));
  assert.ok(result.plan.stops.every((s) => s.notes.some((n) => n.startsWith("Opening hours not available"))));
  assert.ok(result.plan.warnings.some((w) => w.code === "opening_hours_unknown" && w.message.includes("not confirmed to be open")));
  assert.equal(result.plan.validation.status, "warning");
  assert.ok(result.plan.validation.issues.some((i) => i.code === "opening_hours_unknown"));
});

test("CASE 9b: 地図検索がすべて失敗 → 場所を作らず、エラーを返す", async () => {
  const { deps, calls } = makeDeps({ searchFails: true });
  const result = await planRoute(request("", { destinations: ["tokyo"], foods: ["ramen"] }), deps);
  assert.deepEqual([result.ok, result.error], [false, "places_failed"]);
  assert.equal(calls.ai.length, 0, "場所が無いのに AI を呼ばない");
});

test("CASE 9c: 営業時間が分かる場所は、その時間に収める（休みの日の場所は候補にしない）", async () => {
  const places = {
    ...PLACES,
    ラーメン: [
      place("夜だけ麺", "Ramen restaurant", { openingPeriods: daily(18, 23) }),
      place("昼の麺", "Ramen restaurant", { openingPeriods: daily(11, 15) }),
      // 火曜（2）が休み
      place("火曜休み麺", "Ramen restaurant", { openingPeriods: daily(11, 21).filter((p) => p.openDay !== 2) }),
    ],
  };
  const { deps, calls } = makeDeps({
    places,
    planner: (input) => ({
      title: "t", concept: "c", start_time: "10:00", unmet_requests: [],
      stops: input.candidates.filter((c) => c.found_for === "Ramen").map((c) => ({ id: c.id, stay_minutes: 60, reason: "r", estimated_cost_yen: 1000 }))
        .concat(input.candidates.filter((c) => c.type === "activity").slice(0, 1).map((c) => ({ id: c.id, stay_minutes: 60, reason: "r", estimated_cost_yen: 0 }))),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], foods: ["ramen"], timeStart: "10:00", timeEnd: "16:00" }), deps);
  assert.equal(result.ok, true);
  const names = plannerCalls(calls)[0].input.candidates.map((c) => c.name);
  assert.ok(!names.includes("火曜休み麺"), "その日が休みの場所は候補にしない");
  assert.ok(!result.plan.stops.some((s) => s.name === "夜だけ麺"), "営業時間に収まらない場所は外す");
  const lunch = result.plan.stops.find((s) => s.name === "昼の麺");
  assert.ok(lunch && minutes(lunch.arrival) >= 11 * 60 && minutes(lunch.departure) <= 15 * 60);
  assert.equal(lunch.openingHours, "11:00–15:00");
  assert.equal(lunch.evidence.openingHours, "external");
});

test("CASE 10: MICHI 独自データが無くても、普通に作れる", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(request("", { destinations: ["tokyo"], interests: ["culture"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(plannerCalls(calls)[0].input.candidates.every((c) => c.michi === null));
  assert.ok("michi_data_fetch_ms" in result.plan.planner.timings);
});

test("CASE 10b: MICHI 独自データの取得に失敗しても、止まらない", async () => {
  const { deps } = makeDeps();
  deps.michi = { placeData: async () => { throw new Error("db down"); }, routes: async () => [] };
  const result = await planRoute(request("", { destinations: ["tokyo"], interests: ["culture"] }), deps);
  assert.equal(result.ok, true);
});

test("CASE 11: 文章「ラーメンは要らない」＋設定でラーメン → 食い違いを見つけて知らせ、ラーメンを外す", async () => {
  const { deps, calls } = makeDeps({ reading: { rejected_foods: ["ramen"] } });
  const result = await planRoute(request("I don't want ramen.", { destinations: ["tokyo"], foods: ["ramen"], interests: ["anime"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.conflicts.some((c) => c.code === "message_rejects_selected" && c.message.includes("Ramen")));
  const input = plannerCalls(calls)[0].input;
  assert.deepEqual(input.soft_preferences.foods, []);
  assert.ok(input.hard_constraints.exclusions.includes("Ramen"));
  assert.ok(input.candidates.every((c) => !/ラーメン|らーめん|麺屋|Ramen/.test(`${c.name} ${c.kind} ${c.found_for}`)));
  assert.ok(!result.plan.stops.some((s) => /Ramen/.test(s.category ?? "")));
});

test("CASE 11b: 設定同士の食い違い（夜の街が興味にも、避けたいことにもある）", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(request("", { destinations: ["tokyo"], interests: ["nightlife", "culture"], avoid: ["nightlife"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.conflicts.some((c) => c.code === "avoid_vs_interest"));
  assert.ok(plannerCalls(calls)[0].input.candidates.every((c) => !/Bar|居酒屋/.test(`${c.name} ${c.kind}`)));
});

test("CASE 12: 少ない入力（Tokyo・Food）でも、仮定を明記して作る", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(request("", { destinations: ["tokyo"], interests: ["food"] }), deps);
  assert.equal(result.ok, true);
  const text = result.plan.assumptions.join(" | ");
  assert.match(text, /No date was set.*2026-10-06 \(Tuesday\)/);
  assert.match(text, /No start time was set/);
  assert.match(text, /number of travelers was not set/);
  assert.match(text, /No transportation was set/);
  // 指定に無い候補（観光など）を足したことも、仮定として出す
  assert.match(text, /general options you did not ask for/);
  const general = plannerCalls(calls)[0].input.candidates.filter((c) => !c.requested);
  assert.ok(general.length > 0);
});

test("行き先も無い設定だけの依頼は、行き先を仮に決めて作る（何も聞き返さない）", async () => {
  const { deps } = makeDeps();
  const result = await planRoute(request("", { foods: ["ramen"] }), deps);
  assert.equal(result.ok, true);
  assert.ok(result.plan.assumptions.some((a) => a.includes("No destination was set")));
});

test("作り直し: 検証で fail のときだけ、1回だけ作り直す", async () => {
  const { deps, calls } = makeDeps({
    planner: (input, count) =>
      count === 1
        ? { title: "t", concept: "c", start_time: null, unmet_requests: [], stops: [{ id: "p999", stay_minutes: 60, reason: "r", estimated_cost_yen: 0 }] }
        : { title: "t", concept: "c", start_time: null, unmet_requests: [], stops: input.candidates.slice(0, 3).map((c) => ({ id: c.id, stay_minutes: 60, reason: "r", estimated_cost_yen: 0 })) },
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], interests: ["culture"] }), deps);
  assert.equal(result.ok, true);
  assert.equal(plannerCalls(calls).length, 2);
  assert.equal(result.plan.planner.regenerations, 1);
  assert.ok(!result.plan.stops.some((s) => s.placeId === "p999"), "候補に無い場所は捨てる");
});

test("作り直し: 最初から検証を通れば、AI は1回だけ", async () => {
  const { deps, calls } = makeDeps();
  const result = await planRoute(request("", { destinations: ["tokyo"], interests: ["culture"] }), deps);
  assert.equal(plannerCalls(calls).length, 1);
  assert.equal(result.plan.planner.regenerations, 0);
});

test("必ず行きたい場所: 見つかれば候補に入り、見つからなければそう知らせる", async () => {
  const { deps, calls } = makeDeps({
    planner: (input) => ({
      title: "t", concept: "c", start_time: null, unmet_requests: [],
      stops: [...input.candidates.filter((c) => c.must_visit), ...input.candidates.filter((c) => !c.must_visit).slice(0, 2)].map((c) => ({ id: c.id, stay_minutes: 60, reason: "r", estimated_cost_yen: 0 })),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], mustVisit: "浅草寺, 存在しない場所" }), deps);
  assert.equal(result.ok, true);
  assert.ok(plannerCalls(calls)[0].input.candidates.some((c) => c.must_visit && c.name === "浅草寺"));
  assert.ok(result.plan.stops.some((s) => s.name === "浅草寺"));
  assert.ok(result.plan.warnings.some((w) => w.code === "must_visit_not_found" && w.message.includes("存在しない場所")));
});

test("個人情報: AI に渡すのは旅行の条件と候補だけ。ログに文章やアレルギーの中身を残さない", async () => {
  const { deps, calls } = makeDeps({ reading: {} });
  await planRoute(request("My email is someone@example.com, plan a day.", { destinations: ["tokyo"], allergies: ["peanuts"], allergiesOther: "kiwi" }), deps);
  const input = plannerCalls(calls)[0].input;
  assert.deepEqual(Object.keys(input).sort(), ["candidates", "context", "hard_constraints", "limits", "output_language", "party_size", "plan_window", "previous_attempt", "soft_preferences", "traveler_message"].sort());
  const log = JSON.stringify(calls.logs[0]);
  assert.ok(!log.includes("example.com") && !log.includes("kiwi") && !log.includes("peanut"));
  assert.equal(calls.logs[0].request.hard_constraint_count, 2);
  assert.equal(calls.logs[0].prompt_version, "route-planner-v1");
  for (const key of ["trip_request_ms", "candidate_fetch_ms", "michi_data_fetch_ms", "ai_generation_ms", "validation_ms", "total_ms"]) {
    assert.equal(typeof calls.logs[0].timings[key], "number", key);
  }
});

test("速度: 検索は多くても5件で、並列に始める。同じ検索を2回しない", async () => {
  const { deps, calls } = makeDeps({ reading: { search_keywords: [{ keyword: "相撲", kind: "activity", label: "sumo" }] } });
  let running = 0;
  let peak = 0;
  const original = deps.searchPlaces;
  deps.searchPlaces = async (query, language) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return original(query, language);
  };
  const result = await planRoute(
    request("I'd like to see sumo.", { destinations: ["tokyo"], foods: ["ramen", "sushi", "cafe"], interests: ["anime", "culture", "art", "history"] }),
    deps,
  );
  assert.equal(result.ok, true);
  assert.ok(calls.searches.length <= 6, `検索 ${calls.searches.length} 件`);
  assert.equal(new Set(calls.searches).size, calls.searches.length);
  assert.ok(peak >= 2, "検索は並列");
  assert.ok(calls.searches.includes("東京 相撲"), "文章に書かれた希望も検索する");
  // 検索の枠に入らなかった条件は、探せていないと知らせる
  assert.ok(result.plan.unresolvedConstraints.length > 0);
});

test("Prompt: 版が分かり、利用者の希望として混ざりそうな例文を含まない", () => {
  assert.equal(ACTIVE_PROMPTS.planner.version, "route-planner-v1");
  assert.equal(ACTIVE_PROMPTS.interpreter.version, "interpret-request-v1");
  for (const prompt of [ACTIVE_PROMPTS.planner, ACTIVE_PROMPTS.interpreter]) {
    assert.ok(!/night view|city view|夜景|展望|you asked for|you requested/i.test(prompt.system), prompt.version);
    assert.ok(!/札幌|Sapporo|Otaru|小樽/.test(prompt.system), prompt.version);
  }
  const system = ACTIVE_PROMPTS.planner.system;
  for (const phrase of [
    "You are MICHI Route Planner.",
    "valid route request",
    "Hard constraints always override soft preferences",
    "Never invent current facts",
    "Prefer an executable route over an impressive-looking one",
    "Do not maximize the number of places",
  ]) assert.ok(system.includes(phrase), phrase);
});

test("営業時間の読み取り: 分からない・休み・営業・深夜まで・24時間", () => {
  assert.deepEqual(dayHours(null, 2), { status: "unknown" });
  assert.deepEqual(dayHours(undefined, 2), { status: "unknown" });
  assert.deepEqual(dayHours(daily(11, 21).filter((p) => p.openDay !== 2), 2), { status: "closed" });
  assert.deepEqual(dayHours(daily(11, 21), 2), { status: "open", periods: [[660, 1260]] });
  assert.deepEqual(dayHours([{ openDay: 2, openMinute: 18 * 60, closeDay: 3, closeMinute: 2 * 60 }], 2), { status: "open", periods: [[1080, 1560]] });
  assert.deepEqual(dayHours([{ openDay: 0, openMinute: 0, closeDay: null, closeMinute: null }], 4), { status: "open", periods: [[0, 1440]] });
});

test("安全性の作り話: AI が「豚肉なし」「アレルギーでも安全」と書いても、その文は使わない", async () => {
  const { deps } = makeDeps({
    planner: (input) => ({
      title: "Pork-free ramen day",
      concept: "A day that is safe for your shellfish allergy.",
      start_time: null,
      unmet_requests: ["Ramen without pork (all candidates caution 'pork_possible')", "A quiet garden"],
      stops: input.candidates.slice(0, 3).map((c, i) => ({
        id: c.id,
        stay_minutes: 60,
        reason: i === 0 ? "Enjoy ramen without pork, matching your dietary restrictions." : "Walk around the area.",
        estimated_cost_yen: 1000,
      })),
    }),
  });
  const result = await planRoute(request("", { destinations: ["tokyo"], foods: ["ramen"], dietary: ["no_pork"], allergies: ["shellfish"] }), deps);
  assert.equal(result.ok, true);
  assert.equal(result.plan.title, "Tokyo route");
  assert.equal(result.plan.summary, "");
  assert.equal(result.plan.stops[0].description, "Stop for Ramen.");
  assert.equal(result.plan.stops[1].description, "Walk around the area.");
  assert.deepEqual(result.plan.unresolvedConstraints.filter((t) => /pork|caution/i.test(t)), []);
  assert.ok(result.plan.unresolvedConstraints.includes("A quiet garden"));
  assert.ok(result.plan.validation.issues.some((i) => i.code === "ai_text_replaced"));
  // 決まった注意文は残る
  assert.ok(result.plan.warnings.some((w) => w.code === "hard_constraints_unverified"));
});

test("徒歩のみ: 歩いて回れる1つのエリアの候補だけを AI に渡す", async () => {
  const at = (name, category, lat, lng) => ({ ...place(name, category), latitude: lat, longitude: lng });
  const places = {
    文化体験: [at("近い寺", "Temple", 35.0, 135.76), at("遠い寺", "Temple", 35.09, 135.68), at("近い工房", "Cultural center", 35.004, 135.762)],
    ランチ: [at("近い食堂", "Restaurant", 35.002, 135.761), at("遠い食堂", "Restaurant", 35.1, 135.69), at("近いそば", "Restaurant", 35.006, 135.764)],
    カフェ: [at("近い喫茶", "Cafe", 35.003, 135.758)],
  };
  const { deps, calls } = makeDeps({ places });
  const result = await planRoute(request("", { destinations: ["kyoto"], interests: ["culture"], transportation: ["walking"] }), deps);
  assert.equal(result.ok, true);
  const names = plannerCalls(calls)[0].input.candidates.map((c) => c.name);
  assert.ok(names.length >= 4 && names.every((n) => n.startsWith("近い")), names.join(","));
  assert.ok(result.plan.legs.every((leg) => leg.mode === "walk" && leg.minutes <= 30));
  assert.ok(result.plan.assumptions.some((a) => a.includes("one walkable area")));
});

test("文章の行き先: 検索は日本語の地名、表示はプランの文章の言語", async () => {
  const { deps, calls } = makeDeps({ reading: { area: "札幌市", area_label: "Sapporo" } });
  const result = await planRoute(request("Half a day in Sapporo."), deps);
  assert.equal(result.ok, true);
  assert.ok(calls.searches.every((q) => q.startsWith("札幌市 ")));
  assert.equal(result.plan.conditions.area, "Sapporo");
});

test("確認していない評判（地元の人に人気 など）を、AI の文として出さない", async () => {
  const { deps } = makeDeps({
    reading: {},
    planner: (input) => ({
      title: "Tokyo food day",
      concept: "A relaxed day at cafes favored by locals in Tokyo.",
      start_time: null,
      unmet_requests: [],
      stops: input.candidates.slice(0, 3).map((c, i) => ({ id: c.id, stay_minutes: 60, reason: i === 0 ? "A local favorite for lunch." : "Coffee break.", estimated_cost_yen: 1000 })),
    }),
  });
  const result = await planRoute(request("I want somewhere locals actually go.", { destinations: ["tokyo"], interests: ["food"] }), deps);
  assert.equal(result.ok, true);
  assert.equal(result.plan.summary, "");
  assert.ok(!/local favorite|favored by locals/i.test(JSON.stringify(result.plan.stops)));
  assert.equal(result.plan.stops[1].description, "Coffee break.");
});
