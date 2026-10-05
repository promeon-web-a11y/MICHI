# Mikke Supabase Backend

Mikke MVPの「保存 → AIプラン → 採用 → 実訪問」を、Supabase上で検証するためのバックエンド一式です。

## 実装済み

| 領域 | 内容 |
|---|---|
| DB | `users / places / saved_places / plans / plan_items / visits / events` |
| セキュリティ | 全7テーブルでRLSを有効化。他ユーザーの保存・プラン・訪問・イベントは参照不可 |
| Place保存 | `save_place` RPCでPlaceのupsertとユーザー保存を1トランザクション化 |
| AIプラン | 条件で候補を絞り、OpenAIで1〜4件を構成して保存するEdge Function |
| Place照合 | 店名/住所からGoogle Places (New) を検索し候補を返すEdge Function |
| Instagramキャプション解析 | 貼り付けられたキャプション文から店名/エリア/カテゴリ候補をOpenAIで抽出するEdge Function |
| プラン採用 | `accept_plan` RPC |
| 訪問回答 | `answer_visit` RPC。「行った」Placeを訪問済みに更新 |
| KPIイベント | 固定12イベント。主要イベントはDBトリガーで自動記録。`analytics` スキーマにKPI集計ビュー |
| テスト | スキーマ、RLS分離、RPC、イベント連動、イベント改ざん防止、KPI集計を確認するpgTAP 87項目 |
| 開発データ | 札幌のダミーPlace 2件とデモユーザー |

## データ構成

| テーブル | 役割 | 主な所有関係 |
|---|---|---|
| `users` | Supabase Authと1対1のプロフィール | 本人のみ |
| `places` | Google等で正規化した共通Place | 認証ユーザーが参照 |
| `saved_places` | ユーザーがSNSから保存したPlace | 本人のみ |
| `plans` | 条件・生成結果・採用状態 | 本人のみ |
| `plan_items` | プラン内の1〜4スポット | 親Planの本人のみ |
| `visits` | 行った／行かなかった回答 | 本人のみ |
| `events` | KPI計測ログ（退会後は匿名化して保持） | 本人のみ参照・書き込みはRPC/トリガーのみ |

## 固定イベント

`sign_up_completed`, `url_submitted`, `place_extraction_result`, `place_saved`,
`place_removed`, `plan_request_submitted`, `plan_generated`,
`plan_generation_failed`, `plan_accepted`, `plan_regenerated`, `visit_answered`, `visit_confirmed`

`place_saved / place_removed / plan_generated / plan_accepted / visit_answered / visit_confirmed` はDB変更から自動記録されます。クライアントが直接記録できるイベント名は残りの計測用イベントに制限し、重要KPIの水増しを防ぎます。

## イベント計測とKPI集計

### 記録のしかた

| イベント | 記録元 | 備考 |
|---|---|---|
| `sign_up_completed` | `auth.users` 作成トリガー | |
| `place_saved` / `place_removed` | `saved_places` INSERT / DELETE トリガー | 同じPlaceの再保存（更新）は記録しない |
| `plan_generated` | `create_generated_plan` による `plans` INSERT | |
| `plan_accepted` | `plans.accepted_at` が初めて設定された時 | 再採用しても1回 |
| `visit_answered` | `visits` INSERT / UPDATE | 回答履歴。回答を変えるたびに記録 |
| `visit_confirmed` | `went=true` が初めて成立した時 | **訪問数KPIの正本**。Plan単位で1回だけ（部分ユニークインデックスで保証） |
| その他5種 | `track_event` RPC | `url_submitted`, `place_extraction_result`, `plan_request_submitted`, `plan_generation_failed`, `plan_regenerated` のみ |

- クライアントは `events` を **SELECT（自分の行）しかできません**。書き込みは `track_event`（security definer、上記5種のみ、properties はJSONオブジェクト・16KBまで）とDBトリガーだけです。
- `plans` / `plan_items` / `visits` も直接は書き込めず、`create_generated_plan` / `accept_plan` / `answer_visit` RPC経由のみです（KPIの偽装防止）。
- `track_event` に同じ `p_event_id` を再送しても重複しません（既存IDを返す）。`trackEvent(client, name, properties, eventId)` の第4引数で指定できます。
- フロントエンドは `url_submitted` に「1回のURL送信操作」ごとの `eventId` を付けて送ります。AI解析時と保存時の両方で呼ばれても1件だけ記録されます（URL変更・保存完了・「続けて保存する」で新しい操作になる）。
- `generate-plan` はイベント記録に失敗すると `track_event_failed` をEdge Functionログへ出します。

