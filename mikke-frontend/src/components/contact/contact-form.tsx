"use client";

// お問い合わせフォーム（名前・メールアドレス・内容だけ）。
// 送信用のサーバー処理は持たず、これまでと同じサポート窓口へのメール（mailto）を使う:
// 入力内容を件名・本文に入れた状態で、利用者のメールアプリを開く。
// サーバーで受け付ける方式に変えるときは、onSubmit の中身だけを差し替える。
import { useState, type FormEvent } from "react";

import { SITE_INFO, supportMailto } from "@/lib/siteInfo";

const FIELD =
  "mt-2 w-full rounded-lg border border-line-strong bg-input px-4 text-base text-fg outline-none transition-colors placeholder:text-fg-mute focus:border-fg-sub";

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setOpened(false);
    if (!name.trim()) return setError("お名前を入力してください。");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("メールアドレスを正しく入力してください。");
    if (message.trim().length < 5) return setError("お問い合わせ内容を入力してください。");

    const body = [`お名前：${name.trim()}`, `メールアドレス：${email.trim()}`, "", message.trim()].join("\n");
    const mailto = supportMailto("MICHIへのお問い合わせ", body);
    if (!mailto) return setError("ただいまフォームを利用できません。時間をおいてお試しください。");
    setError(null);
    setOpened(true);
    window.location.href = mailto;
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <div>
        <label htmlFor="contact-name" className="text-sm font-bold">
          お名前
        </label>
        <input
          id="contact-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          className={`${FIELD} h-13`}
        />
      </div>
      <div>
        <label htmlFor="contact-email" className="text-sm font-bold">
          メールアドレス
        </label>
        <input
          id="contact-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={120}
          className={`${FIELD} h-13`}
        />
      </div>
      <div>
        <label htmlFor="contact-message" className="text-sm font-bold">
          お問い合わせ内容
        </label>
        <textarea
          id="contact-message"
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={1500}
          className={`${FIELD} resize-y py-3 leading-7`}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}

      <button type="submit" className="h-12 w-full rounded-full bg-primary px-8 text-sm font-bold text-on-primary transition-opacity hover:opacity-90 sm:w-auto">
        メールアプリで送信する
      </button>

      <p className="text-[13px] leading-relaxed text-fg-mute" aria-live="polite">
        {opened
          ? `メールアプリを開きました。内容を確認して、そのまま送信してください。開かない場合は ${SITE_INFO.supportEmail} までメールでご連絡ください。`
          : "ボタンを押すと、入力した内容が入った状態でメールアプリが開きます。通常3営業日以内を目安に返信します。"}
      </p>
    </form>
  );
}
