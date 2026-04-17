# T243 実装レポート — trace DB `task_sessions` に `base_branch` / `base_sha` / `base_source` 列を追加

- taskRunId: `task-243-1776424220`
- 担当 role: implementer
- 実装日: 2026-04-17
- 計画書: `plan.md`（同 dir）
- Design Review 修正: `design-review.md`（同 dir）

---

## Completed Tasks

| 番号 | タスク名 | 完了 |
|------|---------|------|
| T243-0 | T242 取り込み（`git merge main` で fast-forward） | ✅ |
| T243-1 | trace-store.ts SCHEMA 拡張 + `ensureTaskSessionsColumns` マイグレーション | ✅ |
| T243-2 | `TaskSessionRecord` に optional の `base_branch` / `base_sha` / `base_source` 追加 | ✅ |
| T243-3 | `insertTaskSession` の INSERT 文に 3 列を追加（バインドも追加） | ✅ |
| T243-4 | `conductor.ts` で worktree 作成直後に `git rev-parse HEAD`（cwd=worktreePath, timeout=30s）を呼んで `baseSha` を取得し、`insertTaskSession` に 3 フィールド渡し。`worktree_created` ログにも `sha=<short>` を追加 | ✅ |
| T243-5 | `trace-store.test.ts` に新規 describe `task_sessions base columns (T243)` を追加（3 ケース） | ✅ |
| T243-6 | `conductor.test.ts` に新規 describe `assignTask: base_* persistence (T243)` を追加（1 ケース、結合レベル） | ✅ |
| T243-7 | `cmdTraceTask` 出力ヘッダに `Base: <label> @<short-sha> (source=<source>)` 1 行を追加（旧データは `Base: -`） | ✅ |
| T243-8 | `docs/spec/01-skill-cmux-team.md` のトレーサビリティ章に base 列一覧と出力例を追記 | ✅ |
| T243-9 | `CLAUDE.md` の「トレーサビリティ（v3.4.0）」に base 列の説明を追記し、古い `cmux-team trace --task` 表記を `trace-task` に修正 | ✅ |
| T243-10 | `CHANGELOG.md` の `Unreleased` に `Added` セクションで T243 エントリを追記 | ✅ |
| T243-11 | `skills/trace-task/SKILL.md` の出力例に `Base:` 行を追加し、分析観点に worktree base の項目を追加 | ✅ |

---

