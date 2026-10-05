import type { Metadata } from "next";
import { InfoPage, InlineLink, Numbered, Section } from "../_components/InfoPage";
import { SITE_INFO } from "@/lib/siteInfo";

export const metadata: Metadata = { title: "MICHI利用規約" };

export default function TermsPage() {
  return (
    <InfoPage title="MICHI利用規約" meta={<>制定日：{SITE_INFO.termsEnactedOn}</>}>
      <p>
        本利用規約は、{SITE_INFO.operatorName}（以下「運営者」）が提供するサービス「MICHI」（Androidアプリ及びWebサイト。以下「本サービス」）の利用条件を定めるものです。
      </p>

      <Section title="第1条　本サービス">
        <p>
          本サービスは、利用者がSNS等で見つけた店舗、観光地、イベント等を保存し、利用者が指定した時間、予算、移動手段、現在地その他の条件をもとに、AIが外出プランを提案するサービスです。
        </p>
      </Section>

      <Section title="第2条　利用登録">
        <p>利用者は、正確な情報を登録し、自身の責任でアカウントを管理するものとします。</p>
        <p>18歳未満の方は、保護者の同意を得たうえで利用してください。</p>
      </Section>

      <Section title="第3条　入力情報">
        <p>利用者は、SNS投稿のURL、キャプション、店舗情報その他の情報を、本サービスの機能を利用するために入力できます。</p>
        <p>利用者は、第三者の著作権、プライバシーその他の権利を侵害する情報を入力してはなりません。</p>
      </Section>

      <Section title="第4条　AIによる提案">
        <p>本サービスが生成するプランや店舗情報は、AI及び外部サービスを利用して作成されます。</p>
        <p>
          営業時間、料金、休業日、交通状況、店舗の営業状況等について、正確性や最新性を保証するものではありません。実際に訪問する前に、店舗や施設の公式情報を確認してください。
        </p>
        <p>本サービスは、予約の成立、移動の安全、施設の利用可否等を保証するものではありません。</p>
      </Section>

      <Section title="第5条　禁止事項">
        <p>利用者は、次の行為を行ってはなりません。</p>
        <Numbered
          items={[
            "法令または公序良俗に違反する行為",
            "他人になりすます行為",
            "他人の権利やプライバシーを侵害する行為",
            "本サービスへ不正にアクセスする行為",
            "本サービスへ過度な負荷をかける行為",
            "不正な目的で位置情報や店舗情報を利用する行為",
            "その他、運営者が不適切と判断する行為",
          ]}
        />
      </Section>

      <Section title="第6条　サービスの変更・停止">
        <p>運営者は、保守、障害、外部サービスの停止その他必要な場合、本サービスの全部または一部を変更・停止できるものとします。</p>
      </Section>

      <Section title="第7条　アカウントの停止">
        <p>利用者が本規約に違反した場合、運営者は事前の通知なくアカウントを停止または削除する場合があります。</p>
      </Section>

      <Section title="第8条　免責及び責任">
        <p>運営者は、本サービスから得られる情報の完全性、正確性、最新性及び特定目的への適合性を保証しません。</p>
        <p>ただし、運営者の故意または重大な過失による場合など、法令上免責が認められない場合には、本条は適用されません。</p>
      </Section>

      <Section title="第9条　個人情報">
        <p>
          個人情報の取扱いについては、別途定める<InlineLink href="/privacy">プライバシーポリシー</InlineLink>に従います。
        </p>
      </Section>

      <Section title="第10条　退会">
        <p>
          利用者は、本サービス所定の方法（アプリの「設定・アカウント」からのアカウント削除、またはお問い合わせ窓口への依頼）により退会できます。
        </p>
        <p className="text-sm text-fg-mute">
          退会（アカウント削除）の方法は<InlineLink href="/account/delete">アカウントの削除</InlineLink>をご確認ください。
        </p>
      </Section>

      <Section title="第11条　規約の変更">
        <p>運営者は、必要に応じて本規約を変更する場合があります。重要な変更を行う場合は、本サービス内等で通知します。</p>
      </Section>

      <Section title="第12条　準拠法及び管轄">
        <p>
          本規約は日本法に準拠します。本サービスに関して紛争が発生した場合、札幌地方裁判所または札幌簡易裁判所を第一審の合意管轄裁判所とします。
        </p>
      </Section>

      <div className="space-y-1 border-t border-line pt-6 text-sm">
        <p>運営者：{SITE_INFO.operatorName}</p>
        <p>
          お問い合わせ：<InlineLink href="/contact">お問い合わせ窓口</InlineLink>
        </p>
      </div>
    </InfoPage>
  );
}
