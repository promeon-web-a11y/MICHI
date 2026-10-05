// 画面に出す文言（ブランド名・ナビゲーション・各ページの見出しやボタン）。文言を変えるときはこのファイルだけを直す。
// 多言語化するときは、このファイルの値を言語ごとに差し替える（コンポーネントには文言を直接書かない）。
import type { ImageKey } from "./images";
import type { Locale } from "./locale";

/** 画面に見えるブランド名。内部の名前（ログ・保存キー・環境変数・src/lib/siteInfo.ts）は Mikke のまま変えない */
export const BRAND = {
  name: "MICHI",
  tagline: "AIがつくる、日本の旅プラン",
  description: "行きたい場所や過ごし方を書くだけで、AIが旅のルートを組み立てるMICHI",
} as const;

export const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/plans", label: "みんなのプラン" },
  { href: "/contact", label: "Q&A" },
] as const;

export const HEADER_COPY = {
  auth: "ログイン / 新規登録",
  comingSoon: "準備中",
  openMenu: "メニューを開く",
  closeMenu: "メニューを閉じる",
  mainMenu: "メインメニュー",
} as const;

export const FOOTER_COPY = {
  terms: "利用規約",
  privacy: "プライバシーポリシー",
  accountDelete: "アカウント削除",
  photoCredits: "写真クレジット",
} as const;

/** Mikke 版 Home の見出し（MICHI の Home では表示しない。文言だけ残している） */
export const HERO_COPY = {
  headline: ["まだ見ぬ、", "“いい時間”を、", "見つけに行こう。"],
  sub: ["AIが、あなたに合った", "おでかけプランを提案します。"],
} as const;

/** 入力欄のプレースホルダー（複数あるときは数秒ごとに切り替わる） */
export const PROMPT_PLACEHOLDERS = ["今日はどんな旅にしたい？"] as const;

/** Mikke 版 Home の写真カード（MICHI の Home では表示しない。データだけ残している） */
export const PROMPT_CATEGORIES: { label: string; image: ImageKey; prompt: string }[] = [
  { label: "夜景", image: "nightView", prompt: "札幌で夜景を楽しめるプランを作って" },
  { label: "グルメ", image: "ramen", prompt: "札幌で食べ歩き中心のプランを作って" },
  { label: "自然", image: "bluePond", prompt: "北海道らしい自然を楽しみたい" },
  { label: "ドライブ", image: "road", prompt: "札幌から車で半日ドライブしたい" },
];

export const HOME_COPY = {
  promptLabel: "行きたい場所や過ごし方をAIに相談する",
  send: "AIに相談する",
} as const;

/** 送信してから結果が出るまでの表示 */
export const THINKING_COPY = {
  title: "MICHIが考えています…",
  steps: ["条件を整理しています", "実在するお店・スポットを探しています", "ルートを組み立てています"],
} as const;

/** AI が作ったプランの表示 */
export const RESULT_COPY = {
  eyebrow: "AIがつくったルート",
  time: "時間",
  budget: "予算の目安",
  stops: "立ち寄り",
  stopsUnit: "か所",
  schedule: "旅のスケジュール",
  stay: "滞在",
  estimate: "目安",
  openMap: "Googleマップで見る",
  photo: "写真",
  disclaimer:
    "お店・スポットはGoogleマップの情報をもとにしています。滞在時間・移動時間・予算は目安です。営業時間や料金は変わることがあるため、お出かけ前にご確認ください。",
  retry: "別のプランを考えてもらう",
  retrying: "考えています…",
  edit: "条件を変える",
  notices: "ご確認ください",
  assumptions: "MICHIが仮に決めたこと",
  unresolved: "確かめられなかった条件",
  hours: "営業時間（Googleマップ）",
} as const;

export const PLANS_COPY = {
  title: "みんなのプラン",
  lead: ["実際に旅した人たちのルートから、", "次のいい時間を見つけよう。"],
  searchLabel: "行き先・キーワードで検索",
  searchPlaceholder: "行き先・キーワードで検索（例：京都 カフェ、北海道 ドライブ）",
  filterLabel: "カテゴリーで絞り込む",
  all: "すべて",
  popular: "人気のプラン",
  results: "検索結果",
  countUnit: "件",
  empty: "条件に合うプランが見つかりませんでした。キーワードやカテゴリーを変えてお試しください。",
  likes: "いいね",
  save: "保存",
  sampleNote: "※ 現在はサンプルのプランを掲載しています。投稿者・いいね数・コメントは表示確認用の内容です。",
} as const;

