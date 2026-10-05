# 10 REFERENCE（変わりやすい情報）

> **ここにある情報は、会社方針でも恒久的な事実でもありません。**
> 料金・仕様・条件は予告なく変わります。**実行時に、最新の公式情報を確認してください。**
> この文書の記載だけを根拠に、金額の見積もり・契約・設計の判断をしてはなりません。

| 項目 | 内容 |
|---|---|
| 目的 | 料金、外部サービスの仕様、コストの目安、現在の実装との対応など、時間で変わる情報の置き場所と確認手順を示す |
| 区分 | **REFERENCE** |
| Version | 1.0.0 |
| 最終更新 | 2026-10-05 |
| 変更権限 | AI社員が更新してよい（確認日と出典URLまたはパスが必須）。ただし現在の `CLAUDE.md` 4節は AI社員の書き込み先を `docs/ai-operations/` に限っているため、人間の許可が出るまでは更新案を `docs/ai-operations/` に置く（Q-16） |
| 関連文書 | `05_TECH_STRATEGY.md`、`08_BOOKING_AND_PAYMENT_POLICY.md`、`09_CURRENT_STRATEGY.md` |

## 1. 使い方

1. 金額・上限・仕様・条件が必要になったら、2節の公式ページをその場で確認する
2. 使った値には、**確認日と出典URL**を付ける
3. 確認できなかった値は「未確認」と書く。記憶や過去の文書の値で埋めない
4. この文書に値を追記するときは、行ごとに確認日を書く。確認日のない値は無効として扱う

## 2. 外部サービス（料金・仕様は記載しない）

料金と上限は**意図的に書いていない**。下の公式ページで確認する。

| サービス | MICHI での用途 | 確認する項目 | 公式の確認先 |
|---|---|---|---|
| Supabase | Backend、PostgreSQL、Auth、Storage、Edge Functions | プラン料金、DB容量、Storage、Egress、同時接続、バックアップの保持期間 | https://supabase.com/pricing |
| Vercel | Frontend のホスティング | プラン料金、商用利用の条件、帯域、関数の実行上限 | https://vercel.com/pricing |
| AI API（現在の実装は OpenAI） | プラン生成、文章からの条件・場所の抽出 | モデルごとの単価、データの保持・学習利用の条件、レート制限 | https://openai.com/api/pricing |
| Google Places API (New) | 場所の検索・照合、写真 | SKU ごとの単価、無料枠、Field Mask による課金区分、キャッシュ・保存に関する規約 | https://mapsplatform.google.com/pricing/ |
| Google Routes API | 区間ごとの経路・所要時間 | SKU ごとの単価、TRANSIT の対応地域 | 同上 |
| 予約サービス・Affiliate | 予約候補からの遷移 | 提携条件、報酬率、Cookie の有効期間、表示・表記の義務 | ［TODO］提携先が未定。決まったら追記 |

- 上のURLは 2026-10-05 にこの文書へ記載したもので、**URLの有効性と内容はこの時点で確認していない**。開けない場合は公式サイトから探す
- ［事実］現在の実装が使う外部サービス（OpenAI、Google Places API (New)、Google Routes API）は `mikke-supabase-backend/README.md` と `mikke-frontend/README.md` による（2026-10-05 確認）。モデル名は環境変数で指定され、固定されていない

## 3. 月額コストの目安（原文の概算）

原文（2026年10月時点）が示した**概算の目安**。実績でも見積もりの確定値でもない。AI・Google API の利用量で大きく変わる。

| 規模 | 月額の目安 |
|---:|---:|
| 〜100人 | ¥0〜3,000 |
| 〜500人 | ¥1,000〜5,000 |
| 〜1,000人 | ¥2,000〜8,000 |
| 〜3,000人 | ¥5,000〜15,000 |
| 〜5,000人 | ¥8,000〜20,000 |
| 〜10,000人 | ¥10,000〜30,000 程度を**目標** |

- 算出の根拠（前提とした料金プラン、1人当たりの利用回数）は原文にない
- 1万人規模では Supabase Pro 等への移行を想定する、という記載が原文にある（方針は `05` T-4）
- コストを語るときは、この表ではなく、その時点の料金と実際の利用量から計算する

## 4. 現在の実装との対応（2026-10-05 時点のスナップショット）

`03_DATA_POLICY.md` の概念と、リポジトリ内の migration にある表の対応。**コードが変われば古くなる。使う前に migration を確認する。**
本番環境に反映されているかは確認していない（`mikke-supabase-backend/README.md` は v3 の migration を「まだ実行していません」と記載）。

| 方針上の概念 | 実装の表 | 差 |
|---|---|---|
| users | `public.users` | `email` 列がある（Q-04）。`language` `country` `profile_image` はない。`home_area` がある |
| places | `public.places` | 対応する。`(provider, provider_place_id)` で一意 |
| routes | `public.route_posts` | `days` `currency` `travel_style` `party_size` `language` `deleted_at` はない。1プランにつき1件。集計値 `like_count` 等を持つ |
| route_items | `public.route_post_stops` | 1〜4件まで。時刻は `visited_time` のみ。`transport_type` `actual_cost` `day_number` はない（Q-05） |
| Likes（ルート） | `public.route_likes` | 対応する（原本の行を保持） |
| Saves（ルート） | 該当する表は未確認 | ルートへの反応は `route_likes` と `route_wishes` の2種類 |
| Want to go | `public.route_wishes`（ルート）、`public.saved_places`（場所） | 方針は「場所への Want to go」。実装はルートと場所の両方にある |
| Likes（場所） | `public.place_likes` | 方針に明記なし |
| Comments | `public.route_comments` | 対応する |
| 実際の訪問 | `public.visits` | 対応する |
| 写真 | Storage `route-photos`（非公開、署名付きURL）、パスは `route_post_stops.photo_path` 等 | 対応する。保持期間は未確定 |
| イベント | `public.events`（固定12種） | 予約サイトへの遷移はない（Q-10） |
| 現地報告 | なし | `06` の項目を持つ表はない |

根拠: `mikke-supabase-backend/supabase/migrations/202609230001_initial_schema.sql`、`202609280008_v3_route_posts.sql`、`202609290009_v3_access_ugc.sql`、`202609290010_v3_spots.sql`、`mikke-supabase-backend/README.md`。

## 5. 追記の書式

| 項目 | 値 | 確認日 | 出典 | 確認者 |
|---|---|---|---|---|
| （例）○○の単価 | — | YYYY-MM-DD | URL | 役割名 |

## 変更履歴

| Version | 日付 | 変更者 | 内容 |
|---|---|---|---|
| 1.0.0 | 2026-10-05 | Claude Code（責任者の指示） | 初版。料金の値は記載していない |
