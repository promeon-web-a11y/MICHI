// Unit tests for supabase/functions/route-plan/route.ts
// Run: npm run test:functions   (Node >= 23.6 strips TypeScript types natively)
// The Google Routes API is never called: a mocked ComputeRoute returns responses shaped like the
// official REST reference (routes[].duration "123s", legs[].steps[].transitDetails, travelAdvisory.transitFare Money).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowedTransitModes,
  buildRoutedPlan,
  buildRoutesRequest,
  chooseLegRoute,
  classifyFetchFailure,
  classifyRoutesResponse,
  type ComputeRoute,
  departureFrom,
  fitIntoDuration,
  type LoadedPlan,
  minStayMinutes,
  parseDuration,
  parseMoney,
  parseRouteRequest,
  parseRoutesResponse,
  ROUTES_FIELD_MASK,
  routeCallLogEntry,
  routeDiagnosticsSummary,
  type RouteMode,
  routeLegs,
  sanitizeForLog,
  summarizeBudget,
  summarizeFares,
  toLoadedPlan,
  type TransportMode,
} from "../../supabase/functions/route-plan/route.ts";

const NOW = new Date("2026-09-26T01:00:20.000Z"); // 10:00:20 JST → departure 10:01

// The tests written for Step 4-6 describe the behaviour with Routes TRANSIT switched ON
// (ENABLE_GOOGLE_TRANSIT=true). They stay valid for re-enabling it later. The Japan MVP default (OFF)
// is tested in "日本 MVP: TRANSIT を問い合わせない" below with the plain functions.
const T = { enableTransit: true };
const chooseLegRouteT = (...a: Parameters<typeof chooseLegRoute>) => chooseLegRoute(a[0], a[1], a[2], a[3], a[4], T);
const routeLegsT = (p: LoadedPlan, o: { latitude: number; longitude: number }, d: Date, c: ComputeRoute, clock?: () => number) =>
  routeLegs(p, o, d, c, clock, T);
const buildRoutedPlanT = (p: LoadedPlan, o: { latitude: number; longitude: number }, n: Date, c: ComputeRoute, clock?: () => number) =>
  buildRoutedPlan(p, o, n, c, clock, T);
const ORIGIN = { latitude: 43.0687, longitude: 141.3508 };
const PLAN_ID = "2687aac6-0000-4000-8000-000000000001";

// ---- Routes API response fixtures (official field names) -----------------------------------
const walkJson = (seconds: number, meters = seconds * 1.3) => ({
  routes: [{
    duration: `${seconds}s`,
    distanceMeters: Math.round(meters),
    polyline: { encodedPolyline: "abc" },
    legs: [{ steps: [
      { travelMode: "WALK", staticDuration: `${Math.round(seconds / 2)}s`, distanceMeters: Math.round(meters / 2) },
      { travelMode: "WALK", staticDuration: `${seconds - Math.round(seconds / 2)}s`, distanceMeters: Math.round(meters / 2) },
    ] }],
  }],
});
const driveJson = (seconds: number) => ({
  routes: [{ duration: `${seconds}s`, distanceMeters: seconds * 8, legs: [{ steps: [{ travelMode: "DRIVE", staticDuration: `${seconds}s`, distanceMeters: seconds * 8 }] }] }],
});
function transitJson(seconds: number, opts: { fare?: unknown; transfers?: boolean; depart?: Date } = {}) {
  const depart = opts.depart ?? new Date("2026-09-26T01:01:00Z");
  const at = (m: number) => new Date(depart.getTime() + m * 60_000).toISOString();
  const ride = (line: string, from: string, to: string, s: number, e: number, type = "SUBWAY") => ({
    travelMode: "TRANSIT",
    staticDuration: `${(e - s) * 60}s`,
    distanceMeters: 3000,
    transitDetails: {
      stopDetails: { departureStop: { name: from }, arrivalStop: { name: to }, departureTime: at(s), arrivalTime: at(e) },
      headsign: "真駒内",
      stopCount: 4,
      transitLine: { name: line, nameShort: "N", color: "#00a650", vehicle: { type, name: { text: "地下鉄" } }, agencies: [{ name: "札幌市交通局" }] },
    },
  });
  const steps = [
    { travelMode: "WALK", staticDuration: "300s", distanceMeters: 350 },
    ride("南北線", "さっぽろ", "大通", 7, 9),
    ...(opts.transfers ? [{ travelMode: "WALK", staticDuration: "180s", distanceMeters: 150 }, ride("東西線", "大通", "西11丁目", 13, 16)] : []),
    { travelMode: "WALK", staticDuration: "240s", distanceMeters: 250 },
  ];
  return {
    routes: [{
      duration: `${seconds}s`,
      distanceMeters: 4200,
      legs: [{ steps }],
      ...(opts.fare === undefined ? {} : { travelAdvisory: { transitFare: opts.fare } }),
    }],
  };
}

