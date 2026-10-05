// 表示言語（日本語 / 英語）の判定。ブラウザとサーバーの両方から読むので、処理は小さな関数だけにする。

export type Locale = "ja" | "en";

export const LOCALES: readonly Locale[] = ["ja", "en"];

/** 言語を切り替えるリンクに出す名前（その言語自身の表記） */
export const LOCALE_NAMES: Record<Locale, string> = { ja: "日本語", en: "English" };

/**
 * 画面の表示言語を決める。?lang= の指定を優先し、無ければブラウザの言語設定（Accept-Language の先頭）を見る。
 * 日本語のブラウザと、言語設定が分からないときは、これまでどおり日本語にする。
 */
export function resolveLocale(langParam: unknown, acceptLanguage: string | null | undefined): Locale {
  if (langParam === "ja" || langParam === "en") return langParam;
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase();
  if (!first) return "ja";
  return first.startsWith("ja") ? "ja" : "en";
}

/** 入力された文章の言語。ひらがな・カタカナ・漢字が1文字でもあれば日本語、無ければ英語として扱う */
export function detectTextLocale(text: string): Locale {
  return /[぀-ヿ㐀-鿿]/.test(text) ? "ja" : "en";
}
