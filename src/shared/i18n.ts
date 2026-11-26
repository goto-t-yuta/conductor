import type { AgentTaskStatus, IntegrationMode, PreferredLanguage } from "./types.js";
import { DEFAULT_PREFERRED_LANGUAGE } from "./language.js";

export type UiLocale = "ja" | "en";

interface GlobalNavigatorLike {
  language?: string;
  languages?: readonly string[];
}

function normalizeLocaleTag(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function isJapaneseLocaleTag(tag: string): boolean {
  return tag === "ja" || tag.startsWith("ja-") || tag.startsWith("ja_");
}

/**
 * Detects the active UI locale ("ja" | "en") from browser navigator / OS locale,
 * defaulting to "en" whenever the environment is non-Japanese.
 */
export function detectSystemLocale(overrideLocale?: string | null): UiLocale {
  const candidates: string[] = [];

  if (typeof overrideLocale === "string" && overrideLocale.trim()) {
    candidates.push(overrideLocale);
  } else {
    const nav = (globalThis as { navigator?: GlobalNavigatorLike }).navigator;
    if (nav) {
      if (Array.isArray(nav.languages) && nav.languages.length > 0) {
        for (const lang of nav.languages) {
          if (typeof lang === "string" && lang.trim()) {
            candidates.push(lang);
            break;
          }
        }
      }
      if (typeof nav.language === "string" && nav.language.trim()) {
        candidates.push(nav.language);
      }
    }

    if (candidates.length === 0 && typeof process !== "undefined" && process.env) {
      const envLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
      if (envLocale && envLocale !== "C" && envLocale !== "POSIX") {
        candidates.push(envLocale);
      }
    }

    if (candidates.length === 0) {
      try {
        const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (intlLocale) {
          candidates.push(intlLocale);
        }
      } catch {
        // ignore Intl errors
      }
    }
  }

  const first = normalizeLocaleTag(candidates[0]);
  if (!first) return "en";
  return isJapaneseLocaleTag(first) ? "ja" : "en";
}

/**
 * Resolves the active UI locale ("ja" | "en") from Conductor's `preferredLanguage` setting.
 * - "ja"   -> "ja"
 * - "en"   -> "en"
 * - "auto" -> detects from navigator.language / OS locale (defaults to "en" when non-Japanese)
 * - missing/unknown -> defaults to DEFAULT_PREFERRED_LANGUAGE ("ja")
 */
export function resolveUiLocale(
  preferredLanguage?: PreferredLanguage | null,
  systemLocaleOverride?: string | null,
): UiLocale {
  if (preferredLanguage === "ja") return "ja";
  if (preferredLanguage === "en") return "en";
  if (preferredLanguage === "auto") return detectSystemLocale(systemLocaleOverride);
  return DEFAULT_PREFERRED_LANGUAGE === "en" ? "en" : "ja";
}

export const UI_STRINGS = {
  ja: {
    // Common & App
    "app.starting": "Conductor を起動しています...",
    "common.close": "閉じる",
    "common.cancel": "キャンセル",
    "common.delete": "削除",
    "common.retry": "再試行",
    "common.reload": "再読み込み",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.loading": "読み込み中...",
    "common.stop": "停止",
    "common.all": "すべて",
    "common.finder": "Finder",
    "common.revealInFinder": "Finder で表示",
    "common.copyPath": "パスをコピー",
    "common.copyPathWith": "パスをコピー: {path}",
    "common.error": "エラー",

    // Task status & actions
    "taskStatus.queued": "待機中",
    "taskStatus.running": "実行中",
    "taskStatus.needs_review": "確認待ち",
    "taskStatus.done": "完了",
    "taskStatus.failed": "失敗",
    "task.quickDoneLabel": "Done",
    "task.quickReopenLabel": "Reopen",
    "task.markDoneTitle": "完了にする",
    "task.reopenTitle": "再オープンする",
    "task.doneBadge": "完了",
    "task.runningBadge": "実行中",
    "task.unlandedBadge": "未Land",
    "task.blockedRunning": "実行中のタスクは直接完了にできません。先にワーカーを停止してください。",
    "task.blockedUnlanded":
      "未Landの変更が残っているため完了にできません。先に Land を実行（または Worktree を破棄）してください。",

    // TaskSidebar & Questions
    "sidebar.tasks": "タスク",
    "sidebar.addProjectTitle": "別のプロジェクトフォルダを追加 (⌘O)",
    "sidebar.projectsCount": "Projects ({count})",
    "sidebar.autoDetected": "自動認識済み",
    "sidebar.addOne": "1件追加",
    "sidebar.addOneTitle": "単体のプロジェクトフォルダを追加 (⌘O)",
    "sidebar.scanDir": "配下を一括",
    "sidebar.scanDirTitle": "親ディレクトリ配下のプロジェクトを一括登録 (⌘⇧O)",
    "sidebar.rescanTitle": "プロジェクトを再スキャン",
    "sidebar.searchProjectsPlaceholder": "プロジェクトを検索...",
    "sidebar.customModeTitle": "個別設定: {mode}",
    "sidebar.mentionInChat": "チャットで言及",
    "sidebar.removeFromList": "リストから除外",
    "sidebar.noMatchingProjects": "一致するプロジェクトがありません",
    "sidebar.noTasksTitle": "タスクはまだありません",
    "sidebar.noTasksDescription":
      "チャットでプロジェクト名を出して依頼すると、エージェントが裏でワーカーを起動しここにタスクを表示します。",
    "sidebar.activeAndReview": "実行中・確認待ち",
    "sidebar.completed": "完了",
    "sidebar.groupByProjectOnTitle": "プロジェクト別グループ表示: ON（クリックでフラット表示に切替）",
    "sidebar.groupByProjectOffTitle": "プロジェクト別グループ表示: OFF（クリックでプロジェクト別にグループ表示）",
    "sidebar.groupByProjectAria": "プロジェクト別にグループ表示を切替",
    "sidebar.projectGroupRunningTitle": "実行中 {count}件",
    "sidebar.projectGroupReviewTitle": "確認待ち {count}件",
    "sidebar.projectGroupTotalTitle": "タスク {count}件",
    "sidebar.projectGroupMatchTitle": "{filtered} / {total} 件一致",
    "sidebar.projectGroupExpandTitle": "{name} のタスクを展開",
    "sidebar.projectGroupCollapseTitle": "{name} のタスクを折りたたむ",
    "sidebar.unassignedProject": "未分類",
    "sidebar.searchCompletedPlaceholder": "完了タスクを検索...",
    "sidebar.searchCompletedAria": "完了タスクをタイトル・プロジェクト名・概要で検索",
    "sidebar.searchCompletedTitle": "タイトル・プロジェクト名・概要で絞り込み",
    "sidebar.clearFilter": "検索フィルタをクリア",
    "sidebar.showingCount": "{filtered} / {total} 件表示",
    "sidebar.noMatchingCompleted": "一致する完了タスクがありません",
    "sidebar.clearFilterBtn": "フィルタをクリア",
    "sidebar.openInBrowserTitle": "右ブラウザで開く",
    "sidebar.stopWorker": "ワーカーを停止",
    "sidebar.worktreeTitleParent": "Worktree: {branch} (親: {parent})",
    "sidebar.worktreeTitle": "Worktree: {branch}",
    "sidebar.pushPrTitle": "ブランチ {branch} を Push / PR 作成",
    "sidebar.landToBranchTitle": "{branch} へ変更を Land ({mode})",
    "sidebar.landChangesTitle": "変更を Land ({mode})",
    "sidebar.questions": "質問",
    "sidebar.questionsResizeAria": "Questions セクションの高さを調整",
    "sidebar.questionsResizeTitle": "ドラッグして高さを調整（ダブルクリックでデフォルトに戻す）",
    "sidebar.questionsActiveTitle": "{count}件 応答中",
    "sidebar.questionsUnreadTitle": "{count}件 未読の完了回答",
    "sidebar.questionsEmpty": "チャットで質問すると履歴と進捗がここに表示されます",
    "sidebar.searchQuestionsPlaceholder": "質問を検索...",
    "sidebar.searchQuestionsAria": "質問を本文・プロジェクト名・タスク（T#・タイトル）で検索",
    "sidebar.searchQuestionsTitle": "質問・プロジェクト名・タスク（T#・タイトル）で絞り込み",
    "sidebar.noMatchingQuestions": "一致する質問がありません",
    "sidebar.questionUnreadTooltip": "未読の完了回答",
    "sidebar.questionStreaming": "応答中",
    "sidebar.questionUnread": "未読",
    "questions.attachmentPrefix": "添付: {labels}",
    "questions.fallbackSnippet": "(質問)",
    "questions.thinking": "思考中…",
    "questions.preparing": "応答を準備中…",
    "questions.waiting": "応答待機中…",
    "questions.endedWithError": "エラーで終了しました",
    "questions.answered": "回答完了",

    // UnifiedChat & History & Mentions
    "chat.toggleSidebarTitle": "タスク一覧を表示/非表示 (⌘B)",
    "chat.reconnect": "再接続",
    "chat.parallelResponding": "{count}件 並列応答中",
    "chat.stopAll": "全停止",
    "chat.frontDeskProvider": "チャット窓口（高速レスポンス）",
    "chat.workerProvider": "プロジェクト実行ワーカー（既定）",
    "chat.settingsTitle": "設定 (言語 / Git Worktree / Usage)",
    "chat.usagePillTitle":
      "Usage / API利用料 — 今日: {todayTokens} tokens ({todayCost}) / 累計: {allTokens} tokens ({allCost})",
    "chat.usagePillEmptyTitle": "Usage / API利用料を表示",
    "chat.toggleMarkdownTitle": "Markdown Viewer を開く/切替 (⌘⇧M)",
    "chat.toggleRightPaneTitle": "右ペイン (Browser / Markdown) を表示/非表示 (⌘\\)",
    "chat.openImageInRightPaneTitle": "右ペインで画像を表示: {label}",
    "chat.openImageInRightPaneAria": "画像を右ペインで表示: {label}",
    "chat.removeAttachmentAria": "{label} を削除",
    "chat.composerPlaceholder":
      "複数プロジェクトへの指示や質問を入力…（@ でプロジェクト/タスクを指定・応答中でも連投OK）",
    "chat.attachImage": "画像を添付",
    "chat.screenshotBtn": "スクショ",
    "chat.screenshotTitle": "右ブラウザのスクショを添付 (⌘⇧S)",
    "chat.elementPickerBtn": "要素選択",
    "chat.elementPickerTitle": "右ブラウザ上の要素を選択してチャットへ送る (⌘⇧P)",
    "chat.attachUrlTitle": "現在のブラウザURLを添付",
    "chat.errorsCountBtn": "エラー ({count})",
    "chat.attachErrorsTitle": "右ブラウザのコンソール/通信エラーをチャットへ添付",
    "chat.sendTitle": "送信 (Enter) — 連投OK",
    "chat.welcomeHeading": "1つのチャットで、すべてのプロジェクトを動かす",
    "chat.welcomeSubtitle":
      "連投OKの並列高速チャット。左のタスクはエージェントが自動管理し、右の Chromium ブラウザを直接操作・検証できます。",
    "chat.welcomeProjectsDetected":
      "{count}個のプロジェクトを自動認識済み（そのまま名前で指示できます）",
    "chat.welcomeProjectsScanning": "プロジェクトを自動検出中...",
    "chat.welcomeAddFolder": "+ フォルダ追加",
    "chat.welcomeSampleFallback": "プロジェクト",
    "chat.welcomePrompt1Title": "最近のプロジェクト状況を整理",
    "chat.welcomePrompt1Body":
      "最近触っているプロジェクトのブランチと未コミット変更をまとめて教えて。",
    "chat.welcomePrompt2Title": "{name} の調査を依頼",
    "chat.welcomePrompt2Body": "{name} の現状を調査してタスクにまとめて。",
    "chat.welcomePrompt3Title": "右ブラウザを自動操作して検証",
    "chat.welcomePrompt3Body":
      "右のIn-App Browserで開いているページをスナップショット確認して、コンソールエラーがないか調べて。",
    "chat.welcomePrompt4Title": "開発サーバー起動＋ブラウザ表示",
    "chat.welcomePrompt4Body":
      "{name} の開発サーバーを起動して、右のIn-App Browserで開いて確認できるようにして。",
    "chat.openTaskDetail": "タスク詳細を開く",
    "chat.reasoningProcess": "思考プロセス",
    "chat.preparingReply": "応答を準備中...",
    "chat.toolChipsSummary": "ツール実行 {count}件（{breakdown}）",
    "chat.toolChipsSummaryNoBreakdown": "ツール実行 {count}件",
    "chat.toolChipsErrorSuffix": " · {count}件エラー",
    "chat.toolChipsExpandAria": "ツール実行の詳細を展開",
    "chat.toolChipsCollapseAria": "ツール実行の詳細を折りたたむ",
    "chat.scrollToBottom": "最新メッセージへ",

    // ChatHistoryMenu
    "history.buttonTitle": "チャット履歴 — 過去のチャットをワンクリックで復元",
    "history.title": "チャット履歴",
    "history.newChat": "新規チャット",
    "history.searchPlaceholder": "履歴を検索...",
    "history.noMatches": "一致するチャット履歴がありません",
    "history.activeBadge": "表示中",
    "history.noMessages": "メッセージなし",
    "history.messageCount": "{count}件",
    "history.undo": "戻す",
    "history.deleteTitle": "このチャットを履歴から削除",
    "history.newChatBtnTitle": "新しいチャットを開始 (⌘N) — 現在のチャットは履歴に保存されます",
    "history.confirmDialogAria": "新しいチャットを開始する確認",
    "history.confirmTitle": "新しいチャットを開始しますか？",
    "history.confirmDesc":
      "現在のチャット（{count}件）は履歴に自動保存され、隣の履歴ボタンからいつでも復元できます。",
    "history.confirmActiveWarn": "応答中の{count}件は停止して保存されます。",
    "history.confirmStartBtn": "新規チャットを開始",
    "history.timeJustNow": "たった今",
    "history.timeMinutesAgo": "{count}分前",
    "history.timeHoursAgo": "{count}時間前",
    "history.timeYesterday": "昨日",
    "history.timeDaysAgo": "{count}日前",

    // Mentions
    "mention.selectedAria": "選択中のメンション",
    "mention.removeTaskTitle": "{code} のメンションを削除",
    "mention.removeTaskAria": "{code} {title} のメンションを削除",
    "mention.removeProjectTitle": "@{name} のメンションを削除",
    "mention.openTaskAria": "タスクを開く: {tooltip}",
    "mention.popoverAria": "メンション候補",
    "mention.projectTasksTitle": "@{name}/ のタスク",
    "mention.defaultTitle": "プロジェクト / タスクをメンション",
    "mention.shortcutsHint": "↑↓ 移動 · Enter/Tab 選択 · Esc 閉じる",
    "mention.noProjectTasks": "{name} に一致するタスクがありません",
    "mention.noMatches": "一致するプロジェクトまたはタスクがありません",
    "mention.filterTasksTitle": "@{name}/ でタスクを絞り込み",

    // TaskInspectorModal
    "inspector.statusAria": "タスクステータス",
    "inspector.statusTitle": "タスクステータスを変更",
    "inspector.refreshGitTitle": "Git 状態を更新",
    "inspector.parentDirty": "親リポジトリに未コミット変更あり",
    "inspector.conflictFiles": "対象ファイル: {files}",
    "inspector.aiResolveStarting": "解消を開始中...",
    "inspector.aiResolveBtn": "AIでコンフリクト解消",
    "inspector.landing": "取り込み中...",
    "inspector.pushPrGhTitle": "ブランチを Push して gh CLI で PR を作成",
    "inspector.pushPrNoGhTitle": "ブランチを Push（gh CLI 未検出の場合は Push のみ実行）",
    "inspector.deleteWorktree": "Worktree を削除",
    "inspector.summary": "概要",
    "inspector.latestOutput": "ワーカー最新出力",
    "inspector.activityLog": "実行ログ ({count})",
    "inspector.toolLogSummary": "ツール実行ログ（全 {count}件: {breakdown}）",
    "inspector.toolLogSummaryEmptyBreakdown": "ツール実行ログ（全 {count}件）",
    "inspector.toolLogMoreTools": "他 {count}種",
    "inspector.toolLogExpandAria": "ツール実行ログを展開",
    "inspector.toolLogCollapseAria": "ツール実行ログを折りたたむ",
    "inspector.openInBrowser": "ブラウザで開く",

    // SettingsModal
    "settings.title": "Conductor 設定",
    "settings.usageTabTitle": "Usage / API利用料",
    "settings.generalTab": "一般設定",
    "settings.tabsAria": "設定タブ",
    "settings.closeAria": "設定を閉じる",
    "settings.languageTitle": "言語設定 / Output Language",
    "settings.languageDesc":
      "UI表示、チャット返信、タスクのタイトル・要約、ワーカーの完了レポートの出力言語を指定します。",
    "settings.integrationTitle": "Git Worktree 統合モード（グローバル既定）",
    "settings.integrationDesc":
      "ワーカーは各タスク専用の Git Worktree で並列実行されます。完了後の取り込み方式を選択してください。",
    "settings.autoLandTitle": "ワーカー完了時に自動 Land（コンフリクト時は AI が自力解消）",
    "settings.autoLandDesc":
      "feature-branch / direct モード時、タスク完了後に自動で取り込みを実行します。コンフリクトが発生した場合は最大2回までワーカーが自動で解消を試みます（per-task-pr モードは手動 Push/PR のまま維持）。",
    "settings.perProjectTitle": "プロジェクトごとの個別設定",
    "settings.perProjectDescBefore":
      "特定のプロジェクトだけ統合モードを上書きできます（未設定時はプロジェクト直下の ",
    "settings.perProjectDescAfter": " またはグローバル既定を使用）。",
    "settings.filterProjectsPlaceholder": "プロジェクトを絞り込む...",
    "settings.noProjects": "対象のプロジェクトがありません",
    "settings.projectModeAria": "{name} の統合モード",
    "settings.defaultModeOption": "既定 ({mode})",

    // UnifiedRightPane & ProjectSwitcher
    "rightPane.toggleFileTree": "ファイルツリーを表示 / 非表示",
    "rightPane.tabsAria": "{name} のタブ",
    "rightPane.unsavedChanges": "未保存の変更があります",
    "rightPane.closeTabAria": "{title} を閉じる",
    "rightPane.newBrowserTabTitle": "新しいブラウザタブを開く",
    "rightPane.newTerminalTabTitle": "新しいターミナルタブを開く (⌘⇧T)",
    "rightPane.openMarkdownTitle": "Markdown ファイルを開く (⌘⌥O)",
    "rightPane.openMarkdownAria": "Markdown ファイルを開く",
    "rightPane.closePanel": "右パネルを閉じる",
    "rightPane.resizeFileTreeTitle": "ドラッグしてファイルツリーの幅を調整",
    "rightPane.emptyDesc":
      "このプロジェクトで開いているタブはまだありません。ブラウザ・ターミナル・Markdown・画像・コードを1つのタブバーでまとめて管理できます。",
    "rightPane.newBrowserTabBtn": "新しいブラウザタブ",
    "rightPane.newTerminalTabBtn": "新しいターミナル",
    "rightPane.openMarkdownBtn": "Markdown ファイルを開く",
    "rightPane.openFileTreeBtn": "ファイルツリーを開く",
    "rightPane.recentMarkdownHeader": "最近の Markdown ({name})",
    "rightPane.removeFromHistory": "履歴から削除",
    "rightPane.dropMarkdown": "Markdown ファイルをドロップして開く",
    "switcher.title": "右ペインのプロジェクトを切替: {name}",
    "switcher.listboxAria": "プロジェクトを切替",
    "switcher.clearSearchAria": "検索をクリア",
    "switcher.openTabsSection": "開いているタブ",
    "switcher.allProjectsSection": "すべてのプロジェクト",

    // InAppBrowserPane
    "browser.back": "戻る",
    "browser.forward": "進む",
    "browser.stopLoading": "読み込みを中止",
    "browser.reload": "再読み込み",
    "browser.urlPlaceholder": "localhost:3000 や URL を入力...",
    "browser.devToolsTitle": "Chrome DevTools を開閉 (⌘⌥I)",
    "browser.devToolsAria": "Chrome DevTools を開閉",
    "browser.openExternal": "外部ブラウザで開く",
    "browser.screenshotBtn": "スクショ",
    "browser.screenshotTitle": "画面スクショをチャットに添付 (⌘⇧S)",
    "browser.screenshotAria": "画面スクショをチャットに添付",
    "browser.pickerBtn": "要素選択",
    "browser.pickerTitle": "ページ上の要素を選択してチャットに添付 (⌘⇧P)",
    "browser.pickerAria": "要素選択モード",
    "browser.attachUrlBtn": "URL添付",
    "browser.attachUrlTitle": "現在のブラウザURLをチャットに添付",
    "browser.attachUrlDisabledTitle": "URL を開くとチャットに添付できます",
    "browser.attachErrorsBtn": "エラー添付",
    "browser.attachErrorsTitleWithCount": "コンソール/通信エラー ({count}件) をチャットへ添付",
    "browser.attachErrorsEmptyTitle": "コンソール/通信エラーをチャットへ添付（現在エラーはありません）",
    "browser.attachErrorsAria": "コンソール/通信エラーをチャットへ添付",
    "browser.pickerBanner":
      "要素選択モード：ページ上の要素をクリックすると HTML/CSS とスクショをチャットに添付します (Esc で終了)",
    "browser.pickerDone": "終了",
    "browser.emptyDesc":
      "CDP 直結の内蔵 Chromium。Agent がクリック・入力・コンソールエラー監視・スクショ撮影を自動実行でき、本物の Chrome DevTools も開けます。",

    // MarkdownViewerPane & MarkdownView & Mermaid
    "markdown.openFileTitle": "ファイルを選択して開く (⌘⌥O)",
    "markdown.pathPlaceholder": "/path/to/README.md や file:// URL を入力...",
    "markdown.renderedTitle": "Rendered プレビュー",
    "markdown.rawTitle": "Code / Source 編集モード",
    "markdown.tocTitle": "見出しアウトライン ({count})",
    "markdown.noHeadingsTitle": "見出しがありません",
    "markdown.autoReloadOnTitle": "ライブ自動更新: ON（クリックで一時停止）",
    "markdown.autoReloadOffTitle": "ライブ自動更新: OFF（クリックで再開）",
    "markdown.checkDiskTitle": "ディスクの変更を確認",
    "markdown.manualReloadTitle": "手動で再読み込み",
    "markdown.attachFileTitle": "このファイルをチャットに添付",
    "markdown.unsavedBadge": "未保存",
    "markdown.discardTitle": "未保存の変更を破棄してディスクから再読み込み",
    "markdown.discardBtn": "変更を破棄",
    "markdown.saveTitle": "保存 (⌘S)",
    "markdown.savingBtn": "保存中...",
    "markdown.saveBtn": "保存",
    "markdown.linesCount": "{count}行",
    "markdown.savedFeedback": "保存しました",
    "markdown.reloadedFeedback": "更新済み",
    "markdown.emptyDescBefore": "ローカルの ",
    "markdown.emptyDescAfter":
      " ファイルをリアルタイム自動更新・見出しアウトライン・ソース編集付きで扱えます。",
    "markdown.recentFilesHeader": "最近開いたファイル",
    "markdown.externalDeleted":
      "ディスク上のファイルが外部で削除されました。現在の未保存の編集は保持されています（保存で再作成できます）。",
    "markdown.externalChanged":
      "ディスク上のファイルが外部で更新されました。未保存の編集内容を守るため自動上書きを保留しています。",
    "markdown.dismissBanner": "通知を閉じる",
    "markdown.retrySave": "再保存",
    "markdown.editorHint": "⌘S で保存 · Tab インデント",
    "markdown.editorAria": "{fileName} の Markdown ソースエディタ",
    "markdown.openInViewerTitle": "Markdown Viewer で開く",
    "markdown.imageZoomTitle": "クリックで Image Viewer で拡大表示",
    "markdown.imageLoadFailed": "画像を読み込めませんでした",
    "markdown.imageRenderFailed": "画像データの表示に失敗しました。",
    "markdown.imageLoading": "{name} を読み込み中...",
    "markdown.readFailed": "ファイルを読み込めませんでした。",
    "markdown.saveFailed": "ファイルの保存に失敗しました。",
    "markdown.reloadFailed": "ファイルの再読み込みに失敗しました。",
    "mermaid.diagramTitle": "Mermaid 図を表示",
    "mermaid.codeTitle": "Mermaid ソースを表示",
    "mermaid.renderFailed": "Mermaid 図のレンダリングに失敗しました",
    "mermaid.rendering": "Mermaid 図をレンダリング中...",

    // ImageViewerPane
    "image.fitTitle": "ペインに合わせる (0)",
    "image.actualSizeTitle": "原寸大 100% で表示 (1)",
    "image.zoomOutTitle": "縮小 (-)",
    "image.zoomOutAria": "縮小",
    "image.zoomInTitle": "拡大 (+)",
    "image.zoomInAria": "拡大",
    "image.bgGroupAria": "背景スタイル",
    "image.bgChecker": "透過",
    "image.bgDark": "暗",
    "image.bgLight": "明",
    "image.closeTabTitle": "この画像タブを閉じる",
    "image.copyPathAria": "画像パスをコピー",
    "image.sourcePageTitle": "元ページをブラウザで開く: {url}",
    "image.sourcePageBtn": "元ページ",
    "image.emptyDesc":
      "チャットに貼り付けた画像や添付サムネイルをクリックすると、この右ペインで拡大表示できます。",
    "image.loading": "画像を読み込み中...",
    "image.errorHeading": "画像を表示できませんでした",
    "image.missingData": "画像データが見つかりません。",
    "image.clickActualSizeTitle": "クリックで原寸大 (100%) に切替",
    "image.clickFitTitle": "クリックでペインに合わせる (Fit)",
    "image.dblClickActualSizeTitle": "ダブルクリックで原寸大 (100%) に切替 / ピンチでズーム",
    "image.dblClickFitTitle": "ダブルクリックでペインに合わせる (Fit) / スクロール・ドラッグで移動",

    // CodeViewerPane & ProjectFileTree
    "code.copyContent": "内容をコピー",
    "code.wrapOn": "行の折り返し: ON",
    "code.wrapOff": "行の折り返し: OFF",
    "code.wrapAria": "行の折り返しを切替",
    "code.empty": "ファイルツリーからファイルを選択すると、ここに内容が表示されます。",
    "code.loading": "ファイルを読み込み中...",
    "code.binaryTitle": "バイナリファイルはプレビューできません",
    "code.tooLargeTitle": "ファイルサイズが上限を超えています",
    "code.readErrorTitle": "ファイルを読み込めませんでした",
    "fileTree.aria": "プロジェクトファイルツリー",
    "fileTree.revealFolder": "Finder でフォルダを開く",
    "fileTree.refresh": "ファイルツリーを更新",
    "fileTree.selectProjectTitle": "プロジェクトを選択してください",
    "fileTree.selectProjectDesc":
      "現在は General スコープです。上部のプロジェクト切替からプロジェクトを選ぶと、配下のファイルツリーを閲覧できます。",
    "fileTree.filterPlaceholder": "ファイル名で絞り込み...",
    "fileTree.clearFilterAria": "絞り込みをクリア",
    "fileTree.noMatches": "一致するファイルがありません",
    "fileTree.noFiles": "表示できるファイルがありません",
    "fileTree.emptyDir": "(空)",
    "fileTree.loadDirError": "ディレクトリを読み込めませんでした。",

    // TerminalPane
    "terminal.defaultTitle": "ターミナル",
    "terminal.statusStarting": "起動中...",
    "terminal.statusRunning": "実行中",
    "terminal.statusExited": "終了 (コード {code})",
    "terminal.statusExitedNoCode": "終了",
    "terminal.statusError": "エラー",
    "terminal.restartBtn": "再起動",
    "terminal.restartTitle": "ターミナルを再起動",
    "terminal.clearTitle": "画面をクリア",
    "terminal.copyTitle": "選択テキストをコピー",
    "terminal.pasteTitle": "クリップボードから貼り付け",
    "terminal.newTabTitle": "新しいターミナルタブを開く",
    "terminal.fallbackBanner": "フォールバックモード ({backend}) で実行中",
    "terminal.exitedNotice":
      "プロセスが終了しました（終了コード: {code}）。「再起動」ボタンまたは Enter で新しいシェルを開始できます。",
    "terminal.exitedNoticeNoCode":
      "プロセスが終了しました。「再起動」ボタンまたは Enter で新しいシェルを開始できます。",
    "terminal.startFailed": "ターミナルの起動に失敗しました。",
    "terminal.ariaLabel": "インタラクティブターミナル: {title}",

    // Main-process TaskEvent & currentStep labels
    "taskEvent.completedReview": "完了（確認待ち）",
    "taskEvent.completedReviewUnlanded": "完了（確認待ち・未Land）",
    "taskEvent.failed": "失敗",
    "taskEvent.noOutput": "(出力なし)",
    "taskEvent.noChangesLabel": "(変更なし)",
    "taskEvent.autoLandNoop": "✅ 自動 Land 完了: {target}（差分なし・Worktree クリーンアップ済み）",
    "taskEvent.autoLandResolved": "✅ 自動 Land 完了: {target}（コンフリクト自力解消済み）",
    "taskEvent.autoLandSuccess": "✅ 自動 Land 完了: {target}",
    "taskEvent.autoLandFailed": "⚠️ 自動 Land を実行できませんでした: {message}",
    "taskEvent.conflictLimitReached": "コンフリクト自動解消の上限に到達",
    "taskEvent.conflictResolveFailed": "コンフリクト自動解消に失敗",
    "taskEvent.autoResumeFailed": "自動再開に失敗しました",
    "taskEvent.autoResumedSession": "再起動後に自動再開しました（セッション継続）",
    "taskEvent.autoResumedNew": "再起動後に自動再開しました（新規セッション）",
    "taskStep.completedReview": "完了・確認待ち",
    "taskStep.completedNoChanges": "完了・確認待ち (変更なし)",
    "taskStep.completedLandedBranch": "完了・確認待ち (Landed → {branch})",
    "taskStep.completedLanded": "完了・確認待ち (Landed)",
    "taskStep.autoLanding": "自動 Land を実行中...",
    "taskStep.autoLandError": "完了・自動 Land エラー",
    "taskStep.interrupted": "中断されました",
    "taskStep.failed": "エラーで終了",

    // Voice Input & Readback (OS-standard STT & TTS)
    "voice.stopSpeaking": "読み上げ停止",
    "voice.stopSpeakingTitle": "読み上げを停止",
    "voice.readbackOnTitle": "音声読み上げ: ON（完了した返信とタスク完了通知を読み上げます・クリックでOFF）",
    "voice.readbackOffTitle": "音声読み上げ: OFF（クリックで完了返信・タスク完了通知の自動読み上げをON）",
    "voice.readbackDisableAria": "音声読み上げをオフにする",
    "voice.readbackEnableAria": "音声読み上げをオンにする",
    "voice.listeningLabel": "音声入力中 ({locale})",
    "voice.listeningHint": "話してください…（⌥Space で停止 / Esc でキャンセル）",
    "voice.dismissErrorAria": "音声入力エラーを閉じる",
    "voice.autoSendShort": "自動送信",
    "voice.autoSendOnTitle": "発話終了時に自動送信: ON（ハンズフリー送信・クリックでOFF）",
    "voice.autoSendOffTitle": "発話終了時に自動送信: OFF（クリックでONにすると発話終了後に即送信）",
    "voice.micStopTitle": "音声入力を停止 (⌥Space / Alt+Space) — {locale}",
    "voice.micStartTitle": "音声入力を開始 (⌥Space / Alt+Space) — {locale}",
    "voice.micStopAria": "音声入力を停止",
    "voice.micStartAria": "音声入力を開始",
    "settings.voiceTitle": "音声入力・読み上げ / Voice (OS 標準・無料)",
    "settings.voiceDescBeforeKbd": "チャット入力欄のマイクボタン（または ",
    "settings.voiceDescBetweenKbdAndCode": "）で音声入力、OS 標準 TTS（macOS ",
    "settings.voiceDescAfterCode": "）で返信やタスク完了通知を自動読み上げします。",
    "settings.voiceReadbackTitle": "返信・タスク完了を音声読み上げ (Voice Readback)",
    "settings.voiceReadbackDescBeforeCode": "完了した Conductor の返信（コードや URL を除いた要約）とタスク完了通知（例: 「T48 が完了しました」）を macOS ",
    "settings.voiceReadbackDescAfterCode": " で自動読み上げします。",
    "settings.voiceAutoSendTitle": "発話終了時に自動送信 (Auto-send on speech end)",
    "settings.voiceAutoSendDesc": "ON にすると音声入力の認識完了後すぐにチャットを送信します（OFF の場合は送信前に入力内容を確認・編集できます）。",

    // Remote Access & Android QR Setup
    "remote.title": "リモートアクセス / Tailscale Mobile Bridge",
    "remote.desc":
      "Tailscale 経由で Android アプリやモバイルブラウザから Conductor のチャット・タスクをリアルタイム操作します。",
    "remote.refreshTitle": "Tailscale ネットワーク情報を再検出",
    "remote.refreshBtn": "再検出",
    "remote.toggleTitle": "Remote Bridge サーバーを有効化",
    "remote.statusRunning": "稼働中 · SSE {count}台",
    "remote.statusError": "エラー",
    "remote.statusStopped": "停止中",
    "remote.toggleDescBeforeCode": "ON の間のみ ",
    "remote.toggleDescAfterCode": " で待受し、すべての API に Bearer Token 認証を必須とします。",
    "remote.qrHeading": "Android クイックセットアップ（QRコード）",
    "remote.qrSubheading":
      "2ステップで Android アプリの導入からデスクトップとのリンク設定まで完了します。",
    "remote.step1Badge": "Step 1",
    "remote.step1Title": "Android アプリをダウンロード",
    "remote.step1Desc":
      "スマホのカメラで読み取り、GitHub Releases の最新リリースから APK をインストールします。",
    "remote.step1QrAria": "Android APK ダウンロード用 QR コード",
    "remote.step1CopyUrl": "URL コピー",
    "remote.step2Badge": "Step 2",
    "remote.step2Title": "デスクトップとリンク（ペアリング）",
    "remote.step2DescActive":
      "Android アプリの「QRコードをスキャンしてリンク」または標準カメラで読み取ると、URL とトークンが自動設定されて即座に接続します。",
    "remote.step2QrAria": "デスクトップ連携用 QR コード",
    "remote.step2TailscaleWarning":
      "Tailscale IP が未検出です。Mac と Android の両方で Tailscale を ON にして「再検出」を押してください。",
    "remote.step2TokenHint":
      "認証トークンを含むため画面共有時はご注意ください。「再生成」で以前の QR を無効化できます。",
    "remote.step2DisabledDesc":
      "リンク用 QR コードを表示するには、Remote Bridge サーバーを有効化してください。",
    "remote.step2EnableBtn": "Remote Bridge を有効化して QR を表示",
    "remote.portLabel": "ポート番号（既定: 4789）",
    "remote.applyBtn": "適用",
    "remote.tailscaleDetection": "Tailscale 検出結果",
    "remote.notDetected": "未検出",
    "remote.urlLabel": "接続 URL（Android Chrome でもそのまま開けます）",
    "remote.copyBtn": "コピー",
    "remote.copiedBtn": "コピー済み",
    "remote.bearerTokenLabel": "Bearer Token",
    "remote.hideTokenAria": "トークンを隠す",
    "remote.showTokenAria": "トークンを表示",
    "remote.regenerateBtn": "再生成",
    "remote.connectUriLabel": "Android アプリ一括接続 URI（そのまま貼り付け可能）",
    "remote.copyUriBtn": "URI コピー",
  },
  en: {
    // Common & App
    "app.starting": "Starting Conductor...",
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.retry": "Retry",
    "common.reload": "Reload",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.loading": "Loading...",
    "common.stop": "Stop",
    "common.all": "All",
    "common.finder": "Finder",
    "common.revealInFinder": "Reveal in Finder",
    "common.copyPath": "Copy path",
    "common.copyPathWith": "Copy path: {path}",
    "common.error": "Error",

    // Task status & actions
    "taskStatus.queued": "Queued",
    "taskStatus.running": "Running",
    "taskStatus.needs_review": "Needs Review",
    "taskStatus.done": "Completed",
    "taskStatus.failed": "Failed",
    "task.quickDoneLabel": "Done",
    "task.quickReopenLabel": "Reopen",
    "task.markDoneTitle": "Mark as done",
    "task.reopenTitle": "Reopen task",
    "task.doneBadge": "Completed",
    "task.runningBadge": "Running",
    "task.unlandedBadge": "Unlanded",
    "task.blockedRunning": "Cannot mark a running task as done. Stop the worker first.",
    "task.blockedUnlanded":
      "Cannot mark as done while unlanded changes remain. Land the changes (or remove the worktree) first.",

    // TaskSidebar & Questions
    "sidebar.tasks": "Tasks",
    "sidebar.addProjectTitle": "Add project folder (⌘O)",
    "sidebar.projectsCount": "Projects ({count})",
    "sidebar.autoDetected": "Auto-detected",
    "sidebar.addOne": "Add folder",
    "sidebar.addOneTitle": "Add a single project folder (⌘O)",
    "sidebar.scanDir": "Scan folder",
    "sidebar.scanDirTitle": "Bulk-add projects under a parent folder (⌘⇧O)",
    "sidebar.rescanTitle": "Rescan projects",
    "sidebar.searchProjectsPlaceholder": "Search projects...",
    "sidebar.customModeTitle": "Project override: {mode}",
    "sidebar.mentionInChat": "Mention in chat",
    "sidebar.removeFromList": "Remove from list",
    "sidebar.noMatchingProjects": "No matching projects",
    "sidebar.noTasksTitle": "No tasks yet",
    "sidebar.noTasksDescription":
      "Mention a project in chat to start a background worker — tasks will appear here automatically.",
    "sidebar.activeAndReview": "Active & Review",
    "sidebar.completed": "Completed",
    "sidebar.groupByProjectOnTitle": "Group by project: ON (click for flat list)",
    "sidebar.groupByProjectOffTitle": "Group by project: OFF (click to group by project)",
    "sidebar.groupByProjectAria": "Toggle grouping tasks by project",
    "sidebar.projectGroupRunningTitle": "{count} running",
    "sidebar.projectGroupReviewTitle": "{count} needs review",
    "sidebar.projectGroupTotalTitle": "{count} tasks",
    "sidebar.projectGroupMatchTitle": "{filtered} of {total} matched",
    "sidebar.projectGroupExpandTitle": "Expand tasks for {name}",
    "sidebar.projectGroupCollapseTitle": "Collapse tasks for {name}",
    "sidebar.unassignedProject": "Unassigned",
    "sidebar.searchCompletedPlaceholder": "Search completed tasks...",
    "sidebar.searchCompletedAria": "Search completed tasks by title, project, or summary",
    "sidebar.searchCompletedTitle": "Filter by title, project, or summary",
    "sidebar.clearFilter": "Clear search filter",
    "sidebar.showingCount": "Showing {filtered} of {total}",
    "sidebar.noMatchingCompleted": "No matching completed tasks",
    "sidebar.clearFilterBtn": "Clear filter",
    "sidebar.openInBrowserTitle": "Open in right browser",
    "sidebar.stopWorker": "Stop worker",
    "sidebar.worktreeTitleParent": "Worktree: {branch} (base: {parent})",
    "sidebar.worktreeTitle": "Worktree: {branch}",
    "sidebar.pushPrTitle": "Push branch {branch} & create PR",
    "sidebar.landToBranchTitle": "Land changes to {branch} ({mode})",
    "sidebar.landChangesTitle": "Land changes ({mode})",
    "sidebar.questions": "Questions",
    "sidebar.questionsResizeAria": "Resize Questions section height",
    "sidebar.questionsResizeTitle": "Drag to resize height (double-click to reset)",
    "sidebar.questionsActiveTitle": "{count} active",
    "sidebar.questionsUnreadTitle": "{count} unread replies",
    "sidebar.questionsEmpty": "Ask a question in chat to track replies and progress here.",
    "sidebar.searchQuestionsPlaceholder": "Search questions...",
    "sidebar.searchQuestionsAria": "Search questions by text, project, or task (T# / title)",
    "sidebar.searchQuestionsTitle": "Filter by question, project, or task (T# / title)",
    "sidebar.noMatchingQuestions": "No matching questions",
    "sidebar.questionUnreadTooltip": "Unread completed reply",
    "sidebar.questionStreaming": "Streaming",
    "sidebar.questionUnread": "Unread",
    "questions.attachmentPrefix": "Attachments: {labels}",
    "questions.fallbackSnippet": "(Question)",
    "questions.thinking": "Thinking…",
    "questions.preparing": "Preparing response…",
    "questions.waiting": "Waiting for response…",
    "questions.endedWithError": "Ended with an error",
    "questions.answered": "Answered",

    // UnifiedChat & History & Mentions
    "chat.toggleSidebarTitle": "Toggle tasks sidebar (⌘B)",
    "chat.reconnect": "Reconnect",
    "chat.parallelResponding": "{count} active",
    "chat.stopAll": "Stop all",
    "chat.frontDeskProvider": "Chat Orchestrator (Fast)",
    "chat.workerProvider": "Project Worker (Default)",
    "chat.settingsTitle": "Settings (Language / Git Worktree / Usage)",
    "chat.usagePillTitle":
      "Usage / API Cost — Today: {todayTokens} tokens ({todayCost}) / All-time: {allTokens} tokens ({allCost})",
    "chat.usagePillEmptyTitle": "Show Usage / API Cost",
    "chat.toggleMarkdownTitle": "Open/Switch Markdown Viewer (⌘⇧M)",
    "chat.toggleRightPaneTitle": "Toggle right pane (Browser / Markdown) (⌘\\)",
    "chat.openImageInRightPaneTitle": "View image in right pane: {label}",
    "chat.openImageInRightPaneAria": "View image in right pane: {label}",
    "chat.removeAttachmentAria": "Remove {label}",
    "chat.composerPlaceholder":
      "Ask a question or give instructions across projects… (@ to mention project/task · non-blocking)",
    "chat.attachImage": "Attach image",
    "chat.screenshotBtn": "Screenshot",
    "chat.screenshotTitle": "Attach browser screenshot (⌘⇧S)",
    "chat.elementPickerBtn": "Pick Element",
    "chat.elementPickerTitle": "Pick a page element to attach to chat (⌘⇧P)",
    "chat.attachUrlTitle": "Attach current browser URL",
    "chat.errorsCountBtn": "Errors ({count})",
    "chat.attachErrorsTitle": "Attach browser console & network errors to chat",
    "chat.sendTitle": "Send (Enter) — non-blocking",
    "chat.welcomeHeading": "Orchestrate all your projects from one chat",
    "chat.welcomeSubtitle":
      "Fast, non-blocking multi-agent chat. Background workers manage tasks on the left while an embedded Chromium browser and Markdown viewer run on the right.",
    "chat.welcomeProjectsDetected":
      "{count} projects auto-detected (reference them by name or @mention)",
    "chat.welcomeProjectsScanning": "Scanning local projects...",
    "chat.welcomeAddFolder": "+ Add folder",
    "chat.welcomeSampleFallback": "project",
    "chat.welcomePrompt1Title": "Summarize recent project status",
    "chat.welcomePrompt1Body":
      "Summarize active branches and uncommitted changes across my recent projects.",
    "chat.welcomePrompt2Title": "Inspect {name}",
    "chat.welcomePrompt2Body": "Inspect {name} and break down the current issues into tasks.",
    "chat.welcomePrompt3Title": "Verify page in the right browser",
    "chat.welcomePrompt3Body":
      "Take a snapshot of the active page in the In-App Browser and check for console or network errors.",
    "chat.welcomePrompt4Title": "Start dev server & preview",
    "chat.welcomePrompt4Body":
      "Start the dev server for {name} and open it in the In-App Browser.",
    "chat.openTaskDetail": "Open Task Detail",
    "chat.reasoningProcess": "Reasoning",
    "chat.preparingReply": "Preparing response...",
    "chat.toolChipsSummary": "{count} tool calls ({breakdown})",
    "chat.toolChipsSummaryNoBreakdown": "{count} tool calls",
    "chat.toolChipsErrorSuffix": " · {count} error(s)",
    "chat.toolChipsExpandAria": "Expand tool call details",
    "chat.toolChipsCollapseAria": "Collapse tool call details",
    "chat.scrollToBottom": "Scroll to bottom",

    // ChatHistoryMenu
    "history.buttonTitle": "Chat history — restore previous conversations in one click",
    "history.title": "Chat History",
    "history.newChat": "New Chat",
    "history.searchPlaceholder": "Search history...",
    "history.noMatches": "No matching chat sessions",
    "history.activeBadge": "Active",
    "history.noMessages": "No messages",
    "history.messageCount": "{count} msgs",
    "history.undo": "Back",
    "history.deleteTitle": "Delete this chat from history",
    "history.newChatBtnTitle": "Start new chat (⌘N) — current chat is saved to history",
    "history.confirmDialogAria": "Confirm starting a new chat",
    "history.confirmTitle": "Start a new chat?",
    "history.confirmDesc":
      "Your current chat ({count} messages) will be saved to history and can be restored anytime.",
    "history.confirmActiveWarn": "{count} active responses will be stopped before saving.",
    "history.confirmStartBtn": "Start New Chat",
    "history.timeJustNow": "Just now",
    "history.timeMinutesAgo": "{count}m ago",
    "history.timeHoursAgo": "{count}h ago",
    "history.timeYesterday": "Yesterday",
    "history.timeDaysAgo": "{count}d ago",

    // Mentions
    "mention.selectedAria": "Selected mentions",
    "mention.removeTaskTitle": "Remove {code} mention",
    "mention.removeTaskAria": "Remove mention for {code} {title}",
    "mention.removeProjectTitle": "Remove @{name} mention",
    "mention.openTaskAria": "Open task: {tooltip}",
    "mention.popoverAria": "Mention suggestions",
    "mention.projectTasksTitle": "Tasks in @{name}/",
    "mention.defaultTitle": "Mention project or task",
    "mention.shortcutsHint": "↑↓ Navigate · Enter/Tab Select · Esc Close",
    "mention.noProjectTasks": "No matching tasks in {name}",
    "mention.noMatches": "No matching projects or tasks",
    "mention.filterTasksTitle": "Type @{name}/ to filter tasks",

    // TaskInspectorModal
    "inspector.statusAria": "Task status",
    "inspector.statusTitle": "Change task status",
    "inspector.refreshGitTitle": "Refresh Git status",
    "inspector.parentDirty": "Parent repository has uncommitted changes",
    "inspector.conflictFiles": "Conflicted files: {files}",
    "inspector.aiResolveStarting": "Starting resolution...",
    "inspector.aiResolveBtn": "Resolve Conflict with AI",
    "inspector.landing": "Landing...",
    "inspector.pushPrGhTitle": "Push branch and create PR with gh CLI",
    "inspector.pushPrNoGhTitle": "Push branch (push only if gh CLI is not available)",
    "inspector.deleteWorktree": "Remove Worktree",
    "inspector.summary": "Summary",
    "inspector.latestOutput": "Latest Worker Output",
    "inspector.activityLog": "Activity Log ({count})",
    "inspector.toolLogSummary": "Tool execution log ({count} total: {breakdown})",
    "inspector.toolLogSummaryEmptyBreakdown": "Tool execution log ({count} total)",
    "inspector.toolLogMoreTools": "+{count} more",
    "inspector.toolLogExpandAria": "Expand tool execution log",
    "inspector.toolLogCollapseAria": "Collapse tool execution log",
    "inspector.openInBrowser": "Open in Browser",

    // SettingsModal
    "settings.title": "Conductor Settings",
    "settings.usageTabTitle": "Usage / API Cost",
    "settings.generalTab": "General",
    "settings.tabsAria": "Settings tabs",
    "settings.closeAria": "Close settings",
    "settings.languageTitle": "Language / Output Language",
    "settings.languageDesc":
      "Controls UI language, orchestrator replies, task titles/summaries, and worker completion reports.",
    "settings.integrationTitle": "Git Worktree Integration Mode (Global Default)",
    "settings.integrationDesc":
      "Each task worker runs in an isolated Git worktree. Choose how completed changes are integrated.",
    "settings.autoLandTitle": "Auto-Land on worker completion (with AI conflict resolution)",
    "settings.autoLandDesc":
      "Automatically lands completed worktrees in feature-branch and direct modes. On rebase conflict, the worker attempts self-resolution up to 2 times (per-task-pr stays manual Push/PR).",
    "settings.perProjectTitle": "Per-Project Overrides",
    "settings.perProjectDescBefore":
      "Override the integration mode for individual repositories (falls back to ",
    "settings.perProjectDescAfter": " in the repo root or the global default).",
    "settings.filterProjectsPlaceholder": "Filter projects...",
    "settings.noProjects": "No matching projects",
    "settings.projectModeAria": "Integration mode for {name}",
    "settings.defaultModeOption": "Default ({mode})",

    // UnifiedRightPane & ProjectSwitcher
    "rightPane.toggleFileTree": "Toggle file tree",
    "rightPane.tabsAria": "Tabs for {name}",
    "rightPane.unsavedChanges": "Unsaved changes",
    "rightPane.closeTabAria": "Close {title}",
    "rightPane.newBrowserTabTitle": "Open new browser tab",
    "rightPane.newTerminalTabTitle": "Open new terminal tab (⌘⇧T)",
    "rightPane.openMarkdownTitle": "Open Markdown file (⌘⌥O)",
    "rightPane.openMarkdownAria": "Open Markdown file",
    "rightPane.closePanel": "Close right panel",
    "rightPane.resizeFileTreeTitle": "Drag to resize file tree",
    "rightPane.emptyDesc":
      "No open tabs for this project yet. Manage Browser, Terminal, Markdown, Image, and Code tabs together in one strip.",
    "rightPane.newBrowserTabBtn": "New Browser Tab",
    "rightPane.newTerminalTabBtn": "New Terminal",
    "rightPane.openMarkdownBtn": "Open Markdown File",
    "rightPane.openFileTreeBtn": "Open File Tree",
    "rightPane.recentMarkdownHeader": "Recent Markdown ({name})",
    "rightPane.removeFromHistory": "Remove from history",
    "rightPane.dropMarkdown": "Drop Markdown files to open",
    "switcher.title": "Switch right-pane project: {name}",
    "switcher.listboxAria": "Switch project",
    "switcher.clearSearchAria": "Clear search",
    "switcher.openTabsSection": "Open Tabs",
    "switcher.allProjectsSection": "All Projects",

    // InAppBrowserPane
    "browser.back": "Back",
    "browser.forward": "Forward",
    "browser.stopLoading": "Stop loading",
    "browser.reload": "Reload",
    "browser.urlPlaceholder": "Enter localhost:3000 or URL...",
    "browser.devToolsTitle": "Toggle Chrome DevTools (⌘⌥I)",
    "browser.devToolsAria": "Toggle Chrome DevTools",
    "browser.openExternal": "Open in external browser",
    "browser.screenshotBtn": "Screenshot",
    "browser.screenshotTitle": "Attach page screenshot to chat (⌘⇧S)",
    "browser.screenshotAria": "Attach page screenshot to chat",
    "browser.pickerBtn": "Pick Element",
    "browser.pickerTitle": "Pick a page element to attach to chat (⌘⇧P)",
    "browser.pickerAria": "Element picker mode",
    "browser.attachUrlBtn": "Attach URL",
    "browser.attachUrlTitle": "Attach current browser URL to chat",
    "browser.attachUrlDisabledTitle": "Open a URL to attach it to chat",
    "browser.attachErrorsBtn": "Attach Errors",
    "browser.attachErrorsTitleWithCount": "Attach console/network errors ({count}) to chat",
    "browser.attachErrorsEmptyTitle": "Attach console/network errors to chat (no errors)",
    "browser.attachErrorsAria": "Attach console/network errors to chat",
    "browser.pickerBanner":
      "Element Picker: click any element on the page to attach its HTML/CSS and screenshot to chat (Esc to cancel)",
    "browser.pickerDone": "Done",
    "browser.emptyDesc":
      "Embedded Chromium with direct CDP automation. Agents can click, type, monitor console errors, and capture screenshots alongside full Chrome DevTools.",

    // MarkdownViewerPane & MarkdownView & Mermaid
    "markdown.openFileTitle": "Open file (⌘⌥O)",
    "markdown.pathPlaceholder": "Enter /path/to/README.md or file:// URL...",
    "markdown.renderedTitle": "Rendered preview",
    "markdown.rawTitle": "Code / Source editor",
    "markdown.tocTitle": "Heading outline ({count})",
    "markdown.noHeadingsTitle": "No headings",
    "markdown.autoReloadOnTitle": "Live auto-reload: ON (click to pause)",
    "markdown.autoReloadOffTitle": "Live auto-reload: OFF (click to resume)",
    "markdown.checkDiskTitle": "Check disk for changes",
    "markdown.manualReloadTitle": "Reload from disk",
    "markdown.attachFileTitle": "Attach this file to chat",
    "markdown.unsavedBadge": "Unsaved",
    "markdown.discardTitle": "Discard unsaved changes and reload from disk",
    "markdown.discardBtn": "Discard",
    "markdown.saveTitle": "Save (⌘S)",
    "markdown.savingBtn": "Saving...",
    "markdown.saveBtn": "Save",
    "markdown.linesCount": "{count} lines",
    "markdown.savedFeedback": "Saved",
    "markdown.reloadedFeedback": "Updated",
    "markdown.emptyDescBefore": "Preview and edit local ",
    "markdown.emptyDescAfter":
      " files with live auto-reload, heading outline, and source editing.",
    "markdown.recentFilesHeader": "Recently Opened",
    "markdown.externalDeleted":
      "This file was deleted on disk externally. Your unsaved edits are preserved (save to recreate).",
    "markdown.externalChanged":
      "This file changed on disk externally. Auto-reload was paused to protect your unsaved edits.",
    "markdown.dismissBanner": "Dismiss notification",
    "markdown.retrySave": "Retry Save",
    "markdown.editorHint": "⌘S to save · Tab to indent",
    "markdown.editorAria": "Markdown source editor for {fileName}",
    "markdown.openInViewerTitle": "Open in Markdown Viewer",
    "markdown.imageZoomTitle": "Click to enlarge in Image Viewer",
    "markdown.imageLoadFailed": "Failed to load image",
    "markdown.imageRenderFailed": "Failed to display image data.",
    "markdown.imageLoading": "Loading {name}...",
    "markdown.readFailed": "Failed to read file.",
    "markdown.saveFailed": "Failed to save file.",
    "markdown.reloadFailed": "Failed to reload file.",
    "mermaid.diagramTitle": "Show Mermaid diagram",
    "mermaid.codeTitle": "Show Mermaid source",
    "mermaid.renderFailed": "Failed to render Mermaid diagram",
    "mermaid.rendering": "Rendering Mermaid diagram...",

    // ImageViewerPane
    "image.fitTitle": "Fit to pane (0)",
    "image.actualSizeTitle": "Actual size 100% (1)",
    "image.zoomOutTitle": "Zoom out (-)",
    "image.zoomOutAria": "Zoom out",
    "image.zoomInTitle": "Zoom in (+)",
    "image.zoomInAria": "Zoom in",
    "image.bgGroupAria": "Background style",
    "image.bgChecker": "Grid",
    "image.bgDark": "Dark",
    "image.bgLight": "Light",
    "image.closeTabTitle": "Close this image tab",
    "image.copyPathAria": "Copy image path",
    "image.sourcePageTitle": "Open source page in browser: {url}",
    "image.sourcePageBtn": "Source",
    "image.emptyDesc":
      "Click any pasted image or attachment thumbnail in chat to zoom and inspect it here.",
    "image.loading": "Loading image...",
    "image.errorHeading": "Could not display image",
    "image.missingData": "Image data not found.",
    "image.clickActualSizeTitle": "Click to switch to actual size (100%)",
    "image.clickFitTitle": "Click to fit to pane (Fit)",
    "image.dblClickActualSizeTitle": "Double-click for actual size (100%) / Pinch to zoom",
    "image.dblClickFitTitle": "Double-click to fit pane / Scroll or drag to pan",

    // CodeViewerPane & ProjectFileTree
    "code.copyContent": "Copy content",
    "code.wrapOn": "Word wrap: ON",
    "code.wrapOff": "Word wrap: OFF",
    "code.wrapAria": "Toggle word wrap",
    "code.empty": "Select a file from the file tree to preview its contents here.",
    "code.loading": "Loading file...",
    "code.binaryTitle": "Binary files cannot be previewed",
    "code.tooLargeTitle": "File size exceeds preview limit",
    "code.readErrorTitle": "Could not read file",
    "fileTree.aria": "Project file tree",
    "fileTree.revealFolder": "Reveal folder in Finder",
    "fileTree.refresh": "Refresh file tree",
    "fileTree.selectProjectTitle": "Select a project",
    "fileTree.selectProjectDesc":
      "Currently in General scope. Pick a project from the header switcher to browse its file tree.",
    "fileTree.filterPlaceholder": "Filter by filename...",
    "fileTree.clearFilterAria": "Clear filter",
    "fileTree.noMatches": "No matching files",
    "fileTree.noFiles": "No files to display",
    "fileTree.emptyDir": "(empty)",
    "fileTree.loadDirError": "Failed to load directory.",

    // TerminalPane
    "terminal.defaultTitle": "Terminal",
    "terminal.statusStarting": "Starting...",
    "terminal.statusRunning": "Running",
    "terminal.statusExited": "Exited (code {code})",
    "terminal.statusExitedNoCode": "Exited",
    "terminal.statusError": "Error",
    "terminal.restartBtn": "Restart",
    "terminal.restartTitle": "Restart terminal",
    "terminal.clearTitle": "Clear terminal",
    "terminal.copyTitle": "Copy selection",
    "terminal.pasteTitle": "Paste from clipboard",
    "terminal.newTabTitle": "Open new terminal tab",
    "terminal.fallbackBanner": "Running in fallback mode ({backend})",
    "terminal.exitedNotice":
      "Process exited (code: {code}). Click Restart or press Enter to start a new shell.",
    "terminal.exitedNoticeNoCode":
      "Process exited. Click Restart or press Enter to start a new shell.",
    "terminal.startFailed": "Failed to start terminal.",
    "terminal.ariaLabel": "Interactive terminal: {title}",

    // Main-process TaskEvent & currentStep labels
    "taskEvent.completedReview": "Completed (Needs Review)",
    "taskEvent.completedReviewUnlanded": "Completed (Needs Review · Unlanded)",
    "taskEvent.failed": "Failed",
    "taskEvent.noOutput": "(no output)",
    "taskEvent.noChangesLabel": "(no changes)",
    "taskEvent.autoLandNoop": "✅ Auto-land completed: {target} (no changes · worktree cleaned up)",
    "taskEvent.autoLandResolved": "✅ Auto-land completed: {target} (conflict auto-resolved)",
    "taskEvent.autoLandSuccess": "✅ Auto-land completed: {target}",
    "taskEvent.autoLandFailed": "⚠️ Auto-land failed: {message}",
    "taskEvent.conflictLimitReached": "Auto conflict resolution limit reached",
    "taskEvent.conflictResolveFailed": "Auto conflict resolution failed",
    "taskEvent.autoResumeFailed": "Auto-resume failed",
    "taskEvent.autoResumedSession": "Auto-resumed after restart (session continued)",
    "taskEvent.autoResumedNew": "Auto-resumed after restart (new session)",
    "taskStep.completedReview": "Completed · Needs Review",
    "taskStep.completedNoChanges": "Completed · Needs Review (no changes)",
    "taskStep.completedLandedBranch": "Completed · Needs Review (Landed → {branch})",
    "taskStep.completedLanded": "Completed · Needs Review (Landed)",
    "taskStep.autoLanding": "Auto-landing changes...",
    "taskStep.autoLandError": "Completed · Auto-land error",
    "taskStep.interrupted": "Interrupted",
    "taskStep.failed": "Ended with error",

    // Voice Input & Readback (OS-standard STT & TTS)
    "voice.stopSpeaking": "Stop speaking",
    "voice.stopSpeakingTitle": "Stop voice readback",
    "voice.readbackOnTitle": "Voice Readback: ON (reads completed replies and task completion notices — click to turn OFF)",
    "voice.readbackOffTitle": "Voice Readback: OFF (click to enable automatic readback of completed replies and task notices)",
    "voice.readbackDisableAria": "Disable voice readback",
    "voice.readbackEnableAria": "Enable voice readback",
    "voice.listeningLabel": "Listening ({locale})",
    "voice.listeningHint": "Speak now... (Option+Space to stop / Esc to cancel)",
    "voice.dismissErrorAria": "Dismiss voice input error",
    "voice.autoSendShort": "Auto-send",
    "voice.autoSendOnTitle": "Auto-send on speech end: ON (hands-free send — click to turn OFF)",
    "voice.autoSendOffTitle": "Auto-send on speech end: OFF (click to auto-send immediately when speech ends)",
    "voice.micStopTitle": "Stop voice input (Option+Space / Alt+Space) — {locale}",
    "voice.micStartTitle": "Start voice input (Option+Space / Alt+Space) — {locale}",
    "voice.micStopAria": "Stop voice input",
    "voice.micStartAria": "Start voice input",
    "settings.voiceTitle": "Voice Input & Readback (OS-Standard · Free)",
    "settings.voiceDescBeforeKbd": "Use the composer mic button (or ",
    "settings.voiceDescBetweenKbdAndCode": ") for voice input, and OS-standard TTS (macOS ",
    "settings.voiceDescAfterCode": ") to automatically read aloud completed replies and task notices.",
    "settings.voiceReadbackTitle": "Voice Readback (Completed Replies & Task Notices)",
    "settings.voiceReadbackDescBeforeCode": "Automatically reads completed Conductor replies (stripped of code/URLs) and concise task completion notices (e.g., \"T48 completed\") using macOS ",
    "settings.voiceReadbackDescAfterCode": ".",
    "settings.voiceAutoSendTitle": "Auto-send on speech end",
    "settings.voiceAutoSendDesc": "When ON, sends the message immediately after speech recognition finishes (when OFF, lets you review and edit before sending).",

    // Remote Access & Android QR Setup
    "remote.title": "Remote Access / Tailscale Mobile Bridge",
    "remote.desc":
      "Control Conductor chat and tasks in real time from the Android app or mobile browser over Tailscale.",
    "remote.refreshTitle": "Redetect Tailscale network info",
    "remote.refreshBtn": "Redetect",
    "remote.toggleTitle": "Enable Remote Bridge Server",
    "remote.statusRunning": "Running · {count} SSE",
    "remote.statusError": "Error",
    "remote.statusStopped": "Stopped",
    "remote.toggleDescBeforeCode": "Listens on ",
    "remote.toggleDescAfterCode": " only while ON, requiring Bearer Token authentication on all API endpoints.",
    "remote.qrHeading": "Android Quick Setup (QR Code)",
    "remote.qrSubheading":
      "Install the Android app and pair it with this desktop in 2 quick steps.",
    "remote.step1Badge": "Step 1",
    "remote.step1Title": "Download Android App",
    "remote.step1Desc":
      "Scan with your phone camera to open GitHub Releases and install the latest APK.",
    "remote.step1QrAria": "QR code for downloading the Android APK",
    "remote.step1CopyUrl": "Copy URL",
    "remote.step2Badge": "Step 2",
    "remote.step2Title": "Link with Desktop (Pairing)",
    "remote.step2DescActive":
      "Scan using \"Scan QR to Link\" in the Android app or your system camera to auto-save the URL & token and connect immediately.",
    "remote.step2QrAria": "QR code for pairing with desktop Conductor",
    "remote.step2TailscaleWarning":
      "Tailscale IP not detected. Turn on Tailscale on both Mac and Android, then click Redetect.",
    "remote.step2TokenHint":
      "Contains your auth token — keep private when screen sharing. Click Regenerate to invalidate older QR codes.",
    "remote.step2DisabledDesc":
      "Enable the Remote Bridge server to generate a pairing QR code for your Android device.",
    "remote.step2EnableBtn": "Enable Remote Bridge & Show QR",
    "remote.portLabel": "Port (Default: 4789)",
    "remote.applyBtn": "Apply",
    "remote.tailscaleDetection": "Tailscale Detection",
    "remote.notDetected": "Not detected",
    "remote.urlLabel": "Connection URL (also works in Android Chrome)",
    "remote.copyBtn": "Copy",
    "remote.copiedBtn": "Copied",
    "remote.bearerTokenLabel": "Bearer Token",
    "remote.hideTokenAria": "Hide token",
    "remote.showTokenAria": "Show token",
    "remote.regenerateBtn": "Regenerate",
    "remote.connectUriLabel": "Android One-Paste Connect URI",
    "remote.copyUriBtn": "Copy URI",
  },
} as const satisfies Record<UiLocale, Record<string, string>>;

export type UiStringKey = keyof typeof UI_STRINGS.ja;

export function t(
  locale: UiLocale,
  key: UiStringKey,
  params?: Record<string, string | number>,
): string {
  const dict = UI_STRINGS[locale] ?? UI_STRINGS.ja;
  const template: string = dict[key] ?? UI_STRINGS.ja[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

export function formatTaskStatusLabel(status: AgentTaskStatus, locale: UiLocale = "ja"): string {
  switch (status) {
    case "queued":
      return t(locale, "taskStatus.queued");
    case "running":
      return t(locale, "taskStatus.running");
    case "needs_review":
      return t(locale, "taskStatus.needs_review");
    case "done":
      return t(locale, "taskStatus.done");
    case "failed":
      return t(locale, "taskStatus.failed");
  }
}

export function getFriendlyToolLabel(name: string, locale: UiLocale = "ja"): string {
  if (locale === "en") {
    switch (name) {
      case "list_projects":
        return "List projects";
      case "register_project":
        return "Register project";
      case "search_projects":
        return "Search projects";
      case "scan_directory_projects":
        return "Scan directory projects";
      case "list_tasks":
        return "List tasks";
      case "create_task":
        return "Create task";
      case "update_task":
        return "Update task";
      case "start_worker":
        return "Start worker";
      case "send_to_worker":
        return "Send to worker";
      case "stop_worker":
        return "Stop worker";
      case "get_task_detail":
        return "Get task detail";
      case "browser_open":
        return "Open browser";
      case "browser_snapshot":
        return "Browser snapshot";
      case "browser_click":
        return "Click browser element";
      case "browser_type":
        return "Type in browser";
      case "browser_press_key":
        return "Press browser key";
      case "browser_scroll":
        return "Scroll browser";
      case "browser_screenshot":
        return "Capture screenshot";
      case "browser_console_errors":
        return "Check console/network errors";
      default:
        return name;
    }
  }

  switch (name) {
    case "list_projects":
      return "プロジェクト一覧を確認";
    case "register_project":
      return "プロジェクトを登録";
    case "search_projects":
      return "プロジェクトを検索";
    case "scan_directory_projects":
      return "配下のプロジェクトを一括登録";
    case "list_tasks":
      return "タスク一覧を確認";
    case "create_task":
      return "タスクを作成";
    case "update_task":
      return "タスクを更新";
    case "start_worker":
      return "ワーカーを起動";
    case "send_to_worker":
      return "ワーカーへ追加指示";
    case "stop_worker":
      return "ワーカーを停止";
    case "get_task_detail":
      return "タスク詳細を取得";
    case "browser_open":
      return "ブラウザを開く";
    case "browser_snapshot":
      return "画面スナップショット取得";
    case "browser_click":
      return "ブラウザ要素をクリック";
    case "browser_type":
      return "ブラウザへ文字入力";
    case "browser_press_key":
      return "キー操作を送信";
    case "browser_scroll":
      return "ブラウザをスクロール";
    case "browser_screenshot":
      return "ブラウザ画面を撮影";
    case "browser_console_errors":
      return "コンソール/通信エラー確認";
    default:
      return name;
  }
}

export function getLocalizedLanguageOptionMeta(
  lang: PreferredLanguage,
  locale: UiLocale = "ja",
): { label: string; shortLabel: string; description: string } {
  if (locale === "en") {
    switch (lang) {
      case "ja":
        return {
          label: "日本語 (Japanese)",
          shortLabel: "日本語",
          description:
            "Display UI and write orchestrator replies, task titles/summaries, and worker completion reports in Japanese.",
        };
      case "en":
        return {
          label: "English",
          shortLabel: "English",
          description:
            "Display UI and write orchestrator replies, task titles/summaries, and worker completion reports in English.",
        };
      case "auto":
        return {
          label: "Auto",
          shortLabel: "Auto",
          description:
            "Detect UI locale from your system language and match the user's input language for chat replies and worker reports.",
        };
    }
  }

  switch (lang) {
    case "ja":
      return {
        label: "日本語",
        shortLabel: "日本語",
        description:
          "UI表示、オーケストレーターのチャット返信、タスクのタイトル・要約、ワーカーの完了レポートを常に日本語で出力します。",
      };
    case "en":
      return {
        label: "English",
        shortLabel: "English",
        description:
          "Always display UI and write Orchestrator chat replies, task titles/summaries, and worker completion reports in English.",
      };
    case "auto":
      return {
        label: "自動 (Auto)",
        shortLabel: "自動",
        description:
          "システム言語に応じて UI 表示を切り替え、ユーザーの入力言語に合わせてチャット返信・タスク名・ワーカー報告の言語を自動で切り替えます。",
      };
  }
}

export function getLocalizedIntegrationModeMeta(
  mode: IntegrationMode,
  locale: UiLocale = "ja",
): { label: string; shortLabel: string; badgeText: string; description: string } {
  if (locale === "en") {
    switch (mode) {
      case "feature-branch":
        return {
          label: "Feature Branch (Default)",
          shortLabel: "Feature Branch",
          badgeText: "Branch",
          description:
            "Creates a conductor/<slug> branch automatically when the parent repo is on main/master, rebasing subsequent tasks onto the same branch.",
        };
      case "per-task-pr":
        return {
          label: "Per-Task PR",
          shortLabel: "Per-Task PR",
          badgeText: "PR",
          description:
            "Keeps each task on its own branch without merging into the parent repo, letting you push and open a Pull Request.",
        };
      case "direct":
        return {
          label: "Direct",
          shortLabel: "Direct",
          badgeText: "Direct",
          description:
            "Rebases and lands changes directly onto the active parent branch (including main/master) and removes the worktree after landing.",
        };
    }
  }

  switch (mode) {
    case "feature-branch":
      return {
        label: "Feature Branch（既定）",
        shortLabel: "Feature Branch",
        badgeText: "Branch",
        description:
          "親リポジトリが main / master の場合は自動で conductor/<slug> ブランチを作成し、後続タスクも同じブランチへリベースして順次統合します。",
      };
    case "per-task-pr":
      return {
        label: "Per-Task PR",
        shortLabel: "Per-Task PR",
        badgeText: "PR",
        description:
          "親リポジトリへマージせずタスク専用ブランチを保持し、リモートへの Push や PR 作成を行います。",
      };
    case "direct":
      return {
        label: "Direct",
        shortLabel: "Direct",
        badgeText: "Direct",
        description:
          "main / master を含む現在の親ブランチへ直接リベース＆取り込みを行い、完了後に Worktree を削除します。",
      };
  }
}
