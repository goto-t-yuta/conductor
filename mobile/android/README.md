# Conductor Mobile (Android)

Mac 上の **Conductor** デスクトップアプリに **Tailscale** 経由で接続し、リアルタイムチャットと Agent Tasks の確認・操作（Done / Reopen / Stop / Land）を行うネイティブ Android クライアント（Kotlin + Jetpack Compose / Material 3）です。

## 主な機能

- **Setup / 接続画面**:
  - **QRコードスキャンでワンタップリンク**: デスクトップの「設定 → リモートアクセス → Step 2」QRコードを読み取るだけで URL・Bearer Token を自動保存して即座に接続（CameraX + ZXing、Google Play 開発者サービス不要）
  - システムカメラで読み取った `conductor://connect?...` / `conductor://link?...` ディープリンクからの自動リンク対応
  - Tailscale URL (`http://100.x.x.x:4789`) + Bearer Token 入力・URI 一括貼り付け
  - 接続テスト（`/api/health` + `/api/snapshot`）と Jetpack DataStore への永続保存
- **Chat**:
  - SSE (`/api/events`) によるリアルタイムストリーム同期 + 自動再接続 / フォールバックポーリング
  - ストリーミング中の応答表示・個別停止 / 全停止・新規チャット作成
  - `@` メンションピッカー（プロジェクト / タスクを `explicitMentions` として添付）
- **Tasks**:
  - Running / Needs Review / Completed のグループ表示
  - タスク詳細ボトムシート（Worktree / Git Status / 最新出力）
  - ワンタップの **Stop** / **Land** / **Done** / **Reopen**（デスクトップ側ガードと連動）
- **Settings**:
  - テーマ切替（System / Light / Dark）、アプリ内アップデート確認（GitHub Releases 直接参照・APK ダウンロード＆インストール）、SSE / ポーリング接続ステータス確認、URL・Token 編集、再接続、切断

## 事前準備

1. Mac と Android 端末の両方に **Tailscale** をインストールし、同じ tailnet にログインします。
2. Mac で Conductor を起動し、**設定（歯車アイコン）→「リモートアクセス / Tailscale Mobile Bridge」** を ON にします。
3. 表示された `conductor://connect?...` URI（または接続 URL と Bearer Token）をコピーします。

> **ブラウザだけでもすぐ使えます**: Android の Chrome で `http://<MacのTailscale IP>:4789` を開くと、軽量なモバイル Web UI フォールバックがそのまま動作します。

## ビルド & 実機インストール手順

### 1. 環境変数（macOS / Homebrew の場合）

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

（Android Studio を使用している場合は `ANDROID_HOME="$HOME/Library/Android/sdk"` を指定してください）

### 2. Debug APK のビルド & ユニットテスト実行

```bash
cd mobile/android
./gradlew testDebugUnitTest assembleDebug
```

ビルド成果物は以下に生成されます：
`mobile/android/app/build/outputs/apk/debug/app-debug.apk`

### 3. Release 署名付き APK のビルド（上書きアップデート対応）

配布用 APK は毎回同じ署名鍵と単調増加する `versionCode` でビルドする必要があります（署名鍵が変わると Android で上書きインストール時に `App not installed` になります）。

GitHub Actions（`.github/workflows/release.yml`）では以下の GitHub Secrets を用いて固定鍵で `assembleRelease` を実行し、`GITHUB_RUN_NUMBER` に基づいて単調増加する `versionCode` / `versionName` を付与します：

- `ANDROID_KEYSTORE_BASE64`（PKCS12 / JKS キーストアを Base64 エンコードした文字列）
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

ローカルで同じ固定鍵を使って Release APK をビルドする場合（バックアップ例: `~/.conductor-signing/signing.env`）：

```bash
source ~/.conductor-signing/signing.env
cd mobile/android
CONDUCTOR_BUILD_RUN_NUMBER=7 ./gradlew testDebugUnitTest testReleaseUnitTest assembleRelease
```

成果物: `mobile/android/app/build/outputs/apk/release/app-release.apk`

> **初回移行時の注意**: 以前の Debug 署名版 APK（`assembleDebug` でビルドされたリリース）が端末に入っている場合、固定 Release 署名鍵へ切り替えた最初の 1 回のみ既存アプリのアンインストールが必要です。それ以降の Release 署名版同士はアプリ内アップデートおよび `adb install -r` で上書き更新できます。

### 4. Android 実機 / エミュレータへのインストール

USB デバッグを有効にした Android 端末を接続し、以下を実行します：

```bash
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```
