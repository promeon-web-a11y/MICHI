// Tests for src/services/plan/trip-request.ts   Run: npm test
// 文章（チャット）と詳細設定を TripRequest にまとめる処理と、サーバー側の検証・AI に渡す文章づくりを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTripRequest,
  emptyTripDetails,
  hasHardConstraints,
  hasTripRequestContent,
  sanitizeTripRequest,
  summarizeTripRequest,
  tripRequestLanguage,
  tripRequestToPrompt,
} from "../src/services/plan/trip-request.ts";

const details = (overrides = {}) => ({ ...emptyTripDetails(), ...overrides });
const MAX = 300;

test("CASE 1: チャットだけで送れる。AI に渡す文章は書かれた文章そのまま", () => {
  const text = "I have six hours in Tokyo and want great ramen and anime.";
  const request = buildTripRequest(`  ${text}  `, details(), "en");
  assert.equal(hasTripRequestContent(request), true);
  assert.equal(request.natural_language_request, text);
  assert.equal(tripRequestToPrompt(request), text);
  assert.deepEqual(summarizeTripRequest(request, "en"), []);
});

test("CASE 2: 詳細設定だけで送れる（動詞のある文章は要らない）", () => {
  const request = buildTripRequest(
    "",
    details({
      destinations: ["tokyo"],
      budgetAmount: "15,000",
      travelerCount: 2,
      travelerType: "couple",
      interests: ["food", "anime"],
      foods: ["ramen"],
      transportation: ["train"],
    }),
    "en",
  );
  assert.equal(hasTripRequestContent(request), true);
  assert.equal(request.natural_language_request, "");
  const prompt = tripRequestToPrompt(request);
  assert.match(prompt, /^Please plan an outing in Japan/);
  assert.match(prompt, /- Destination: Tokyo/);
  assert.match(prompt, /- Budget \(total\): 15000 yen/);
  assert.match(prompt, /- Travelers: 2 travelers, Couple/);
  assert.match(prompt, /- Interests: Food, Anime/);
  assert.match(prompt, /- Food they would like: Ramen/);
  assert.match(prompt, /- Transportation: Train/);
});

test("CASE 2: 条件が1つだけでも送れる", () => {
  assert.equal(hasTripRequestContent(buildTripRequest("", details({ foods: ["ramen"] }), "en")), true);
  assert.equal(hasTripRequestContent(buildTripRequest("", details({ pace: "relaxed" }), "en")), true);
});

test("CASE 3: チャット＋詳細設定は、両方を失わずに1つの依頼になる", () => {
  const text = "I want somewhere locals actually go.";
  const request = buildTripRequest(text, details({ destinations: ["tokyo"], travelerType: "couple", allergies: ["shellfish"] }), "en");
  assert.equal(request.natural_language_request, text);
  assert.equal(request.destinations[0].id, "tokyo");
  const prompt = tripRequestToPrompt(request);
  assert.ok(prompt.startsWith(text));
  assert.match(prompt, /- Destination: Tokyo/);
  assert.match(prompt, /- Allergies \(hard constraint, must avoid\): Shellfish/);
});

test("CASE 4: どちらも空なら送れない", () => {
  assert.equal(hasTripRequestContent(buildTripRequest("", details(), "en")), false);
  assert.equal(hasTripRequestContent(buildTripRequest("   \n ", details(), "ja")), false);
  // 空白だけの自由入力・不正な金額は、条件として数えない
  assert.equal(hasTripRequestContent(buildTripRequest("", details({ destinationOther: "  ", budgetAmount: "abc", mustVisit: " , " }), "en")), false);
});

test("Clear: 初期値に戻すと、条件は0件になる", () => {
  const cleared = buildTripRequest("", emptyTripDetails(), "en");
  assert.deepEqual(summarizeTripRequest(cleared, "en"), []);
  // emptyTripDetails は毎回新しい値を返す（前の設定が残らない）
  const first = emptyTripDetails();
  first.interests.push("food");
  assert.deepEqual(emptyTripDetails().interests, []);
});

