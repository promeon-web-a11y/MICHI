"use client";

// ルートの共有ボタン。端末の共有メニューを開き、使えないブラウザではリンクをコピーする。
import { useState } from "react";

import { ROUTE_COPY } from "@/content/site";

import { ShareIcon } from "../icons";

export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // 共有メニューを閉じた・コピーが許可されていない。何もしない
    }
  }

  return (
    <span className="flex items-center gap-2">
      <button type="button" onClick={share} aria-label={ROUTE_COPY.share} className="flex h-8 w-8 items-center justify-center transition-colors hover:text-fg-sub">
        <ShareIcon width={19} height={19} strokeWidth={1.5} />
      </button>
      <span className="text-xs text-fg-sub" aria-live="polite">
        {copied ? ROUTE_COPY.shared : ""}
      </span>
    </span>
  );
}
