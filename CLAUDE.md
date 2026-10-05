# MICHI

このファイルは、MICHIで作業するAI（Claude Code と AI社員）が最初に読む共通ルールです。
`【 】` の部分は雛形です。内容を決めたら書き換えてください。

## 1. MICHIの目的

- **何をするプロジェクトか**: 【例: 旅行者が、SNSで見つけた場所から行き先のプランを作れるサービス「Mikke」を育てる】
- **誰のためか**: 【対象の人】
- **解決したい困りごと**: 【困りごと】
- **いまの段階**: 【例: デモサイトで反応を確かめている段階】
- **当面のゴール**: 【いつまでに・何を達成するか】

詳しい方針は `docs/ai-operations/strategy.md`、数値目標は `docs/ai-operations/kpi.md` を参照。

## 2. フォルダ構成

| パス | 内容 |
|---|---|
| `mikke-frontend/` | Web版（Next.js）。デモサイト |
| `mikke-mobile/` | スマートフォン版（Expo） |
| `mikke-supabase-backend/` | バックエンド（Supabase） |
| `assets/` | 画像などの素材 |
| `docs/design-reference/` | デザインの参考資料 |
| `docs/ai-operations/` | AI社員の運用文書（方針・KPI・決定の記録・各担当の成果物） |
| `docs/ai-knowledge/` | 社内ナレッジ（会社方針・商品原則・データ／セキュリティ方針・技術戦略）。使い方は「7. MICHI AI Knowledge」 |
| `.claude/agents/` | AI社員（サブエージェント）の定義 |

3つのアプリのフォルダは、それぞれ独立したGitリポジトリで、独自の `CLAUDE.md` を持っています。
その中で作業するときは、そのフォルダの `CLAUDE.md` のルールにも従ってください。

## 3. AI社員

| 名前 | 担当 | 成果物の保存先 |
|---|---|---|
| `manager` | 進捗管理とタスク整理 | `docs/ai-operations/manager/` |
| `research` | 市場・旅行者ニーズ調査 | `docs/ai-operations/research/` |
| `product` | デモサイトの改善案と確認 | `docs/ai-operations/product/` |
| `marketing` | SNS・Webコンテンツ案 | `docs/ai-operations/marketing/` |
| `operations` | 問い合わせや利用データの整理 | `docs/ai-operations/operations/` |

## 4. 作業ルール

- AI社員が書き込むのは `docs/ai-operations/` の中だけ。アプリやサイトのコードは読むだけにする
- 成果物のファイル名は日付から始める（例: `2026-10-04-competitors.md`）
- 事実には根拠（出典のURL、ファイルのパス）を付ける。推測は「推測」と明記する
- 確認できていないことを「確認済み」「完了」と書かない
- 決まったことは `docs/ai-operations/decisions.md` に追記する
- 秘密情報（`.env.local`、APIキー、パスワード）の中身を、文書やチャットに書き写さない
- 利用者の個人情報は、文書に残す前に匿名にする
- 【追加のルール】

## 5. 承認が必要な操作

次の操作は、AIが自分の判断で実行せず、必ず先に人間の承認を得てください。

**コード・公開**
- `mikke-frontend/` `mikke-mobile/` `mikke-supabase-backend/` のコードや設定の変更
- デプロイ、本番環境への反映、アプリストアへの提出
- `git push`、ブランチやコミットの削除・書き換え

**データ**
- 本番データベースへの接続、データの変更・削除
- マイグレーションの実行
- ファイルやフォルダの削除

**外部への発信**
- SNSへの投稿、Webコンテンツの公開
- メールや問い合わせへの返信の送信
- 外部サービスへの登録、フォームの送信

**お金・契約**
- 有料サービスの契約・購入、プランの変更
- APIの利用量が大きく増える操作

**その他**
- 環境変数・APIキー・権限設定の変更
- 【追加の項目】

承認の求め方: 「何をするか」「なぜ必要か」「元に戻せるか」を伝えてから、返事を待つ。

## 6. 承認なしで進めてよい操作

- ファイルを読むこと、検索すること
- `docs/ai-operations/` の中での文書の作成・更新
- 公開されている情報の調査
- 【追加の項目】

## 7. MICHI AI Knowledge

`docs/ai-knowledge/` は、MICHIの会社方針・商品原則・データ方針・セキュリティ方針・技術戦略をまとめた社内ナレッジです。
索引は `docs/ai-knowledge/README.md` です。どの文書を読むか迷ったら、まず索引を見てください。

**全部を毎回読む必要はありません。** 共通の3文書を読み、あとは仕事の内容に応じて必要な文書だけを追加で読みます。

### 7-1. 共通で確認する文書

Claude Code と AI社員は、MICHIに関する重要な判断・実装・調査をする前に、次の3つを確認する。

- `docs/ai-knowledge/01_COMPANY_CONSTITUTION.md`
- `docs/ai-knowledge/02_PRODUCT_PRINCIPLES.md`
- `docs/ai-knowledge/09_CURRENT_STRATEGY.md`

