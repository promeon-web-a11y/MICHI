# アカウント削除 運営手順書

Mikke v0.1 にはアプリ内の削除ボタンがなく、アカウント削除は利用者からのメール依頼を受けて運営者が行います。
利用者向けの案内は `mikke-frontend/src/app/account/delete/page.tsx`（`/account/delete`）、
依頼先は Vercel の環境変数 `NEXT_PUBLIC_SUPPORT_EMAIL` のメールアドレスです。

**v0.2（モバイルアプリ）以降**は、アプリの「設定・アカウント → アカウントを削除」から利用者自身が削除できます。
Edge Function `delete-account` がリクエストの JWT から本人を確定し、この手順書と同じ `auth.users` の hard delete
（`auth.admin.deleteUser(id, false)`）を行います。DB 側の結果は下の「削除の仕組み」と同じです。
メール依頼（アプリを使えない場合など）は引き続きこの手順で対応します。

## 削除の仕組み（前提）

**Supabase Auth のユーザー（`auth.users`）を1件削除するだけ**で、DB側は1つのトランザクションで以下が自動的に行われます。
途中で失敗した場合は全体が取り消され、中途半端に消えた状態にはなりません。

| データ | 結果 |
|---|---|
| `auth.users` / `auth.identities` / `auth.sessions` / refresh token | 削除 |
| `public.users` | 削除（`auth.users` から CASCADE） |
| `saved_places` / `plans` / `plan_items` / `visits` | 削除（CASCADE） |
| `events` | 一般ユーザー：`user_id` を NULL にし、properties を集計用キーのみに絞って匿名化して残す。`is_internal = true`：削除 |
| `places`（共有の店舗情報） | 残る（`created_by` が NULL になる） |

## 禁止操作

以下は**行わないでください**。Authとデータの片方だけが残ります。

- ❌ `delete from public.users ...` など、`public` スキーマ側だけを削除する
  → Authユーザーが残り、ログインできるのにデータが壊れた状態になります（`public.users` は再作成されません）。
- ❌ Admin API の soft delete（`auth.admin.deleteUser(id, true)`）
  → `auth.users` の行が残るため CASCADE が動かず、個人データがすべて残ります。
- ❌ `public.users.deleted_at` を設定するだけで「削除済み」とみなす
  → アクセスは止まらず、データも残ります。
- ❌ `saved_places` 等を手で先に削除する（不要。ユーザー削除で自動的に消えます）

## 手順

### 1. 依頼の受付・本人確認

1. サポート用メールに件名「【Mikke】アカウント削除希望」等の依頼が届く。
2. Supabase Dashboard → Authentication → Users で、**依頼メールの送信元アドレス**を検索する。
   - 一致するユーザーがいる → 本人確認OK。次へ。
   - 送信元と、本文に書かれた削除対象アドレスが異なる → **削除対象アドレス宛て**に確認メールを送り、そのアドレスからの返信で意思確認が取れるまで削除しない。
   - 該当ユーザーがいない → 「該当するアカウントが見つからない」旨を返信する（他人の登録有無を推測させる情報は書かない）。
3. 目安：受付から3営業日以内に最初の返信をする（`/contact` の記載どおり）。

### 2. 削除前の確認（SQL Editor）

対象ユーザーのIDを控えます。

```sql
select au.id, au.email, u.is_internal, au.created_at, au.last_sign_in_at
from auth.users au
left join public.users u on u.id = au.id
where lower(au.email) = lower('削除対象のメールアドレス');
```

- 1件だけ返ることを確認し、`id` を控える（以下 `<USER_ID>`）。
- `is_internal = true`（開発・テスト用）の場合、操作履歴（events）も完全に削除されます。

### 3. 削除の実行

Supabase Dashboard → Authentication → Users → 対象ユーザーの「…」メニュー → **Delete user** を実行する。

- エラーが出た場合：トランザクションは取り消され、何も消えていません。エラーメッセージを控え、原因を確認してから再実行してください。
  利用者には「対応中」と連絡し、放置しないでください。
- Dashboard が使えない場合の代替（同じ hard delete です）：
  ```sql
  delete from auth.users where id = '<USER_ID>';
  ```

### 4. 削除後の確認（SQL Editor）

すべて `0` であることを確認します。

```sql
select
  (select count(*) from auth.users        where id = '<USER_ID>')      as auth_users,
  (select count(*) from auth.identities   where user_id = '<USER_ID>') as auth_identities,
  (select count(*) from auth.sessions     where user_id = '<USER_ID>') as auth_sessions,
  (select count(*) from public.users      where id = '<USER_ID>')      as users,
  (select count(*) from public.saved_places where user_id = '<USER_ID>') as saved_places,
  (select count(*) from public.plans      where user_id = '<USER_ID>') as plans,
  (select count(*) from public.visits     where user_id = '<USER_ID>') as visits,
  (select count(*) from public.events     where user_id = '<USER_ID>' or entity_id = '<USER_ID>') as events_linked;
```

`plan_items` は `plans` の削除に連動して FK で必ず消えるため、個別確認は不要です。

### 5. 完了連絡

依頼元（本人確認済みのアドレス）へ完了を連絡します。例：

> Mikkeをご利用いただきありがとうございました。
> ご依頼いただいたアカウント（登録メールアドレス：xxx）と関連データの削除が完了しました。
> 削除したアカウント及びデータは復元できません。
> なお、ログイン中の端末では最大1時間程度ログイン状態の表示が残る場合がありますが、データは既に削除されています。
> 今後同じメールアドレスで新規登録することは可能です（以前のデータは引き継がれません）。

### 6. 記録

対応記録として、受付日・完了日・対応者を残します（依頼メールのスレッドで可）。
削除したユーザーのIDやデータの控えを別途保存しないでください。

## 補足

- 削除後も、発行済みのアクセストークン（最大1時間）が切れるまでは画面上ログイン状態に見えることがありますが、
  データは表示されず、保存・プラン作成などの書き込みはすべて失敗します。
- Supabase のバックアップには一定期間情報が残ります（プライバシーポリシー記載どおり、障害復旧以外には使いません）。

## 持ち主のいない投稿写真（v3.0）

`delete-account` は auth.users を消す前に `route-photos/<user_id>/` の写真をすべて消します（1000件を超えてもページングして消す）。
Storage の一時的な障害で消し切れなかった場合、ログに `delete_account_photo_cleanup_incomplete`（件数のみ）が出ます。
そのときは SQL Editor で持ち主のいないフォルダーを探し、Dashboard の Storage から消してください。

```sql
select (storage.foldername(name))[1] as user_folder, count(*) as files
from storage.objects
where bucket_id = 'route-photos'
  and not exists (select 1 from public.users u where u.id::text = (storage.foldername(name))[1])
group by 1;
```
