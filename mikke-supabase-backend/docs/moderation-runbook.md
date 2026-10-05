# 通報・ブロック・運営対応の手順（v3.0 みんなのルート）

`202609290009_v3_access_ugc.sql` で追加した仕組みの運用手順です。
運営の操作はすべて Supabase Dashboard の **SQL Editor**（`postgres` ロール）から行います。
`moderation` スキーマは Data API に公開しておらず、`anon` / `authenticated` には権限がありません。

## 利用者ができること（アプリ）

| 操作 | 場所 | 結果 |
|---|---|---|
| 投稿を通報 | ルート詳細 →「このルートを通報」 | `content_reports` に記録。通報した人にはその投稿が表示されなくなる |
| コメントを通報 | コメントの「通報」 | 同上（そのコメントが通報者に表示されなくなる） |
| ユーザーを通報 | 通報画面の「投稿者（コメントした人）を通報」 | 投稿・コメントから相手を特定して記録（アプリは相手の user_id を扱わない） |
| ブロック | ルート詳細 / コメント / 通報画面 | お互いの投稿・コメントが表示されず、いいね・行きたい・コメントもできなくなる |
| ブロック解除 | 設定 →「ブロックしたユーザー」 | すぐに元に戻る |

- 理由は `spam`（宣伝・スパム）/ `harassment`（嫌がらせ・誹謗中傷）/ `inappropriate`（性的・暴力的など不適切）/ `privacy`（個人情報・無断撮影）/ `other`。詳細は任意で500文字まで
- 同じ人が同じ対象を二重に通報しても1件にまとめる。1人24時間20件まで
- 通報時点の内容（タイトル・紹介・立ち寄り・ひと言・コメント本文・写真パス）を `content_snapshot` に保存するため、あとで編集・削除されても確認できる

## 1. 未対応の通報を確認する

```sql
select report_id, waiting, target_type, reason, detail, open_reports_for_target,
       post_visibility, post_hidden_at, comment_hidden_at, user_suspended_at,
       jsonb_pretty(content_snapshot) as snapshot
from moderation.report_queue;
```

- `open_reports_for_target` が多いものから優先する
- 写真は `snapshot` の `photo_path` を Storage（`route-photos` バケット）で開いて確認する
- 目安: 受付から **24時間以内** に対応する（担当・頻度は本番反映前に決める）

## 2. 対処する

```sql
-- 問題なし
select moderation.resolve_report('<report_id>', 'dismiss', '規約違反なし');
-- 投稿またはコメントを非表示（投稿者本人には「運営により非表示」と表示される）
select moderation.resolve_report('<report_id>', 'hide_content', 'スパム');
-- 投稿停止（公開・コメント不可。公開中の投稿・コメントもほかの人に表示しない）
select moderation.resolve_report('<report_id>', 'suspend_user', '嫌がらせの繰り返し');
-- 両方
select moderation.resolve_report('<report_id>', 'hide_and_suspend', '悪質');
```

- 同じ対象への未対応の通報はまとめて閉じる（戻り値は閉じた件数）
- 対応済みの通報は `status`（`actioned` / `dismissed`）・`action_taken`・`moderator_note`・`resolved_at` が残る
- 違法な内容（犯罪予告・児童の性的な内容など）は非表示にしたうえで、証拠を保全し警察等へ相談する

## 3. 元に戻す（異議申し立て）

```sql
select moderation.restore('post', '<post_id>');
select moderation.restore('comment', '<comment_id>');
select moderation.restore('user', '<user_id>');
```

## 4. 記録の確認

```sql
select status, action_taken, count(*) from public.content_reports group by 1, 2 order by 1, 2;
select * from public.content_reports where status <> 'open' order by resolved_at desc limit 50;
```

## 退会との関係

- 退会すると `content_reports.reporter_id` / `reported_user_id` は NULL になり、通報の記録と `content_snapshot` は残る
  （保持期間は本番反映前に決める。プライバシーポリシーへの記載が必要）
- ブロックは退会でお互い削除される

## 未整備（本番反映前に決める）

- 新しい通報が来たことを運営へ知らせる仕組み（Database Webhook → メール等）。現在は SQL Editor で定期的に確認する前提
- 通報された投稿を一定件数で自動的に非表示にするか（現在は運営が確認するまで、通報者以外には表示される）
- 利用規約・コミュニティガイドラインへの禁止事項と対応の記載、アプリからの問い合わせ窓口