type Script = Partial<Record<RouteMode, unknown | "timeout" | "error" | "none">>;
/** Mock ComputeRoute: per leg (0-based) and mode */
function mockCompute(legs: Script[]) {
  const calls: { mode: RouteMode; leg: number; departure: string }[] = [];
  const legOf = (to: { latitude: number }) => STOPS.findIndex((s) => s.latitude === to.latitude);
  const compute: ComputeRoute = async (mode, _from, to, departure) => {
    const leg = legOf(to);
    calls.push({ mode, leg, departure: departure.toISOString() });
    const v = legs[leg]?.[mode];
    // Same classification path as index.ts (HTTP status + body text)
    if (v === undefined || v === "none") return classifyRoutesResponse(mode, 200, "{}");
    if (v === "timeout") return classifyFetchFailure(mode, true, "TimeoutError");
    if (v === "error") return classifyRoutesResponse(mode, 500, JSON.stringify({ error: { code: 500, message: "Internal error", status: "INTERNAL" } }));
    return classifyRoutesResponse(mode, 200, JSON.stringify(v));
  };
  return { compute, calls };
}

const STOPS = [
  { place_id: "p1", google_place_id: "ChIJ1", name: "THE BUTTER", category: "cafe", address: "札幌市中央区", latitude: 43.06, longitude: 141.35, stay_minutes: 60 },
  { place_id: "p2", google_place_id: "ChIJ2", name: "パフェ佐藤", category: "cafe", address: "札幌市中央区", latitude: 43.061, longitude: 141.352, stay_minutes: 45 },
  { place_id: "p3", google_place_id: null, name: "大通公園", category: "sightseeing", address: "札幌市中央区", latitude: 43.059, longitude: 141.345, stay_minutes: 40 },
];

function plan(overrides: Partial<LoadedPlan> = {}): LoadedPlan {
  return {
    id: PLAN_ID,
    status: "accepted",
    durationMinutes: 180,
    budgetYen: 3000,
    transportModes: ["walking", "train", "bus"],
    placesBudgetYen: 2000,
    placesBudgetStatus: "estimated",
    stops: STOPS.slice(0, 2).map((s) => ({ ...s })),
    ...overrides,
  };
}

const planRow = (overrides: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  status: "accepted",
  estimated_budget: 3000,
  condition_json: {
    source: "mobile_plan_options",
    duration_minutes: 180,
    budget_yen: 3000,
    transport_modes: ["walking", "train", "bus"],
    option: { budget_status: "estimated" },
  },
  ...overrides,
});
const itemRow = (seq: number, stop: (typeof STOPS)[number]) => ({
  sequence: seq,
  stay_minutes: stop.stay_minutes,
  places: { id: stop.place_id, name: stop.name, category: stop.category, address: stop.address, latitude: String(stop.latitude), longitude: String(stop.longitude), provider: "google", provider_place_id: stop.google_place_id },
});

// ---------------------------------------------------------------------------------------------
describe("request / plan validation", () => {
  it("plan_id と origin が必要（user_id は受け取らない）", () => {
    assert.deepEqual(parseRouteRequest({ plan_id: PLAN_ID, origin: ORIGIN, user_id: "someone" }), { ok: true, value: { planId: PLAN_ID, origin: ORIGIN } });
    assert.deepEqual(parseRouteRequest({ plan_id: "x", origin: ORIGIN }), { ok: false, error: "plan_id_required" });
    assert.deepEqual(parseRouteRequest({ plan_id: PLAN_ID }), { ok: false, error: "origin_required" });
    assert.deepEqual(parseRouteRequest({ plan_id: PLAN_ID, origin: { latitude: 0, longitude: 0 } }), { ok: false, error: "origin_required" });
    assert.deepEqual(parseRouteRequest(null), { ok: false, error: "invalid_body" });
  });

  it("19. accepted plan を読み込む（並び順・数値化）", () => {
    const r = toLoadedPlan(planRow(), [itemRow(2, STOPS[1]), itemRow(1, STOPS[0])]);
    assert.ok(r.ok === true);
    assert.deepEqual(r.plan.stops.map((s) => s.name), ["THE BUTTER", "パフェ佐藤"]);
    assert.equal(r.plan.stops[0].latitude, 43.06);
    assert.equal(r.plan.stops[0].google_place_id, "ChIJ1");
    assert.deepEqual(r.plan.transportModes, ["walking", "train", "bus"]);
  });

  it("20. generated（未選択）の plan は拒否", () => {
    assert.deepEqual(toLoadedPlan(planRow({ status: "generated" }), [itemRow(1, STOPS[0])]), { ok: false, error: "plan_not_accepted" });
  });

  it("21. 他ユーザーの plan（RLS で行が返らない）→ plan_not_found", () => {
    assert.deepEqual(toLoadedPlan(null, []), { ok: false, error: "plan_not_found" });
  });

  it("旧 generate-plan のプラン・座標なし・項目なしは対象外", () => {
    assert.deepEqual(toLoadedPlan(planRow({ condition_json: { travel_mode: "walk" } }), [itemRow(1, STOPS[0])]), { ok: false, error: "unsupported_plan" });
    const noLoc = { ...itemRow(1, STOPS[0]), places: { ...itemRow(1, STOPS[0]).places, latitude: null } };
    assert.deepEqual(toLoadedPlan(planRow(), [noLoc]), { ok: false, error: "place_without_location" });
    assert.deepEqual(toLoadedPlan(planRow(), []), { ok: false, error: "plan_has_no_items" });
  });
});