## Files Changed

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/trace-store.ts` | (a) `WorktreeBaseSource` を type-only import / (b) `TaskSessionRecord` に optional の `base_branch` / `base_sha` / `base_source` 追加 / (c) `SCHEMA` の `task_sessions` CREATE 文末尾に 3 列追加（新規 DB 用） / (d) `ensureTaskSessionsColumns(db)` 関数を新規追加し `initDB` で呼出（`PRAGMA table_info` → 欠損列のみ `ALTER TABLE ADD COLUMN`、冪等、`console.warn("[trace-store] task_sessions_migrated col=...")` で記録） / (e) `insertTaskSession` の INSERT 文と bind に 3 列を追加 |
| `skills/cmux-team/manager/conductor.ts` | (a) worktree 作成直後に `execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath, timeout: 30000 })` を呼んで 40 hex を取得（失敗時は null + `log("error", ...)`、形式不正も同様）/ (b) `worktree_created` ログに `sha=<shortSha>` 追加 / (c) 既存 `insertTaskSession` 呼び出しに `base_branch=baseResolution.baseLabel` / `base_sha=baseSha` / `base_source=baseResolution.source` を追加 |
| `skills/cmux-team/manager/main.ts` | `cmdTraceTask` のヘッダブロックに `Base: <label> @<short-sha> (source=<source>)` 1 行追加（`event=assigned` + `role=conductor` 行から拾う、無ければ `Base: -`）。`console.log()` の空行位置を Sessions 取得後・Base 行の後に移動 |
| `skills/cmux-team/manager/trace-store.test.ts` | (a) import に `mkdir`、`Database` を追加、`insertTaskSession` / `getTaskSessions` を追加 / (b) 新規 describe で 3 テスト追加: 新規 DB の書き込み・読み出し、未指定時 NULL、旧スキーマ DB → `initDB` 再呼び出しで ALTER 3 列追加 + 冪等 + 旧行 NULL 維持 |
| `skills/cmux-team/manager/conductor.test.ts` | 新規 describe `assignTask: base_* persistence (T243)` で 1 テスト: 実 git init で local main 作成 → `assignTask` → trace DB から `event=assigned` 行を読み出し `base_branch="main"` / `base_source="config-local"` / `base_sha=40hex` / `base_sha === git rev-parse HEAD` を検証 |
| `docs/spec/01-skill-cmux-team.md` | トレーサビリティ章に出力例（Base 行含む）と `task_sessions` 主要列の表を追加（base 列の意味とマイグレーション挙動を明記） |
| `CLAUDE.md` | 「トレーサビリティ（v3.4.0）」セクションの `検索` 行を `cmux-team trace-task <id>` に統一、新規 `base 列（T243）` 行で event=assigned 行のみに base 情報が記録されること・旧データは NULL であることを明記 |
| `CHANGELOG.md` | Unreleased に Added セクションを追加し T243 エントリを記述（DB スキーマ拡張・マイグレーション戦略・CLI 出力拡張を網羅） |
| `skills/trace-task/SKILL.md` | 出力例に Base 行を追加、Base 行のフォーマット説明を追記、分析観点に「worktree base」の項目を追加 |

合計: コード 4 ファイル、テスト 2 ファイル、ドキュメント 4 ファイル変更。新規ファイル 0、削除ファイル 0。

---

## TDD Cycles / Verification Results

### Cycle 1: trace-store.ts スキーマ拡張 + INSERT 拡張（T243-1, T243-2, T243-3, T243-5）

| Phase | 内容 | 結果 |
|-------|------|------|
| RED | trace-store.test.ts の新 describe で `insertTaskSession` の 3 列、未指定 NULL、旧スキーマ → ALTER の 3 ケースを追加。実装前に走らせれば落ちるはず（コンパイル時点で型エラー） | 実装と並行のためスキップ（コードレビューで意図確認） |
| GREEN | trace-store.ts に `WorktreeBaseSource` import、`TaskSessionRecord` 拡張、SCHEMA 末尾に 3 列、`ensureTaskSessionsColumns` 関数追加、`insertTaskSession` の INSERT・bind 拡張を実施 | `bun test trace-store.test.ts` → 11 pass / 0 fail / 54 expect |
| REFACTOR | 旧スキーマテストで `await rm(oldDir)` を try/finally で確実にクリーンアップ。`migratedDb.close()` も outer try-finally で保護 | 同 |
| VERIFY | `bunx tsc --noEmit` → exit 0 | ✅ |

migration ログは `[trace-store] task_sessions_migrated col=base_branch` 等が 3 行出力されることをテストランナーの stdout で確認済み。

### Cycle 2: conductor.ts の base_sha 取得 + 結合テスト（T243-4, T243-6）

| Phase | 内容 | 結果 |
|-------|------|------|
| RED | conductor.test.ts に新 describe で実 git init→assignTask→trace DB 読み出しで `base_branch=main` / `base_source=config-local` / `base_sha=40hex` を検証する結合テストを追加 | 実装前に走らせると `base_branch` が undefined → 落ちる想定 |
| GREEN | conductor.ts に rev-parse HEAD 呼び出し（cwd=worktreePath, timeout=30s, 40hex 形式チェック）、worktree_created ログに sha 追加、insertTaskSession に 3 フィールド渡しを実装 | `bun test conductor.test.ts` → 11 pass / 0 fail / 48 expect |
| REFACTOR | 形式不正時のログを 64 文字 truncate にして異常な値が長文ログに紛れ込むのを防止 | 同 |
| VERIFY | `bunx tsc --noEmit` → exit 0 | ✅ |

実テストでは `git rev-parse HEAD`（main の 40 hex）と worktree 内の `git rev-parse HEAD` が一致することを `expect(row.base_sha).toBe(expectedSha)` で確認した。これで `git worktree add -b X <start-point>` が start-point に HEAD を揃えるという plan D1 の前提が結合レベルで実証された。

### Cycle 3: cmdTraceTask 出力拡張（T243-7）

CLI 出力なので unit テストは追加せず、実 DB を使った smoke check を行った（次節の Final Verification 参照）。

---

## Issues Encountered

1. **T242 取り込みの merge 元**: plan は `git merge origin/main` を指示していたが、本 worktree fetch 時点で T242（commit `3d001f5` / merge `7fb1116`）はまだ origin/main に push されていなかった（origin/main は `4ca412b`）。一方 local `main` ブランチには T242 が既にマージ済みだったため、`git merge main` で fast-forward した。worktree branch は origin/main から 4 commits ahead になるが、T243 commit 時に `task-243-1776424220/task` ブランチに含まれるべき差分は T242 + T243 のみで、追加の commit はない。
2. **CLI smoke 時の cwd**: 当初 worktree dir で `cmux-team trace-task` を実行したところ `.team/traces/` 不在でエラー。これは worktree 構造上 `.team` がプロジェクトルート側にしか存在しないため正常。`cd /Users/yamamoto/git/cmux-team` + 明示的に worktree 内 `main.ts` を `bun run` する形でプロジェクトルートの DB を対象にして smoke 確認した。
3. **Migration の冪等性確認**: 旧スキーマ DB を作って 1 回目 `initDB` で ALTER 走らせた後、明示的に再 `initDB` を呼んで 2 回目では ALTER がスキップ（PRAGMA で全列存在判定）されることをテスト 3 で確認。これにより daemon 再起動時に毎回 ALTER がやり直されることはない。

---

## Final Verification

### `bunx tsc --noEmit`

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
$ echo $?
0
```