### 集計ビュー（`analytics` スキーマ）

APIには公開していません。Supabaseダッシュボードの **SQL Editor** から参照します。

```sql
select * from analytics.kpi_totals;                               -- 累計KPI
select * from analytics.kpi_daily order by date_jst desc limit 30; -- 日次（Asia/Tokyo）
```

| 列（kpi_totals） | 意味 |
|---|---|
| `registered_users_total` | 登録ユーザー数（退会者を含む累計） |
| `registered_users_current` | 現在の登録ユーザー数 |
| `places_saved_total` / `saved_places_current` | 保存数（累計 / 現在保存中） |
| `plans_generated_total` / `plans_accepted_total` | プラン生成数 / 採用数 |
| `visits_confirmed_total` | 訪問数（`visit_confirmed`） |
| `plan_accept_rate` / `accepted_plan_visit_rate` / `generated_plan_visit_rate` | 採用率 / 採用→訪問率 / 生成→訪問率 |

`kpi_daily` は日ごとの同項目と `active_users`（その日に何かイベントがあった既存ユーザー数）を返します。

### 内部・テストアカウントの除外

```sql
update public.users set is_internal = true where email in ('you@example.com');
```

`is_internal = true` のユーザーはすべてのKPIビューから除外されます。利用者自身はこの列を変更できません。

### 退会ユーザーの扱い

ユーザーを削除しても `events` は残り、`user_id` は NULL になります（KPI履歴は減らない）。
削除直前に properties を集計用の許可キーのみに絞り、位置情報・自由記述・URL・各種ID・AI出力を消し、
`sign_up_completed` のユーザーIDも消します。内部アカウントの場合は履歴ごと削除します。

退会依頼を受けたときの運営手順（本人確認・削除方法・禁止操作・完了確認）は
[`docs/account-deletion-runbook.md`](docs/account-deletion-runbook.md) を参照してください。

## AIプラン生成の流れ

1. JWTから利用者を確定
   - `start_at` / `end_at` は日付・時刻・タイムゾーン（`+09:00` または `Z`）付きのISO 8601のみ受け付ける（`invalid_time_format`）。終了≦開始は `invalid_time_range`、24時間超は `time_range_too_long`、終了が過去なら `time_range_in_past`（いずれも400）。フロントは送信前に同じ条件を日本語メッセージで検証する（`mikke-frontend/src/lib/planTime.ts`）
2. 本人の未除外Placeのみ取得
3. 予算、営業時間（定休日を含む）、距離、気分、保存経過日数で候補を絞り上位12件に限定
4. サーバーが各候補の「当日の営業時間」と「候補間の移動時間（直線距離×迂回係数から推定、到達不能な組は除外）」を計算してOpenAIへ渡す
5. AIは固定JSON Schema（Structured Outputs, strict）で **どの場所を・どの順で・何分滞在するか・理由** だけを返す。場所は短いキー（`c1`…）の enum で固定され、候補外は構造上返せない
6. **時刻はサーバーが決定的に計算**（前の滞在＋移動時間の後、開店まで待つ）。AIに時刻計算をさせない
7. 最終ゲート `validatePlan` で、候補内・重複なし・順序・営業時間内・移動時間を確保・時間枠内・予算内を再検証
8. 不合格なら理由をAIに返して1回だけ再試行。それでも不合格なら、AI自身のプランのうち検証を通る先頭部分（例: 1軒目のみ）があればそれを使う。なければ保存せず `422 ai_output_failed_validation`（画面には日本語で再試行を案内）
9. PlanとPlan Itemsを1トランザクションで保存

