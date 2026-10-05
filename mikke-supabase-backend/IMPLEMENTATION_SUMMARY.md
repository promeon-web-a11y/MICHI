# Mikke｜Supabaseバックエンド実装結果

## 結論

**AIに任せられる設計・SQL・RLS・バックエンド処理・計測・テスト・文書化を実装済みです。**

残る人手作業は、Supabaseプロジェクト作成、キー設定、クラウド反映、実機での最終確認です。

## 今回行った作業と結果

| 作業 | 結果 |
|---|---|
| DB設計 | 7テーブルを定義。保存Placeと共通Placeを分離し、Plan内の順序も保持 |
| Supabase SQL | 型、制約、外部キー、Index、更新日時トリガー、RPCを1 migrationに集約 |
| RLS | 全7テーブルで有効化。他人の保存・Plan・Visit・Eventを見られない設計 |
| Place保存 | Place登録／再利用とユーザー保存を `save_place` で一括処理 |
| AIプラン | 条件絞り込み→上位12候補→固定JSON出力→候補外拒否→DB保存を実装 |
| 採用・訪問 | `accept_plan` と `answer_visit` を実装。訪問済み状態も連動 |
| イベント計測 | MVPの11イベントを固定。重要5イベントはDBトリガーで自動記録 |
| テスト | スキーマ、30件のRLS/RPC/イベントテスト、ダミーデータを作成 |
| ドキュメント | ローカル起動、本番反映、データ構成、実装境界をREADMEに記載 |

## KPIにつながる記録

| KPI | 利用イベント／データ |
|---|---|
| 登録 | `sign_up_completed` |
| 初回保存・保存数 | `place_saved` / `saved_places` |
| Plan生成 | `plan_generated` |
| Plan採用 | `plan_accepted` |
| 実訪問 | `visit_answered` の `went = true` |
| Plan → Visit率 | 訪問したPlan数 ÷ 生成Plan数 |

## 安全性の要点

- 認証ユーザーIDはリクエスト本文ではなくJWTの `auth.uid()` を使用
- 他ユーザーの所有データはRLSで遮断
- AIは保存済み候補のID以外をPlanに入れられない
- 訪問Placeは採用Plan内にあるものだけ許可
- KPIの主要イベントはクライアントから直接偽装できない
- Service Role Keyをフロントエンドで使わない

## 未実施／ユーザー側で必要

| 作業 | 理由 |
|---|---|
| Supabaseプロジェクト作成・接続 | アカウント操作とProject Refが必要 |
| APIキー設定 | Supabase anon keyとOpenAI API keyが必要 |
| クラウドmigration／Function deploy | 接続先と権限が必要 |
| 実DBでpgTAP実行 | この作業環境にはDocker/Supabase CLIがないため |
| 画面からの最終動作確認 | UI接続後に実機確認が必要 |

## 完了判定

- 設計・実装ファイル: **完了**
- 静的整合性チェック: **完了**
- Supabase実環境への反映: **未実施（認証情報待ち）**
- MVPの本番動作確認: **未実施（UI接続後）**
