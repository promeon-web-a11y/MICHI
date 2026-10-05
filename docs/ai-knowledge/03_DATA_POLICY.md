# 03 DATA POLICY（データ資産の方針）

| 項目 | 内容 |
|---|---|
| 目的 | MICHI が何のデータを持ち、何を持たず、どういう構造で持つかを定める |
| 区分 | **POLICY** |
| Version | 1.0.0 |
| 最終更新 | 2026-10-05 |
| 変更権限 | 人間（プロジェクト責任者）のみ |
| 関連文書 | 守り方：`04_SECURITY_POLICY.md`。現地情報：`06`。AIでの使い方：`07`。現在の実装との対応：`10_REFERENCE.md` 4節 |

> この文書は**方針**であり、DBの設計書ではない。3節の構造は原文が示した基本形で、現在の実装とは名前・項目が異なる部分がある（`10_REFERENCE.md` 4節、Q-04、Q-05）。
> この文書を根拠に、migration の作成・実行をしてはならない（`CLAUDE.md` 5節：人間の承認が必要）。

## 1. 基本方針

| 番号 | 方針 | 重要度 |
|---|---|---|
| D-1 | 「みんなのルート」を会社の主要なデータ資産として扱う | 【MUST】 |
| D-2 | 旅行プランの生成履歴だけでなく、実際に日本を旅行した外国人の行動・評価・現地情報を**構造化して**蓄積する | 【MUST】 |
| D-3 | 集計値（例：Like 500件）だけでなく、**誰が・何に・どう反応したか**という原本の関係データを保持する | 【MUST】 |
| D-4 | 同じ店舗・観光地を利用者ごとに重複して作らない。共通の Place を参照する | 【MUST】 |
| D-5 | 事業に必要のない個人情報を持たない | 【MUST NOT】 |
| D-6 | 重要資産（6節）を失わない | 【MUST】 |
| D-7 | データを特定のベンダーに依存しすぎない、移行可能な構造で持つ | 【SHOULD】 |
| D-8 | 写真などの実ファイルはDBに入れず、DBには参照情報（保存先のパス等）を持つ | 【MUST】 |

基本思想: **旅行体験を理解するためのデータは持つ。個人を監視するためのデータは持たない。**

## 2. 保存するもの

| 対象 | 内容 |
|---|---|
| Routes | 実際に旅行したルート（旅行全体の情報） |
| Route Items | ルート内の訪問場所、訪問した順番、日時・滞在時間、移動方法、実際に使った金額、旅行者のコメント |
| Places | 場所の共通マスター |
| Comments | 旅行者のコメント |
| Likes | 誰がどのルートに「いいね」したか |
| Saves | 誰がどのルートを保存したか |
| Want to go | 誰がどの場所に「行きたい」を付けたか |
| 実際の訪問 | 実際に訪問したかどうか |
| 写真 | 実ファイルは Object Storage、DBにはメタデータと参照 |
| 旅行者による現地情報 | 店舗・施設に関する外国人目線の情報、現地から投稿されたリアルタイム情報（`06`） |
| イベント | ルートの利用・採用、予約サイトへの遷移など、検証に必要なもの（Q-10） |

### 関係データの原本（D-3）

```text
user_id → route_id → like
user_id → route_id → save
user_id → place_id → want_to_go
```

- 【MUST】集計値を別に持つ場合も、原本の行を残す
- 【MUST NOT】集計値を作ったことを理由に、原本の行を削除しない
- 目的: 「アメリカ人の初訪日旅行者に人気のルート」「浅草寺を訪れた人が次にどこへ行ったか」のような分析・推薦に使えるようにする

## 3. 構造の基本形

［方針］すべてを1つの巨大なデータにせず、PostgreSQL 上で役割ごとに分ける。

```text
USERS ─┬─ ROUTES ── ROUTE_ITEMS ── PLACES
       └─ COMMENTS

ROUTES ─ LIKES / SAVES / PHOTOS / COMMENTS
PLACES ─ WANT_TO_GO
```

| 表 | 役割 | 原文が挙げた項目 |
|---|---|---|
| users | 最低限のアカウント情報。メール・認証情報は Auth 側と分ける | user_id, display_name, language, country（任意）, profile_image, created_at |
| places | 場所の共通マスター | place_id, name, external_place_id, latitude, longitude, category |
| routes | 旅行全体の情報 | route_id, creator_id, title, description, days, budget, currency, travel_style, party_size, language, visibility, created_at, updated_at, deleted_at |
| route_items | 実際の旅行行動 | route_id, day_number, sequence, place_id, arrival_time, departure_time, transport_type, actual_cost, traveler_comment |

- ［TODO］上の項目名は原文の案。現在の実装の表・列とは一致しない（`10_REFERENCE.md` 4節）。どちらに合わせるかは未決定（Q-05）
- 【MUST】Place は外部の場所ID（例：`external_place_id`）で同一性を判定し、重複を作らない

## 4. 保存しない、または必要最小限とするもの

| 対象 | 重要度 |
|---|---|
| クレジットカード番号 | 【MUST NOT】保存しない（`08`） |
| パスポート情報 | 【MUST NOT】保存しない |
| 常時のGPS位置履歴 | 【MUST NOT】保存しない（`04` 3節） |
| 必要のない本人確認情報 | 【MUST NOT】保存しない |
| AI推薦に必要のないセンシティブ情報 | 【MUST NOT】保存しない |
| 不要な住所 | 【MUST NOT】保存しない。必要な場合は必要最小限 |
| 不要な電話番号 | 【MUST NOT】保存しない。必要な場合は必要最小限 |

- 【MUST】新しい項目を集める案を出すときは、「何に使うか」「それがないと何ができないか」を書く。書けない項目は集めない
- ［TODO］「必要」と判断する基準と判断者は未決定。迷う項目は人間に確認する

## 5. ベンダーに依存しない（D-7）

- ［方針］Supabase は現在のインフラであり、MICHI のデータ資産そのものではない
- 【SHOULD】ルート・場所・コメント・Like・Save・Want to go は、別の PostgreSQL や他のクラウドへ移せる構造で持つ
- 【SHOULD】特定ベンダーにしかない機能にデータの意味を依存させない（依存する場合は理由を記録する）

技術面の詳細は `05_TECH_STRATEGY.md` 5節。

## 6. 重要資産

失ってはならないデータ:

**ルート／コメント／Like／Save／Want to go／Place との関係性／現地情報**

保護の手段（バックアップ、Export、Soft Delete、操作ログ等）は `04_SECURITY_POLICY.md` 5節。

## 7. AI社員がデータを扱うとき

- 【MUST】`docs/` に書く文書では、利用者の個人情報を匿名にする（`CLAUDE.md` 4節）
- 【MUST NOT】本番データベースに接続しない。必要なら人間の承認を得る（`CLAUDE.md` 5節）
- 【MUST】集計や分析の結果には、期間・対象・取得方法を添える

## 変更履歴

| Version | 日付 | 変更者 | 内容 |
|---|---|---|---|
| 1.0.0 | 2026-10-05 | Claude Code（責任者の指示） | 初版 |
