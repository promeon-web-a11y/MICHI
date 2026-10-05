# Mikke Mobile (v0.2)

Expo SDK 57 + Expo Router のスマートフォン版 Mikke。
既存の Web 版（`../mikke-frontend`）とは独立したプロジェクト。

現段階の範囲: **他アプリからの共有受信のみ**（OpenAI / Google Places / Supabase 保存は未実装）。

## 構成

| パス | 役割 |
| --- | --- |
| `src/app/+native-intent.ts` | `mikke://expo-sharing` で起動されたら `/handle-share` へ振り分け |
| `src/app/handle-share.tsx` | 共有受信の開発確認画面（取得 → 表示 → 確認 → クリア） |
| `src/app/index.tsx` | ホーム（サンプル Payload での解析検証ボタンあり） |
| `src/share/url-utils.ts` | `extractUrls` / `detectSource` / `normalizeSharedUrl` |
| `src/share/process-share-payloads.ts` | Payload 解析（例外を投げず warnings / errors に集約） |
| `src/share/logger.ts` | 開発ログ（console + 画面表示用バッファ） |
| `tests/share.test.ts` | 上記ロジックの単体テスト |

## コマンド

```bash
npm test           # URL抽出・判定・正規化の単体テスト
npm run typecheck
npm run lint
npx expo start --dev-client   # Development Build に接続
```

## Development Build（Expo Go では共有受信は動きません）

Share Extension / Intent Filter を含むため、`expo-dev-client` の Development Build が必要。
Windows からは EAS Build（クラウド）を使う。

```bash
npx eas-cli@latest login
npx eas-cli@latest init                                   # EAS プロジェクト作成（app.json に projectId が追加される）
npx eas-cli@latest build --profile development --platform android
npx eas-cli@latest device:create                          # iOS: 端末の UDID 登録
npx eas-cli@latest build --profile development --platform ios   # Apple Developer Program 必須
```

ビルドをインストール後、PC で `npx expo start --dev-client` を起動し、アプリから接続する。

## 実機テスト項目

1. Mikke を完全終了 → Instagram から共有 → Mikke 起動 → URL 取得
2. Mikke をバックグラウンド → Instagram から共有 → URL 取得
3. TikTok から共有 → URL 取得
4. YouTube から共有 → URL 取得
5. 文章＋URL の共有 → URL 抽出
6. 未知の Web サイト（Safari / Chrome から共有）→ source = web
7. 不正データ → クラッシュしない（ホームの「サンプルPayloadで解析を検証」でも確認可）

各テスト後は確認画面で「確認済み・クリア」を押す（`clearSharedPayloads()`）。
押さなければ Payload は残るため、再起動しても同じ内容を再確認できる。

## 注意

- iOS の共有受信は expo-sharing 公式ドキュメント上 **experimental**（Share Extension からメインアプリを開く方式）。
- `bundleIdentifier` / `package` は `com.promeon.mikke`。変更する場合は初回 EAS Build 前に行うこと。
