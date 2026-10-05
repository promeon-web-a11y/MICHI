// Home 以外の情報ページの上部（黒地に見出しだけ。写真は使わない）。
export function PageHero({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-[860px] px-5 py-12 md:py-16">
        <p className="text-xs tracking-[0.2em] text-fg-mute">{eyebrow}</p>
        <h1 className="mt-3 text-[28px] font-bold leading-tight md:text-4xl">{title}</h1>
        <p className="mt-4 max-w-2xl text-pretty text-sm text-fg-sub md:text-[15px]">{lead}</p>
      </div>
    </section>
  );
}