/** 「みんなのプラン」のカテゴリーチップ（「すべて」の後ろに並ぶ順） */
export const PLAN_CHIPS = [
  "東京", "京都", "大阪", "北海道", "九州", "沖縄", "温泉", "グルメ", "カフェ", "ドライブ", "ひとり旅", "カップル", "家族旅行",
] as const;

export const ROUTE_COPY = {
  back: "みんなのプランへ戻る",
  reviewsUnit: "件",
  like: "いいね",
  save: "保存する",
  share: "共有する",
  shared: "リンクをコピーしました",
  duration: "所要時間",
  totalDuration: "総所要時間",
  budget: "予算（1人あたり）",
  spots: "訪問スポット",
  spotsUnit: "か所",
  transport: "移動手段",
  style: "旅のスタイル",
  about: "約",
  yen: "円",
  map: "ルートの概略図",
  openMap: "地図で見る",
  schedule: "旅のスケジュール",
  openSpot: "Googleマップで開く",
  go: "このルートで行く",
  customize: "AIで自分向けに変更",
  aboutRoute: "このルートについて",
  travelerInfo: "旅行者向け情報",
  travelerInfoNote: (count: number) => `${count}件の旅行者の投稿をもとに表示しています。`,
  comments: "みんなのコメント",
  postComment: "コメントを投稿する",
  comingSoon: "準備中",
} as const;

/** 「旅行者向け情報」の項目名（並び順もこの順） */
export const TRAVELER_INFO_LABELS = {
  englishMenu: "英語メニュー",
  englishStaff: "英語対応スタッフ",
  creditCard: "クレジットカード",
  reservation: "予約の必要性",
  vegetarian: "ベジタリアン対応",
  luggage: "大きな荷物での移動",
} as const;

// ---------------------------------------------------------------------------------------------
// 言語ごとの文言（Home・AI プランの表示・共通ヘッダー・フッター）
// 日本語は上の定数をそのまま使う。英語は下の SITE_COPY_EN。画面では siteCopy(locale) で取り出す。
// 「みんなのプラン」「Q&A」・規約類のページは日本語のまま（英語にするときは、同じ形でここに足す）。
// ---------------------------------------------------------------------------------------------

export type SiteCopy = {
  brand: { name: string; tagline: string; description: string };
  navLinks: readonly { href: string; label: string }[];
  header: { auth: string; comingSoon: string; openMenu: string; closeMenu: string; mainMenu: string; home: string; language: string };
  footer: { terms: string; privacy: string; accountDelete: string; photoCredits: string; legalNav: string; cropped: string };
  home: {
    promptLabel: string;
    send: string;
    /** 送信ボタンに出す文字。null のときはアイコンだけ */
    sendLabel: string | null;
    placeholders: readonly string[];
    /** 入力欄の上に出すサービスの説明。null のときは出さない */
    intro: { eyebrow: string; headline: string; lead: string; note: string } | null;
    /** 入力欄の下に出す入力例（押すと入力欄に入る）。空のときは出さない */
    examplesLabel: string;
    examples: readonly string[];
    /** 文章も詳細設定も空のまま送ろうとしたときの案内 */
    emptyHint: string;
    details: TripDetailsCopy;
  };
  thinking: { title: string; steps: readonly string[] };
  result: {
    eyebrow: string;
    time: string;
    budget: string;
    stops: string;
    stopsUnit: string;
    schedule: string;
    stay: string;
    estimate: string;
    openMap: string;
    photo: string;
    disclaimer: string;
    retry: string;
    retrying: string;
    edit: string;
    /** Route Planner が付ける情報の見出し */
    notices: string;
    assumptions: string;
    unresolved: string;
    /** 営業時間（外部の情報であることを添える） */
    hours: string;
  };
};

/**
 * 詳細設定（入力欄の横のボタンで開く条件の設定）の文言。
 * チップに出す選択肢の名前は services/plan/trip-request.ts にある（AI に渡す文章でも同じ名前を使うため）。
 */