describe("Routes API request / response", () => {
  it("TRANSIT は departureTime と allowedTravelModes、routingPreference なし", () => {
    const b = buildRoutesRequest("TRANSIT", ORIGIN, STOPS[0], new Date("2026-09-26T01:01:00Z"), ["walking", "train", "bus"]) as any;
    assert.equal(b.travelMode, "TRANSIT");
    assert.equal(b.departureTime, "2026-09-26T01:01:00.000Z");
    assert.deepEqual(b.transitPreferences.allowedTravelModes, ["SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL", "BUS"]);
    assert.equal(b.routingPreference, undefined);
    assert.equal(b.languageCode, "ja");
    assert.deepEqual(b.origin, { location: { latLng: ORIGIN } });
  });

  it("WALK は routingPreference / departureTime なし、DRIVE は TRAFFIC_UNAWARE（Essentials）", () => {
    const w = buildRoutesRequest("WALK", ORIGIN, STOPS[0], NOW, ["walking"]) as any;
    assert.equal(w.routingPreference, undefined);
    assert.equal(w.departureTime, undefined);
    const d = buildRoutesRequest("DRIVE", ORIGIN, STOPS[0], NOW, ["car"]) as any;
    assert.equal(d.routingPreference, "TRAFFIC_UNAWARE");
  });

  it("allowedTransitModes", () => {
    assert.deepEqual(allowedTransitModes(["bus"]), ["BUS"]);
    assert.deepEqual(allowedTransitModes(["train"]), ["SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"]);
  });

  it("Field Mask は必要な項目だけ", () => {
    assert.ok(ROUTES_FIELD_MASK.includes("routes.legs.steps.transitDetails"));
    assert.ok(ROUTES_FIELD_MASK.includes("routes.travelAdvisory.transitFare"));
    assert.ok(!ROUTES_FIELD_MASK.includes("*"));
    assert.ok(!ROUTES_FIELD_MASK.includes("navigationInstruction"));
  });

  it("parseDuration / parseMoney（units は int64 文字列もある）", () => {
    assert.equal(parseDuration("165s"), 165);
    assert.equal(parseDuration("1.6s"), 2);
    assert.equal(parseDuration(undefined), null);
    assert.deepEqual(parseMoney({ currencyCode: "JPY", units: "290" }), { amount: 290, currency: "JPY" });
    assert.deepEqual(parseMoney({ currencyCode: "USD", units: "2", nanos: 500000000 }), { amount: 2.5, currency: "USD" });
    assert.equal(parseMoney(null), null);
    assert.equal(parseMoney({ units: "290" }), null);
  });

  it("3・10. 公共交通の応答: 徒歩をまとめ、路線・駅・時刻・乗換を取り出す", () => {
    const r = parseRoutesResponse(transitJson(1260, { transfers: true, fare: { currencyCode: "JPY", units: "290" } }), "TRANSIT")!;
    assert.equal(r.duration_seconds, 1260);
    assert.deepEqual(r.steps.map((s) => s.kind), ["walk", "transit", "walk", "transit", "walk"]);
    const ride = r.steps[1] as any;
    assert.deepEqual(
      [ride.line_name, ride.departure_stop, ride.arrival_stop, ride.vehicle_type, ride.agency, ride.headsign, ride.stop_count],
      ["南北線", "さっぽろ", "大通", "SUBWAY", "札幌市交通局", "真駒内", 4],
    );
    assert.equal(ride.departure_at, "2026-09-26T01:08:00.000Z");
    assert.deepEqual(r.fare, { amount: 290, currency: "JPY" });
  });

  it("1. 徒歩の応答: 連続する徒歩ステップを1つにまとめる", () => {
    const r = parseRoutesResponse(walkJson(600, 780), "WALK")!;
    assert.deepEqual(r.steps, [{ kind: "walk", duration_seconds: 600, distance_meters: 780 }]);
    assert.equal(r.fare, null);
  });

  it("11. 経路なし（空の応答）→ null", () => {
    assert.equal(parseRoutesResponse({}, "TRANSIT"), null);
    assert.equal(parseRoutesResponse({ routes: [] }, "WALK"), null);
  });
});

