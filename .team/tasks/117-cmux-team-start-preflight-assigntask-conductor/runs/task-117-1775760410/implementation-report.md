# 実装レポート: task-117

## 概要

plan.md v2 および design-review.md v2 の指示に従って、`cmux-team start` の preflight チェック追加と `assignTask` エラー影響分離を実装した。TDD で進め、`bun test` は全て green。

## 変更したファイル

### 修正

1. **`skills/cmux-team/manager/main.ts`**
   - import 文に `import { runPreflight, printPreflightIssues } from "./preflight";` を追加
   - `cmdStart()` 内、cmux 環境チェック直後・`createDaemon` 呼び出し前に preflight 実行を挿入
   - preflight 失敗時は `printPreflightIssues` で出力してから `process.exit(1)`

2. **`skills/cmux-team/manager/conductor.ts`**
   - `AssignTaskError` クラスと `AssignFailureKind` 型を新規追加・export
     - `cause` は TypeScript `override` 問題を避けるため明示的にフィールドとして保持
   - `assignTask` の戻り値型を `Promise<ConductorState | null>` → `Promise<ConductorState>` に変更
   - 失敗点ごとに `throw new AssignTaskError(kind, reason)`:
     - タスクディレクトリ readdir 失敗 → `task`
     - タスクファイル不在 → `task`
     - `git worktree add` 失敗 → `task`
     - プロンプト生成失敗 → `task`
     - `cmux.send` / `sendKey` 失敗 → `conductor`
   - `cmux.renameTab` を個別 `try/catch` で包み、失敗は `log("error", ...)` のみ（catch-all に流れて task abort されないようにする）
   - 関数末尾の catch-all: `AssignTaskError` は re-throw、それ以外は `AssignTaskError("task", ...)` でラップ（保守的に task 側に寄せて Conductor を守る）
   - **worktree 作成後の cleanup**: `worktreeCreated` フラグで追跡し、catch 句で `git worktree remove --force` + `git branch -D` を実行（Design Review v2 追加指摘 #1 対応、ブランチ名衝突の悪循環を防ぐ）
   - `spawnConductor` 内の `assignTask` 呼び出しを `try/catch` でラップし、`AssignTaskError` は kind/reason を log して `null` を返す（既存仕様を維持）

3. **`skills/cmux-team/manager/daemon.ts`**
   - `AssignTaskError` を `./conductor` から import
   - `scanTasks` を `export async function` に変更（テストから直接呼び出せるように）
   - `scanTasks` 内の `assignTask` 呼び出しを `try/catch` に置き換え:
     - `e.kind === "task"` → タスクを `aborted` にして Conductor は idle のまま、`continue`
     - `e.kind === "conductor"` → Conductor を `disconnected` に、`continue`
     - `AssignTaskError` 以外の想定外例外（defensive） → Conductor を落として `continue`
   - ログフォーマットは既存 `task_aborted` と完全一致: `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}`（dashboard.tsx:277-282 のパーサ互換）
   - `updated` 変数は `let updated: ConductorState;` として宣言（Design Review v2 追加指摘 #2 対応、`| null` 型を外した）

### 新規追加

4. **`skills/cmux-team/manager/preflight.ts`** (新規)
   - `runPreflight(projectRoot)`: git リポジトリ / claude / bun / 書き込み可否を検証
   - 各検証は try/catch で失敗を issue として積み、途中で throw しない（全検証を必ず走り切る）
   - `claude` / `bun` の検出には `Bun.which()` を使用（外部プロセス起動不要）
   - 書き込みテストは `projectRoot` 直下の `.cmux-team-preflight-test` に write → unlink で実施。**`.team/` は一切触らない**（`initInfra` との責務分離）
   - `printPreflightIssues(result)`: `console.error` に整形出力（ok=true 時は何もしない）

5. **`skills/cmux-team/manager/preflight.test.ts`** (新規)
   - 9 テストケース:
     - git リポジトリ内で `not_git_repo` が含まれない
     - 非 git ディレクトリで `not_git_repo` が含まれる
     - 複数項目同時失敗（非 git + 書き込み不可）が throw せず全 issue が積まれる
     - preflight 単独では `.team/` を作成しない
     - `.cmux-team-preflight-test` が残らない
     - 書き込み不可ディレクトリで `team_dir_not_writable` が含まれる（root では skip）
     - 全て成功していれば `not_git_repo` / `team_dir_not_writable` が含まれない
     - `printPreflightIssues` ok=true なら何も出力しない
     - `printPreflightIssues` ok=false で `console.error` に整形出力

