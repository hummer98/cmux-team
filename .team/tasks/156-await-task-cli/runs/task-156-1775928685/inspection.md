# Inspection: await-task CLI

## 判定: GO

## 検品結果

### 実装の完全性

- [x] Step 1: `cmdAwaitTask()` 関数 — `cmdCloseTask()` の直後に追加。plan.md のコードとほぼ同一。
- [x] Step 2: switch 文 case 追加 — `close-task` の直後に `await-task` case を追加。
- [x] Step 3: i18n.ts ヘルプテキスト — en/ja 両方に `help_await_task` を追加。内容は plan.md と一致。
- [x] Step 4: help_main 追記 — en/ja 両方の `help_main` に `await-task` 行を追加。`close-task` の直後に配置。
- [x] Step 5: SKILL.md 更新 — cmux-team/SKILL.md にコマンド一覧行 + セクション4を追加。cmux-agent-role/SKILL.md にセクション7のサブセクションとして追記。
- [x] Step 6: ヘッダーコメント更新 — main.ts 冒頭の Usage コメントに `await-task` 行を追加。

変更ファイル一覧（5ファイル）が plan.md の記載と一致（conductor-role.md は plan で「任意」のため変更なしで問題なし）。

### コード品質

- [x] `cmdAwaitTask()` のパターンが `cmdCloseTask()` / `cmdAbortTask()` と一致（`hasHelpFlag()` → `requireArg()` → `getArg()` → `loadTaskState()` フロー）
- [x] `fs.watch` は callback 型を使用。static import で `watch` を追加（Design Review 指摘反映済み）
- [x] タイムアウト処理: `setTimeout` + `AbortController` でクリーンに実装。`clearTimeout` + `watcher.close()` の後に `process.exit()` を呼ぶ作法。
- [x] `printSummaries()` のフォールバックチェーン: summary.md → journal → "no summary available" メッセージの3段。plan.md と一致。
- [x] 空の `catch {}` は watcher callback 内の JSON パースエラー対応のみ。plan.md で設計意図が説明済みでロギングポリシーの「冪等な後処理」例外に該当。
- [x] Design Review 指摘: static import — 反映済み（`import { ..., watch } from "fs"`）
- [x] Design Review 指摘: セクション番号 — cmux-agent-role/SKILL.md で `## 7.5` ではなく `### タスク完了待ち`（セクション7のサブセクション）として追記。適切。

### 動作テスト

- [x] ヘルプ表示: `bun main.ts await-task --help` → 日本語ヘルプが正しく表示される
- [x] 存在しないタスク ID: `bun main.ts await-task --task-id 99999` → `Error: task 99999 not found in task-state.json` + exit 1
- [x] 型チェック: `bunx tsc --noEmit` — `main.ts(386,42)` のエラーは既存（main branch でも `main.ts(385,42)` で同一エラー発生）。**新規コードによるリグレッションなし。**

### スキル文書

- [x] cmux-team/SKILL.md: コマンド一覧テーブル行 + セクション4「タスク完了待ち（await-task）」追加。Markdown 書式正常。コードブロック・テーブル・見出しの構造が既存セクションと一貫。
- [x] cmux-agent-role/SKILL.md: セクション7の末尾に `### タスク完了待ち` サブセクション追加。セクション8との間に適切に配置。Markdown 書式正常。

## 指摘事項

なし。

## 総評

plan.md の全6ステップが忠実に実装されている。Design Review の2つの minor 指摘（static import、セクション番号）も両方とも反映済み。コードは既存パターンに完全に準拠しており、動作テスト3項目もすべてパス。新規の型エラーは発生していない。スキル文書の Markdown 書式も正常。

実装品質は高く、追加の修正なしで GO と判定する。
