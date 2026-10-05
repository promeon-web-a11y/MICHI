// Unit tests for supabase/functions/identify-place/logic.ts
// Run: npm run test:functions   (Node >= 23.6 strips TypeScript types natively)
// OpenAI / Google Places は実際には呼ばず、IdentifyDeps にモックを注入して処理フローを検証する。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type AiCandidate,
  areaScore,
  buildOpenAiRequestBody,
  buildPlacesRequestBody,
  buildSearchQuery,
  categoryScore,
  decideMatch,
  EXTRACTION_SCHEMA,
  getOpenAiOutputText,
  type GooglePlace,
  hasEnoughInformation,
  identifyPlace,
  type IdentifyDeps,
  nameSimilarity,
  normalizeInput,
  parseExtraction,
  PLACES_FIELD_MASK,
  redactSecrets,
  toPlaceResult,
  UpstreamError,
  urlHints,
} from "../../supabase/functions/identify-place/logic.ts";

const candidate = (overrides: Partial<AiCandidate> = {}): AiCandidate => ({
  candidate_name: "森彦",
  area_hint: "札幌市中央区",
  prefecture: "北海道",
  city: "札幌市",
  category_hint: "cafe",
  search_query: "森彦 札幌",
  evidence: ["#森彦"],
  confidence: 0.85,
  ...overrides,
});

const aiOutput = (candidates: AiCandidate[], insufficient_reason: string | null = null) =>
  JSON.stringify({ candidates, insufficient_reason });

const gPlace = (id: string, name: string, address: string, types: string[] = ["cafe"], extra: Partial<GooglePlace> = {}): GooglePlace => ({
  id,
  displayName: { text: name },
  formattedAddress: address,
  location: { latitude: 43.06, longitude: 141.33 },
  primaryType: types[0],
  types,
  businessStatus: "OPERATIONAL",
  ...extra,
});

/** 呼び出し回数を記録するモック */
function mockDeps(opts: {
  ai?: string | Error;
  places?: GooglePlace[] | Error | ((query: string) => GooglePlace[]);
}) {
  const calls = { extract: 0, search: [] as string[] };
  const deps: IdentifyDeps = {
    extract: async () => {
      calls.extract++;
      if (opts.ai instanceof Error) throw opts.ai;
      return opts.ai ?? aiOutput([]);
    },
    searchPlaces: async (query) => {
      calls.search.push(query);
      if (opts.places instanceof Error) throw opts.places;
      if (typeof opts.places === "function") return opts.places(query);
      return opts.places ?? [];
    },
  };
  return { deps, calls };
}

const input = (body: Record<string, unknown>) => {
  const result = normalizeInput(body);
  assert.ok(result);
  return result;
};

// ---------------------------------------------------------------------------------------------
describe("normalizeInput", () => {
  it("URL + text + source を整理し、text から URL を除く", () => {
    const r = input({ url: "https://www.instagram.com/p/abc/", text: "森彦 最高 https://www.instagram.com/p/abc/?igsh=1", source: "instagram" });
    assert.equal(r.source, "instagram");
    assert.equal(r.text, "森彦 最高");
    assert.deepEqual(r.warnings, []);
  });

  it("source はURLから判定し、申告と食い違えば URL を優先", () => {
    const r = input({ url: "https://vt.tiktok.com/ZS1/", source: "instagram" });
    assert.equal(r.source, "tiktok");
    assert.ok(r.warnings.includes("source_mismatch_used_url"));
  });

  it("URL が無ければ申告値、それも無ければ unknown", () => {
    assert.equal(input({ text: "森彦", source: "web" }).source, "web");
    assert.equal(input({ text: "森彦" }).source, "unknown");
    assert.equal(input({ text: "森彦", source: "facebook" }).source, "unknown");
  });

  it("malformed URL は無視して警告", () => {
    const r = input({ url: "https://", text: "森彦" });
    assert.equal(r.url, null);
    assert.ok(r.warnings.includes("malformed_url_ignored"));
    assert.equal(input({ url: "javascript:alert(1)" }).url, null);
  });

  it("オブジェクト以外は null（400）", () => {
    for (const body of [null, undefined, "text", 1, []]) assert.equal(normalizeInput(body), null);
  });

  it("text が文字列以外・空でも例外なし", () => {
    assert.equal(input({ text: 123 }).text, null);
    assert.equal(input({ text: "   " }).text, null);
    assert.equal(input({ text: "https://example.com/only-url" }).text, null);
  });

  it("長すぎる text は切り詰める", () => {
    const r = input({ text: "あ".repeat(5000) });
    assert.equal(r.text?.length, 3000);
    assert.ok(r.warnings.includes("text_truncated"));
  });
});