不合格になった試行は、理由とAIの生出力がEdge Functionログ（`plan_attempt_rejected`）に残り、最終的に失敗した場合は `plan_generation_failed` イベント（`violations`, `attempts`, `generated_raw`）にも記録されます。
ロジックは `supabase/functions/generate-plan/plan.ts` にあり、`npm run test:functions` で単体テストできます。

営業時間は次の正規化形式なら判定します。データがない場合は `unknown` として候補に残し、AIには推測させません。

```json
{
  "timezone": "Asia/Tokyo",
  "weekly": {
    "monday": [["09:00", "18:00"]],
    "tuesday": [["09:00", "18:00"]]
  }
}
```

## Place照合（Google Places）の流れ

1. `resolve-place` Edge FunctionがJWTから利用者を確定（未ログインは拒否）
2. 検索クエリ（店名/住所）をGoogle Places API (New) の Text Search に渡す
3. 結果をMikkeのplacesスキーマ（`place_category`, `price_band`, `opening_hours`の形式）に変換
4. 候補（最大5件）をそのまま返す。DBへの保存はここでは行わない

フロントエンドは候補から1件選び、そのまま既存の `save_place` RPCを呼ぶ（保存フロー自体は変更なし）。
カテゴリはGoogleのplace typesからのベストエフォート変換、営業時間のタイムゾーンは `Asia/Tokyo` 固定（日本国内サービス前提）。
Google Places APIキー（`GOOGLE_PLACES_API_KEY`）はこの関数の中でのみ使用し、フロントエンドには渡さない。

## Instagramキャプション解析の流れ

Instagram公式APIは、そのアプリに接続したアカウント自身の投稿しか取得できない仕様のため、
他人の投稿のキャプションをAPI経由で取得することはできません。そのためMikkeでは、
**ユーザーがURLとキャプション文を自分で貼り付ける**運用にし、Instagram APIは一切使いません。

1. `extract-place-candidates` Edge FunctionがJWTから利用者を確定
2. ユーザーが貼り付けたURL＋キャプション文をOpenAIに渡す
3. 店名候補・エリア候補・カテゴリ候補を、固定JSON Schemaで**複数件**抽出（1件に確定しない）
4. フロントエンドが候補から検索クエリを組み立て、既存の `resolve-place`（Google Places）にそのまま渡す
5. 以降は既存のGoogle Places照合〜`save_place`保存のフローと完全に同じ

この機能は `OPENAI_API_KEY` / `OPENAI_PLAN_MODEL` を再利用するため、追加のSecrets登録は不要です。

## モバイル共有 → Place特定（identify-place）の流れ

mikke-mobile の共有受信（OS Share Sheet）から呼ばれる、抽出〜照合を1回で行うEdge Functionです。
既存の `extract-place-candidates` / `resolve-place` は mikke-frontend が使用中のため変更していません。

1. JWTから利用者を確定（未ログインは拒否。既存関数と同じ方式）
2. 入力 `{ url?, text?, source? }` を整理。`source` は URL から再判定（`instagram / tiktok / youtube / web / unknown`）。不正URLは無視して警告、テキスト中のURLは除去
3. URL・テキストに手がかりが無ければ **OpenAIを呼ばず** `insufficient_information`（URL先のページは取得しない＝スクレイピングしない）
4. OpenAI（Responses API + Structured Outputs strict）で店名・エリア・都道府県/市区町村・カテゴリ・検索クエリ・根拠・AI confidence を抽出。Place ID・住所・座標・営業時間は出力させない
5. 店名が無い／AI confidence が低い場合は Google を呼ばず `insufficient_information`
6. Google Places API (New) Text Search（`pageSize: 5`、Field Mask は `id, displayName, formattedAddress, location, primaryType, types, businessStatus` のみ）。0件のときだけ次の候補で1回再検索
7. 店名一致度・エリア一致・カテゴリ一致・閉業状態でスコア化し、AI confidence を掛けて最終 confidence（0〜1）を算出
8. `confirmed / needs_review / not_found / insufficient_information / error` で返す。同名店舗が並ぶ場合は確定せず `needs_review` と候補一覧
9. DB保存は行わない（Step 3-4）

