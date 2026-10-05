// 候補の場所を集めるための検索語づくりと、集めた候補のふるい分け。AI は使わない。
// - 検索語は、整理済みの条件（PlannerBrief）からプログラムが作る（AI に検索語を考えさせない）
// - 守る条件と明らかにぶつかる候補は、AI に渡す前に外す。判断できない候補は、外さずに注意（caution）を付ける
// - 判定に使うのは、場所の名前・種別・見つけた検索語だけ。お店の原材料や設備は分からないので、
//   「外していない = 条件に合う」ではない（結果には必ず「確認できていない」と出す）
import type { Locale } from "@/content/locale";
import { DIETARY_OPTIONS, FOOD_OPTIONS, INTEREST_OPTIONS, labelOf, type AllergyId, type DietaryId, type FoodId, type InterestId } from "@/services/plan/trip-request";
import { haversineKm } from "@/services/maps/travel-estimate";
import type { OpeningPeriod, PlaceCandidate } from "@/services/places/google-places";

import type { PlaceKind, PlannerBrief } from "./brief";
import { toTime } from "./brief";
import type { CautionTopic } from "./messages";

export const MAX_QUERIES = 5;
export const MAX_CANDIDATES = 16;
const MAX_MUST_VISIT_QUERIES = 2;
const MAX_CHAT_QUERIES = 2;

export type SearchItem = {
  query: string;
  /** 検索語のうち、場所の種類を表す部分（ふるい分けにも使う） */
  keyword: string;
  /** 何のための候補か（プランの文章の言語） */
  label: string;
  kind: PlaceKind;
  /** 利用者が指定した条件から作った検索か。false は、1日を組み立てるために MICHI が足した一般的な候補 */
  requested: boolean;
  /** 「必ず行きたい場所」の検索のとき、その名前 */
  mustVisit: string | null;
  /** 食事の制限に合わせた検索か（見つかっても、適合は確認できていない） */
  dietSearch: boolean;
};

const FOOD_SEARCH: Record<FoodId, { keyword: string; kind: PlaceKind }> = {
  sushi: { keyword: "寿司", kind: "meal" },
  ramen: { keyword: "ラーメン", kind: "meal" },
  wagyu: { keyword: "和牛 焼肉", kind: "meal" },
  seafood: { keyword: "海鮮", kind: "meal" },
  yakitori: { keyword: "焼き鳥", kind: "meal" },
  izakaya: { keyword: "居酒屋", kind: "meal" },
  cafe: { keyword: "カフェ", kind: "cafe" },
  sweets: { keyword: "スイーツ", kind: "cafe" },
  local_cuisine: { keyword: "郷土料理", kind: "meal" },
};

const INTEREST_SEARCH: Record<InterestId, { keyword: string; kind: PlaceKind }> = {
  food: { keyword: "ご当地グルメ", kind: "meal" },
  culture: { keyword: "文化体験", kind: "activity" },
  history: { keyword: "歴史 史跡", kind: "activity" },
  anime: { keyword: "アニメ ショップ", kind: "activity" },
  nature: { keyword: "公園 自然", kind: "activity" },
  shopping: { keyword: "ショッピング 商店街", kind: "activity" },
  nightlife: { keyword: "バー", kind: "activity" },
  onsen: { keyword: "日帰り温泉", kind: "activity" },
  art: { keyword: "美術館", kind: "activity" },
  photography: { keyword: "景色 スポット", kind: "activity" },
  local_experiences: { keyword: "体験", kind: "activity" },
  theme_parks: { keyword: "テーマパーク", kind: "activity" },
};

/** 食事の制限があるとき、食事の候補を探す検索語（見つかった店が適合しているとは限らない） */
const DIET_SEARCH: Partial<Record<DietaryId, string>> = {
  vegan: "ヴィーガン レストラン",
  vegetarian: "ベジタリアン レストラン",
  halal: "ハラール レストラン",
  kosher: "コーシャ レストラン",
  gluten_free: "グルテンフリー レストラン",
};