describe("区間ごとの移動手段の選択", () => {
  const leg0 = (script: Script) => mockCompute([script]);

  it("1. 徒歩15分以内なら徒歩（他の API は呼ばない）", async () => {
    const { compute, calls } = leg0({ WALK: walkJson(600), TRANSIT: transitJson(900) });
    const r = await chooseLegRouteT(["walking", "train"], ORIGIN, STOPS[0], NOW, compute);
    assert.ok(r.ok === true);
    assert.equal(r.route.mode, "WALK");
    assert.deepEqual(calls.map((c) => c.mode), ["WALK"]);
  });

  it("4. 徒歩が長ければ公共交通（徒歩区間を含む）", async () => {
    const { compute } = leg0({ WALK: walkJson(2400), TRANSIT: transitJson(1260) });
    const r = await chooseLegRouteT(["walking", "train", "bus"], ORIGIN, STOPS[0], NOW, compute);
    assert.ok(r.ok === true);
    assert.equal(r.route.mode, "TRANSIT");
    assert.deepEqual(r.alternatives, [{ mode: "WALK", duration_seconds: 2400 }]);
  });

  it("2. 車のみ", async () => {
    const { compute, calls } = leg0({ DRIVE: driveJson(600) });
    const r = await chooseLegRouteT(["car"], ORIGIN, STOPS[0], NOW, compute);
    assert.ok(r.ok === true);
    assert.equal(r.route.mode, "DRIVE");
    assert.deepEqual(calls.map((c) => c.mode), ["DRIVE"]);
  });

  it("公共交通と車が両方あれば速い方", async () => {
    const { compute } = leg0({ TRANSIT: transitJson(1500), DRIVE: driveJson(700) });
    const r = await chooseLegRouteT(["train", "car"], ORIGIN, STOPS[0], NOW, compute);
    assert.equal(r.ok === true && r.route.mode, "DRIVE");
  });

  it("公共交通の経路が無い（日本で TRANSIT が返らない場合も）→ 徒歩へ、transit_status=no_route", async () => {
    const { compute } = leg0({ WALK: walkJson(2400), TRANSIT: "none" });
    const r = await chooseLegRouteT(["walking", "train"], ORIGIN, STOPS[0], NOW, compute);
    assert.ok(r.ok === true);
    assert.equal(r.route.mode, "WALK");
    assert.equal(r.transitStatus, "no_route");
    assert.deepEqual(r.diagnostics.map((d) => [d.mode, d.status, d.http_status]), [["WALK", "ok", 200], ["TRANSIT", "no_route", 200]]);
  });

  it("TRANSIT が API エラーなら徒歩へ、transit_status=api_error（見つからない と 取得できない を区別）", async () => {
    const r = await chooseLegRouteT(["walking", "train"], ORIGIN, STOPS[0], NOW, leg0({ WALK: walkJson(2400), TRANSIT: "error" }).compute);
    assert.ok(r.ok === true);
    assert.equal(r.transitStatus, "api_error");
  });

  it("徒歩15分以内なら TRANSIT は not_requested", async () => {
    const r = await chooseLegRouteT(["walking", "train"], ORIGIN, STOPS[0], NOW, leg0({ WALK: walkJson(600) }).compute);
    assert.equal(r.transitStatus, "not_requested");
  });

  it("11・12・13. 経路なし / API 失敗 / タイムアウト", async () => {
    const reasonOf = async (v: unknown) => {
      const r = await chooseLegRouteT(["train"], ORIGIN, STOPS[0], NOW, leg0({ TRANSIT: v }).compute);
      assert.equal(r.ok, false);
      return [!r.ok && r.reason, r.transitStatus];
    };
    assert.deepEqual(await reasonOf("none"), ["no_route", "no_route"]);
    assert.deepEqual(await reasonOf("error"), ["api_error", "api_error"]);
    assert.deepEqual(await reasonOf("timeout"), ["timeout", "timeout"]);
  });
});

describe("時刻の再計算・複数区間", () => {
  it("5・6・7. origin→Place1→Place2 を実際の所要時間で並べ、各区間の出発時刻で問い合わせる", async () => {
    const dep = departureFrom(NOW);
    assert.equal(dep.toISOString(), "2026-09-26T01:01:00.000Z");
    const { compute, calls } = mockCompute([{ WALK: walkJson(2400), TRANSIT: transitJson(1260, { fare: { currencyCode: "JPY", units: "290" } }) }, { WALK: walkJson(300) }]);
    const { legs, stops } = await routeLegsT(plan(), ORIGIN, dep, compute);
    // leg 0: 10:01 発 → 21分 → 10:22 着、60分滞在 → 11:22 発
    assert.equal(legs[0].mode, "TRANSIT");
    assert.equal(legs[0].arrival_at, "2026-09-26T01:22:00.000Z");
    assert.equal(stops[0].arrival_at, "2026-09-26T01:22:00.000Z");
    assert.equal(stops[0].leave_at, "2026-09-26T02:22:00.000Z");
    // leg 1: Place1 → Place2 は 11:22 に問い合わせ、徒歩5分
    assert.equal(calls.find((c) => c.leg === 1)!.departure, "2026-09-26T02:22:00.000Z");
    assert.equal(legs[1].mode, "WALK");
    assert.equal(legs[1].from_name, "THE BUTTER");
    assert.equal(stops[1].arrival_at, "2026-09-26T02:27:00.000Z");
    assert.equal(legs[0].fare_status, "known");
    assert.equal(legs[1].fare_status, "not_applicable");
  });

  it("14. 一部区間の失敗: 経路は作らず、その後の時刻は不確定として扱う", async () => {
    const { compute } = mockCompute([{ WALK: walkJson(600) }, { WALK: "error" }]);
    const { legs, stops } = await routeLegsT(plan(), ORIGIN, departureFrom(NOW), compute);
    assert.equal(legs[0].status, "ok");
    assert.equal(legs[1].status, "failed");
    assert.equal(legs[1].failure_reason, "api_error");
    assert.equal(legs[1].duration_minutes, null);
    assert.equal(stops[1].arrival_at, null);
  });

  it("全体の時間切れ後の区間は呼ばない", async () => {
    let t = 0;
    const { compute, calls } = mockCompute([{ WALK: walkJson(600) }, { WALK: walkJson(600) }]);
    const slow: ComputeRoute = async (...args) => {
      t += 50_000;
      return compute(...args);
    };
    const { legs } = await routeLegsT(plan(), ORIGIN, departureFrom(NOW), slow, () => t);
    assert.equal(legs[1].failure_reason, "deadline_exceeded");
    assert.equal(calls.length, 1);
  });
});