判定ロジックは `supabase/functions/identify-place/logic.ts`、テストは `npm run test:functions`。
Secretsは既存の `OPENAI_API_KEY` / `OPENAI_PLAN_MODEL` / `GOOGLE_PLACES_API_KEY` を使用（任意で `OPENAI_IDENTIFY_MODEL`）。
Edge Functionログには共有本文・APIキーを出さず、ステータス・件数・エラーコードのみ出力します。

## モバイル共有 → Place保存（save-place）の流れ

identify-place の結果を、ログインユーザーの保存Placeとして登録するEdge Functionです。
**migrationは追加していません**。既存の `save_place` RPC と一意制約をそのまま使います。

1. JWTから利用者を確定（本文の `user_id` は読まない。Service Role Key は使わず、ユーザーJWTのクライアントでRLSを常に効かせる）
2. 入力検証: Google Place ID 必須。`identification.status` は `confirmed`、または `needs_review` かつ `selected_by_user: true` のみ受け付ける（not_found 等は400）
3. `places`（provider='google', provider_place_id）→ 本人の `saved_places` を確認。保存済みなら **何も書き込まず** `already_saved`（既存の共有元情報を上書きしない）
4. 未保存なら既存 `save_place` RPC で places 作成/再利用 → saved_places 作成
5. 同時実行で3をすり抜けた場合も、DBの一意制約（`places(provider, provider_place_id)` / `saved_places(user_id, place_id)`）と `ON CONFLICT` で重複行は作られない。RPCの返却行が `saved_at ≠ updated_at`（ON CONFLICT UPDATE された行）なら `already_saved` を返す

| 返却 status | HTTP | 意味 |
|---|---|---|
| `saved` | 200 | 新規保存 |
| `already_saved` | 200 | 保存済み（重複作成なし） |
| `unauthorized` | 401 | 未ログイン／不正JWT |
| `invalid_request` | 400 | 入力不正・保存不可ステータス |
| `error` | 500 | DBエラー等（詳細はEdge Functionログのみ） |

保存する値（既存カラムのみ）:

- `places`: `provider='google'`, `provider_place_id`, `name`, `address`, `latitude`, `longitude`, `category`（Google types から resolve-place と同じ規則で変換）, `data_checked_at`
- `saved_places`: `source_platform`（youtube / unknown は enum に無いため `other`）, `source_url`（正規化URL。テキストのみの共有は Google Maps URL で代替）, `source_caption`（共有テキストからURLを除いたもの）, `extraction_confidence`
- `primary_type` / `types` / `business_status` は対応カラムが無いため保存しない

本番での確認用SQL（読み取り専用）は `docs/step-3-4-verification.sql`。

## モバイル「今日どこ行く？」→ A/B/C プラン（generate-plan-options）

mikke-mobile の PlanConditions（Step 4-4）から、保存Placeだけを使ってコンセプトの異なる最大3プランを作る Edge Function です。
**`generate-plan`（mikke-frontend が使用中）は変更していません**。その純粋ロジック `generate-plan/plan.ts`
（`schedulePlan` / `validatePlan` / 営業時間 / 移動の概算）を再利用します（`priceCeiling` を export しただけ）。migration はありません。

1. JWTで利用者を確定し、RLS の効いたクエリで本人の `saved_places` だけを取得（service role 不使用）
2. 候補の絞り込み: 座標あり・非表示でない・予算の料金帯内・その時間に定休でない・現在地から直線距離の半径内
   - 半径（候補選定専用。移動時間としては表示しない）: 徒歩 1.5km/時間（1.5〜5km）、電車・バス 5km/時間（5〜30km）、車 10km/時間（10〜50km）。選んだ中で最速の手段を使う
   - 気分・距離・営業時間の確実さ・保存日数で並べ、上位15件だけを AI に渡す（住所・座標は渡さない）
3. 候補3件以上で3プラン、2件なら2、1件なら1（場所を作って3案にしない）
4. OpenAI（Structured Outputs strict）は候補キーの選択・順番・滞在時間・タイトル/コンセプト/説明/理由だけを返す
5. サーバーが時刻を計算（現在地からの移動バッファ込み）し、プランごとに時間枠・予算・営業時間・重複・候補外を検証。
   プラン間で同じ場所の組み合わせは除外。違反があれば1回だけ再試行し、それでも駄目なら有効な前半部分だけを使う