test("アレルギーと食べたいものは別のデータになる", () => {
  const request = buildTripRequest("", details({ foods: ["seafood", "sushi"], allergies: ["shellfish"], allergiesOther: "kiwi, mango" }), "en");
  assert.deepEqual(request.food_preferences, ["seafood", "sushi"]);
  assert.deepEqual(request.allergies, ["shellfish"]);
  assert.deepEqual(request.allergies_other, ["kiwi", "mango"]);
  assert.deepEqual(request.dietary_restrictions, []);
  assert.equal(hasHardConstraints(request), true);
  assert.equal(hasHardConstraints(buildTripRequest("", details({ foods: ["seafood"] }), "en")), false);
  assert.equal(hasHardConstraints(buildTripRequest("", details({ dietary: ["halal"] }), "en")), true);
  const prompt = tripRequestToPrompt(request);
  assert.match(prompt, /- Food they would like: Sushi, Seafood/);
  assert.match(prompt, /- Allergies \(hard constraint, must avoid\): Shellfish, kiwi, mango/);
});

test("文章と設定が食い違っても、両方をそのまま持つ（片方に寄せない）", () => {
  const request = buildTripRequest("No seafood please", details({ foods: ["seafood"] }), "en");
  assert.equal(request.natural_language_request, "No seafood please");
  assert.deepEqual(request.food_preferences, ["seafood"]);
  const prompt = tripRequestToPrompt(request);
  assert.match(prompt, /No seafood please/);
  assert.match(prompt, /- Food they would like: Seafood/);
});

test("複数選択: 選んだものがすべて入り、行き先は複数の地域を持てる", () => {
  const request = buildTripRequest(
    "",
    details({
      destinations: ["kyoto", "tokyo"],
      destinationOther: "Otaru",
      interests: ["onsen", "food", "art"],
      transportation: ["walking", "train", "bus"],
      dietary: ["vegetarian", "no_alcohol"],
      avoid: ["crowds", "stairs"],
      groupNeeds: ["children", "luggage"],
    }),
    "en",
  );
  assert.deepEqual(
    request.destinations.map((d) => d.name),
    ["Tokyo", "Kyoto", "Otaru"],
  );
  assert.deepEqual(request.destinations[2], { id: null, country: "Japan", prefecture: null, city: null, name: "Otaru" });
  assert.deepEqual(request.interests, ["onsen", "food", "art"]);
  assert.deepEqual(request.transportation, ["walking", "train", "bus"]);
  assert.deepEqual(request.dietary_restrictions, ["vegetarian", "no_alcohol"]);
  assert.deepEqual(request.avoid, ["crowds", "stairs"]);
  assert.deepEqual(request.group_needs, ["children", "luggage"]);
});

test("TripRequest の形", () => {
  const request = buildTripRequest(
    "",
    details({
      destinations: ["tokyo"],
      date: "2026-11-03",
      timeStart: "10:00",
      timeEnd: "19:00",
      budgetAmount: "15000",
      travelerCount: 2,
      travelerType: "couple",
      interests: ["food", "anime"],
      foods: ["ramen"],
      allergies: ["shellfish"],
      transportation: ["walking", "train"],
      pace: "balanced",
    }),
    "en",
  );
  assert.deepEqual(request, {
    version: 1,
    language: "en",
    natural_language_request: "",
    destinations: [{ id: "tokyo", country: "Japan", prefecture: "Tokyo", city: null, name: "Tokyo" }],
    dates: { start: "2026-11-03", end: "2026-11-03" },
    available_time: { start: "10:00", end: "19:00" },
    budget: { amount: 15000, currency: "JPY" },
    travelers: { count: 2, type: "couple" },
    interests: ["food", "anime"],
    food_preferences: ["ramen"],
    dietary_restrictions: [],
    allergies: ["shellfish"],
    allergies_other: [],
    transportation: ["walking", "train"],
    pace: "balanced",
    avoid: [],
    avoid_other: [],
    must_visit: [],
    starting_point: null,
    ending_point: null,
    walking_tolerance: null,
    setting: null,
    spot_style: null,
    group_needs: [],
  });
  // JSON にして送り、サーバーで検証しても同じ形のまま
  assert.deepEqual(sanitizeTripRequest(JSON.parse(JSON.stringify(request)), MAX), request);
});

