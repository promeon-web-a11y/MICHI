// 全ページ共通のフッター（1行だけの細い帯）。規約類へのリンクと写真のクレジットを置く。
// locale を省くと日本語。リンク先の規約類のページは日本語のまま。
import Link from "next/link";

import { IMAGES } from "@/content/images";
import type { Locale } from "@/content/locale";
import { siteCopy } from "@/content/site";

export function SiteFooter({ locale = "ja" }: { locale?: Locale }) {
  const { brand, footer } = siteCopy(locale);
  const legalLinks = [
    { href: "/terms", label: footer.terms },
    { href: "/privacy", label: footer.privacy },
    { href: "/account/delete", label: footer.accountDelete },
  ];
  const credits = Object.values(IMAGES).filter((image) => image.credit !== null);
  return (
    <footer lang={locale} className="border-t border-line text-xs text-fg-mute">
      <div className="mx-auto max-w-[1360px] px-5 py-6 md:px-10">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
          <p>© 2026 {brand.name}</p>
          <nav aria-label={footer.legalNav} className="flex flex-wrap gap-x-7 gap-y-2">
            {legalLinks.map((link) => (
              <Link key={link.href} href={link.href} className="transition-colors hover:text-fg">
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <details className="mt-3">
          <summary className="inline-block cursor-pointer transition-colors hover:text-fg">{footer.photoCredits}</summary>
          <ul className="mt-3 space-y-1.5 leading-relaxed">
            {credits.map((image) => (
              <li key={image.src}>
                {image.alt} —{" "}
                <a href={image.credit!.source} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-fg">
                  {image.credit!.author}
                </a>
                {locale === "en" ? " (" : "（"}
                <a href={image.credit!.licenseUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-fg">
                  {image.credit!.license}
                </a>
                {locale === "en" ? `, ${footer.cropped})` : `・${footer.cropped}）`}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </footer>
  );
}