export type TripDetailsCopy = {
  /** 入力欄の横のボタン（文字を出す言語で使う）と、その読み上げ用の名前 */
  button: string;
  open: string;
  /** 設定済みの件数の読み上げ（例: 「3件設定済み」） */
  countLabel: (count: number) => string;
  title: string;
  lead: string;
  close: string;
  clear: string;
  destination: string;
  destinationOther: string;
  date: string;
  time: string;
  timeStart: string;
  timeEnd: string;
  budget: string;
  budgetPlaceholder: string;
  travelers: string;
  travelersCount: string;
  fewer: string;
  more: string;
  interests: string;
  food: string;
  transportation: string;
  pace: string;
  dietarySection: string;
  dietary: string;
  allergies: string;
  allergiesOther: string;
  constraintNote: string;
  avoidSection: string;
  avoidOther: string;
  moreSection: string;
  walking: string;
  setting: string;
  spotStyle: string;
  groupNeeds: string;
  groupNote: string;
  startingPoint: string;
  endingPoint: string;
  mustVisit: string;
  placePlaceholder: string;
  listPlaceholder: string;
};

const DETAILS_COPY_JA: TripDetailsCopy = {
  button: "詳細設定",
  open: "詳細設定を開く",
  countLabel: (count) => `${count}件設定済み`,
  title: "詳細設定",
  lead: "必要な項目だけ選んでください。空欄のままでも送れます。",
  close: "閉じる",
  clear: "すべてクリア",
  destination: "行き先",
  destinationOther: "ほかの地域（例: 小樽、鎌倉）",
  date: "日付",
  time: "使える時間",
  timeStart: "開始時刻",
  timeEnd: "終了時刻",
  budget: "予算（合計）",
  budgetPlaceholder: "例: 15000",
  travelers: "人数・同行者",
  travelersCount: "人数",
  fewer: "1人減らす",
  more: "1人増やす",
  interests: "興味",
  food: "食べたいもの",
  transportation: "移動手段",
  pace: "ペース",
  dietarySection: "食事の制限・アレルギー",
  dietary: "食事の制限",
  allergies: "アレルギー",
  allergiesOther: "ほかのアレルギー（「、」で区切る）",
  constraintNote:
    "ここで選んだ内容は、好みではなく守る条件として扱います。ただし、MICHIはお店の原材料や調理方法を確認できません。食べる前に、必ずお店にご確認ください。",
  avoidSection: "避けたいこと",
  avoidOther: "避けたい場所・食べ物・過ごし方（「、」で区切る）",
  moreSection: "さらに詳しく",
  walking: "歩く量",
  setting: "屋内・屋外",
  spotStyle: "場所の種類",
  groupNeeds: "同行者への配慮",
  groupNote: "段差や設備の有無は、まだMICHIでは確認できません。お出かけ前にご確認ください。",
  startingPoint: "出発地点",
  endingPoint: "終了地点",
  mustVisit: "必ず行きたい場所",
  placePlaceholder: "例: 札幌駅、ホテル名",
  listPlaceholder: "「、」で区切って入力",
};

const DETAILS_COPY_EN: TripDetailsCopy = {
  button: "Details",
  open: "Open trip details",
  countLabel: (count) => `${count} set`,
  title: "Trip details",
  lead: "Pick only what matters to you. Everything here is optional.",
  close: "Close",
  clear: "Clear all",
  destination: "Destination",
  destinationOther: "Another area (e.g. Otaru, Kamakura)",
  date: "Date",
  time: "Available time",
  timeStart: "Start time",
  timeEnd: "End time",
  budget: "Budget (total)",
  budgetPlaceholder: "e.g. 15000",
  travelers: "Travelers",
  travelersCount: "Number of travelers",
  fewer: "One fewer traveler",
  more: "One more traveler",
  interests: "Interests",
  food: "Food you'd like",
  transportation: "Transportation",
  pace: "Pace",
  dietarySection: "Dietary needs & allergies",
  dietary: "Dietary restrictions",
  allergies: "Allergies",
  allergiesOther: "Other allergies (separate with commas)",
  constraintNote:
    "MICHI treats these as conditions to follow, not as preferences. However, MICHI cannot check ingredients or how food is prepared. Always confirm with the restaurant before you eat.",
  avoidSection: "Things to avoid",
  avoidOther: "Places, foods or activities to avoid (separate with commas)",
  moreSection: "More preferences",
  walking: "Walking",
  setting: "Indoor / outdoor",
  spotStyle: "Kind of places",
  groupNeeds: "Group needs",
  groupNote: "MICHI cannot yet confirm step-free access or facilities at each place. Please check before you go.",
  startingPoint: "Starting point",
  endingPoint: "Ending point",
  mustVisit: "Must-visit places",
  placePlaceholder: "e.g. Sapporo Station, your hotel",
  listPlaceholder: "Separate with commas",
};

