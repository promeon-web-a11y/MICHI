# src/core — モバイル版と共通の API クライアント

`mikke-mobile/src` の React / Expo に依存しないモジュール（Supabase の REST・RPC・Edge Functions 呼び出し、
表示用の整形、画面をまたぐ状態のストア）を **そのまま** コピーしたものです。Web β版はこれを使って、
モバイル版と同じバックエンド（同じ RPC・Edge Functions・RLS）に同じ形でリクエストします。

- 元ファイル: `mikke-mobile/src/<同じ相対パス>`（2026-09-30 時点の `feature/v3-app` の作業ツリー）
- Web 用に変えた点:
  - 環境変数名 `EXPO_PUBLIC_*` → `NEXT_PUBLIC_*`
  - `place/identify-place-client.ts`: 共有受信の型（`ShareAnalysis`）をモバイル専用モジュールから切り離して同じファイルに定義
  - `plan/plan-options-store.ts`: 再読み込み後に提案を戻す `hydrate()` を追加（Web 版のみ。モバイル版はアプリ内で状態が保たれるため不要）
- どちらかでロジックを変えたら、もう一方にも反映してください（API の形がずれると片方だけ壊れます）。
- React から使う部分（ログイン状態・画面のフック）は `src/web/` にあります。