describe("urlHints / hasEnoughInformation", () => {
  it("SNS 投稿URL（ID のみ）は手がかりなし", () => {
    assert.deepEqual(urlHints("https://www.instagram.com/reel/C1a2B3c4D5e/", "instagram"), []);
    assert.deepEqual(urlHints("https://youtu.be/dQw4w9WgXcQ", "youtube"), []);
  });

  it("アカウント名・日本語スラッグ・Webドメインは手がかり", () => {
    assert.deepEqual(urlHints("https://www.tiktok.com/@morihiko_cafe/video/7300000000000000000", "tiktok"), ["@morihiko_cafe"]);
    assert.deepEqual(urlHints("https://example.com/%E6%A3%AE%E5%BD%A6/", "web"), ["example.com", "森彦"]);
  });

  it("URLのみ（SNS投稿ID）・空入力は情報不足", () => {
    assert.equal(hasEnoughInformation(input({ url: "https://www.instagram.com/reel/C1a2B3c4D5e/" })), false);
    assert.equal(hasEnoughInformation(input({})), false);
    assert.equal(hasEnoughInformation(input({ text: "!!" })), false);
  });
});

describe("OpenAI リクエスト・出力解析", () => {
  it("Structured Outputs(strict) で送信し、会話を保存しない", () => {
    const body = buildOpenAiRequestBody(input({ text: "森彦" }), "test-model") as any;
    assert.equal(body.model, "test-model");
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
  });

  it("スキーマは Place ID・住所・座標・営業時間を要求しない", () => {
    const keys = Object.keys((EXTRACTION_SCHEMA.properties.candidates.items as any).properties);
    for (const forbidden of ["place_id", "address", "formatted_address", "latitude", "longitude", "opening_hours"]) {
      assert.ok(!keys.includes(forbidden), forbidden);
    }
    // strict モードでは全プロパティが required
    assert.deepEqual([...EXTRACTION_SCHEMA.properties.candidates.items.required].sort(), keys.sort());
  });

  it("出力テキスト取り出し（正常・拒否・未完了・空）", () => {
    assert.deepEqual(getOpenAiOutputText({ status: "completed", output_text: "{}" }), { text: "{}" });
    assert.deepEqual(
      getOpenAiOutputText({ status: "completed", output: [{ content: [{ type: "output_text", text: "{\"a\":1}" }] }] }),
      { text: "{\"a\":1}" },
    );
    assert.deepEqual(getOpenAiOutputText({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "no" }] }] }), { error: "ai_refused" });
    assert.deepEqual(getOpenAiOutputText({ status: "incomplete" }), { error: "ai_response_incomplete" });
    assert.deepEqual(getOpenAiOutputText(null), { error: "ai_response_invalid" });
    assert.deepEqual(getOpenAiOutputText({ status: "completed", output: [] }), { error: "ai_output_missing" });
  });

  it("parseExtraction: 不正JSON・スキーマ違反・値の丸め", () => {
    assert.deepEqual(parseExtraction("not json"), { ok: false, error: "ai_output_invalid_json" });
    assert.deepEqual(parseExtraction("{\"foo\":1}"), { ok: false, error: "ai_output_invalid_schema" });
    const r = parseExtraction(JSON.stringify({
      candidates: [
        { ...candidate({ confidence: 0.4 }), category_hint: "unknown_cat" },
        candidate({ candidate_name: "  別の店  ", confidence: 7 }),
      ],
      insufficient_reason: null,
    }));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.candidates[0].candidate_name, "別の店");
    assert.equal(r.value.candidates[0].confidence, 1);
    assert.equal(r.value.candidates[1].category_hint, null);
  });

  it("buildSearchQuery: AI の query に店名が無ければ組み立て直す", () => {
    assert.equal(buildSearchQuery(candidate()), "森彦 札幌");
    assert.equal(buildSearchQuery(candidate({ search_query: "札幌 カフェ" })), "森彦 札幌市中央区");
    assert.equal(buildSearchQuery(candidate({ search_query: null, area_hint: null, city: null, prefecture: null })), "森彦");
    assert.equal(buildSearchQuery(candidate({ candidate_name: null })), null);
  });
});