const GENERAL: Record<PlaceKind, { keyword: string; label: Record<Locale, string> }> = {
  meal: { keyword: "ランチ", label: { en: "a meal", ja: "食事" } },
  cafe: { keyword: "カフェ", label: { en: "a café", ja: "カフェ" } },
  activity: { keyword: "観光スポット", label: { en: "sightseeing", ja: "観光" } },
};

/** 2つの一覧から交互に取る（食べ物と興味の、どちらかだけで検索の枠が埋まらないようにする） */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/**
 * 検索語の一覧を作る（多くても MAX_QUERIES 件。外部 API の呼び出しを増やしすぎない）。
 * 順番: 必ず行きたい場所 → 選ばれた食べ物・興味 → 文章に書かれた希望 → 足りない種類だけ一般的な候補。
 */
export function buildSearchPlan(brief: PlannerBrief): SearchItem[] {
  const { language, area, soft, hard } = brief;
  const item = (keyword: string, label: string, kind: PlaceKind, extra: Partial<SearchItem> = {}): SearchItem => ({
    query: `${area.search} ${keyword}`,
    keyword,
    label,
    kind,
    requested: true,
    mustVisit: null,
    dietSearch: false,
    ...extra,
  });

  const mustVisit = soft.mustVisit.slice(0, MAX_MUST_VISIT_QUERIES).map((name) => item(name, name, "activity", { mustVisit: name }));
  const chat = soft.keywords.slice(0, MAX_CHAT_QUERIES).map((k) => item(k.keyword, k.label, k.kind));

  const dietKeyword = hard.dietary.map((id) => ({ id, keyword: DIET_SEARCH[id] })).find((d) => d.keyword);
  const foods = soft.foods.map((id) => item(FOOD_SEARCH[id].keyword, labelOf(FOOD_OPTIONS, id, language), FOOD_SEARCH[id].kind));
  const interests = soft.interests
    // 食べ物を選んでいるときは、興味の「グルメ」では別に検索しない
    .filter((id) => !(id === "food" && (soft.foods.length > 0 || dietKeyword)))
    .map((id) => item(INTEREST_SEARCH[id].keyword, labelOf(INTEREST_OPTIONS, id, language), INTEREST_SEARCH[id].kind));
  const diet = dietKeyword ? [item(dietKeyword.keyword!, labelOf(DIETARY_OPTIONS, dietKeyword.id, language), "meal", { dietSearch: true })] : [];

  const derivedCap = Math.max(0, MAX_QUERIES - mustVisit.length - chat.length);
  const plan = [...mustVisit, ...[...diet, ...interleave(foods, interests)].slice(0, derivedCap), ...chat];

  // 食事・見て回る場所のどちらかが無いときだけ、一般的な候補を足す（指定に無いものなので requested = false）
  const general = (kind: PlaceKind) => item(GENERAL[kind].keyword, GENERAL[kind].label[language], kind, { requested: false });
  for (const kind of ["meal", "activity", "cafe"] as const) {
    if (plan.length >= MAX_QUERIES) break;
    const missing = !plan.some((p) => p.kind === kind && !p.mustVisit);
    if (kind === "cafe" ? plan.length < 3 && missing : missing) plan.push(general(kind));
  }
  const seen = new Set<string>();
  return plan.filter((p) => (seen.has(p.query) ? false : (seen.add(p.query), true)));
}

// ---------------------------------------------------------------------------------------------
// ふるい分け
// ---------------------------------------------------------------------------------------------

