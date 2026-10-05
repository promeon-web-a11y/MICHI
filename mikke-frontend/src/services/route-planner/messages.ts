// Route Planner が結果に付ける文（仮定・注意・食い違い・確かめられなかった条件・場所ごとの注意）。
// 安全に関わる文を AI に書かせないため、すべてここの決まった文から作る。プランの文章と同じ言語で出す。
import type { Locale } from "@/content/locale";

export type CautionTopic = "pork_possible" | "animal_possible" | "uncertified_meat" | "allergen_possible" | "diet_search_hit";

type Messages = {
  listSeparator: string;
  weekdays: readonly string[];
  // 仮定
  areaDefault: (area: string) => string;
  extraDestinations: (used: string, others: string) => string;
  dateAssumed: (date: string, weekday: string) => string;
  startAssumed: (time: string) => string;
  partyAssumed: string;
  transportAssumed: string;
  generalOptions: (labels: string) => string;
  walkableArea: string;
  // 注意
  hardUnverified: (list: string) => string;
  accessibilityPartial: (known: number, total: number) => string;
  hoursUnknown: (names: string) => string;
  costUnknown: string;
  mustVisitNotFound: (name: string) => string;
  mustVisitLeftOut: (name: string) => string;
  messageNotUsed: string;
  windowIgnored: string;
  noMeal: string;
  backtracking: string;
  // 食い違い
  preferenceVsRestriction: (item: string, restriction: string) => string;
  messageVsRestriction: (item: string, restriction: string) => string;
  messageRejectsSelected: (item: string) => string;
  avoidVsInterest: (item: string) => string;
  destinationDiffers: (message: string, details: string) => string;
  budgetDiffers: (used: string) => string;
  paceDiffers: (used: string) => string;
  // 確かめられなかった条件
  cannotCheck: (item: string) => string;
  localSpots: string;
  pointsNotIncluded: string;
  // 場所ごとの注意
  stopHoursUnknown: string;
  caution: Record<CautionTopic, string>;
};