6. 予算は料金帯の上限の合計（`estimated` / 一部不明 `partial` / 不明 `unknown`）。AI に金額を作らせない。交通費は含まない
7. 各プランを既存 `create_generated_plan` RPC で `plans` に保存（`condition_json.option` に set_id / variant / title 等）。
   選択は既存 `accept_plan` RPC
8. 正確な現在地は保存・ログしない（`condition_json` と イベントは約1km精度 or 座標なし）

注意: `plans` の INSERT ごとに `plan_generated` イベントが記録されるため、1回の生成で最大3件になる（KPI の採用率の分母が増える）。

## 選択したプランの実ルート（route-plan）

mobile Step 4-6。`accept_plan` 済みの本人のプランについて、現在地 → 場所1 → 場所2 … の各区間を
Google Routes API（`directions/v2:computeRoutes`）で取得し、実際の所要時間で時刻を計算し直します。DB には保存しません（migration なし）。

1. JWT で本人確認。plans / plan_items はユーザー JWT で読むので RLS により本人の行だけ（他人の plan は 404）。`status=accepted` 以外は 409
2. 出発地点（正確な現在地）はアプリから受け取り、メモリ上だけで使う（DB の condition_json は約1km精度のため）。ログにも出さない
3. 区間ごとの手段（ルールベース・すべて Google の実経路から選ぶ）: 徒歩を選択していて徒歩15分以内 → 徒歩。
   それ以外は DRIVE（車を選択時）の実ルート。電車・バスを選択していて車の経路が無ければ、
   **「公共交通（Google マップで確認）」の区間**（`status: external_transit`）として返し、所要時間・路線・時刻・運賃は作らない
   （徒歩の実ルートは `walk_reference` として参考情報でだけ返す）
   - **日本 MVP では Routes API の TRANSIT を問い合わせない**（Step 4-6 の本番確認で札幌は HTTP 200 / routes なし＝no_route だったため）。
     Secret `ENABLE_GOOGLE_TRANSIT=true` を設定したときだけ、従来どおり TRANSIT も問い合わせて速い方を使う
4. TRANSIT は経由地を指定できないため区間ごとに1リクエスト。DRIVE は `TRAFFIC_UNAWARE`（Essentials SKU）
5. 時間超過時は、表示する時刻を狂わせないよう**最後の場所だけ**を調整（滞在を最短 max(15分, 元の50%) まで縮める → だめなら外す）。
   1か所でも入らなければ `does_not_fit`
6. 運賃は `routes.travelAdvisory.transitFare` が返った区間だけ（Google は全区間の運賃が分かる場合のみ返す）。推測しない。
   予算は「場所の既存概算＋確認できた運賃」。確認できた額だけで超えた場合のみ `over_budget=true`
7. キー: `GOOGLE_ROUTES_API_KEY`（推奨・サーバー専用・Routes API のみ許可）。未設定なら `GOOGLE_PLACES_API_KEY`（Routes API を許可している場合のみ動く）

## v3.0: 行った記録・みんなのルート（202609280008_v3_route_posts.sql）

mikke-mobile v3.0 の「行った記録 → 投稿 → みんなのルート」「いいね・行きたい・コメント」「投稿写真」「設定」「今月の生成回数」のための追加です。
既存テーブル・既存 RPC・KPI トリガーは変更していません（`answer_visit` は記録作成時に内部から呼び、訪問 KPI の正本は従来どおり）。

| 追加 | 内容 |
|---|---|
| `users` 列 | `show_posts_in_feed`（自分の投稿を みんな に表示）, `notify_weekend_hints`, `notify_saved_updates`（通知の希望。配信の仕組みは未実装） |
| `route_posts` | 行った記録と公開ルートを同じ行で扱う（`visibility` private → public）。1プランにつき1件 |
| `route_post_stops` | 立ち寄りごとの時刻・何をした・ひと言・写真パス（移動時間・交通手段は保存しない） |
| `route_likes` / `route_wishes` / `route_comments` | いいね・行きたい・コメント。件数は `route_posts` にトリガーで集計 |
| Storage `route-photos` | 非公開バケット（5MB・jpeg/png/webp）。パス `<user_id>/<post_id>/<file>`。閲覧は署名付きURL |