describe("duration_minutes への収め方", () => {
  async function routed(p: LoadedPlan, script: Script[]) {
    const dep = departureFrom(NOW);
    const { legs, stops } = await routeLegsT(p, ORIGIN, dep, mockCompute(script).compute);
    return fitIntoDuration(legs, stops, dep, p.durationMinutes);
  }

  it("15. 時間内ならそのまま", async () => {
    const r = await routed(plan(), [{ WALK: walkJson(600) }, { WALK: walkJson(300) }]);
    assert.equal(r.status, "fits");
    assert.equal(r.total_minutes, 10 + 60 + 5 + 45);
  });

  it("16a. 超過: 最後の場所の滞在を縮めて収める（他の時刻は変えない）", async () => {
    const r = await routed(plan({ durationMinutes: 100 }), [{ WALK: walkJson(600) }, { WALK: walkJson(300) }]);
    assert.equal(r.status, "adjusted");
    assert.deepEqual(r.adjustments, [{ type: "shortened_stay", place_id: "p2", place_name: "パフェ佐藤", from_minutes: 45, to_minutes: 25 }]);
    assert.equal(r.total_minutes, 100);
    assert.equal(r.stops[0].stay_minutes, 60, "前の場所は変えない");
  });

  it("16b. 縮めても入らなければ最後の場所を外す", async () => {
    const r = await routed(plan({ durationMinutes: 80 }), [{ WALK: walkJson(600) }, { WALK: walkJson(300) }]);
    assert.equal(r.status, "adjusted");
    assert.deepEqual(r.adjustments.map((a) => a.type), ["dropped_place"]);
    assert.equal(r.stops.length, 1);
    assert.equal(r.legs.length, 1);
    assert.ok(r.total_minutes! <= 80);
  });

  it("16c. 1か所でも入らなければ does_not_fit（勝手に超過させない）", async () => {
    const r = await routed(plan({ durationMinutes: 40, stops: [{ ...STOPS[0] }] }), [{ WALK: walkJson(2400), TRANSIT: transitJson(2100) }]);
    assert.equal(r.status, "does_not_fit");
  });

  it("minStayMinutes", () => {
    assert.equal(minStayMinutes(60), 30);
    assert.equal(minStayMinutes(20), 15);
  });

  it("区間が失敗していれば判定しない（unknown）", async () => {
    const r = await routed(plan(), [{ WALK: walkJson(600) }, { WALK: "error" }]);
    assert.equal(r.status, "unknown");
  });
});

describe("運賃・予算（推測しない）", () => {
  const leg = (fare_status: "known" | "unknown" | "not_applicable", amount?: number) =>
    ({ fare_status, fare: amount === undefined ? null : { amount, currency: "JPY" } }) as any;

  it("8. 運賃あり（全区間）", () => {
    assert.deepEqual(summarizeFares([leg("known", 290), leg("known", 210), leg("not_applicable")]), { status: "all_known", known_total: 500, currency: "JPY", unknown_legs: 0, external_legs: 0 });
  });

  it("9. 運賃なし・一部だけ", () => {
    assert.deepEqual(summarizeFares([leg("unknown")]), { status: "none_known", known_total: 0, currency: null, unknown_legs: 1, external_legs: 0 });
    assert.deepEqual(summarizeFares([leg("known", 290), leg("unknown")]), { status: "partial", known_total: 290, currency: "JPY", unknown_legs: 1, external_legs: 0 });
    assert.equal(summarizeFares([leg("not_applicable")]).status, "not_applicable");
  });

  it("17. 予算内（全部判明）", () => {
    const b = summarizeBudget(plan({ placesBudgetYen: 2000 }), { status: "all_known", known_total: 580, currency: "JPY", unknown_legs: 0, external_legs: 0 }, 0);
    assert.deepEqual([b.confirmed_total_yen, b.completeness, b.over_budget], [2580, "complete", false]);
  });

  it("18. 予算超過（確認できた額だけで超過）→ over_budget=true", () => {
    const b = summarizeBudget(plan({ placesBudgetYen: 3000 }), { status: "partial", known_total: 290, currency: "JPY", unknown_legs: 1, external_legs: 0 }, 0);
    assert.deepEqual([b.confirmed_total_yen, b.completeness, b.over_budget], [3290, "partial", true]);
  });

  it("不明があって超過も確定しない → null（断定しない）", () => {
    const b = summarizeBudget(plan({ placesBudgetYen: 1000 }), { status: "none_known", known_total: 0, currency: null, unknown_legs: 1, external_legs: 0 }, 0);
    assert.equal(b.over_budget, null);
    const noBudget = summarizeBudget(plan({ budgetYen: null }), { status: "all_known", known_total: 290, currency: "JPY", unknown_legs: 0, external_legs: 0 }, 0);
    assert.equal(noBudget.over_budget, null);
  });

  it("場所を外した後の施設費は上限扱い（partial）", () => {
    assert.equal(summarizeBudget(plan(), { status: "not_applicable", known_total: 0, currency: null, unknown_legs: 0, external_legs: 0 }, 1).places_status, "partial");
  });
});