const P = {
  shellfish: /海鮮|かに|カニ|蟹|えび|エビ|海老|牡蠣|かき小屋|貝|浜焼|オイスター|seafood|crab|shrimp|prawn|lobster|oyster|shellfish/i,
  fish: /寿司|鮨|すし|スシ|sushi|海鮮|魚|うなぎ|鰻|刺身|fish|seafood|sashimi/i,
  wheat: /ラーメン|らーめん|拉麺|うどん|そば|蕎麦|パン|ベーカリー|パスタ|ピザ|お好み焼|たこ焼|餃子|ramen|udon|soba|noodle|bakery|pasta|pizza|gyoza|dumpling/i,
  milk: /チーズ|アイス|ジェラート|ミルク|牧場|パフェ|ソフトクリーム|cheese|ice cream|gelato|milk|dairy|parfait/i,
  egg: /オムライス|たまご|玉子|卵|プリン|パンケーキ|omelet|egg|pudding|pancake/i,
  nuts: /ピーナッツ|ナッツ|peanut|nut/i,
  soy: /豆腐|とうふ|納豆|味噌|tofu|natto|miso/i,
  sesame: /ごま|胡麻|担々|坦々|sesame|tantan/i,
  sweets: /スイーツ|ケーキ|洋菓子|和菓子|パティスリー|菓子|ドーナツ|クレープ|dessert|sweets|cake|pastry|patisserie|confection|donut|crepe/i,
  pork: /とんかつ|トンカツ|豚|ポーク|とんこつ|pork|tonkatsu|tonkotsu/i,
  porkPossible: /ラーメン|らーめん|拉麺|餃子|中華|お好み焼|ramen|gyoza|dumpling|chinese|okonomiyaki/i,
  alcohol: /居酒屋|バー(?!ガー|ベキュー)|酒場|ビール|ブルワリー|ワイン|日本酒|パブ|ビアガーデン|スナック|izakaya|\bbar\b|beer|brewery|wine|sake|\bpub\b/i,
  nightlife: /クラブ|キャバ|ナイトクラブ|night ?club|\bclub\b/i,
  meat: /焼肉|焼き肉|焼鳥|焼き鳥|やきとり|ステーキ|ホルモン|ジンギスカン|とんかつ|肉|ハンバーグ|ハンバーガー|すき焼|しゃぶ|yakiniku|yakitori|steak|bbq|barbecue|burger|sukiyaki|shabu/i,
  brothPossible: /ラーメン|らーめん|うどん|そば|蕎麦|居酒屋|和食|定食|ramen|udon|soba|izakaya|japanese restaurant/i,
};

const ALLERGY_EXCLUDE: Record<AllergyId, RegExp[]> = {
  shellfish: [P.shellfish, P.fish],
  fish: [P.fish, P.shellfish],
  peanuts: [P.nuts],
  tree_nuts: [P.nuts],
  egg: [P.egg],
  milk: [P.milk],
  wheat: [P.wheat],
  soy: [P.soy],
  sesame: [P.sesame],
};
const SWEETS_ALLERGENS: AllergyId[] = ["milk", "egg", "wheat", "peanuts", "tree_nuts"];

const DIETARY_EXCLUDE: Record<DietaryId, RegExp[]> = {
  vegetarian: [P.meat, P.fish, P.shellfish],
  vegan: [P.meat, P.fish, P.shellfish, P.milk, P.egg],
  halal: [P.pork, P.alcohol],
  kosher: [P.pork, P.shellfish],
  no_pork: [P.pork],
  no_alcohol: [P.alcohol],
  gluten_free: [P.wheat],
};

