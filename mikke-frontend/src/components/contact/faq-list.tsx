// よくある質問（アコーディオン）。開閉はブラウザ標準の <details> に任せる（JavaScript なしで動く）。
import { PlusIcon } from "../icons";

export function FaqList({ items }: { items: { question: string; answer: string }[] }) {
  return (
    <div className="border-t border-line">
      {items.map((item) => (
        <details key={item.question} className="group border-b border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[15px] font-bold md:text-base [&::-webkit-details-marker]:hidden">
            {item.question}
            <PlusIcon width={20} height={20} className="shrink-0 text-fg-sub transition-transform duration-300 group-open:rotate-45" />
          </summary>
          <p className="pb-6 pr-8 text-sm leading-loose text-fg-sub">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