→ **exit 0、型エラー 0 件**。

### `bun test`

```
475 pass
0 fail
1066 expect() calls
Ran 475 tests across 22 files. [19.65s]
```

T242 取り込み直後（マージ後）の baseline は 471 tests。T243 で:
- `trace-store.test.ts` に 3 ケース追加（11 → 11、`task_sessions base columns (T243)` describe で 3 ケース）
- `conductor.test.ts` に 1 ケース追加（10 → 11、`assignTask: base_* persistence (T243)` describe で 1 ケース）

合計 +4 ケース → 475 tests。**全 pass / 0 fail**。

### CLI 動作確認: `cmux-team trace-task <id>`

```
$ cd /Users/yamamoto/git/cmux-team && PROJECT_ROOT=/Users/yamamoto/git/cmux-team \
    bun run /Users/yamamoto/git/cmux-team/.worktrees/task-243-1776424220/skills/cmux-team/manager/main.ts \
    trace-task 243

Task T243: trace DB の task_sessions に base_branch と base_sha を記録する
Run: task-243-1776424220
Worktree: .worktrees/task-243-1776424220
[trace-store] task_sessions_migrated col=base_branch
[trace-store] task_sessions_migrated col=base_sha
[trace-store] task_sessions_migrated col=base_source
Base: -

Sessions:
  conductor    e8e3bb36  surface:45    -           -
  planner      --------  surface:80    -           -
  design-reviewer --------  surface:82    -           -
  impl         --------  surface:84    -           -
```

確認できた点:
- **マイグレーション**: 既存プロジェクトの `traces.db` に対して初回 `initDB` で 3 列が ALTER 経由で追加された（warn が 3 行出力）
- **旧データ表示**: T243 conductor セッションは T243-4 実装前に assigned されていたため、`base_*` 列は NULL → `Base: -` が正しく表示される
- **既存表示**: Task / Run / Worktree / Sessions の表示は従来通り維持され表示崩れなし

### 補助確認: スキーマ確認

```
$ sqlite3 .team/traces/traces.db "PRAGMA table_info(task_sessions);"
0|id|INTEGER|0||1
1|timestamp|TEXT|1||0
...
8|event|TEXT|1||0
9|base_branch|TEXT|0||0
10|base_sha|TEXT|0||0
11|base_source|TEXT|0||0
```

→ 既存 DB に対して `base_branch` / `base_sha` / `base_source` 3 列が ALTER で正しく追加されている。NOT NULL 制約なし、TEXT 型、デフォルト値なし（plan D2/D3 通り）。

---

## まとめ

T243-0〜T243-11 を全て完了。`task_sessions` テーブルに base 情報（`base_branch` / `base_sha` / `base_source`）が `event=assigned` 行のみで記録されるようになり、worktree が削除された後でも事後診断ができるようになった。新規 DB はフル定義で CREATE され、既存 DB は冪等な ALTER マイグレーションで列追加される。CLI `cmux-team trace-task` ヘッダにも Base 行が追加され、可視化された。

回帰なし: tsc 0 件、bun test 475 pass / 0 fail、既存 CLI 出力崩れなし。