/** 文章で「欲しくない」と書かれた食べ物・興味を、候補から外すための語 */
const FOOD_PATTERN: Partial<Record<FoodId, RegExp>> = {
  sushi: /寿司|鮨|すし|sushi/i,
  ramen: /ラーメン|らーめん|拉麺|ramen/i,
  wagyu: /和牛|焼肉|wagyu|yakiniku/i,
  seafood: P.shellfish,
  yakitori: /焼鳥|焼き鳥|やきとり|yakitori/i,
  izakaya: /居酒屋|izakaya/i,
  cafe: /カフェ|喫茶|コーヒー|cafe|café|coffee/i,
  sweets: P.sweets,
};
const INTEREST_PATTERN: Partial<Record<InterestId, RegExp>> = {
  anime: /アニメ|anime|マンガ|漫画|manga/i,
  shopping: /ショッピング|モール|デパート|百貨店|商店街|shopping|mall|department store/i,
  nightlife: new RegExp(`${P.alcohol.source}|${P.nightlife.source}`, "i"),
  onsen: /温泉|銭湯|スパ|onsen|hot spring|\bspa\b/i,
  art: /美術館|ギャラリー|art museum|gallery/i,
  theme_parks: /テーマパーク|遊園地|theme park|amusement park/i,
  history: /史跡|城|歴史|historic|castle/i,
  nature: /公園|庭園|park|garden/i,
};

export type Screening = { excluded: boolean; cautions: CautionTopic[] };

/** 候補1件を、守る条件に照らして見る。excluded = 明らかにぶつかる（AI に渡さない） */
export function screenPlace(place: Pick<PlaceCandidate, "name" | "category" | "priceLevel" | "wheelchairEntrance">, found: SearchItem, brief: PlannerBrief): Screening {
  const { hard } = brief;
  const haystack = `${place.name} ${place.category ?? ""} ${found.mustVisit ? "" : found.keyword}`;
  const hit = (pattern: RegExp) => pattern.test(haystack);
  const cautions: CautionTopic[] = [];

  const excluded =
    hard.allergies.some((id) => ALLERGY_EXCLUDE[id].some(hit)) ||
    hard.dietary.some((id) => DIETARY_EXCLUDE[id].some(hit)) ||
    hard.excludedFoods.some((id) => FOOD_PATTERN[id] && hit(FOOD_PATTERN[id])) ||
    hard.excludedInterests.some((id) => INTEREST_PATTERN[id] && hit(INTEREST_PATTERN[id])) ||
    (hard.avoidNightlife && (hit(P.alcohol) || hit(P.nightlife))) ||
    hard.excludedTexts.some((value) => haystack.toLowerCase().includes(value.toLowerCase())) ||
    [...hard.allergiesOther].some((value) => haystack.toLowerCase().includes(value.toLowerCase())) ||
    (hard.avoidExpensive && (place.priceLevel === "PRICE_LEVEL_EXPENSIVE" || place.priceLevel === "PRICE_LEVEL_VERY_EXPENSIVE")) ||
    (hard.wheelchair && place.wheelchairEntrance === false);
  if (excluded) return { excluded: true, cautions: [] };

  const eats = found.kind !== "activity";
  if (hard.dietary.some((id) => id === "no_pork" || id === "halal" || id === "kosher") && hit(P.porkPossible)) cautions.push("pork_possible");
  if (hard.dietary.some((id) => id === "vegetarian" || id === "vegan") && hit(P.brothPossible)) cautions.push("animal_possible");
  if (hard.dietary.some((id) => id === "halal" || id === "kosher") && eats && !found.dietSearch && hit(P.meat)) cautions.push("uncertified_meat");
  if (hard.allergies.some((id) => SWEETS_ALLERGENS.includes(id)) && hit(P.sweets)) cautions.push("allergen_possible");
  if (found.dietSearch) cautions.push("diet_search_hit");
  return { excluded: false, cautions };
}

// ---------------------------------------------------------------------------------------------
// 営業時間
// ---------------------------------------------------------------------------------------------

/** その日の営業時間。unknown = 情報が無い（営業しているという意味ではない） */
export type DayHours = { status: "unknown" } | { status: "closed" } | { status: "open"; periods: [number, number][] };