test("件数と表示: 設定した条件の数と名前（表示言語ごと）", () => {
  const request = buildTripRequest(
    "",
    details({ destinations: ["tokyo"], budgetAmount: "20000", travelerType: "couple", interests: ["food"], allergies: ["shellfish"], transportation: ["train"] }),
    "en",
  );
  assert.deepEqual(summarizeTripRequest(request, "en"), ["Tokyo", "¥20,000", "Couple", "Food", "Train", "Allergy: Shellfish"]);
  assert.deepEqual(summarizeTripRequest(request, "ja"), ["東京", "¥20,000", "カップル", "グルメ", "電車", "アレルギー: 甲殻類・貝"]);
});

test("プランの言語: 文章があればその言語、無ければ画面の言語", () => {
  assert.equal(tripRequestLanguage(buildTripRequest("", details({ foods: ["ramen"] }), "en")), "en");
  assert.equal(tripRequestLanguage(buildTripRequest("", details({ foods: ["ramen"] }), "ja")), "ja");
  assert.equal(tripRequestLanguage(buildTripRequest("ラーメンを食べたい", details(), "en")), "ja");
  // 自由入力の地名に日本語があっても、英語の文章なら英語のまま
  assert.equal(tripRequestLanguage(buildTripRequest("A quiet afternoon", details({ mustVisit: "浅草寺" }), "ja")), "en");
  const ja = tripRequestToPrompt(buildTripRequest("", details({ destinations: ["sapporo"], allergies: ["egg"] }), "ja"));
  assert.match(ja, /^次の条件で/);
  assert.match(ja, /- 行き先: 札幌/);
  assert.match(ja, /- アレルギー（必ず避ける）: 卵/);
});

test("サーバーの検証: 知らない選択肢・形の違う値・長すぎる文字は捨てる", () => {
  const cleaned = sanitizeTripRequest(
    {
      language: "fr",
      natural_language_request: "  ramen \n please ",
      destinations: [{ id: "tokyo" }, { id: "tokyo" }, { id: "atlantis", name: "x".repeat(200) }, { name: "second free text" }],
      dates: { start: "tomorrow", end: "2026-11-03" },
      available_time: { start: "25:00", end: "19:00" },
      budget: { amount: -5, currency: "BTC" },
      travelers: { count: 500, type: "robot" },
      interests: ["food", "hacking", "food"],
      allergies: "shellfish",
      allergies_other: ["  kiwi  ", 42, "kiwi", "a", "b", "c", "d", "e"],
      pace: "warp",
      starting_point: { evil: true },
      unknown_field: "ignored",
    },
    MAX,
  );
  assert.equal(cleaned.language, "ja");
  assert.equal(cleaned.natural_language_request, "ramen please");
  assert.deepEqual(
    cleaned.destinations.map((d) => [d.id, d.name.length]),
    [
      ["tokyo", 5],
      [null, 60],
    ],
  );
  assert.deepEqual(cleaned.dates, { start: null, end: "2026-11-03" });
  assert.deepEqual(cleaned.available_time, { start: null, end: "19:00" });
  assert.deepEqual(cleaned.budget, { amount: null, currency: "JPY" });
  assert.deepEqual(cleaned.travelers, { count: null, type: null });
  assert.deepEqual(cleaned.interests, ["food"]);
  assert.deepEqual(cleaned.allergies, []);
  assert.deepEqual(cleaned.allergies_other, ["kiwi", "a", "b", "c", "d"]);
  assert.equal(cleaned.pace, null);
  assert.equal(cleaned.starting_point, null);
  assert.equal("unknown_field" in cleaned, false);

  assert.equal(sanitizeTripRequest(null, MAX), null);
  assert.equal(sanitizeTripRequest("text", MAX), null);
  assert.equal(sanitizeTripRequest([], MAX), null);
  assert.equal(sanitizeTripRequest({ natural_language_request: "x".repeat(MAX + 1) }, MAX), null);
  // 中身が空の依頼は、形は直せるが送信できる内容は無い
  assert.equal(hasTripRequestContent(sanitizeTripRequest({}, MAX)), false);
});