- RLS: 他人の投稿は「公開済み かつ 投稿者の show_posts_in_feed = true」のときだけ読める（`can_view_route_post`）。書き込みはすべて security definer RPC（`auth.uid()`）。直接書けるのは本人の投稿・コメントの削除だけ
- RPC: `list_public_routes`（キーワード・地域・予算上限・系統・テーマ AND、並び順 recommended / likes / wishes）, `list_public_route_areas`, `get_route_post`, `list_my_route_posts`, `list_my_route_wishes`, `create_visit_record`, `update_route_post`（`p_publish=true` のときだけ公開）, `unpublish_route_post`, `toggle_route_reaction`, `add_route_comment`, `start_route_from_post`（同じ順番で行く＝採用済みプランを作る。`condition_json.source = mobile_route_copy`）, `save_route_places`（今日向けに調整）, `get_plan_generation_usage`
- `generate-plan-options` は任意の `place_ids`（1〜20件）と `based_on_route_post_id` を受け付ける（「今日向けに調整」で元ルートの場所だけを候補にする）。未指定なら従来どおり
- `delete-account` は削除前に `route-photos/<user_id>/` の写真を消す（DB の行は CASCADE で消える）
- 未確定の仕様: 無料生成回数の上限（`get_plan_generation_usage` の `monthly_limit` は null）、「おすすめ」の並び順の定義（現在は 反応数×14日減衰）、通知の配信方式、写真の保持期間

### 追補: 直接取得の権限・通報・ブロック（202609290009_v3_access_ugc.sql）

- `route_posts` / `route_comments` の SELECT を列単位にした。`memory`・`plan_id`・`user_id`（コメントの `user_id` も）は Data API から直接読めない（本人も）。本人向けの値は `get_route_post` / `list_my_route_posts` が返す。`select=*` は 42501 になる
- `toggle_route_reaction(p_post_id, p_kind, p_active)`: 同じ人・投稿・種類の操作を advisory lock で直列化。`p_active` を渡すとその状態にする（連打・二重送信でもエラーにならず結果が同じ）。2引数の切り替えも従来どおり動く
- `create_visit_record` の付け直しで、残す場所の時刻・行動・ひと言・写真を引き継ぐ。表紙が外した場所の写真なら残った写真に差し替える
- `list_unused_route_photos(p_post_id?)`: 自分の写真のうち、投稿から参照されていない10分以上前のものを返す（アプリが Storage API で消す）
- 通報・ブロック: `report_route_content`, `block_user`, `list_blocked_users`, `unblock_user`。表 `content_reports` / `user_blocks` は Data API から読めない
- 運営: `moderation.report_queue` / `moderation.resolve_report` / `moderation.restore`（SQL Editor のみ）。手順は [docs/moderation-runbook.md](docs/moderation-runbook.md)
- 非表示（`route_posts.hidden_at` / `route_comments.hidden_at`）・投稿停止（`users.suspended_at`）・ブロック・自分が通報した投稿は、一覧・詳細・写真の署名・反応・コメントのすべてで `can_view_route_post` / `can_view_route_comment` により除外される

### 追補: お店・スポット（202609290010_v3_spots.sql）

- スポット = 既存の `places`。`list_public_spots` は、見られる公開ルートの立ち寄り先になっている場所だけを返す（写真は立ち寄りの投稿写真、地域はルートの地域。無ければ null で、架空の値は作らない）
- スポットの「行きたい」= 既存の `saved_places`（`set_place_reaction(p_place_id, 'wish', p_active)`。`source_url = mikke://places/<id>`）。保存一覧の「場所」とプラン作成にそのまま使われる。**KPI の place_saved にも数えられる**点に注意
- スポットの「いいね」= 新しい `place_likes`（Data API からは読めない）。`list_my_place_likes` で保存一覧の「いいね」
- `get_spot`（写真・この場所を含むルート）、`get_route_post` の各立ち寄りに `wished`
- 立ち寄りのコメント（`route_post_stops.note`）を 140 → 300 文字に