6. **`skills/cmux-team/manager/conductor.test.ts`** (新規)
   - 3 テストケース（cmux モジュール mock 不要のルートのみ検証）:
     - タスクファイル不在 → `task` kind、Conductor は idle のまま
     - git 未初期化 → `worktree add` 失敗で `task` kind、Conductor は idle のまま
     - タスクファイル不在ケースで worktree を作成しない

7. **`skills/cmux-team/manager/daemon.test.ts`** (拡張)
   - `scanTasks` 統合テスト 2 件を追加:
     - git 未初期化で assignTask 失敗時、タスクは `aborted` / Conductor は `idle` のまま維持
     - idle Conductor 不在時は何も変更しない（throttled）

## テスト結果

```
bun test v1.3.11 (af24e281)
 62 pass
 0 fail
 138 expect() calls
Ran 62 tests across 6 files. [663.00ms]
```

全 62 テスト green（既存 51 + 新規 11）。

### 型チェック

```
bunx tsc --noEmit
```

`dashboard.tsx` の既存エラー (WidgetVariant 型不整合) を除き、`preflight.ts`, `conductor.ts`, `daemon.ts` およびテストファイルは全て型チェックをパス。既存エラーは本タスクのスコープ外。

## 想定外に対処した点

1. **`AssignTaskError.cause` の TypeScript override エラー**
   - 最初は constructor parameter properties で `public readonly cause?: unknown` を書いたが、TS4115 (ES2022 の `Error.cause` との override) エラーが発生
   - 対応: コンストラクタ内で `(this as any).cause = cause` とすることで回避

2. **`Bun.which` の PATH 依存性**
   - plan では「`process.env.PATH = ""` で `claude_not_found` を再現できる」と記載されていたが、実環境では `Bun.which` が PATH 空でも claude を解決してしまった
   - 対応: 「複数項目同時失敗」テストケースを `claude/bun 不在` ではなく `非 git + 書き込み不可` の組み合わせに変更。claude/bun 検出のテストは CI 環境依存のためスキップ方針（plan 通り）

3. **`daemon.test.ts` の `createTask` helper が task-state.json を ready で書き込む挙動**
   - `scanTasks` のタスク abort テストで、task-state.json の `status` が `ready` の状態で `scanTasks` が走ることを確認する必要があった
   - helper は期待通り動作していたためそのまま使用

## Design Review v2 追加指摘への対応

1. ✅ **worktree 作成後の cleanup** — `worktreeCreated` フラグを導入し catch 句で `git worktree remove --force` + `git branch -D` を実行
2. ✅ **`updated` 変数の型宣言** — `let updated: ConductorState;` に変更、`| null` を外した
3. ⭕ **`task.ts` の `markTaskAborted` helper 新設** — optional だったため今回は見送り（既存 `main.ts:1543, 1595` と同一のインライン形式を維持、将来的なリファクタ余地として残す）
4. ✅ **`preflight.test.ts` の `team_dir_not_writable` テストで root skip** — `if (process.getuid?.() === 0) return;` を追加

## 完了条件チェックリスト

- [x] `preflight.ts`, `preflight.test.ts` が追加されている
- [x] `main.ts` に preflight 呼び出しが追加されている
- [x] `conductor.ts` に `AssignTaskError` クラス + throw 化実装
- [x] `conductor.test.ts` が追加されている
- [x] `daemon.ts` で `scanTasks` が export され、assignTask 呼び出しが try/catch 分岐に
- [x] `cd skills/cmux-team/manager && bun test` が全てグリーン（62/62）
- [x] 新規追加ファイル含めて `bunx tsc --noEmit` が通る（既存 dashboard.tsx エラーを除く）
- [x] `cmux.renameTab` が個別 try/catch で包まれている
- [x] worktree 作成後の失敗で cleanup 処理が走る
- [x] `task_aborted` ログフォーマットが既存形式と一致（dashboard パーサ互換）