const SITE_COPY_JA: SiteCopy = {
  brand: BRAND,
  navLinks: NAV_LINKS,
  header: { ...HEADER_COPY, home: `${BRAND.name} ホーム`, language: "表示言語" },
  footer: { ...FOOTER_COPY, legalNav: "サービス情報", cropped: "一部を切り抜いて使用" },
  home: {
    ...HOME_COPY,
    sendLabel: null,
    placeholders: PROMPT_PLACEHOLDERS,
    intro: null,
    examplesLabel: "",
    examples: [],
    emptyHint: "行きたい場所や過ごし方を書くか、詳細設定で条件を選んでください。",
    details: DETAILS_COPY_JA,
  },
  thinking: THINKING_COPY,
  result: RESULT_COPY,
};

const SITE_COPY_EN: SiteCopy = {
  brand: {
    name: BRAND.name,
    tagline: "AI trip planner for Japan",
    description: "Tell MICHI where you want to go and how you like to spend your time, and AI builds a route from real places.",
  },
  // 「みんなのプラン」は日本語だけで、表示確認用の仮データ（投稿者・評価・コメント）が本物に見えるため、英語の画面からはリンクしない。
  // Q&A・規約類は日本語のページへ行くので、リンクにその旨を書く。
  navLinks: [
    { href: "/", label: "Home" },
    { href: "/contact", label: "Q&A (Japanese)" },
  ],
  header: {
    auth: "Log in / Sign up",
    comingSoon: "Coming soon",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    mainMenu: "Main menu",
    home: `${BRAND.name} home`,
    language: "Language",
  },
  footer: {
    terms: "Terms of Service (Japanese)",
    privacy: "Privacy Policy (Japanese)",
    accountDelete: "Delete account (Japanese)",
    photoCredits: "Photo credits",
    legalNav: "Service information",
    cropped: "cropped",
  },
  home: {
    promptLabel: "Tell the AI where you want to go and how you want to spend your time",
    send: "Plan my trip",
    sendLabel: "Plan my trip",
    placeholders: ["Tell us where, how long, and what you enjoy."],
    intro: {
      eyebrow: "For visitors to Japan",
      headline: "Plan your day in Sapporo with AI",
      lead: "MICHI is a trip planner for travelers visiting Japan. Describe your time, budget and interests in your own words, and get a simple itinerary built from real places on Google Maps.",
      note: "Free to try, no sign-up. Works best for Sapporo and nearby areas.",
    },
    examplesLabel: "Try an example",
    // いまの機能で読み取れる条件（エリア・使える時間・予算・人数・移動手段・目的）だけで書く
    examples: [
      "I have 6 hours in Sapporo. I enjoy cafés and local food. Please suggest a relaxed itinerary.",
      "Half a day in Sapporo for two people, no car, budget 10,000 yen. We want seafood and a night view.",
      "A day trip to Otaru by train. I like walking around old streets and trying local sweets.",
    ],
    emptyHint: "Write a request, or set a few trip details.",
    details: DETAILS_COPY_EN,
  },
  thinking: {
    title: "MICHI is planning your trip…",
    steps: ["Reading your request", "Finding real shops and spots", "Putting your route together"],
  },
  result: {
    eyebrow: "AI-built route",
    time: "Time",
    budget: "Estimated cost",
    stops: "Stops",
    stopsUnit: "",
    schedule: "Itinerary",
    stay: "Stay",
    estimate: "Est.",
    openMap: "Open in Google Maps",
    photo: "Photo",
    disclaimer:
      "Shops and spots are based on Google Maps information. The short descriptions are written by AI to explain the route; they are not reviews or recommendations of each place. Stay times, travel times and costs are estimates. Opening hours and prices can change, so please check before you go.",
    retry: "Suggest another plan",
    retrying: "Thinking…",
    edit: "Change my request",
    notices: "Please check",
    assumptions: "What MICHI assumed",
    unresolved: "Conditions MICHI could not check",
    hours: "Hours (Google Maps)",
  },
};

export function siteCopy(locale: Locale): SiteCopy {
  return locale === "en" ? SITE_COPY_EN : SITE_COPY_JA;
}