describe("Google Places リクエスト", () => {
  it("Field Mask は必要な項目だけ（写真・営業時間なし）", () => {
    assert.equal(
      PLACES_FIELD_MASK,
      "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.businessStatus",
    );
    assert.ok(!/photos|OpeningHours|reviews|\*/.test(PLACES_FIELD_MASK));
  });

  it("Text Search (New) の本文（pageSize で件数を絞る）", () => {
    assert.deepEqual(buildPlacesRequestBody("森彦 札幌"), { textQuery: "森彦 札幌", languageCode: "ja", regionCode: "JP", pageSize: 5 });
  });

  it("toPlaceResult: id の無い結果は捨て、欠損値は null", () => {
    assert.equal(toPlaceResult({ displayName: { text: "x" } }), null);
    assert.deepEqual(toPlaceResult({ id: "p1" }), {
      google_place_id: "p1", name: "", formatted_address: null, latitude: null, longitude: null,
      primary_type: null, types: [], business_status: null,
    });
  });
});

describe("照合スコア", () => {
  it("nameSimilarity: 表記揺れ・支店名・無関係", () => {
    assert.equal(nameSimilarity("森彦", "森彦"), 1);
    assert.equal(nameSimilarity("ＭＯＲＩＨＩＫＯ", "morihiko"), 1);
    assert.ok(nameSimilarity("きのとや", "きのとや 大通公園店") >= 0.8);
    assert.ok(nameSimilarity("森彦", "スターバックス") < 0.2);
  });

  it("areaScore: 住所に含まれるエリアヒントの割合", () => {
    assert.equal(areaScore(candidate(), "日本、〒064-0801 北海道札幌市中央区南１条西２８丁目"), 1);
    assert.equal(areaScore(candidate({ area_hint: null, city: null, prefecture: null }), "どこか"), null);
    assert.equal(areaScore(candidate({ area_hint: "福岡", city: null, prefecture: null }), "北海道札幌市"), 0);
  });

  it("categoryScore", () => {
    assert.equal(categoryScore("cafe", ["coffee_shop", "food"]), 1);
    assert.equal(categoryScore("ramen", ["ramen_restaurant"]), 1);
    assert.equal(categoryScore("cafe", ["hotel", "lodging"]), 0);
    assert.equal(categoryScore(null, ["cafe"]), null);
  });

  it("decideMatch: 閉業店は確定しない", () => {
    const place = toPlaceResult(gPlace("p1", "森彦", "北海道札幌市中央区", ["cafe"], { businessStatus: "CLOSED_PERMANENTLY" }))!;
    const d = decideMatch(candidate(), [place]);
    assert.equal(d.status, "needs_review");
    assert.equal(d.reason, "place_closed_permanently");
  });
});

