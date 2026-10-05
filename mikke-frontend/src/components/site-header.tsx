"use client";

// 全ページ共通のヘッダー（黒地・下に 1px の線）。
// - PC: ロゴ＋3つのリンク＋「ログイン / 新規登録」　- スマホ: ロゴ＋ハンバーガー（全画面メニュー）
// - 「ログイン / 新規登録」は画面がまだ無いため、押せない表示にしている（画面を作ったらリンクに差し替える）
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { LOCALE_NAMES, type Locale } from "@/content/locale";
import { siteCopy } from "@/content/site";

import { CloseIcon, MenuIcon } from "./icons";

const CONTAINER = "mx-auto flex h-[var(--header-h)] max-w-[1360px] items-center justify-between px-5 md:px-10";
const LOGO = "text-[22px] font-medium leading-none tracking-[0.22em]";

/**
 * locale を省くと日本語（Home 以外のページはこれまでどおり）。
 * languageSwitch を付けると、もう一方の言語の Home へ切り替えるリンクを出す（Home だけが2言語に対応している）。
 */
export function SiteHeader({ locale = "ja", languageSwitch = false }: { locale?: Locale; languageSwitch?: boolean }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const { brand: BRAND, header: HEADER_COPY, navLinks } = siteCopy(locale);
  const otherLocale: Locale = locale === "en" ? "ja" : "en";
  // 言語を選んでいる間は、Home へのリンクでもその言語を保つ
  const homeHref = languageSwitch ? `/?lang=${locale}` : "/";
  const NAV_LINKS = navLinks.map((link) => ({ ...link, to: link.href === "/" ? homeHref : link.href }));
  const languageLink = languageSwitch ? (
    <Link
      href={`/?lang=${otherLocale}`}
      lang={otherLocale}
      hrefLang={otherLocale}
      aria-label={`${HEADER_COPY.language}: ${LOCALE_NAMES[otherLocale]}`}
      className="text-[13px] font-medium text-fg-sub underline-offset-4 transition-colors hover:text-fg hover:underline"
    >
      {LOCALE_NAMES[otherLocale]}
    </Link>
  ) : null;

  // メニューを開いている間は、後ろのページをスクロールさせない
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const isCurrent = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      <header lang={locale} className="sticky top-0 z-40 border-b border-line bg-background text-fg">
        <div className={CONTAINER}>
          <Link href={homeHref} className={LOGO} aria-label={HEADER_COPY.home}>
            {BRAND.name}
          </Link>

          <div className="hidden items-center gap-11 md:flex">
            <nav aria-label={HEADER_COPY.mainMenu} className="flex items-center gap-11">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.to}
                  aria-current={isCurrent(link.href) ? "page" : undefined}
                  className="relative py-2 text-[14px] font-medium text-fg transition-colors hover:text-fg-sub aria-[current=page]:hover:text-fg aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-0 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-px aria-[current=page]:after:bg-accent"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
            <button
              type="button"
              disabled
              title={HEADER_COPY.comingSoon}
              className="h-9 cursor-default rounded-full border border-line-strong px-4 text-[13px] font-medium text-fg"
            >
              {HEADER_COPY.auth}
            </button>
            {languageLink}
          </div>

          <div className="flex items-center gap-3 md:hidden">
            {languageLink}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label={HEADER_COPY.openMenu}
              aria-expanded={menuOpen}
              className="-mr-2 flex h-11 w-11 items-center justify-center"
            >
              <MenuIcon width={26} height={26} />
            </button>
          </div>
        </div>
      </header>

      {menuOpen && (
        <div lang={locale} className="anim-fade-in fixed inset-0 z-50 flex flex-col bg-background text-fg md:hidden">
          <div className="flex h-[var(--header-h)] items-center justify-between border-b border-line px-5">
            <span className={LOGO}>{BRAND.name}</span>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label={HEADER_COPY.closeMenu}
              className="-mr-2 flex h-11 w-11 items-center justify-center"
            >
              <CloseIcon width={26} height={26} />
            </button>
          </div>
          <nav aria-label={HEADER_COPY.mainMenu} className="flex flex-col px-5 pt-4">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.to}
                onClick={() => setMenuOpen(false)}
                aria-current={isCurrent(link.href) ? "page" : undefined}
                className="border-b border-line py-5 text-lg font-medium text-fg-sub aria-[current=page]:text-fg"
              >
                {link.label}
              </Link>
            ))}
            <p className="py-5 text-lg font-medium text-fg-mute">
              {HEADER_COPY.auth}
              <span className="ml-3 text-xs">{HEADER_COPY.comingSoon}</span>
            </p>
          </nav>
        </div>
      )}
    </>
  );
}