誤字の修正や、ファイルの場所を調べるだけの軽い作業では省いてよい。

### 7-2. 仕事の内容に応じて追加で確認する文書

開発・コード変更・DB設計・API・AI機能を扱うときは、共通の3文書に加えて `03` `04` `05` `06` `07` から関係するものを読む。

次の事項に関係する実装・設計では、対応する文書の確認を**必須**とする。

| 関係する事項 | 必ず確認する文書 | 関連する要確認事項 |
|---|---|---|
| 個人情報 | `03_DATA_POLICY.md`、`04_SECURITY_POLICY.md` | Q-04 |
| 位置情報 | `04_SECURITY_POLICY.md` | Q-07 |
| Routes / Places / Comments / Likes / Saves / Want to go | `03_DATA_POLICY.md` | Q-05、Q-09 |
| AIへのデータ入力 | `07_AI_DATA_USAGE_POLICY.md` | — |
| 現地情報 | `06_REALTIME_TRAVEL_DATA.md` | Q-08、Q-13 |
| 予約・決済 | `08_BOOKING_AND_PAYMENT_POLICY.md` | Q-10 |
| 認証・RLS | `04_SECURITY_POLICY.md` | Q-04、Q-06 |
| Storage（写真） | `03_DATA_POLICY.md`、`04_SECURITY_POLICY.md` | Q-14 |
| データ削除・バックアップ | `04_SECURITY_POLICY.md` | Q-03、Q-14 |
| 技術構成・インフラ・コスト | `05_TECH_STRATEGY.md`、`10_REFERENCE.md` | Q-12 |

ナレッジを確認しても、「5. 承認が必要な操作」は変わらない。コードやDBの変更には、これまでどおり人間の承認が必要。

### 7-3. 判断が衝突したときの優先順位

1. 人間からの最新の明示的な指示
2. `01_COMPANY_CONSTITUTION.md`
3. POLICY の文書（`02` `03` `04` `06` `07` `08`）
4. `09_CURRENT_STRATEGY.md`（および STRATEGY の `05`）
5. REFERENCE の文書（`10_REFERENCE.md`）
6. 既存の実装

- **セキュリティ、プライバシー、データ削除、法令、本番データ**に関係する重大な矛盾は、上の順位で自分で決めない。作業を止めて人間に確認する
- HYPOTHESIS（仮説）、TO VALIDATE、［TODO］と書かれた内容を、確定事項として扱わない
- `10_REFERENCE.md` の価格・API仕様・外部サービスの仕様は、永続的な事実として扱わない。使う前に最新の公式情報を確認する

### 7-4. 知らずに進めてはならない原則

詳細は各文書にある。次に反する作業は、始める前に人間に確認する。

- AIだけに依存しない
- 実際の旅行者のデータを MICHI の資産とする
- AIは確認できない事実を捏造しない
- カード番号を原則保持しない
- 不要な位置履歴を原則保持しない
- 重要な旅行データ（ルート・コメント・Like・Save・Want to go・Place との関係・現地情報）を保護する
- AI社員の権限は必要最小限にする
- 重大な操作には人間の承認を得る
- 利用者の重要な最終判断（予約・決済など）を利用者に残す

### 7-5. 未解決の要確認事項（Q-01〜Q-16）

`docs/ai-knowledge/README.md` の6節に、既存資料と方針の食い違いが Q-01〜Q-16 として記録されている。

- 作業が未解決の Q 項目に関係するときは、進める前に「**未解決の方針衝突がある**」と、Q の番号を添えて人間に知らせる
- Q 項目を、自分の判断で解決しない。どちらか一方を前提にして実装・文書化しない

### 7-6. AI社員ごとの担当ナレッジ

全AI社員は `01` `02` `09` を読み、担当に応じて次を追加する。各AI社員の定義（`.claude/agents/*.md`）にも同じ内容を書いている。

| AI社員 | 状態 | 担当ナレッジ |
|---|---|---|
| `manager` | 既存 | 01, 02, 09 |
| `research` | 既存 | 01, 02, 06, 09, 10 |
| `product` | 既存 | 01, 02, 06, 08, 09 |
| `marketing` | 既存 | 01, 02, 06, 08, 09 |
| `operations` | 既存 | 01, 02, 03, 04, 09 |
| Development AI | 未作成 | 01, 02, 03, 04, 05, 06, 07, 09 |
| Security AI | 未作成 | 01, 03, 04, 05, 09 |
| Finance AI | 未作成 | 01, 05, 08, 09, 10 |

- `docs/ai-knowledge/` は、AI社員にとって**読むだけ**の場所。変更が必要だと考えたときは、変更案を `docs/ai-operations/` に書いて人間に知らせる
- 新しいAI社員を追加するときは、`docs/ai-knowledge/README.md` 5節の手順に従い、上の表と README の表に1行ずつ足し、定義ファイルに「参照するナレッジ」の節を書く
