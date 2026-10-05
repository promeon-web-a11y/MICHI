# Mikke Frontend

Mikke の Web 版（Next.js）です。全画面の写真とAI入力欄を中心にした「シネマティック・フルスクリーン」のデザインで、
登録なしで「文章を入力 → 実在する場所を含むプランを表示」まで試せます。

## セットアップ

```bash
npm install
cp .env.local.example .env.local
# .env.local に値を設定（下の「環境変数」）
npm run dev
```

## 環境変数

| 変数名 | 使う場所 | 内容 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ブラウザ | Supabase（公開前提の値。アクセス制御は RLS） |
| `NEXT_PUBLIC_SUPPORT_EMAIL` / `NEXT_PUBLIC_SITE_URL` | ブラウザ | お問い合わせ窓口・公開URL |
| `OPENAI_API_KEY` / `OPENAI_PLAN_MODEL` | **サーバーのみ** | AI（`/api/plan`） |
| `GOOGLE_PLACES_API_KEY` | **サーバーのみ** | Google Places（`/api/plan`・`/api/place-photo`） |

サーバーのみの3つは `mikke-supabase-backend` の Edge Function Secrets と同じ名前・同じ値です。
`NEXT_PUBLIC_` を付けないので、ブラウザには渡りません（キーをコードに直接書かないこと）。

## ページ

| ページ | パス | 内容 |
|---|---|---|
| Home | `/`（`?q=` で入力欄に文章を入れて開ける） | 全画面の写真・コピー・AI入力欄・写真カード・プランの表示 |
| みんなのプラン | `/plans` | プランの一覧（現在は仮データ）。選ぶと Home の入力欄に条件が入る |
| Q&A・お問い合わせ | `/contact` | よくある質問（アコーディオン）とお問い合わせフォーム（メールアプリを開く） |
| 規約など | `/terms` `/privacy` `/account/delete` | 公開ページ（アプリ版からも開く） |

## AI プランの流れ（`POST /api/plan`）

1. 文章から条件を整理（OpenAI）: エリア・予算・人数・移動手段・時間・目的と、地図の検索語
2. 実在する場所を検索（Google Places Text Search）
3. 候補の中から立ち寄り先を選んで並べる（OpenAI）。候補に無い場所は捨てるので、実在しない場所は混ざらない
4. 到着時刻・移動時間の目安を計算（直線距離から。`services/maps/travel-estimate.ts`）

ログインなしで呼べるため、IP ごとの簡易な回数制限を入れています（`services/rate-limit.ts`。1分5回・1日40回）。
既存の Edge Functions（`generate-plan-options` など。ログイン必須・保存した場所から作る）は変更していません。

## Vercelへのデプロイ

Project Settings → Environment Variables に、上の表の変数を設定します。
`OPENAI_API_KEY` `OPENAI_PLAN_MODEL` `GOOGLE_PLACES_API_KEY` が無いと、AI入力欄は「ただいまプランを作成できません」と表示します。
`NEXT_PUBLIC_SUPPORT_EMAIL` が Production で未設定・不正な場合はビルドが失敗します（`next.config.ts`）。
アカウント削除依頼を受けた後の運営作業は `mikke-supabase-backend/docs/account-deletion-runbook.md` を参照してください。

## ディレクトリ構成

```
src/
  app/             ページ（/, /plans, /contact, 規約類）と API（api/plan, api/place-photo）
  components/      画面の部品（home / plans / contact、共通ヘッダー・フッター）
  content/         文言・写真・FAQ・仮データ（コピーや写真の差し替えはここだけ）
  services/        API 処理（UI から分離）
    ai/            OpenAI
    places/        Google Places
    maps/          移動時間の目安
    plan/          プラン生成（プロンプト・組み立て・型・表示用の整形・ブラウザ用クライアント）
    plans/         みんなのプランの取得口（Supabase に切り替えるときはここ）
  core/            モバイル版と共通の Supabase API クライアント（コピー。今の画面では未使用。保存・投稿を足すときに使う）
  web/             ログイン状態（Supabase Auth）・画面用フック（同上）
  lib/             Supabase クライアント・運営者情報
```

写真は `public/images/` と `src/content/images.ts`（クレジットつき。フッターに表示）。テストは `npm test`。