/** 通常の営業時間から、指定した曜日の営業時間（0:00 からの分。日をまたぐ閉店は 1440 を超える値）を取り出す */
export function dayHours(periods: OpeningPeriod[] | null | undefined, weekday: number): DayHours {
  if (!periods) return { status: "unknown" };
  const today: [number, number][] = [];
  for (const period of periods) {
    if (period.openDay !== weekday) continue;
    if (period.closeDay === null || period.closeMinute === null) {
      today.push([0, 1440]);
      continue;
    }
    const days = (period.closeDay - period.openDay + 7) % 7;
    const close = period.closeMinute + days * 1440;
    if (close > period.openMinute) today.push([period.openMinute, close]);
  }
  // 24時間営業は、Google では「日曜 0:00 に開いて閉まらない」1件で表される
  if (today.length === 0 && periods.length === 1 && periods[0].closeDay === null) return { status: "open", periods: [[0, 1440]] };
  return today.length > 0 ? { status: "open", periods: today.sort((a, b) => a[0] - b[0]) } : { status: "closed" };
}

export function formatDayHours(hours: DayHours): string | null {
  if (hours.status !== "open") return null;
  return hours.periods.map(([open, close]) => (open === 0 && close >= 1440 ? "24h" : `${toTime(open)}–${toTime(close)}`)).join(", ");
}

// ---------------------------------------------------------------------------------------------
// 候補
// ---------------------------------------------------------------------------------------------

export type RouteCandidate = {
  place: PlaceCandidate;
  found: SearchItem;
  hours: DayHours;
  cautions: CautionTopic[];
};

/**
 * 検索結果を1つの候補一覧にする。検索ごとに1件ずつ順番に取り（特定の種類だけで埋めない）、
 * 守る条件と明らかにぶつかる場所・その日が休みの場所は入れない。
 */
export function collectCandidates(plan: SearchItem[], results: (PlaceCandidate[] | null)[], brief: PlannerBrief, limit = MAX_CANDIDATES): RouteCandidate[] {
  const byId = new Map<string, RouteCandidate>();
  for (let rank = 0; byId.size < limit; rank++) {
    let any = false;
    plan.forEach((found, index) => {
      // 「必ず行きたい場所」の検索は、先頭の1件だけを使う（同じ名前の別の場所を混ぜない）
      const place = found.mustVisit && rank > 0 ? undefined : results[index]?.[rank];
      if (!place) return;
      any = true;
      if (byId.has(place.id) || byId.size >= limit) return;
      const screening = screenPlace(place, found, brief);
      const hours = dayHours(place.openingPeriods, brief.weekday);
      if (screening.excluded || hours.status === "closed") return;
      byId.set(place.id, { place, found, hours, cautions: screening.cautions });
    });
    if (!any) break;
  }
  return [...byId.values()];
}

/** 徒歩で1区間に歩ける直線距離（km）。estimateLeg と同じ速さ（時速 4.5km）・迂回の係数（1.3）で、分から求める */
const walkableKm = (minutes: number) => ((minutes / 60) * 4.5) / 1.3;

/**
 * 移動が徒歩だけのとき、歩いて回れる1つのエリアの候補だけを残す（離れた場所どうしを AI に選ばせない）。
 * 近くに候補がいちばん多い場所を中心にし、そこから歩ける距離の候補を残す。「必ず行きたい場所」があれば、そこを中心にする。
 * しぼると候補が足りなくなるときは、しぼらずに返す（narrowed = false）。
 */
export function walkableCluster(candidates: RouteCandidate[], brief: PlannerBrief): { candidates: RouteCandidate[]; narrowed: boolean } {
  const radius = walkableKm(brief.maxWalkLegMinutes);
  const near = (center: RouteCandidate) => candidates.filter((c) => haversineKm(center.place, c.place) <= radius);
  const centers = candidates.some((c) => c.found.mustVisit !== null) ? candidates.filter((c) => c.found.mustVisit !== null) : candidates;
  let best: RouteCandidate[] = [];
  for (const center of centers) {
    const group = near(center);
    if (group.length > best.length) best = group;
  }
  const enough = best.length >= Math.max(brief.limits.maxStops, 3);
  return enough && best.length < candidates.length ? { candidates: best, narrowed: true } : { candidates, narrowed: false };
}