const MESSAGES: Record<Locale, Messages> = {
  en: {
    listSeparator: ", ",
    weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    areaDefault: (area) => `No destination was set, so this route is planned in ${area}.`,
    extraDestinations: (used, others) => `This is a one-day route in ${used}. ${others} was not included.`,
    dateAssumed: (date, weekday) => `No date was set, so opening hours were checked for ${date} (${weekday}).`,
    startAssumed: (time) => `No start time was set, so the route starts at ${time}.`,
    partyAssumed: "The number of travelers was not set, so costs are estimated for one person.",
    transportAssumed: "No transportation was set, so travel times assume public transport and walking.",
    generalOptions: (labels) => `To fill the day, MICHI added general options you did not ask for: ${labels}.`,
    walkableArea: "You chose to get around on foot, so the route stays within one walkable area.",
    hardUnverified: (list) =>
      `You set: ${list}. MICHI could not verify ingredients, preparation or certification at any place on this route. Places that clearly conflict were left out, but compatibility is not confirmed. Please confirm directly with each restaurant before you eat.`,
    accessibilityPartial: (known, total) =>
      `Step-free entrance information (from Google Maps) was available for ${known} of ${total} places. MICHI has not confirmed accessibility inside any place. Please check before you go.`,
    hoursUnknown: (names) => `Opening hours were not available for: ${names}. These places are not confirmed to be open. Please check before you go.`,
    costUnknown: "Some costs could not be estimated, so the total may be higher than shown.",
    mustVisitNotFound: (name) => `“${name}” could not be found on the map, so it is not on this route.`,
    mustVisitLeftOut: (name) => `“${name}” could not be fitted into this route.`,
    messageNotUsed: "Your message could not be read as a trip request, so only the selected details were used.",
    windowIgnored: "The end time is not after the start time, so the end time was not used.",
    noMeal: "This route has no meal stop around lunch time.",
    backtracking: "This route goes back and forth between areas more than necessary.",
    preferenceVsRestriction: (item, restriction) =>
      `“${item}” is selected as something you would like, but you also set ${restriction}. The restriction takes priority, so MICHI did not look for ${item} places.`,
    messageVsRestriction: (item, restriction) =>
      `Your message asks for ${item}, but ${restriction} is set. The restriction takes priority, so MICHI did not look for ${item} places.`,
    messageRejectsSelected: (item) =>
      `Your message says you do not want ${item}, but ${item} is selected in the details. The route follows your message and leaves ${item} out.`,
    avoidVsInterest: (item) => `${item} is selected as an interest and also as something to avoid. The route avoids it.`,
    destinationDiffers: (message, details) => `Your message mentions ${message}, but ${details} is selected in the details. The route uses ${details}.`,
    budgetDiffers: (used) => `Your message and the details give different budgets. The route uses the lower one (${used}).`,
    paceDiffers: (used) => `Your message and the details give different paces. The route uses the one selected in the details (${used}).`,
    cannotCheck: (item) => `${item}: MICHI has no data to check this yet.`,
    localSpots: "Local spots: MICHI cannot yet tell which places are used mainly by locals.",
    pointsNotIncluded: "Travel from your starting point and to your ending point is not included in the times.",
    stopHoursUnknown: "Opening hours not available. Please check before you go.",
    caution: {
      pork_possible: "This kind of food often uses pork (for example in broth or toppings). MICHI could not verify this place.",
      animal_possible: "This kind of food often uses meat or fish (for example in broth). MICHI could not verify this place.",
      uncertified_meat: "MICHI found no certification information for this place.",
      allergen_possible: "This kind of food often contains the allergens you set. MICHI could not verify this place.",
      diet_search_hit: "Found by a map search for your dietary need. MICHI has not verified certification, menu or ingredients.",
    },
  },
  ja: {
    listSeparator: "、",
    weekdays: ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"],
    areaDefault: (area) => `行き先の指定が無かったため、${area}でプランを作りました。`,
    extraDestinations: (used, others) => `${used}の1日のプランです。${others}は含めていません。`,
    dateAssumed: (date, weekday) => `日付の指定が無かったため、${date}（${weekday}）の営業時間で確かめました。`,
    startAssumed: (time) => `開始時刻の指定が無かったため、${time}に始めるプランにしました。`,
    partyAssumed: "人数の指定が無かったため、費用は1人分の目安です。",
    transportAssumed: "移動手段の指定が無かったため、移動時間は電車・バスと徒歩を前提にしています。",
    generalOptions: (labels) => `1日を組み立てるため、指定に無い一般的な候補（${labels}）をMICHIが足しました。`,
    walkableArea: "移動が徒歩のため、歩いて回れる1つのエリアの中でプランを作りました。",
    hardUnverified: (list) =>
      `設定された条件: ${list}。MICHIは、このプランのどのお店についても、原材料・調理方法・認証を確認できていません。明らかに合わないお店は外していますが、条件に合うことは確認できていません。食べる前に、必ずお店に直接ご確認ください。`,
    accessibilityPartial: (known, total) =>
      `入口の段差の情報（Googleマップ）があったのは、${total}か所中${known}か所です。店内や施設内のバリアフリーは、MICHIでは確認できていません。お出かけ前にご確認ください。`,
    hoursUnknown: (names) => `営業時間を取得できなかった場所: ${names}。営業していることは確認できていません。お出かけ前にご確認ください。`,
    costUnknown: "費用を見積もれなかった場所があるため、合計は表示より高くなることがあります。",
    mustVisitNotFound: (name) => `「${name}」は地図で見つからなかったため、プランに入っていません。`,
    mustVisitLeftOut: (name) => `「${name}」は、このプランに入れられませんでした。`,
    messageNotUsed: "文章をおでかけの相談として読み取れなかったため、詳細設定の条件だけで作りました。",
    windowIgnored: "終了時刻が開始時刻より前のため、終了時刻は使っていません。",
    noMeal: "このプランには、昼どきの食事の立ち寄りがありません。",
    backtracking: "このプランは、エリアの行き来が多めです。",
    preferenceVsRestriction: (item, restriction) =>
      `「${item}」が食べたいものに選ばれていますが、${restriction}も設定されています。制限を優先し、${item}のお店は探していません。`,
    messageVsRestriction: (item, restriction) => `文章では${item}を希望されていますが、${restriction}が設定されています。制限を優先し、${item}のお店は探していません。`,
    messageRejectsSelected: (item) => `文章では${item}を希望しないと書かれていますが、詳細設定では${item}が選ばれています。文章に合わせて、${item}を外しました。`,
    avoidVsInterest: (item) => `${item}が、興味と避けたいことの両方に選ばれています。避ける方を優先しました。`,
    destinationDiffers: (message, details) => `文章には${message}とありますが、詳細設定では${details}が選ばれています。${details}でプランを作りました。`,
    budgetDiffers: (used) => `文章と詳細設定で予算が違います。低い方（${used}）を使いました。`,
    paceDiffers: (used) => `文章と詳細設定でペースが違います。詳細設定の方（${used}）を使いました。`,
    cannotCheck: (item) => `${item}: 確かめるためのデータが、まだMICHIにありません。`,
    localSpots: "地元の人が行く場所: どの場所が地元の人に使われているかは、まだMICHIでは判断できません。",
    pointsNotIncluded: "出発地点から最初の場所まで、最後の場所から終了地点までの移動は、時間に含めていません。",
    stopHoursUnknown: "営業時間を取得できませんでした。お出かけ前にご確認ください。",
    caution: {
      pork_possible: "この種類の料理は、スープや具に豚肉を使うことが多くあります。MICHIはこのお店について確認できていません。",
      animal_possible: "この種類の料理は、だしなどに肉や魚を使うことが多くあります。MICHIはこのお店について確認できていません。",
      uncertified_meat: "このお店の認証についての情報は、MICHIでは見つかっていません。",
      allergen_possible: "この種類の食べ物は、設定されたアレルゲンを含むことが多くあります。MICHIはこのお店について確認できていません。",
      diet_search_hit: "食事の制限に合わせた地図検索で見つかった場所です。認証・メニュー・原材料は、MICHIでは確認できていません。",
    },
  },
};

export const plannerMessages = (locale: Locale): Messages => MESSAGES[locale];
