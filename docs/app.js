(() => {
  "use strict";

  const REPO = "goto-t-yuta/conductor";
  const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const FALLBACK_RELEASE_URL = `https://github.com/${REPO}/releases/latest`;

  const I18N = {
    ja: {
      pageTitle: "Conductor — 単一チャットから並列AIエージェントを指揮するデスクトップオーケストレーター",
      pageDescription:
        "Codex・AGY・Claudeをひとつのノンブロッキングチャットから並列指揮。Git Worktree分離実行＆自動Land、Chromium CDPブラウザ統合、Tailscale＋QRコード対応Androidアプリを備えたオープンソースのマルチエージェントオーケストレーター。",
      "nav.features": "機能",
      "nav.workspace": "ワークスペース",
      "nav.mobile": "モバイル連携",
      "nav.download": "ダウンロード",
      "nav.getApp": "ダウンロード",
      "hero.badgeFallback": "Open Source • MIT License",
      "hero.badgeLatest": "最新リリース: {tag} • MIT License",
      "hero.title": "ひとつのチャットから、<br />並列AIエージェントを指揮する。",
      "hero.subtitle":
        "複数のローカルリポジトリを、入力を止めない単一チャットで統合オーケストレーション。Codex・AGY・Claude の並列 Git Worktree ワーカー、Chromium CDP ブラウザ検証、Tailscale＋QRコード対応 Android アプリまでをひとつのワークスペースに。",
      "hero.downloadDefault": "最新リリースをダウンロード",
      "hero.downloadMacArm": "macOS 向けダウンロード (.dmg)",
      "hero.downloadMacIntel": "macOS Intel 向けダウンロード (.dmg)",
      "hero.downloadWin": "Windows 向けダウンロード (.exe)",
      "hero.downloadLinux": "Linux 向けダウンロード (.AppImage)",
      "hero.downloadAndroid": "Android APK をダウンロード (.apk)",
      "hero.subMacArm": "Apple Silicon (arm64) • {meta}",
      "hero.subMacIntel": "Intel Mac (x64) • {meta}",
      "hero.subWin": "Windows 10 / 11 (x64) • {meta}",
      "hero.subLinux": "AppImage (x64) • {meta}",
      "hero.subAndroid": "Tailscale コンパニオンアプリ • {meta}",
      "hero.subFallback": "macOS • Windows • Linux • Android",
      "hero.githubCta": "GitHub で見る",
      "hero.allPlatforms": "macOS (Apple Silicon / Intel)・Windows・Linux・Android APK をすべて見る →",
      "showcase.tabOverview": "3ペイン統合ワークスペース",
      "showcase.tabWorktree": "Git Worktree & Auto-Land",
      "showcase.tabMarkdown": "ライブ Markdown ビューア",
      "showcase.captionOverview":
        "左に Agent Tasks & Questions、中央にノンブロッキング統合チャット（@ メンション付き）、右にプロジェクト連動の Chromium CDP ブラウザを配置。",
      "showcase.captionWorktree":
        "タスクごとの独立 Git Worktree 状態・差分サマリー・Auto-Land 結果・ワーカー出力を一覧し、ワンクリックで操作可能。",
      "showcase.captionMarkdown":
        "プロジェクト単位で切り替わる右ペインに、ファイル監視自動リロード対応の Markdown・コード・画像ビューアとコンソールを統合。",
      "showcase.zoomHint": "拡大表示",
      "flow.step1Title": "単一チャットで複数リポジトリへ指示",
      "flow.step1Desc":
        "<code>@project</code> や <code>@T#</code> バッジで対象を指定。応答のストリーミング中や作業中でも入力がブロックされず、質問や並列指示を即座に続けられます。",
      "flow.step2Title": "独立した Git Worktree で並列実装",
      "flow.step2Desc":
        "タスクごとに専用 worktree を自動作成。Codex・AGY・Claude のワーカーがメイン作業ツリーを汚さずに同時並行でコード変更とテストを実行します。",
      "flow.step3Title": "右ペインで検証し、Auto-Land で統合",
      "flow.step3Desc":
        "内蔵 Chromium ブラウザ・コンソール・Markdown ビューアで成果をその場で確認。完了時は自動 Land、コンフリクト時は AI が自力解消します。",
      "features.eyebrow": "Core Capabilities",
      "features.title": "並列開発のボトルネックをすべて解消する設計",
      "features.subtitle": "大量のターミナルタブやリポジトリごとのチャット画面を行き来する必要はもうありません。",
      "f1.badge": "Unified Orchestration",
      "f1.title": "単一チャットからのマルチプロジェクト並列オーケストレーション",
      "f1.desc":
        "Chat 応答用とコーディング Worker 用のプロバイダー（AGY / Codex / Claude）、モデル、推論強度をそれぞれ独立して選択可能。複数リポジトリを横断する並列タスクをひとつの会話から指揮できます。",
      "f1.bullet1": "<strong>ノンブロッキング入力:</strong> 応答生成やワーカー実行中でも、別タスクの起動や質問を止めずに送信",
      "f1.bullet2": "<strong>構造化 @ メンション:</strong> <code>@project</code> / <code>@T#</code> / <code>@project/T#</code> バッジで対象を正確に特定",
      "f1.bullet3": "<strong>非破壊タスク検査:</strong> 実行中ワーカーを止めずに <code>get_task_detail</code> で進捗・設計・差分を質問",
      "f2.badge": "Git Worktree & Auto-Land",
      "f2.title": "Git Worktree 分離実行＆自動 Land（コンフリクト自力解消付き）",
      "f2.desc":
        "すべてのコーディングタスクは専用の Git Worktree で完全分離して実行されるため、並列エージェント同士が衝突しません。完了後の統合からコンフリクト解消までシームレスに完結します。",
      "f2.bullet1": "<strong>3つの統合モード:</strong> プロジェクト単位でブランチ統合・自動 PR 作成・直接反映を切替",
      "f2.bullet2": "<strong>Auto-Land &amp; AI コンフリクト自力解消:</strong> 競合が起きてもワンクリックで AI が worktree 内で安全に解消",
      "f2.bullet3": "<strong>終了ガード &amp; 自動再開:</strong> 実行中ワーカーの誤終了を防ぎ、再起動時の中断タスク再開にも対応",
      "f3.badge": "Right-Pane Workspace",
      "f3.title": "右ペイン統合ワークスペース：<br />Chromium CDP ブラウザ / コンソール / Markdown・ファイルビューア",
      "f3.desc":
        "ヘッダーからプロジェクトを切り替えるだけで、タブ構成がリポジトリごとに自動スコープ。アプリを離れることなく開発・検証・ドキュメント確認がすべて完結します。",
      "f3.p1Title": "内蔵 Chromium CDP ブラウザ",
      "f3.p1Desc":
        "実 Chromium エンジンに Chrome DevTools (<code>⌘⌥I</code>)、DOM 要素ピッカー (<code>⌘⇧P</code>)、ワンクリック撮影 (<code>⌘⇧S</code>)、エラーチャット添付を搭載。MCP ブラウザツール経由でエージェント自身による UI 検証も可能です。",
      "f3.p2Title": "統合コンソール（xterm.js + PTY）",
      "f3.p2Desc":
        "プロジェクトや worktree に連動した対話的ターミナルを右ペインに統合。開発サーバーのログ確認や手動コマンド実行を同じ画面内で行えます。",
      "f3.p3Title": "ライブ Markdown・コード・ファイル・画像ビューア",
      "f3.p3Desc":
        "ファイル監視で自動リロードする Markdown（GFM / Mermaid / TOC 対応）、プロジェクトファイルツリー、ソースコード・透過グリッド付き画像ビューアをひとつのタブバーに統合。",
      "mobile.eyebrow": "Android Companion",
      "mobile.title": "デスクを離れても、手元から並列開発を指揮する。",
      "mobile.subtitle":
        "同じ Tailscale tailnet 上の Mac に安全接続。リアルタイムチャット・画像添付と閲覧・ワンタップタスク完了・PC リモートコンソール・単体 APK アップデートまで、ネイティブ Android アプリに凝縮しました。",
      "mobile.tabChat": "チャット & 画像添付",
      "mobile.tabTasks": "タスク一覧 & 完了",
      "mobile.tabTerminal": "リモートコンソール",
      "mobile.tabSettings": "Tailscale & 単体更新",
      "mobile.captionChat":
        "SSE ライブ同期チャット。報告内の成果スクショ確認、端末画像の添付送信、@ メンション補完に対応。",
      "mobile.captionTasks":
        "実行中・確認待ち・完了済みを一覧表示。プロジェクト絞り込みやワンタップ Land / Done 操作に対応。",
      "mobile.captionTerminal":
        "Mac 上の対話的シェル（PTY）をスマホから操作。ANSI カラー・cwd 切替・Ctrl+C / Tab 補助キーバーを搭載。",
      "mobile.captionSettings":
        "Tailscale Live SSE 接続、QR コードによるワンタップ連携、GitHub Releases からの単体 APK 更新に対応。",
      "mobile.badge": "Kotlin + Jetpack Compose • Google Play 不要",
      "mobile.detailsTitle": "スマホ1台で、指示・確認・ターミナル操作・更新まで完結",
      "mobile.detailsDesc":
        "デスクトップ版 Conductor と同じデザイン言語・ダーク／ライトテーマを採用。外出先やソファからでも、Mac 上の並列エージェントをリアルタイムに制御できます。",
      "mobile.f1Title": "SSE チャット & @ メンション補完",
      "mobile.f1Desc": "リアルタイム応答ストリームに加え、<code>@</code> 入力でプロジェクト・タスク候補を即座に補完。",
      "mobile.f2Title": "画像添付 & 報告内画像ビューア",
      "mobile.f2Desc": "スマホから画像を添付して指示を送信。ワーカー完了報告に含まれる UI スクショもその場で拡大確認。",
      "mobile.f3Title": "タスク確認 & ワンタップ Land / Done",
      "mobile.f3Desc": "実行中・確認待ちをプロジェクト別に整理。一覧から直接 Land / Done でき、詳細完了時は自動クローズ。",
      "mobile.f4Title": "PC リモートコンソール（PTY）",
      "mobile.f4Desc": "プロジェクトごとの作業ディレクトリ切替・ANSI カラー出力・<code>Ctrl+C</code> / <code>Tab</code> 補助キーバーを搭載。",
      "mobile.f5Title": "Tailscale 経由接続 & QR 連携",
      "mobile.f5Desc": "デスクトップの QR をスキャンするだけで接続完了。Chrome で <code>100.x.x.x:4789</code> を開く Web UI にも対応。",
      "mobile.f6Title": "単体アップデート（GitHub Releases）",
      "mobile.f6Desc": "アプリ内で最新 APK を自動検知し、ワンタップでダウンロード＆上書き更新。ストア審査待ち不要。",
      "mobile.ctaApk": "Android APK をダウンロード",
      "mobile.ctaGuide": "Tailscale・QR 接続ガイド ↗",
      "f5.badge": "Usage • i18n • Voice",
      "f5.title": "トークン使用量・推定利用料（Usage）＆日英 i18n・音声入出力",
      "f5.desc":
        "マルチプロバイダー運用に欠かせないコスト可視化、自然な日本語／英語 UI と出力制御、さらにハンズフリーな音声入出力まで標準搭載しています。",
      "f5.bullet1": "<strong>トークン使用量・推定利用料（Usage）:</strong> プロバイダー・モデルごとの入力／出力トークンと推定コストを一覧で把握",
      "f5.bullet2": "<strong>日英 i18n 完全対応:</strong> UI 表示と AI 出力言語を <code>auto</code> / <code>ja</code> / <code>en</code> で自在に切替",
      "f5.bullet3": "<strong>音声入出力 &amp; ローカルセキュリティ:</strong> マイク音声入力・読み上げ対応。テレメトリゼロ、MCP は <code>127.0.0.1</code> 限定バインド",
      "download.eyebrow": "Download",
      "download.title": "お使いの環境に合わせて今すぐ開始",
      "download.subtitle":
        "GitHub Releases から最新ビルドを自動取得しています。デスクトップ各 OS と Android コンパニオン APK をワンクリックでダウンロードできます。",
      "download.loading": "最新リリースを確認中...",
      "download.fallbackMeta": "GitHub Releases 最新版",
      "download.releaseNotes": "リリースノートを見る ↗",
      "download.recommended": "お使いの OS",
      "download.macDesc": "Apple Silicon (arm64) & Intel (x64) 対応",
      "download.macArm64": "Apple Silicon (.dmg)",
      "download.macX64": "Intel Mac (.dmg)",
      "download.macZip": "ZIP アーカイブ (.zip)",
      "download.winDesc": "Windows 10 / 11 (x64) インストーラー＆ポータブル",
      "download.winSetup": "インストーラー (.exe)",
      "download.winPortable": "ポータブル版 (.exe)",
      "download.linuxDesc": "AppImage / Debian・Ubuntu (.deb) (x64)",
      "download.linuxAppImage": "AppImage (x64)",
      "download.linuxDeb": "Debian / Ubuntu (.deb)",
      "download.androidDesc": "Tailscale + QR 接続コンパニオン APK",
      "download.androidApk": "Android APK (.apk)",
      "download.androidGuide": "Tailscale・QR 接続ガイドを見る ↗",
      "macos.title": "macOS 未署名ビルドの初回起動について",
      "macos.desc":
        "GitHub Actions でビルドされた macOS 版は現在コード未署名のため、<code>/Applications</code> へコピー後の初回起動時に「壊れているため開けません」と表示される場合があります。ターミナルで以下のコマンドを実行して隔離属性（quarantine）を解除してください。",
      "macos.altNote":
        "※ 隔離属性のみを削除したい場合は <code>xattr -dr com.apple.quarantine /Applications/Conductor.app</code> でも同様に起動できます。",
      "source.title": "ソースからビルド・起動する",
      "source.desc":
        "Node.js 22+・pnpm・Git 2.25+ と、いずれかの CLI（<code>codex</code> / <code>agy</code> / <code>claude</code>）があればローカルで即座に開発モード起動できます。",
      "footer.tagline": "Codex・AGY・Claude 向け単一チャットマルチエージェントオーケストレーター",
      "footer.releases": "リリース一覧",
      "footer.androidDocs": "Android ガイド",
      "common.copy": "コピー",
      "common.copied": "コピーしました",
      "common.clickZoom": "クリックで拡大",
    },
    en: {
      pageTitle: "Conductor — Single-Chat Multi-Agent Desktop Orchestrator",
      pageDescription:
        "Orchestrate Codex, AGY, and Claude across multiple repositories from one non-blocking chat with isolated Git worktrees, Auto-Land, Chromium CDP browser, and Tailscale Android companion.",
      "nav.features": "Features",
      "nav.workspace": "Workspace",
      "nav.mobile": "Mobile",
      "nav.download": "Download",
      "nav.getApp": "Download",
      "hero.badgeFallback": "Open Source • MIT License",
      "hero.badgeLatest": "Latest Release: {tag} • MIT License",
      "hero.title": "Orchestrate every coding agent<br />from a single chat.",
      "hero.subtitle":
        "Direct multiple local repositories from one non-blocking conversation. Combine parallel Git worktree workers for Codex, AGY, and Claude with an embedded Chromium CDP browser, integrated console, and a QR-paired Tailscale Android companion.",
      "hero.downloadDefault": "Download Latest Release",
      "hero.downloadMacArm": "Download for macOS (.dmg)",
      "hero.downloadMacIntel": "Download for Intel Mac (.dmg)",
      "hero.downloadWin": "Download for Windows (.exe)",
      "hero.downloadLinux": "Download for Linux (.AppImage)",
      "hero.downloadAndroid": "Download Android APK (.apk)",
      "hero.subMacArm": "Apple Silicon (arm64) • {meta}",
      "hero.subMacIntel": "Intel Mac (x64) • {meta}",
      "hero.subWin": "Windows 10 / 11 (x64) • {meta}",
      "hero.subLinux": "AppImage (x64) • {meta}",
      "hero.subAndroid": "Tailscale Companion App • {meta}",
      "hero.subFallback": "macOS • Windows • Linux • Android",
      "hero.githubCta": "View on GitHub",
      "hero.allPlatforms": "See all downloads for macOS, Windows, Linux & Android APK →",
      "showcase.tabOverview": "3-Pane Workspace",
      "showcase.tabWorktree": "Git Worktree & Auto-Land",
      "showcase.tabMarkdown": "Live Markdown Viewer",
      "showcase.captionOverview":
        "Agent Tasks & Questions on the left, unified non-blocking chat with @ mention badges in the center, and a project-scoped Chromium CDP browser on the right.",
      "showcase.captionWorktree":
        "Inspect each task's isolated Git worktree, diff summary, Auto-Land status, and worker output — with one-click landing and conflict self-resolution.",
      "showcase.captionMarkdown":
        "Switch projects from the right-pane header to scope live-reloading Markdown, code, image viewers, console, and browser tabs per repository.",
      "showcase.zoomHint": "Expand preview",
      "flow.step1Title": "Direct Multiple Repos from One Chat",
      "flow.step1Desc":
        "Attach <code>@project</code> and <code>@T#</code> badges to target exact repos and tasks. Your composer never blocks while responses stream or workers run.",
      "flow.step2Title": "Parallel Execution in Git Worktrees",
      "flow.step2Desc":
        "Every coding task runs in its own isolated Git worktree so Codex, AGY, and Claude workers code and test in parallel without touching your main checkout.",
      "flow.step3Title": "Verify Side-by-Side & Auto-Land",
      "flow.step3Desc":
        "Inspect live previews in the built-in Chromium browser, console, and Markdown viewer, then Auto-Land cleanly with AI conflict self-resolution.",
      "features.eyebrow": "Core Capabilities",
      "features.title": "Built to eliminate parallel AI workflow friction",
      "features.subtitle": "Stop juggling dozens of terminal tabs and separate chat windows across repositories.",
      "f1.badge": "Unified Orchestration",
      "f1.title": "Multi-Project Parallel Orchestration from One Chat",
      "f1.desc":
        "Choose Chat and Worker providers (AGY, Codex, Claude), models, and reasoning effort independently. Coordinate work across all local repositories in one responsive conversation.",
      "f1.bullet1": "<strong>Non-Blocking Composer:</strong> Ask questions, steer active workers, or launch new tasks while responses stream",
      "f1.bullet2": "<strong>Structured @ Mentions:</strong> Color-coded <code>@project</code>, <code>@T#</code>, and <code>@project/T#</code> badges remove guesswork",
      "f1.bullet3": "<strong>Read-Only Inspection:</strong> Query running workers via <code>get_task_detail</code> without interrupting execution",
      "f2.badge": "Git Worktree & Auto-Land",
      "f2.title": "Isolated Git Worktrees & Auto-Land with AI Conflict Resolution",
      "f2.desc":
        "Each coding task executes inside a dedicated Git worktree so parallel agents never collide. Land completed work automatically and resolve conflicts in one click.",
      "f2.bullet1": "<strong>Three Integration Modes:</strong> Configure <code>feature-branch</code>, <code>per-task-pr</code>, or <code>direct</code> globally or per project",
      "f2.bullet2": "<strong>Auto-Land &amp; AI Self-Resolution:</strong> Automatically land finished worktrees and let AI resolve rebase/merge conflicts in place",
      "f2.bullet3": "<strong>Quit Guard &amp; Auto-Resume:</strong> Prevent accidental quits during active runs and resume interrupted tasks on restart",
      "f3.badge": "Right-Pane Workspace",
      "f3.title": "Unified Right-Pane Workspace:<br />Chromium CDP Browser, Console &amp; Markdown / File Viewers",
      "f3.desc":
        "Switch repositories in the right-pane header to automatically scope every open tab — keeping development, live UI verification, and documentation side by side.",
      "f3.p1Title": "In-App Chromium CDP Browser",
      "f3.p1Desc":
        "Real Chromium with native Chrome DevTools (<code>⌘⌥I</code>), DOM Element Picker (<code>⌘⇧P</code>), screenshot capture (<code>⌘⇧S</code>), error badges, and MCP browser tools for agent self-verification.",
      "f3.p2Title": "Integrated Console (xterm.js + PTY)",
      "f3.p2Desc":
        "Interactive project- and worktree-aware terminal embedded in the right pane for dev servers, tests, and quick CLI commands.",
      "f3.p3Title": "Live Markdown, Code, File Tree & Image Viewer",
      "f3.p3Desc":
        "File-watched auto-reloading Markdown (GFM, Mermaid, TOC), project file tree, syntax-aware code viewer, and zoomable image viewer with transparency grid.",
      "mobile.eyebrow": "Android Companion",
      "mobile.title": "Stay in command away from your desk with Android.",
      "mobile.subtitle":
        "Connect securely to your Mac over Tailscale. Real-time chat with image attachments & inline previews, one-tap task Land/Done, remote PC terminal, and standalone GitHub Releases APK updates — all in a native Jetpack Compose app.",
      "mobile.tabChat": "Chat & Images",
      "mobile.tabTasks": "Tasks & Done",
      "mobile.tabTerminal": "Remote Console",
      "mobile.tabSettings": "Tailscale & Updates",
      "mobile.captionChat":
        "Real-time SSE chat with inline report screenshots, mobile photo/image attachments, and @ mention autocomplete.",
      "mobile.captionTasks":
        "Browse Running, Needs Review, and Completed tasks with project filters and one-tap Land / Done controls.",
      "mobile.captionTerminal":
        "Control your Mac's interactive shell (PTY) remotely with ANSI colors, project cwd switcher, and Ctrl+C / Tab aux keys.",
      "mobile.captionSettings":
        "Live Tailscale SSE status, instant QR code pairing, and standalone in-app APK updates straight from GitHub Releases.",
      "mobile.badge": "Kotlin + Jetpack Compose • No Google Play Required",
      "mobile.detailsTitle": "Chat, approve tasks, run terminal commands, and self-update from your pocket",
      "mobile.detailsDesc":
        "Designed with the same visual tokens and Dark/Light theme as Desktop Conductor so switching between your desk and phone feels seamless.",
      "mobile.f1Title": "SSE Chat & @ Mention Autocomplete",
      "mobile.f1Desc": "Live streaming replies with instant <code>@</code> autocomplete for projects and tasks plus scroll position preservation.",
      "mobile.f2Title": "Image Attach & Inline Viewer",
      "mobile.f2Desc": "Attach screenshots or photos right from Android and tap to zoom UI previews inside worker completion reports.",
      "mobile.f3Title": "Tasks & One-Tap Land / Done",
      "mobile.f3Desc": "Filter by project, land worktrees, and mark tasks Done directly from the list with auto-close on detail completion.",
      "mobile.f4Title": "Remote PC Console (PTY)",
      "mobile.f4Desc": "Switch project working directories on your Mac with ANSI color output and a mobile <code>Ctrl+C</code> / <code>Tab</code> key bar.",
      "mobile.f5Title": "Tailscale + QR Instant Pairing",
      "mobile.f5Desc": "Scan Desktop Settings' QR code to connect over Tailscale, or open <code>100.x.x.x:4789</code> in Chrome as a fallback.",
      "mobile.f6Title": "Standalone In-App APK Updates",
      "mobile.f6Desc": "Detects new GitHub Releases automatically and downloads/installs signed APK updates with a single tap.",
      "mobile.ctaApk": "Download Android APK",
      "mobile.ctaGuide": "Tailscale & QR Guide ↗",
      "f5.badge": "Usage • i18n • Voice",
      "f5.title": "Token Usage & Cost Estimates, Bilingual i18n & Voice I/O",
      "f5.desc":
        "Keep multi-provider usage transparent with built-in token/cost analytics, full Japanese/English localization, and hands-free voice interaction.",
      "f5.bullet1": "<strong>Usage &amp; Cost Tracking:</strong> Monitor input/output tokens and estimated spend across providers and models in real time",
      "f5.bullet2": "<strong>Full Japanese &amp; English i18n:</strong> Switch UI and AI output language freely across <code>auto</code>, <code>ja</code>, and <code>en</code>",
      "f5.bullet3": "<strong>Voice I/O &amp; Local-First Privacy:</strong> Built-in voice input/output, zero telemetry, and MCP bound strictly to <code>127.0.0.1</code>",
      "download.eyebrow": "Download",
      "download.title": "Get Conductor for your platform",
      "download.subtitle":
        "Latest installers and packages are fetched live from GitHub Releases for macOS, Windows, Linux, and Android.",
      "download.loading": "Checking latest release...",
      "download.fallbackMeta": "Latest on GitHub Releases",
      "download.releaseNotes": "View Release Notes ↗",
      "download.recommended": "Your OS",
      "download.macDesc": "Apple Silicon (arm64) & Intel (x64)",
      "download.macArm64": "Apple Silicon (.dmg)",
      "download.macX64": "Intel Mac (.dmg)",
      "download.macZip": "ZIP Archive (.zip)",
      "download.winDesc": "Windows 10 / 11 (x64) Installer & Portable",
      "download.winSetup": "Installer (.exe)",
      "download.winPortable": "Portable (.exe)",
      "download.linuxDesc": "AppImage & Debian / Ubuntu (.deb) (x64)",
      "download.linuxAppImage": "AppImage (x64)",
      "download.linuxDeb": "Debian / Ubuntu (.deb)",
      "download.androidDesc": "Tailscale + QR Pairing Companion APK",
      "download.androidApk": "Android APK (.apk)",
      "download.androidGuide": "Tailscale & QR Setup Guide ↗",
      "macos.title": "First Launch on macOS (Unsigned CI Builds)",
      "macos.desc":
        "CI desktop builds are currently unsigned, so macOS Gatekeeper may report <em>\"Conductor is damaged and can't be opened\"</em> after dragging to <code>/Applications</code>. Clear the quarantine attribute in Terminal:",
      "macos.altNote":
        "Tip: You can alternatively run <code>xattr -dr com.apple.quarantine /Applications/Conductor.app</code> to remove only the quarantine flag.",
      "source.title": "Build & Run from Source",
      "source.desc":
        "Requires Node.js 22+, pnpm, Git 2.25+, and at least one authenticated agent CLI (<code>codex</code>, <code>agy</code>, or <code>claude</code>).",
      "footer.tagline": "Single-chat multi-agent orchestrator for Codex, AGY, and Claude.",
      "footer.releases": "Releases",
      "footer.androidDocs": "Android Guide",
      "common.copy": "Copy",
      "common.copied": "Copied!",
      "common.clickZoom": "Click to zoom",
    },
  };

  const SHOTS = {
    overview: {
      src: "./images/conductor-overview.png",
      windowTitle: "Conductor — 3-Pane Workspace & Chromium Browser",
      captionKey: "showcase.captionOverview",
    },
    worktree: {
      src: "./images/conductor-worktree-inspector.png",
      windowTitle: "Conductor — Git Worktree Inspector & Auto-Land",
      captionKey: "showcase.captionWorktree",
    },
    markdown: {
      src: "./images/conductor-markdown-viewer.png",
      windowTitle: "Conductor — Live Markdown & File Viewer",
      captionKey: "showcase.captionMarkdown",
    },
  };

  const OS_ICONS = {
    mac: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.33c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.58.68-1.1 1.79-.96 2.84 1.04.08 2.08-.52 2.72-1.3z"/></svg>',
    win: '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M3 5.55 10.35 4.5v7.05H3V5.55Zm8.35-1.2L21 3v8.55h-9.65V4.35ZM3 12.55h7.35v7.05L3 18.55v-6Zm8.35 0H21V21l-9.65-1.35v-7.1Z"/></svg>',
    linux:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
    android:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17.523 15.341a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Zm-11.046 0a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM17.9 10.67l1.62-2.8a.45.45 0 0 0-.16-.62.45.45 0 0 0-.62.17l-1.64 2.84a10.48 10.48 0 0 0-5.1-1.26c-1.85 0-3.58.46-5.1 1.26L5.26 7.42a.45.45 0 0 0-.62-.17.45.45 0 0 0-.16.62l1.62 2.8C3.53 12.1 1.85 14.74 1.5 17.85h21c-.35-3.11-2.03-5.75-4.6-7.18Z"/></svg>',
    generic:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  };

  const MOBILE_SHOT_ORDER = ["chat", "tasks", "terminal", "settings"];

  const MOBILE_SHOTS = {
    chat: {
      src: "./images/android-chat.png",
      tag: "Chat",
      lightboxTitle: "Conductor Android — Chat, Image Attachments & @ Mentions",
      captionKey: "mobile.captionChat",
    },
    tasks: {
      src: "./images/android-tasks.png",
      tag: "Tasks",
      lightboxTitle: "Conductor Android — Agent Tasks & One-Tap Land / Done",
      captionKey: "mobile.captionTasks",
    },
    terminal: {
      src: "./images/android-terminal.png",
      tag: "Terminal",
      lightboxTitle: "Conductor Android — Remote PC Console (PTY & ANSI)",
      captionKey: "mobile.captionTerminal",
    },
    settings: {
      src: "./images/android-settings.png",
      tag: "Settings",
      lightboxTitle: "Conductor Android — Tailscale Live SSE & Standalone APK Update",
      captionKey: "mobile.captionSettings",
    },
  };

  const state = {
    lang: document.documentElement.getAttribute("data-lang") === "en" ? "en" : "ja",
    theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    platform: { os: "unknown", arch: "arm64" },
    activeShot: "overview",
    activeMobileShot: "chat",
    release: null,
  };

  function t(key, vars = {}) {
    const dict = I18N[state.lang] || I18N.ja;
    let str = dict[key] ?? I18N.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
    return str;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function formatShortTag(tag) {
    if (!tag) return "";
    // Show concise version if tag is e.g. v0.1.0-12-abc1234 -> v0.1.0 (#12) or raw tag
    const m = /^v?(\d+\.\d+\.\d+)-(\d+)-[0-9a-f]+$/i.exec(tag);
    if (m) return `v${m[1]} (build ${m[2]})`;
    return tag;
  }

  function formatDate(iso, lang) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(d);
    } catch {
      return "";
    }
  }

  async function detectPlatform() {
    const ua = navigator.userAgent || "";
    const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    const combined = `${ua} ${plat}`.toLowerCase();

    let os = "unknown";
    if (/android/.test(combined)) {
      os = "android";
    } else if (/mac|darwin|iphone|ipad/.test(combined) && !/iphone|ipad/.test(combined)) {
      os = "mac";
    } else if (/win/.test(combined)) {
      os = "win";
    } else if (/linux|x11/.test(combined)) {
      os = "linux";
    }

    let arch = "arm64";
    try {
      if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === "function") {
        const info = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
        if (info && info.architecture) {
          arch = /arm/i.test(info.architecture) ? "arm64" : "x64";
        }
      } else if (os === "mac") {
        // Intel Macs vs Apple Silicon heuristic (Apple Silicon default for modern macOS)
        arch = "arm64";
      } else if (/x86_64|win64|wow64|x64|amd64/i.test(combined)) {
        arch = "x64";
      }
    } catch {
      /* ignore */
    }

    state.platform = { os, arch };
    highlightDetectedPlatformCard();
    updateHeroDownloadButton();
  }

  function highlightDetectedPlatformCard() {
    document.querySelectorAll("[data-platform-card]").forEach((el) => {
      const cardOs = el.getAttribute("data-platform-card");
      el.classList.toggle("is-recommended", cardOs === state.platform.os);
    });
  }

  function matchReleaseAssets(assets = []) {
    const find = (re) => assets.find((a) => a && typeof a.name === "string" && re.test(a.name)) || null;
    return {
      macArm64Dmg: find(/arm64.*\.dmg$/i) || find(/\.dmg$/i),
      macX64Dmg: find(/(x64|x86_64|intel).*\.dmg$/i),
      macArm64Zip: find(/arm64.*\.zip$/i) || find(/mac.*\.zip$/i),
      macX64Zip: find(/(x64|x86_64).*\.zip$/i),
      winSetup: find(/setup.*\.exe$/i) || find(/\.exe$/i),
      winPortable: find(/portable.*\.exe$/i),
      linuxAppImage: find(/\.appimage$/i),
      linuxDeb: find(/\.deb$/i),
      androidApk: find(/\.apk$/i),
      checksums: find(/sha256sums\.txt$/i),
    };
  }

  function bindAssetLink(linkId, sizeId, asset, fallbackUrl) {
    const link = document.getElementById(linkId);
    if (!link) return;
    const url = asset && asset.browser_download_url ? asset.browser_download_url : fallbackUrl;
    link.href = url;
    if (url === fallbackUrl) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.removeAttribute("target");
      link.removeAttribute("rel");
    }

    if (sizeId) {
      const sizeEl = document.getElementById(sizeId);
      if (sizeEl) {
        sizeEl.textContent = asset && asset.size ? formatBytes(asset.size) : "";
      }
    }
  }

  function updateHeroDownloadButton() {
    const btn = document.getElementById("hero-primary-download");
    const iconEl = document.getElementById("hero-os-icon");
    const labelEl = document.getElementById("hero-download-label");
    const subEl = document.getElementById("hero-download-sub");
    if (!btn || !iconEl || !labelEl || !subEl) return;

    const releaseUrl = (state.release && state.release.htmlUrl) || FALLBACK_RELEASE_URL;
    const assets = state.release ? state.release.assets : {};
    const tagText = state.release ? formatShortTag(state.release.tag) : t("download.fallbackMeta");

    const { os, arch } = state.platform;
    let icon = OS_ICONS.generic;
    let label = t("hero.downloadDefault");
    let sub = state.release ? `${tagText} • macOS / Windows / Linux / Android` : t("hero.subFallback");
    let targetAsset = null;

    if (os === "mac") {
      icon = OS_ICONS.mac;
      if (arch === "x64") {
        label = t("hero.downloadMacIntel");
        targetAsset = assets.macX64Dmg || assets.macArm64Dmg;
        const meta = targetAsset && targetAsset.size ? `${tagText} • ${formatBytes(targetAsset.size)}` : tagText;
        sub = t("hero.subMacIntel", { meta });
      } else {
        label = t("hero.downloadMacArm");
        targetAsset = assets.macArm64Dmg;
        const meta = targetAsset && targetAsset.size ? `${tagText} • ${formatBytes(targetAsset.size)}` : tagText;
        sub = t("hero.subMacArm", { meta });
      }
    } else if (os === "win") {
      icon = OS_ICONS.win;
      label = t("hero.downloadWin");
      targetAsset = assets.winSetup;
      const meta = targetAsset && targetAsset.size ? `${tagText} • ${formatBytes(targetAsset.size)}` : tagText;
      sub = t("hero.subWin", { meta });
    } else if (os === "linux") {
      icon = OS_ICONS.linux;
      label = t("hero.downloadLinux");
      targetAsset = assets.linuxAppImage;
      const meta = targetAsset && targetAsset.size ? `${tagText} • ${formatBytes(targetAsset.size)}` : tagText;
      sub = t("hero.subLinux", { meta });
    } else if (os === "android") {
      icon = OS_ICONS.android;
      label = t("hero.downloadAndroid");
      targetAsset = assets.androidApk;
      const meta = targetAsset && targetAsset.size ? `${tagText} • ${formatBytes(targetAsset.size)}` : tagText;
      sub = t("hero.subAndroid", { meta });
    }

    iconEl.innerHTML = icon;
    labelEl.textContent = label;
    subEl.textContent = sub;

    if (targetAsset && targetAsset.browser_download_url) {
      btn.href = targetAsset.browser_download_url;
      btn.removeAttribute("target");
      btn.removeAttribute("rel");
    } else {
      btn.href = releaseUrl;
      btn.target = "_blank";
      btn.rel = "noopener noreferrer";
    }
  }

  function renderReleaseMetadata() {
    const heroReleaseText = document.getElementById("hero-release-text");
    const heroReleasePill = document.getElementById("hero-release-pill");
    const versionLabel = document.getElementById("release-version-label");
    const notesLink = document.getElementById("release-notes-link");
    const checksumsLink = document.getElementById("release-checksums-link");

    if (!state.release) {
      if (heroReleaseText) heroReleaseText.textContent = t("hero.badgeFallback");
      if (versionLabel) versionLabel.textContent = t("download.fallbackMeta");
      return;
    }

    const shortTag = formatShortTag(state.release.tag);
    const dateStr = formatDate(state.release.publishedAt, state.lang);
    const htmlUrl = state.release.htmlUrl || FALLBACK_RELEASE_URL;

    if (heroReleaseText) {
      heroReleaseText.textContent = t("hero.badgeLatest", { tag: shortTag });
    }
    if (heroReleasePill) {
      heroReleasePill.href = htmlUrl;
    }
    if (versionLabel) {
      versionLabel.textContent = dateStr ? `${state.release.tag} • ${dateStr}` : state.release.tag;
    }
    if (notesLink) {
      notesLink.href = htmlUrl;
    }
    if (checksumsLink) {
      if (state.release.assets.checksums && state.release.assets.checksums.browser_download_url) {
        checksumsLink.href = state.release.assets.checksums.browser_download_url;
        checksumsLink.hidden = false;
      } else {
        checksumsLink.hidden = true;
      }
    }

    const a = state.release.assets;
    bindAssetLink("dl-mac-arm64", "size-mac-arm64", a.macArm64Dmg, htmlUrl);
    bindAssetLink("dl-mac-x64", "size-mac-x64", a.macX64Dmg, htmlUrl);
    bindAssetLink("dl-mac-zip", "size-mac-zip", a.macArm64Zip || a.macX64Zip, htmlUrl);
    bindAssetLink("dl-win-setup", "size-win-setup", a.winSetup, htmlUrl);
    bindAssetLink("dl-win-portable", "size-win-portable", a.winPortable, htmlUrl);
    bindAssetLink("dl-linux-appimage", "size-linux-appimage", a.linuxAppImage, htmlUrl);
    bindAssetLink("dl-linux-deb", "size-linux-deb", a.linuxDeb, htmlUrl);
    bindAssetLink("dl-android-apk", "size-android-apk", a.androidApk, htmlUrl);
    bindAssetLink("mobile-dl-apk", "size-mobile-apk", a.androidApk, htmlUrl);

    updateHeroDownloadButton();
  }

  async function fetchLatestRelease() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !data.tag_name) throw new Error("Missing release tag");

      state.release = {
        tag: data.tag_name,
        publishedAt: data.published_at || "",
        htmlUrl: data.html_url || FALLBACK_RELEASE_URL,
        assets: matchReleaseAssets(Array.isArray(data.assets) ? data.assets : []),
      };
      renderReleaseMetadata();
    } catch {
      // Offline or GitHub API rate-limited: stay gracefully on releases/latest fallback
      state.release = null;
      renderReleaseMetadata();
      updateHeroDownloadButton();
    } finally {
      window.clearTimeout(timer);
    }
  }

  function applyLanguage(lang, persist = false) {
    state.lang = lang === "en" ? "en" : "ja";
    document.documentElement.setAttribute("lang", state.lang);
    document.documentElement.setAttribute("data-lang", state.lang);

    if (persist) {
      try {
        localStorage.setItem("conductor-site-lang", state.lang);
      } catch {
        /* ignore */
      }
    }

    document.title = t("pageTitle");
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute("content", t("pageDescription"));

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      const val = t(key);
      if (val.includes("<")) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });

    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.setAttribute("title", t(key));
    });

    document.querySelectorAll("[data-set-lang]").forEach((btn) => {
      const isCurrent = btn.getAttribute("data-set-lang") === state.lang;
      btn.setAttribute("aria-pressed", String(isCurrent));
      btn.classList.toggle("is-active", isCurrent);
    });

    // Keep active showcase caption synchronized
    const shot = SHOTS[state.activeShot];
    const captionEl = document.getElementById("showcase-caption");
    if (shot && captionEl) {
      captionEl.textContent = t(shot.captionKey);
    }

    const mobileShot = MOBILE_SHOTS[state.activeMobileShot];
    const mobileCaptionEl = document.getElementById("mobile-screen-caption");
    if (mobileShot && mobileCaptionEl) {
      mobileCaptionEl.textContent = t(mobileShot.captionKey);
    }

    renderReleaseMetadata();
    updateHeroDownloadButton();
  }

  function applyTheme(theme, persist = false) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", state.theme);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute("content", state.theme === "dark" ? "#070913" : "#f7f9fc");
    }
    if (persist) {
      try {
        localStorage.setItem("conductor-site-theme", state.theme);
      } catch {
        /* ignore */
      }
    }
  }

  function initLanguageControls() {
    document.querySelectorAll("[data-set-lang]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-set-lang");
        if (target) applyLanguage(target, true);
      });
    });
  }

  function initThemeControls() {
    const toggle = document.getElementById("theme-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        applyTheme(state.theme === "dark" ? "light" : "dark", true);
      });
    }
  }

  function initShowcaseTabs() {
    const img = document.getElementById("showcase-img");
    const winTitle = document.getElementById("showcase-window-title");
    const caption = document.getElementById("showcase-caption");
    const zoomBtn = document.getElementById("showcase-zoom-btn");
    const tabs = document.querySelectorAll(".showcase-tab");

    function setShot(key) {
      const shot = SHOTS[key];
      if (!shot || !img) return;
      state.activeShot = key;
      img.src = shot.src;
      if (winTitle) winTitle.textContent = shot.windowTitle;
      if (caption) caption.textContent = t(shot.captionKey);
      tabs.forEach((tab) => {
        const active = tab.getAttribute("data-shot") === key;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
      });
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.getAttribute("data-shot");
        if (key) setShot(key);
      });
    });

    const openCurrentShot = () => {
      const shot = SHOTS[state.activeShot];
      if (shot) openLightbox(shot.src, shot.windowTitle);
    };

    if (img) img.addEventListener("click", openCurrentShot);
    if (zoomBtn) zoomBtn.addEventListener("click", openCurrentShot);
  }

  function initMobileShowcase() {
    const heroImg = document.getElementById("mobile-showcase-img");
    const heroTrigger = document.getElementById("mobile-hero-trigger");
    const mobileZoomBtn = document.getElementById("mobile-zoom-btn");
    const tagEl = document.getElementById("mobile-screen-tag");
    const captionEl = document.getElementById("mobile-screen-caption");
    const peekLeftBtn = document.getElementById("mobile-peek-left");
    const peekLeftImg = document.getElementById("mobile-peek-left-img");
    const peekRightBtn = document.getElementById("mobile-peek-right");
    const peekRightImg = document.getElementById("mobile-peek-right-img");
    const tabs = document.querySelectorAll("[data-mobile-shot]");
    const featureCards = document.querySelectorAll("[data-mobile-shot-card]");

    function setMobileShot(key) {
      const shot = MOBILE_SHOTS[key];
      if (!shot || !heroImg) return;
      state.activeMobileShot = key;

      heroImg.src = shot.src;
      heroImg.alt = shot.lightboxTitle;
      if (tagEl) tagEl.textContent = shot.tag;
      if (captionEl) captionEl.textContent = t(shot.captionKey);

      const idx = MOBILE_SHOT_ORDER.indexOf(key);
      const prevKey = MOBILE_SHOT_ORDER[(idx - 1 + MOBILE_SHOT_ORDER.length) % MOBILE_SHOT_ORDER.length];
      const nextKey = MOBILE_SHOT_ORDER[(idx + 1) % MOBILE_SHOT_ORDER.length];
      const prevShot = MOBILE_SHOTS[prevKey];
      const nextShot = MOBILE_SHOTS[nextKey];

      if (peekLeftBtn && peekLeftImg && prevShot) {
        peekLeftBtn.setAttribute("data-mobile-switch", prevKey);
        peekLeftImg.src = prevShot.src;
        peekLeftImg.alt = prevShot.lightboxTitle;
      }
      if (peekRightBtn && peekRightImg && nextShot) {
        peekRightBtn.setAttribute("data-mobile-switch", nextKey);
        peekRightImg.src = nextShot.src;
        peekRightImg.alt = nextShot.lightboxTitle;
      }

      tabs.forEach((tab) => {
        const active = tab.getAttribute("data-mobile-shot") === key;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
      });

      featureCards.forEach((card) => {
        const matches = card.getAttribute("data-mobile-shot-card") === key;
        card.classList.toggle("is-highlighted", matches);
      });
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.getAttribute("data-mobile-shot");
        if (key) setMobileShot(key);
      });
    });

    featureCards.forEach((card) => {
      card.addEventListener("click", () => {
        const key = card.getAttribute("data-mobile-shot-card");
        if (key) setMobileShot(key);
      });
    });

    [peekLeftBtn, peekRightBtn].forEach((btn) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-mobile-switch");
        if (key) setMobileShot(key);
      });
    });

    const openCurrentMobileShot = () => {
      const shot = MOBILE_SHOTS[state.activeMobileShot];
      if (shot) openLightbox(shot.src, shot.lightboxTitle);
    };

    if (heroTrigger) heroTrigger.addEventListener("click", openCurrentMobileShot);
    if (mobileZoomBtn) mobileZoomBtn.addEventListener("click", openCurrentMobileShot);

    setMobileShot(state.activeMobileShot);
  }

  function openLightbox(src, title) {
    const modal = document.getElementById("lightbox");
    const img = document.getElementById("lightbox-img");
    const titleEl = document.getElementById("lightbox-title");
    if (!modal || !img) return;
    img.src = src;
    img.alt = title || "Conductor screenshot";
    if (titleEl) titleEl.textContent = title || "Conductor";
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    const modal = document.getElementById("lightbox");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  function initLightbox() {
    document.querySelectorAll("[data-lightbox-src]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const src = btn.getAttribute("data-lightbox-src");
        const title = btn.getAttribute("data-lightbox-title") || "Conductor";
        if (src) openLightbox(src, title);
      });
    });

    document.querySelectorAll("[data-lightbox-close]").forEach((el) => {
      el.addEventListener("click", closeLightbox);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeLightbox();
    });
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function initCopyButtons() {
    const announcer = document.getElementById("live-announcer");
    document.querySelectorAll("[data-copy-target]").forEach((btn) => {
      let resetTimer = null;
      btn.addEventListener("click", async () => {
        const targetId = btn.getAttribute("data-copy-target");
        const codeEl = targetId ? document.getElementById(targetId) : null;
        if (!codeEl) return;
        const text = (codeEl.textContent || "").trim();
        if (!text) return;

        try {
          await copyText(text);
          const labelEl = btn.querySelector(".copy-label");
          btn.classList.add("is-copied");
          if (labelEl) labelEl.textContent = t("common.copied");
          if (announcer) announcer.textContent = t("common.copied");

          if (resetTimer) window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(() => {
            btn.classList.remove("is-copied");
            if (labelEl) labelEl.textContent = t("common.copy");
          }, 2200);
        } catch {
          /* ignore */
        }
      });
    });
  }

  // Bootstrap
  initLanguageControls();
  initThemeControls();
  initShowcaseTabs();
  initMobileShowcase();
  initLightbox();
  initCopyButtons();

  applyTheme(state.theme, false);
  applyLanguage(state.lang, false);
  detectPlatform();
  fetchLatestRelease();
})();