// ---------------------------------------------------------------------------------------------
// 要件のテストケース（処理フロー全体。外部APIはモック）
// ---------------------------------------------------------------------------------------------
describe("identifyPlace: 要件ケース", () => {
  const MORIHIKO = gPlace("ChIJ_morihiko", "森彦", "日本、〒064-0801 北海道札幌市中央区南１条西２８丁目２−５", ["cafe", "food"]);

  it("1. Instagram URL + 店名を含む text → confirmed", async () => {
    const { deps, calls } = mockDeps({ ai: aiOutput([candidate()]), places: [MORIHIKO] });
    const r = await identifyPlace(
      input({ url: "https://www.instagram.com/p/C1a2B3/", text: "札幌の #森彦 でモーニング☕️", source: "instagram" }),
      deps,
    );
    assert.equal(r.status, "confirmed");
    assert.equal(r.place?.google_place_id, "ChIJ_morihiko");
    assert.equal(r.place?.latitude, 43.06);
    assert.ok(r.confidence >= 0.75 && r.confidence <= 1);
    assert.equal(r.input.source, "instagram");
    assert.deepEqual(calls.search, ["森彦 札幌"]);
    assert.equal(r.error, null);
  });

  it("2. TikTok URL + 店名を含む text → confirmed", async () => {
    const ai = candidate({ candidate_name: "麺屋彩未", area_hint: "美園", city: "札幌市", category_hint: "ramen", search_query: "麺屋彩未 札幌" });
    const { deps } = mockDeps({
      ai: aiOutput([ai]),
      places: [gPlace("ChIJ_saimi", "麺屋 彩未", "日本、〒062-0003 北海道札幌市豊平区美園３条５丁目", ["ramen_restaurant", "restaurant"])],
    });
    const r = await identifyPlace(input({ url: "https://www.tiktok.com/@foodie/video/7300000000000000000", text: "札幌 美園の麺屋彩未 #ラーメン" }), deps);
    assert.equal(r.status, "confirmed");
    assert.equal(r.input.source, "tiktok");
    assert.equal(r.place?.primary_type, "ramen_restaurant");
  });

  it("3. YouTube URL + 店名を含む text → confirmed", async () => {
    const ai = candidate({ candidate_name: "白い恋人パーク", area_hint: "宮の沢", category_hint: "sightseeing", search_query: "白い恋人パーク 札幌" });
    const { deps } = mockDeps({
      ai: aiOutput([ai]),
      places: [gPlace("ChIJ_park", "白い恋人パーク", "日本、〒063-0052 北海道札幌市西区宮の沢２条２丁目１１−３６", ["tourist_attraction", "museum"])],
    });
    const r = await identifyPlace(input({ url: "https://youtu.be/abc?si=x", text: "白い恋人パークに行ってきた！" }), deps);
    assert.equal(r.status, "confirmed");
    assert.equal(r.input.source, "youtube");
  });

  it("4. 通常 Web URL + 店名 → confirmed", async () => {
    const { deps } = mockDeps({ ai: aiOutput([candidate()]), places: [MORIHIKO] });
    const r = await identifyPlace(input({ url: "https://tabelog.com/hokkaido/A0101/A010103/1000001/", text: "森彦 (札幌市中央区) - 食べログ" }), deps);
    assert.equal(r.status, "confirmed");
    assert.equal(r.input.source, "web");
  });

  it("5. URLのみ（SNS投稿ID）→ AI を呼ばず insufficient_information", async () => {
    const { deps, calls } = mockDeps({});
    const r = await identifyPlace(input({ url: "https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=1", source: "instagram" }), deps);
    assert.equal(r.status, "insufficient_information");
    assert.equal(r.reason, "no_usable_input");
    assert.equal(calls.extract, 0);
    assert.equal(calls.search.length, 0);
  });

  it("5b. URLのみでもアカウント名などの手がかりがあれば AI に渡す", async () => {
    const { deps, calls } = mockDeps({ ai: aiOutput([], "アカウント名だけでは店名と断定できない") });
    const r = await identifyPlace(input({ url: "https://www.tiktok.com/@morihiko_cafe/video/1" }), deps);
    assert.equal(calls.extract, 1);
    assert.equal(r.status, "insufficient_information");
    assert.equal(r.insufficient_reason, "アカウント名だけでは店名と断定できない");
  });

  it("6. textのみ → source=unknown で confirmed", async () => {
    const { deps } = mockDeps({ ai: aiOutput([candidate()]), places: [MORIHIKO] });
    const r = await identifyPlace(input({ text: "札幌市中央区の森彦、雰囲気最高" }), deps);
    assert.equal(r.status, "confirmed");
    assert.equal(r.input.source, "unknown");
    assert.equal(r.input.url, null);
  });

  it("7. 店名が特定できない → Google を呼ばず insufficient_information", async () => {
    const { deps, calls } = mockDeps({
      ai: aiOutput([candidate({ candidate_name: null, search_query: null, confidence: 0.2 })], "店名の記載がない"),
    });
    const r = await identifyPlace(input({ text: "札幌のおしゃれなカフェ行ってきた☕️" }), deps);
    assert.equal(r.status, "insufficient_information");
    assert.equal(r.reason, "no_place_name_extracted");
    assert.equal(calls.search.length, 0);
    assert.equal(r.extraction?.category_hint, "cafe");
  });

  it("7b. AI の confidence が低すぎる候補では検索しない", async () => {
    const { deps, calls } = mockDeps({ ai: aiOutput([candidate({ confidence: 0.1 })]) });
    const r = await identifyPlace(input({ text: "もりひこ？かも" }), deps);
    assert.equal(r.status, "insufficient_information");
    assert.equal(calls.search.length, 0);
  });

  it("8. 同名店舗が複数（エリア情報あり・同条件）→ needs_review で候補を返す", async () => {
    const ai = candidate({ candidate_name: "スターバックス コーヒー", area_hint: null, city: "札幌市", prefecture: "北海道", search_query: "スターバックス 札幌" });
    const { deps } = mockDeps({
      ai: aiOutput([ai]),
      places: [
        gPlace("s1", "スターバックス コーヒー 札幌大通店", "日本、北海道札幌市中央区大通西３丁目", ["cafe", "coffee_shop"]),
        gPlace("s2", "スターバックス コーヒー 札幌駅前店", "日本、北海道札幌市北区北７条西４丁目", ["cafe", "coffee_shop"]),
        gPlace("s3", "スターバックス コーヒー 札幌ステラプレイス店", "日本、北海道札幌市中央区北５条西２丁目", ["cafe", "coffee_shop"]),
      ],
    });
    const r = await identifyPlace(input({ text: "#スターバックス 新作 #札幌" }), deps);
    assert.equal(r.status, "needs_review");
    assert.equal(r.reason, "multiple_similar_places");
    assert.equal(r.place, null);
    assert.equal(r.candidates.length, 3);
    assert.ok(r.confidence > 0 && r.confidence < 1);
  });

  it("8b. 同名店舗でもエリアで絞れれば confirmed", async () => {
    const ai = candidate({ candidate_name: "森彦", area_hint: "円山", city: "札幌市", search_query: "森彦" });
    const { deps } = mockDeps({
      ai: aiOutput([ai]),
      places: [
        gPlace("m1", "森彦", "日本、北海道札幌市中央区南１条西２８丁目（円山）", ["cafe"]),
        gPlace("m2", "森彦", "日本、東京都渋谷区神宮前", ["cafe"]),
      ],
    });
    const r = await identifyPlace(input({ text: "円山の森彦" }), deps);
    assert.equal(r.status, "confirmed");
    assert.equal(r.place?.google_place_id, "m1");
  });

  it("8c. エリア情報が無い同名店舗 → needs_review", async () => {
    const ai = candidate({ area_hint: null, city: null, prefecture: null, search_query: "森彦" });
    const { deps } = mockDeps({
      ai: aiOutput([ai]),
      places: [gPlace("m1", "森彦", "北海道札幌市中央区"), gPlace("m2", "森彦", "東京都渋谷区")],
    });
    const r = await identifyPlace(input({ text: "#森彦" }), deps);
    assert.equal(r.status, "needs_review");
  });

  it("9. Google Places 0件 → not_found（次の候補で1回だけ再検索）", async () => {
    const { deps, calls } = mockDeps({
      ai: aiOutput([candidate({ candidate_name: "架空の店A", search_query: "架空の店A 札幌" }), candidate({ candidate_name: "架空の店B", search_query: "架空の店B 札幌", confidence: 0.6 }), candidate({ candidate_name: "架空の店C", search_query: "架空の店C", confidence: 0.5 })]),
      places: [],
    });
    const r = await identifyPlace(input({ text: "架空の店A" }), deps);
    assert.equal(r.status, "not_found");
    assert.equal(r.reason, "places_zero_results");
    assert.equal(calls.search.length, 2);
    assert.deepEqual(r.searches.map((s) => s.result_count), [0, 0]);
  });

  it("9b. 結果はあるが店名が一致しない → not_found（候補は開発用に返す）", async () => {
    const { deps } = mockDeps({ ai: aiOutput([candidate()]), places: [gPlace("x", "全然違うお店", "北海道札幌市中央区")] });
    const r = await identifyPlace(input({ text: "森彦" }), deps);
    assert.equal(r.status, "not_found");
    assert.equal(r.reason, "no_name_match");
    assert.equal(r.candidates.length, 1);
  });

  it("10a. OpenAI 失敗 → error(stage=openai)、Google は呼ばない", async () => {
    const { deps, calls } = mockDeps({ ai: new UpstreamError("ai_request_failed", "HTTP 500") });
    const r = await identifyPlace(input({ text: "森彦" }), deps);
    assert.equal(r.status, "error");
    assert.deepEqual(r.error, { stage: "openai", code: "ai_request_failed" });
    assert.equal(calls.search.length, 0);
    assert.ok(!JSON.stringify(r).includes("HTTP 500"), "詳細はクライアントに返さない");
  });

  it("10b. OpenAI タイムアウト / 想定外の例外", async () => {
    const t = await identifyPlace(input({ text: "森彦" }), mockDeps({ ai: new UpstreamError("ai_timeout") }).deps);
    assert.equal(t.error?.code, "ai_timeout");
    const u = await identifyPlace(input({ text: "森彦" }), mockDeps({ ai: new Error("boom") }).deps);
    assert.equal(u.error?.code, "ai_request_failed");
  });

  it("10c. OpenAI JSON 解析失敗 → error(ai_output_invalid_json)", async () => {
    const r = await identifyPlace(input({ text: "森彦" }), mockDeps({ ai: "```json {broken" }).deps);
    assert.equal(r.status, "error");
    assert.equal(r.error?.code, "ai_output_invalid_json");
  });

  it("10d. Google Places 失敗 / タイムアウト → error(stage=google_places)", async () => {
    const f = await identifyPlace(input({ text: "森彦" }), mockDeps({ ai: aiOutput([candidate()]), places: new UpstreamError("places_request_failed", "HTTP 403") }).deps);
    assert.equal(f.status, "error");
    assert.deepEqual(f.error, { stage: "google_places", code: "places_request_failed" });
    assert.equal(f.extraction?.candidate_name, "森彦");
    const t = await identifyPlace(input({ text: "森彦" }), mockDeps({ ai: aiOutput([candidate()]), places: new UpstreamError("places_timeout") }).deps);
    assert.equal(t.error?.code, "places_timeout");
  });

  it("全ステータスで confidence は 0〜1、message は日本語", async () => {
    const cases = [
      mockDeps({ ai: aiOutput([candidate()]), places: [MORIHIKO] }),
      mockDeps({}),
      mockDeps({ ai: new Error("x") }),
    ];
    for (const { deps } of cases) {
      const r = await identifyPlace(input({ text: "森彦" }), deps);
      assert.ok(r.confidence >= 0 && r.confidence <= 1);
      assert.match(r.message, /[ぁ-ん]/);
    }
  });
});

describe("redactSecrets", () => {
  it("APIキーらしき文字列を伏せる", () => {
    const s = redactSecrets("Incorrect API key provided: sk-proj-abcdefghijklmnop. key=AIzaSyA1234567890abcdef Bearer eyJhbGci.x.y");
    assert.ok(!s.includes("abcdefghijklmnop"));
    assert.ok(!s.includes("AIzaSyA1234567890abcdef"));
    assert.ok(!s.includes("eyJhbGci"));
  });
});