describe("buildRoutedPlan", () => {
  it("応答に座標（origin）を含めない・区間の状態をまとめる", async () => {
    const { compute } = mockCompute([{ WALK: walkJson(2400), TRANSIT: transitJson(1260, { fare: { currencyCode: "JPY", units: "290" } }) }, { WALK: walkJson(300) }]);
    const r = await buildRoutedPlanT(plan(), ORIGIN, NOW, compute);
    assert.equal(r.route_status, "ok");
    assert.equal(r.fit_status, "fits");
    assert.equal(r.fares.status, "all_known");
    assert.equal(r.budget.confirmed_total_yen, 2290);
    const text = JSON.stringify(r.legs);
    assert.ok(!text.includes("43.0687") && !text.includes("141.3508"));
  });

  it("全区間失敗 → route_status=failed", async () => {
    const { compute } = mockCompute([{ WALK: "error", TRANSIT: "error" }, { WALK: "error", TRANSIT: "error" }]);
    const r = await buildRoutedPlanT(plan(), ORIGIN, NOW, compute);
    assert.equal(r.route_status, "failed");
  });

  it("徒歩のみ・複数手段の組み合わせ（walking だけ選択）", async () => {
    const modes: TransportMode[] = ["walking"];
    const { compute, calls } = mockCompute([{ WALK: walkJson(1800) }, { WALK: walkJson(300) }]);
    const r = await buildRoutedPlanT(plan({ transportModes: modes }), ORIGIN, NOW, compute);
    assert.deepEqual(r.legs.map((l) => l.mode), ["WALK", "WALK"]);
    assert.ok(calls.every((c) => c.mode === "WALK"));
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4-6 diagnostics: ok / no_route / invalid_response / api_error / timeout
// ---------------------------------------------------------------------------------------------

const googleError = (code: number, status: string, message: string) => JSON.stringify({ error: { code, message, status } });

describe("Routes API の結果分類（診断）", () => {
  it("TRANSIT HTTP 200 + routes あり → ok（ルートも返す）", () => {
    const r = classifyRoutesResponse("TRANSIT", 200, JSON.stringify(transitJson(1260, { fare: { currencyCode: "JPY", units: "290" } })));
    assert.equal(r.diagnostic.status, "ok");
    assert.equal(r.diagnostic.http_status, 200);
    assert.equal(r.route?.mode, "TRANSIT");
  });

  it("TRANSIT HTTP 200 + routes=[] / {} → no_route（エラー扱いにしない）", () => {
    for (const body of [JSON.stringify({ routes: [] }), "{}", ""]) {
      const r = classifyRoutesResponse("TRANSIT", 200, body);
      assert.deepEqual(
        { status: r.diagnostic.status, http: r.diagnostic.http_status, route: r.route },
        { status: "no_route", http: 200, route: null },
        body,
      );
    }
  });

  it("HTTP 200 でも使えない応答は invalid_response（no_route と混同しない）", () => {
    assert.equal(classifyRoutesResponse("TRANSIT", 200, "<html>").diagnostic.status, "invalid_response");
    assert.equal(classifyRoutesResponse("TRANSIT", 200, JSON.stringify({ routes: [{ distanceMeters: 10 }] })).diagnostic.status, "invalid_response");
  });

  it("fallbackInfo があれば記録（Google が条件を緩めた）", () => {
    const body = { ...transitJson(1260), fallbackInfo: { routingMode: "FALLBACK_TRAFFIC_UNAWARE" } };
    assert.equal(classifyRoutesResponse("TRANSIT", 200, JSON.stringify(body)).diagnostic.fallback, true);
  });

  it("TRANSIT HTTP 400 / 403 / 429 / 500 → api_error（Google の status / code / message を保持）", () => {
    const cases: [number, string, string][] = [
      [400, "INVALID_ARGUMENT", "Invalid value at 'transit_preferences.allowed_travel_modes[0]'"],
      [403, "PERMISSION_DENIED", "Routes API has not been used in project 123 before or it is disabled."],
      [429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric 'Compute Routes'"],
      [500, "INTERNAL", "Internal error encountered."],
    ];
    for (const [http, status, message] of cases) {
      const r = classifyRoutesResponse("TRANSIT", http, googleError(http, status, message));
      assert.equal(r.route, null);
      assert.deepEqual(
        [r.diagnostic.status, r.diagnostic.http_status, r.diagnostic.error_status, r.diagnostic.error_code],
        ["api_error", http, status, http],
        `${http}`,
      );
      assert.ok(r.diagnostic.error_message && r.diagnostic.error_message.length <= 200);
    }
    // 本文が JSON でない 502 でも api_error
    const bad = classifyRoutesResponse("TRANSIT", 502, "<html>Bad Gateway</html>");
    assert.deepEqual([bad.diagnostic.status, bad.diagnostic.http_status, bad.diagnostic.error_status], ["api_error", 502, null]);
  });

  it("timeout / 通信失敗", () => {
    assert.deepEqual(
      [classifyFetchFailure("TRANSIT", true, "TimeoutError").diagnostic.status, classifyFetchFailure("TRANSIT", true, "").diagnostic.http_status],
      ["timeout", null],
    );
    const net = classifyFetchFailure("TRANSIT", false, "TypeError: fetch failed").diagnostic;
    assert.deepEqual([net.status, net.error_status], ["api_error", "NETWORK_ERROR"]);
  });

  it("WALK / DRIVE の正常取得は従来どおり ok", () => {
    const w = classifyRoutesResponse("WALK", 200, JSON.stringify(walkJson(600, 780)));
    assert.deepEqual([w.diagnostic.status, w.route?.duration_seconds, w.route?.distance_meters], ["ok", 600, 780]);
    const d = classifyRoutesResponse("DRIVE", 200, JSON.stringify(driveJson(900)));
    assert.deepEqual([d.diagnostic.status, d.route?.mode, d.route?.steps[0].kind], ["ok", "DRIVE", "drive"]);
  });

  it("ログに API キー・JWT・トークン・座標が出ない", () => {
    const leaky = "API key AIzaSyA1234567890abcdefghij invalid; Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig "
      + "origin 43.068712,141.350845 destination 43.0600,141.3500 sk-proj-abcdefghijklmnop";
    const r = classifyRoutesResponse("TRANSIT", 400, googleError(400, "INVALID_ARGUMENT", leaky));
    const entry = routeCallLogEntry("req-1", 0, r.diagnostic);
    const text = JSON.stringify(entry);
    for (const secret of ["AIzaSyA1234567890abcdefghij", "eyJhbGciOiJIUzI1NiJ9", "43.068712", "141.350845", "43.0600", "141.3500", "abcdefghijklmnop"]) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.equal(entry.fields.status, "api_error");
    assert.equal(entry.level, "error");
    assert.equal(sanitizeForLog("a".repeat(500)).length, 200);
  });

  it("no_route のログは『TRANSIT request succeeded but no route was returned』（info）", () => {
    const entry = routeCallLogEntry("req-1", 0, classifyRoutesResponse("TRANSIT", 200, "{}").diagnostic);
    assert.equal(entry.message, "TRANSIT request succeeded but no route was returned");
    assert.equal(entry.level, "info");
    assert.deepEqual(entry.fields, {
      request_id: "req-1", leg: 0, mode: "TRANSIT", status: "no_route", http_status: 200,
      error_status: null, error_code: null, error_message: null, fallback: false,
    });
  });

  it("plan_routed 用の集計（mode / status / HTTP status だけ）と、区間の transit_status", async () => {
    const { compute } = mockCompute([{ WALK: walkJson(2400), TRANSIT: "none" }]);
    const r = await buildRoutedPlanT(plan({ stops: [{ ...STOPS[0] }] }), ORIGIN, NOW, compute);
    assert.equal(r.legs[0].transit_status, "no_route");
    assert.equal(r.legs[0].transit_unavailable, true);
    assert.deepEqual(routeDiagnosticsSummary(r.legs), [
      { leg: 0, mode: "WALK", status: "ok", http_status: 200, error_status: null },
      { leg: 0, mode: "TRANSIT", status: "no_route", http_status: 200, error_status: null },
    ]);
    const text = JSON.stringify(routeDiagnosticsSummary(r.legs));
    assert.ok(!text.includes("43.") && !text.includes("141."));
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4-7: Japan MVP default — Routes TRANSIT is not requested; public transport → Google Maps hand-off
// ---------------------------------------------------------------------------------------------
describe("日本 MVP: TRANSIT を問い合わせない（既定）", () => {
  const ONE_STOP = () => plan({ stops: [{ ...STOPS[0] }] });

  it("既定値は無効", async () => {
    const { ENABLE_GOOGLE_TRANSIT_DEFAULT } = await import("../../supabase/functions/route-plan/route.ts");
    assert.equal(ENABLE_GOOGLE_TRANSIT_DEFAULT, false);
  });

  it("徒歩＋電車・バス / 徒歩56分 → TRANSIT は呼ばず、Google マップで確認する公共交通の区間にする（徒歩56分を移動として使わない）", async () => {
    const { compute, calls } = mockCompute([{ WALK: walkJson(3360, 3907), TRANSIT: transitJson(1200) }]);
    const r = await buildRoutedPlan(ONE_STOP(), ORIGIN, NOW, compute);
    assert.deepEqual(calls.map((c) => c.mode), ["WALK"], "TRANSIT リクエストを送らない");
    const leg = r.legs[0];
    assert.equal(leg.status, "external_transit");
    assert.equal(leg.mode, "TRANSIT");
    assert.equal(leg.duration_minutes, null, "公共交通の所要時間を作らない");
    assert.deepEqual(leg.steps, [], "路線・駅・時刻を作らない");
    assert.equal(leg.fare, null);
    assert.equal(leg.fare_status, "external");
    assert.equal(leg.polyline, null, "経路線を引かない");
    assert.equal(leg.transit_status, "disabled");
    assert.equal(leg.transit_unavailable, false);
    assert.deepEqual(leg.walk_reference, { duration_minutes: 56, distance_meters: 3907, polyline: "abc" }, "徒歩の実ルートは参考情報として別に持つ");
    assert.equal(r.stops[0].arrival_at, null, "到着時刻を断定しない");
    assert.equal(r.fit_status, "unknown");
    assert.equal(r.route_status, "ok");
    assert.equal(r.transit_routing, "google_maps");
    assert.equal(r.fares.external_legs, 1);
    assert.equal(r.budget.completeness, "partial");
    assert.equal(r.budget.over_budget, null, "公共交通の運賃が不明なので予算内と断定しない");
  });

  it("電車・バスのみ → Routes API を1回も呼ばない", async () => {
    const { compute, calls } = mockCompute([{ WALK: walkJson(600), TRANSIT: transitJson(600) }]);
    const r = await buildRoutedPlan(plan({ transportModes: ["train", "bus"], stops: [{ ...STOPS[0] }] }), ORIGIN, NOW, compute);
    assert.equal(calls.length, 0);
    assert.equal(r.legs[0].status, "external_transit");
    assert.equal(r.legs[0].walk_reference, null);
  });

  it("徒歩15分以内なら徒歩（Routes API の実ルート）", async () => {
    const { compute, calls } = mockCompute([{ WALK: walkJson(600) }]);
    const r = await buildRoutedPlan(ONE_STOP(), ORIGIN, NOW, compute);
    assert.deepEqual(calls.map((c) => c.mode), ["WALK"]);
    assert.deepEqual([r.legs[0].status, r.legs[0].mode, r.legs[0].transit_status], ["ok", "WALK", "not_requested"]);
    assert.equal(r.fit_status, "fits");
  });

  it("車も選んでいれば車の実ルート（DRIVE は呼ぶ・TRANSIT は呼ばない）", async () => {
    const { compute, calls } = mockCompute([{ WALK: walkJson(3360), DRIVE: driveJson(720) }]);
    const r = await buildRoutedPlan(plan({ transportModes: ["walking", "train", "car"], stops: [{ ...STOPS[0] }] }), ORIGIN, NOW, compute);
    assert.deepEqual(calls.map((c) => c.mode).sort(), ["DRIVE", "WALK"]);
    assert.deepEqual([r.legs[0].status, r.legs[0].mode, r.legs[0].transit_status], ["ok", "DRIVE", "disabled"]);
  });

  it("徒歩のみを選んだ場合は長くても徒歩（公共交通は選ばれていない）", async () => {
    const { compute } = mockCompute([{ WALK: walkJson(3360) }]);
    const r = await buildRoutedPlan(plan({ transportModes: ["walking"], stops: [{ ...STOPS[0] }] }), ORIGIN, NOW, compute);
    assert.deepEqual([r.legs[0].status, r.legs[0].mode, r.legs[0].transit_status], ["ok", "WALK", "not_requested"]);
  });

  it("公共交通の区間の後の区間も実ルートを取り、時刻は未確定のまま", async () => {
    const { compute } = mockCompute([{ WALK: walkJson(3360) }, { WALK: walkJson(300) }]);
    const r = await buildRoutedPlan(plan(), ORIGIN, NOW, compute);
    assert.deepEqual(r.legs.map((l) => l.status), ["external_transit", "ok"]);
    assert.equal(r.legs[1].times_uncertain, true);
    assert.equal(r.stops[1].arrival_at, null);
    assert.equal(r.legs[1].polyline, "abc");
  });

  it("診断ログに TRANSIT の呼び出しが出ない", async () => {
    const { compute } = mockCompute([{ WALK: walkJson(3360) }]);
    const r = await buildRoutedPlan(ONE_STOP(), ORIGIN, NOW, compute);
    assert.deepEqual(routeDiagnosticsSummary(r.legs).map((d) => d.mode), ["WALK"]);
  });
});
