# Design Review: await-task CLI

## 判定: Approved (with minor changes)

## 良い点

- **既存パターンとの完全な一致**: `cmdAwaitTask()` の構造（`hasHelpFlag()` → `requireArg()` → `getArg()` → `loadTaskState()` → `findTaskFile()`）は `cmdCloseTask()` / `cmdAbortTask()` と完全に同じパターンで、コードベースの一貫性が保たれている
- **fs.watch の選択が適切**: daemon の `initFileWatcher()` が既に `fs.watch` を使用しており（`daemon.ts:164`）、プロジェクト内で実績のある技術選択。callback 型と async iterator 型の違いも正しく説明されている
- **saveTaskState のアトミック書き込みへの理解**: `task.ts:108-112` で write→rename パターンが使われており、fs.watch が確実にトリガーされることを正しく把握している
- **エッジケースの網羅**: 初回チェック（既に closed/aborted）→ fs.watch 監視のフローにより、race condition を回避できている
- **JSON パースエラーのハンドリング**: watcher callback 内の `catch {}` は、アトミック書き込み中の一時ファイル状態を正しく考慮している
- **printSummaries のフォールバック設計**: summary.md → journal → メッセージの3段フォールバックが丁寧
- **テスト計画が具体的**: 基本動作、即時完了、abort、タイムアウト、複数タスクの5パターンが網羅されている
- **設計判断セクションが明確**: 代替案とその棄却理由が6点すべて記載されており、実装者が迷わない

## 指摘事項

### [Minor] i18n.ts のファイル名は正しい（指摘なし）

- **確認結果**: `skills/cmux-team/manager/i18n.ts` は実在する（`Glob` で確認済み）。`main.ts:28` で `import { t } from "./i18n"` としてインポートされている。plan.md の i18n.ts への追記指示は正しい。

### [Minor] findTaskFile は既存関数（新規作成不要）

- **確認結果**: `findTaskFile()` は `main.ts:136` に既に存在する。タスク ID からファイル名検索 → frontmatter の id フィールド検索の2段階で動作する。plan.md の `printSummaries()` 内での使用は問題ない。

### [Minor] SKILL.md のセクション番号の衝突

- **問題**: plan.md では新セクションを「## 4. タスク完了待ち（await-task）」としているが、現在の SKILL.md は `## 0. アーキテクチャ概要` → `## 1. コマンド一覧` → `## 2. トレーサビリティ` → `## 3. cmux 操作リファレンス` の構成。「## 4.」は既存構造的には自然な番号だが、セクション3の直後にこのセクションを追加すると CLI 操作リファレンスの後にコマンド詳細が来る形になり、セクション1（コマンド一覧）の近くに置いた方が情報設計として良い。
- **推奨**: セクション番号は「## 4.」のままで問題ないが、配置がセクション3の直後であることを明確にすること。あるいはセクション1のコマンド一覧テーブルの後に追記する方がユーザー視点で自然。実装者の判断に委ねる。

### [Minor] cmux-agent-role/SKILL.md のセクション番号 7.5 の妥当性

- **問題**: plan.md では `## 7.5. タスク完了待ち` としているが、既存は `## 7. daemon ステータス取得` → `## 8. トレース検索` の整数番号。7.5 は小数点番号で既存パターンと異なる。
- **推奨**: `## 7.5.` ではなく、セクション7の末尾に追記するか、既存の番号をリナンバリングして `## 8. タスク完了待ち` にし、以降を繰り下げる方が整合性がある。ただし番号変更は他文書からの参照に影響する可能性があるため、セクション7の末尾に追記がシンプル。

### [Minor] `process.exit()` による watcher リーク

- **問題**: `cmdAwaitTask()` 内で `process.exit(0)` / `process.exit(1)` を直接呼んでいる箇所が複数あるが、watcher callback 内の `process.exit()` は問題ない（プロセス終了時に watcher は自動クリーンアップされる）。ただし、`timer` の `clearTimeout` と `watcher.close()` を呼んでから `process.exit()` しているのは良い作法。
- **確認結果**: 既存の `cmdCloseTask()` や `cmdAbortTask()` も同様に `process.exit()` を直接呼んでおり、パターンとして一貫している。問題なし。

### [Minor] `watch` の dynamic import

- **問題**: plan.md では `const { watch } = await import("fs")` としているが、main.ts 冒頭で既に `import { existsSync, writeFileSync, mkdirSync } from "fs"` がある（`main.ts:25`）。dynamic import ではなく、既存の static import に `watch` を追加する方がシンプル。
- **推奨**: `main.ts:25` の `import { existsSync, writeFileSync, mkdirSync } from "fs"` に `watch` を追加する:
  ```typescript
  import { existsSync, writeFileSync, mkdirSync, watch } from "fs";
  ```

### [Minor] `readFile`, `readdir`, `existsSync`, `dirname`, `join` のインポート確認

- **確認結果**: すべて既にインポート済み:
  - `readFile`, `readdir`: `main.ts:27` (`from "fs/promises"`)
  - `existsSync`: `main.ts:25` (`from "fs"`)
  - `dirname`: `main.ts:24` (`from "path"`)
  - `join`: `main.ts:24` (`from "path"`)
  - `stat`: `main.ts:27` (`from "fs/promises"`) — `printSummaries` 内では不要だが念のため確認

  plan.md の `printSummaries()` で使用するすべての関数はインポート済み。`watch` のみ追加が必要。

## 総評

全体として非常に良質な実装計画。既存コードベースのパターン（ヘルパー関数、エラーハンドリング、i18n）を正確に踏襲しており、実装者がほぼそのまま写経できるレベルの具体性がある。技術選択（fs.watch callback 型、task-state.json 単一ファイル監視、カンマ区切り複数 ID）はいずれも妥当で、設計判断の根拠も明確。

修正が必要なのは minor な点のみ:
1. `watch` の import を dynamic ではなく static に変更
2. cmux-agent-role/SKILL.md のセクション番号 7.5 → セクション7末尾への追記に変更

いずれも実装時に自然に対応できるレベルの指摘であり、計画自体の方向性・技術選択に問題はない。
