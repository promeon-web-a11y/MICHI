import type { Metadata } from "next";
import { Bullets, InfoPage, InlineLink, Note, Numbered, Section } from "../../_components/InfoPage";
import { BRAND } from "@/content/site";
import { SITE_INFO, supportMailto } from "@/lib/siteInfo";

export const metadata: Metadata = { title: "アカウントの削除 | MICHI" };

const DELETE_REQUEST_SUBJECT = "【MICHI】アカウント削除希望";
const DELETE_REQUEST_BODY = [
  "MICHIのアカウント削除を希望します。",
  "",
  "削除したいアカウントのメールアドレス：",
  "",
  "※本人確認のため、MICHIに登録したメールアドレスから送信してください。",
].join("\n");

// アカウント削除の案内（Google Play の「アカウント削除URL」にも使う）。
// - Androidアプリ（v0.2）: 「設定・アカウント」→「アカウントを削除」から利用者自身が削除できる
//   （mikke-mobile/src/app/account/*.tsx → Edge Function delete-account。本人の auth.users を hard delete）
// - Web版: 現在は削除の画面を持たない（アプリ、または下のメール依頼で削除する）
// - ログインできない場合: サポート用メールで依頼 → 運営者が同じ方法で削除する
//   （運営者の作業手順は mikke-supabase-backend/docs/account-deletion-runbook.md）
// DB 側では関連データの削除（cascade）と操作履歴の匿名化が1回の処理で自動的に行われる。
// 画面の名称（「設定・アカウント」など）はアプリの表示と一致させること。
export default function AccountDeletePage() {
  const mailto = supportMailto(DELETE_REQUEST_SUBJECT, DELETE_REQUEST_BODY);
  return (
    <InfoPage title="アカウントの削除">
      <p>
        {BRAND.name}（運営者：{SITE_INFO.operatorName}）のアカウントと、アカウントに紐づくデータの削除方法をご案内します。
      </p>

      <Section title="アプリから削除する（Android版アプリ）">
        <p>ログインできる場合は、アプリから利用者ご自身で削除できます。</p>
        <Numbered
          items={[
            "MICHIアプリを開き、ログインします。",
            "ホーム画面の下にある「設定・アカウント」を開きます。",
            "画面の下にある「アカウントを削除」をタップします。",
            "削除される内容を確認し、「削除に進む」をタップします。",
            "「データがすべて削除され、元に戻せないことを理解しました」にチェックを入れ、「完全に削除する」をタップします。",
          ]}
        />
        <p>
          削除が完了すると、アプリはログイン前の画面に戻り、端末に保存されているログイン情報も消去されます。
          削除できなかった場合はアカウントはそのまま残りますので、時間をおいてもう一度お試しください。
        </p>
      </Section>

      <Section title="アプリを使えない場合・ログインできない場合">
        <Note>
          ログインできない場合は、
          <InlineLink href="/contact">お問い合わせ窓口</InlineLink>への依頼で削除を受け付けます。
        </Note>
        <Numbered
          items={[
            <>
              MICHIに登録したメールアドレスから、
              {mailto ? (
                <a href={mailto} className="font-medium text-fg underline underline-offset-2">
                  {SITE_INFO.supportEmail}
                </a>
              ) : (
                <InlineLink href="/contact">お問い合わせ窓口</InlineLink>
              )}
              へ、件名「{DELETE_REQUEST_SUBJECT}」で、削除したいアカウントのメールアドレスを送ってください。
            </>,
            "運営者が本人確認を行います（登録したメールアドレスからの連絡をお願いする場合があります）。",
            "確認後、運営者がアカウントと関連データを削除し、完了をご連絡します。",
          ]}
        />
        {mailto && (
          <a
            href={mailto}
            className="inline-block rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-on-primary transition-opacity hover:opacity-90"
          >
            削除依頼メールを作成する
          </a>
        )}
      </Section>

      <Section title="削除されるデータ">
        <p>アカウントを削除すると、次のデータが削除されます。</p>
        <Bullets
          items={[
            "アカウント及び認証情報（メールアドレス、パスワード、ログイン状態）",
            "保存した場所（共有・入力したSNS投稿のURLや文章、メモを含む）",
            "作成・採用したプラン（希望時間、予算、移動手段、出発地の大まかな位置などの条件を含む）",
            "訪問の記録",
          ]}
        />
      </Section>

      <Section title="削除されずに残るデータ">
        <Bullets
          items={[
            "利用状況の統計に使う操作履歴：利用者との紐づけを解除し、集計に必要な項目だけを残して、個人を識別できない形に匿名化したうえで残る場合があります。",
            "店舗・施設の基本情報（名称、住所、位置など）：複数の利用者で共有する情報のため残ります。削除したアカウントとの紐づけは解除されます。",
          ]}
        />
      </Section>

      <Section title="ご注意">
        <p>削除したアカウント及びデータは、原則として復元できません。</p>
        <p>同じメールアドレスで再登録することはできますが、以前のデータは引き継がれません。</p>
        <p>
          システムのバックアップには、削除後も一定期間情報が残る場合があります。バックアップは障害復旧の目的にのみ使用し、それ以外の目的では利用しません。
        </p>
      </Section>
    </InfoPage>
  );
}