### 反映手順（本番。まだ実行していません）

1. ステージング等で `supabase db push` → `supabase test db`（`supabase/tests/003〜005`）
2. 本番: `npm run db:push`（202609280008〜202609290010 が未適用のはず。適用前に `supabase migration list` で確認）
3. `npm run functions:deploy:generate-plan-options` と `npm run functions:deploy:delete-account`
4. Storage に `route-photos` バケットが作られ、非公開であることをダッシュボードで確認

## ローカル起動

必要環境: Docker、Supabase CLI、Node.js 20以上。

```bash
npm install
npm run supabase:start
npm run db:reset
cp supabase/.env.example supabase/.env.local
# supabase/.env.local にローカルanon keyとOpenAI API keyを設定
npm run functions:serve
```

別ターミナルでDBテストを実行します。

```bash
npm run db:test
npm run check
```

Docker が無い環境では、PGlite（WASM の PostgreSQL）に Supabase の最小限の部品（ロール・既定権限・auth.uid()・storage）を用意して
同じ `supabase/tests/*.sql` を実行できます（pgTAP はテストで使う関数だけの互換実装）。PostgREST・Storage API・Postgres 17 との差は
ステージングで確認してください。

```bash
npm run db:test:local                         # すべて
npm run db:test:local -- 004_route_access.sql # 1ファイル
```

アプリを手元で動かして確認するときは、同じ PGlite にテストデータを入れたローカル API を使えます（本番・ステージングには接続しません。Edge Functions は外部 API の費用を避けるため動かさず 503 を返すので、AI プラン生成は確認できません）。

```bash
npm run local:api     # http://localhost:54321（エミュレーターからは http://10.0.2.2:54321）
# mikke-mobile 側（.env.local より優先される）
EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:54321 EXPO_PUBLIC_SUPABASE_ANON_KEY=mikke-local-anon-key npx expo start --dev-client
```

テスト用アカウントは `local-a@mikke.test` / `local-b@mikke.test`（パスワード `local-pass-1`）。店名・コメントはすべて「テスト」と分かるローカル専用のデータです。

## Supabaseへの反映

Supabase CLIは `devDependencies` に入っています（Dockerは本番反映のみなら不要）。

```bash
npm install
npm run login                       # ブラウザで認証
npm run link -- --project-ref YOUR_PROJECT_REF
npm run db:push                     # migrationを本番DBへ反映

cp supabase/.env.production.example supabase/.env.production
# supabase/.env.production に OPENAI_API_KEY と GOOGLE_PLACES_API_KEY を設定
npm run secrets:set
npm run functions:deploy   # generate-plan / resolve-place / extract-place-candidates をまとめてデプロイ
```

`supabase/.env.production` に `SUPABASE_URL` / `SUPABASE_ANON_KEY` は書きません。
Secret名は `SUPABASE_` で始められず、デプロイ済みEdge Functionにはこの2つが自動注入されるためです。

`supabase/.env.local` と `supabase/.env.production` はGitへ追加しないでください。
`SUPABASE_SERVICE_ROLE_KEY` はこのEdge Functionに不要であり、ブラウザにも置きません。
`supabase/seed.sql` はローカル専用のダミーデータです。本番では実行しません（`db push` は実行しません）。

## フロントエンドから使う処理

`src/mikke-backend.ts` に以下の薄いクライアント関数があります。

- `savePlace`
- `removeSavedPlace`
- `acceptPlan`
- `answerVisit`
- `trackEvent`

AIプラン生成は `supabase.functions.invoke("generate-plan", { body: { conditions } })` を呼び出します。

## 現時点の境界

- Instagram URL解析とGoogle Places照合は、4〜6日目の検証結果どおり別の取込処理として接続します。この成果物は「候補確定後」の保存から担当します。
- 営業時間が不明なPlaceは除外せず、結果画面で要確認として扱います。
- OpenAIモデル名は固定せず `OPENAI_PLAN_MODEL` で設定します。
- 本番反映にはSupabaseプロジェクト、anon key、OpenAI API keyが必要です。
