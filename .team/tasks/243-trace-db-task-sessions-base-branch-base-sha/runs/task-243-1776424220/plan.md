# T243 plan — trace DB `task_sessions` に base_branch / base_sha / base_source を記録

- taskRunId: `task-243-1776424220`
- 担当 role: planner
- 作成日: 2026-04-17
- 関連タスク: T242（依存、closed）
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-243-1776424220`

---

## 0. 前提注意（重要）

T243 worktree は T242 が main にマージされる前（merge commit `7fb1116`）の HEAD から切られている。

```
main HEAD  : 7fb1116 Merge T242
T242 commit: 3d001f5 feat(conductor): worktree の base を origin/<mainBranch> から解決
T243 worktree base: 4ca412b (T242 より前)
```

そのため **本 worktree には `skills/cmux-team/manager/worktree-base.ts` が存在しない**。実装タスクを始める前に `git merge origin/main`（または rebase）で T242 を取り込む必要がある。取り込み後、以下のファイル群が本 worktree に揃う:

- `skills/cmux-team/manager/worktree-base.ts` （`resolveWorktreeBase` 純関数）
- `skills/cmux-team/manager/worktree-base.test.ts`
- `schema.ts` の `WorktreeBaseSource` / `WorktreeBaseResolution`
- `conductor.ts` assignTask が `resolveWorktreeBase` 経由の実装になっている
- `worktree_created branch=<b> base=<label> source=<kind> path=<p>` ログ

---

## 1. 課題分析

### 現状の問題点

1. `task_sessions` テーブルに **`worktree_path` は記録されるが base branch / base SHA は記録されない**。
2. そのため PR 事故（Dear / T165 の 14 タスク混入）のような事後診断では、`git log` で親チェーンを辿って分岐点を推定する必要があり、worktree ブランチ / commit が削除された後は追跡不能になる。
3. T242 でログには `base=<label> source=<kind>` が出るようになったが、**DB 側には未保存**。CLI（`cmux-team trace-task`）から事後参照できない。

### 根本原因

- `insertTaskSession` のレコード定義（`TaskSessionRecord`）が worktree 作成時点の base 情報を持っていない。
- `conductor.ts` の assign 経路は `resolveWorktreeBase()` の結果（`baseLabel`, `source`）を DB に渡さずログだけに流している。
- worktree 作成後の HEAD（親 commit）の SHA を取得するコードが存在しない。

### 影響範囲

- `skills/cmux-team/manager/trace-store.ts`: スキーマ、`TaskSessionRecord`、`insertTaskSession` 3 箇所。
- `skills/cmux-team/manager/conductor.ts`: assignTask の `insertTaskSession` 呼び出し箇所、および直前で `git rev-parse HEAD` を呼ぶ処理の追加。
- 既存 DB は `ALTER TABLE` で破壊せず拡張する必要がある（`CREATE TABLE IF NOT EXISTS` はカラム追加を反映しない）。
- `skills/cmux-team/manager/main.ts` の `cmdTraceTask` は現状 base 情報を表示しないが、新カラムを拾うよう拡張すると価値が増す（任意）。
- docs: `docs/spec/01-skill-cmux-team.md`（トレーサビリティ）、`CLAUDE.md`（同セクション）、`CHANGELOG.md`、`skills/trace-task/SKILL.md`（出力例）。

---

## 2. 技術アプローチ

### 選択したアプローチ

1. **スキーマ拡張** は `CREATE TABLE IF NOT EXISTS` に加えて、`initDB()` 内で `PRAGMA table_info(task_sessions)` を走らせ欠損列を `ALTER TABLE task_sessions ADD COLUMN ...` で後付けする。新規 DB では初回 CREATE TABLE がフル定義で通り ALTER はスキップされる。既存 DB では ALTER だけが走り、旧データは全行 NULL で残る。
2. **`insertTaskSession`** のレコード型に optional で `base_branch` / `base_sha` / `base_source` を追加。`event === "assigned"` の行だけに値が入り、他イベント（`agent_spawned` / `closed` / `aborted`）は NULL のまま（後付け補完はしない）。
3. **`conductor.ts`** は worktree 作成が成功した直後に `git rev-parse HEAD`（cwd=worktreePath）で SHA を取る。失敗時は NULL + warn ログ（`log("error", "rev-parse failed ...")`）で先に進み、DB insert は継続する。`resolveWorktreeBase()` の戻り値（`baseLabel`, `source`）を流用して 3 フィールドを埋める。

### 代替案と却下理由

| 案 | 却下理由 |
|----|---------|
| CREATE TABLE を再生成して DROP/CREATE する | 既存の `task_sessions` 履歴を破壊する。T216 `hook_signals` と整合しない破壊的マイグレーションは受け入れ難い |
| 新テーブル `task_session_bases` を別立てにする | join が増えるだけでメリット皆無。`task_sessions` 自体が軽量索引テーブルのため拡張で十分 |
| base 情報を `worktree_path` の末尾に JSON で詰める | 事後クエリが困難。列を増やすほうが素直 |
| `base_sha` を worktree 作成前の `rev-parse origin/<main>` で取る | worktree が **実際に出発した** コミット（親）を記録したい。`git worktree add -b X <start-point>` は HEAD を start-point に揃えるので `cwd=worktreePath` の `rev-parse HEAD` が正しい答え |
| `idx_task_sessions_base_branch` 索引を追加 | 現状の検索 CLI は `task_id` / `session_id` / `task_run_id` しか使わない。索引は将来必要になってから追加する（task.md も「必要なら」と記載） |
| base 情報を `assigned` 以外（`closed` 等）にも複製 | クエリ側で `event='assigned'` でフィルタすれば済む。重複データは更新漏れの原因 |

### 既存パターンとの整合性

- **`resolveWorktreeBase` 戻り値の流用**: `WorktreeBaseResolution.baseLabel`（`dev` / `origin/dev` / `HEAD` 等の表示名）をそのまま `base_branch` 列に入れる。label 付きで保存することで「どの ref を使ったか」が事後復元できる。`source` は `WorktreeBaseSource` enum 値（`explicit` / `config-origin` / `config-local` / `head-fallback`）をそのまま TEXT に格納。
- **マイグレーションパターン**: 既存に倣い `initDB()` 内で完結させる。旧 `traces` テーブル削除（既存）・`hook_signals` 追加（T216）と同じ流儀。
- **エラーハンドリング**: 既存の trace DB insert と同様、`try/catch` で包んで `log("error", ...)` で握りつぶす（trace 書き込み失敗で Conductor 起動自体を止めない）。

---

## 3. 変更対象

### 変更するファイル

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/trace-store.ts` | SCHEMA に `base_branch/base_sha/base_source` を追加 + `initDB()` に `PRAGMA table_info` ベースのマイグレーション + `TaskSessionRecord` 拡張 + `insertTaskSession` 拡張 |
| `skills/cmux-team/manager/conductor.ts` | worktree 作成後に `git rev-parse HEAD` で base_sha を取得し、`insertTaskSession` に `base_branch=baseResolution.baseLabel` / `base_sha` / `base_source=baseResolution.source` を渡す |
| `skills/cmux-team/manager/trace-store.test.ts` | (a) 新規 DB で 3 列が書き込めること / (b) 旧スキーマ DB を手動で作ってから `initDB` を呼び直すと ALTER 経由でカラムが増えること / (c) 旧レコードが NULL のまま残ること |
| `skills/cmux-team/manager/conductor.test.ts` | T242 describe の既存テストに追加: `base_sha` が NULL でなく SHA 形式になっていること、`base_source` が enum 値のいずれかであること |
| `skills/cmux-team/manager/main.ts` | `cmdTraceTask` 出力の conductor 行に base 情報を表示（任意。`Base: <label> (source)` 1 行追加） |
| `skills/trace-task/SKILL.md` | 出力例を新フォーマットに合わせる（base 行を追加） |
| `docs/spec/01-skill-cmux-team.md` | 2 章の trace-task サブセクションに base 列の記載を追加 |
| `CLAUDE.md` | 「トレーサビリティ（v3.4.0）」セクションに base カラムの説明と、古い `cmux-team trace --task` の表記を修正（`trace-task` に統一） |
| `CHANGELOG.md` | T243 エントリを追記 |

### 新規作成するファイル

なし。

### 削除するファイル

なし。

---

## 4. サブタスク分割

### T243-0. 前提作業: T242 の取り込み

- **対象**: 本 worktree 全体
- **手順**: `git fetch origin && git merge origin/main`（または rebase）
- **完了条件**:
  - `skills/cmux-team/manager/worktree-base.ts` が存在する
  - `skills/cmux-team/manager/schema.ts` に `WorktreeBaseResolution` 型がある
  - `skills/cmux-team/manager/conductor.ts` の assignTask が `resolveWorktreeBase` を呼んでいる
  - `bunx tsc --noEmit` が exit 0
  - `bun test` が全 pass（マージ前の 458 tests と同等）
- **検証**: `grep -n "resolveWorktreeBase" skills/cmux-team/manager/conductor.ts`

### T243-1. trace-store.ts スキーマ拡張

- **対象ファイル**: `skills/cmux-team/manager/trace-store.ts`
- **完了条件**:
  - `SCHEMA` 定数の `task_sessions` 定義末尾に `base_branch TEXT, base_sha TEXT, base_source TEXT` を追加（新規 DB 用）
  - `initDB()` 内で `db.exec(SCHEMA)` の直後に **マイグレーション関数** `ensureTaskSessionsColumns(db)` を呼ぶ
  - `ensureTaskSessionsColumns`: `PRAGMA table_info(task_sessions)` で列名セットを取得 → `base_branch/base_sha/base_source` のうち欠損しているものだけに `ALTER TABLE task_sessions ADD COLUMN <name> TEXT` を発行
  - マイグレーション実施時は `log("trace_db_migrated", "task_sessions.<col> added")` を出す（既存 `log` import は trace-store からは使われていないため、追加するか console.warn で済ます判断は実装時に決定）
  - **既存テーブルがない新規 DB の場合**: CREATE TABLE がフル定義で通り、PRAGMA 結果は全列揃うので ALTER はゼロ
- **メソッド制約**:
  - 既存の `db.prepare(...).run(...)` スタイルを維持
  - マイグレーションは同じ `initDB()` 内で **同期的に** 完結させる（他関数から呼び出し可能にする必要はない）
- **検証コマンド**:
  - `grep -n "base_branch TEXT" skills/cmux-team/manager/trace-store.ts`
  - `grep -n "ADD COLUMN" skills/cmux-team/manager/trace-store.ts`
  - `grep -n "ensureTaskSessionsColumns\|PRAGMA table_info" skills/cmux-team/manager/trace-store.ts`

### T243-2. TaskSessionRecord 拡張

- **対象ファイル**: `skills/cmux-team/manager/trace-store.ts`
- **完了条件**:
  - `TaskSessionRecord` に optional で以下を追加:
    ```ts
    base_branch?: string | null;
    base_sha?: string | null;
    base_source?: "explicit" | "config-origin" | "config-local" | "head-fallback" | null;
    ```
  - `base_source` のリテラル型は `schema.ts` の `WorktreeBaseSource`（T242 で追加済み）を import して再利用する。import 循環の懸念がなければ `type WorktreeBaseSource` だけ import する（type-only import）
- **検証コマンド**:
  - `grep -n "base_source" skills/cmux-team/manager/trace-store.ts`

### T243-3. insertTaskSession 拡張

- **対象ファイル**: `skills/cmux-team/manager/trace-store.ts`
- **完了条件**:
  - INSERT 文に `base_branch, base_sha, base_source` 3 列を追加
  - `stmt.run({...})` に `$base_branch`, `$base_sha`, `$base_source` のバインドを追加。未指定時は `null`
  - 他の insert 経路（`agent_spawned` / `closed` / `aborted`）が壊れないこと（未指定 → 全部 NULL）
- **メソッド制約**:
  - 既存の `$timestamp`, `$task_id` 等の `$`-prefix バインディングスタイルを維持
  - 新列に bind が漏れると SQLite が「too few bindings」で throw する（静かに成功させない、このガードは意図的）
- **検証コマンド**:
  - `grep -n "base_branch, base_sha, base_source\|\$base_branch" skills/cmux-team/manager/trace-store.ts`

### T243-4. conductor.ts の base_sha 取得 + 書き込み

- **対象ファイル**: `skills/cmux-team/manager/conductor.ts`
- **完了条件**:
  - worktree 作成（`git worktree add ...`）の成功直後に `git rev-parse HEAD`（`cwd=worktreePath`）を発行して SHA を取得
  - 失敗時は `baseSha = null`、`log("error", "rev-parse HEAD failed in worktree: ...")` で記録し assign は継続
  - 既存 `insertTaskSession` 呼び出し（assigned イベント）に 3 フィールドを追加:
    ```ts
    base_branch: baseResolution.baseLabel,
    base_sha: baseSha,
    base_source: baseResolution.source,
    ```
  - `worktree_created` ログ（T242 で追加済み）に `sha=<short>` も追記して一貫させる（例: `... source=config-origin sha=abcdef1 path=...`）
- **メソッド制約**:
  - 既存の `execFile = promisify(execFileCb)` を使う。新規に child_process を import し直さない
  - `rev-parse HEAD` のタイムアウトは 10s で十分（短時間の local git 呼び出し）
  - SHA は **full 40 文字** で保存、ログ表示だけ short に切る
- **検証コマンド**:
  - `grep -n "rev-parse.*HEAD" skills/cmux-team/manager/conductor.ts`
  - `grep -n "base_branch: baseResolution" skills/cmux-team/manager/conductor.ts`

### T243-5. trace-store.test.ts のテスト追加

- **対象ファイル**: `skills/cmux-team/manager/trace-store.test.ts`
- **完了条件**:
  - 新 describe `"trace-store: task_sessions base columns (T243)"` を追加
  - test 1: 新規 DB に `insertTaskSession` で 3 列を書き込むと読み出せる
  - test 2: 未指定時（旧コードパス）は 3 列が NULL になる
  - test 3: 旧スキーマ DB を手作業で作る（`base_*` 列なしの `CREATE TABLE`）→ `initDB` を呼ぶと ALTER が走って 3 列が追加される。`PRAGMA table_info` で 3 列の存在を確認し、旧 insert のダミー行が NULL で維持されていること
- **メソッド制約**:
  - `beforeEach` で `mkdtemp` を使う既存パターンを踏襲
  - 旧スキーマ再現は `new Database(...)` で直接 `CREATE TABLE task_sessions (...)` を発行して作る
- **検証コマンド**:
  - `bun test skills/cmux-team/manager/trace-store.test.ts`

### T243-6. conductor.test.ts のテスト追加

- **対象ファイル**: `skills/cmux-team/manager/conductor.test.ts`
- **完了条件**:
  - T242 で追加済みの describe にケースを追加するか、新 describe `"assignTask: base_* persistence (T243)"` を設ける
  - モック: `execFile` をスタブして `git worktree add` / `git rev-parse HEAD` の返り値を注入
  - `resolveWorktreeBase` の代わりに `baseResolution` を既に固定する場合は、`conductor.ts` 側がモックしやすい DI にするか、environment fixture で `mainBranch` を渡して決定論的に `config-origin` に倒す
  - 検証: `insertTaskSession` 呼び出し後、DB から該当行を読み出して `base_branch === "origin/main"`、`base_source === "config-origin"`、`base_sha` が 40 文字 hex であること
- **メソッド制約**:
  - 既存 T242 テストが `resolveWorktreeBase` を `git` stub でカバーしているため、conductor テスト側は **結合レベル**（`rev-parse` と insert が連鎖する）を 1 ケース用意すれば十分
- **検証コマンド**:
  - `bun test skills/cmux-team/manager/conductor.test.ts`

### T243-7. cmdTraceTask 出力への反映（任意）

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **完了条件**:
  - `cmdTraceTask` の「Task/Run/Worktree」のヘッダブロックに `Base: <base_branch> @<short-sha> (source=<source>)` を 1 行追加
  - 値は `getSessionsForTask(db, taskId)` の `event='assigned'` 行から拾う（`role='conductor'` + `event='assigned'` は 1 タスクに 1 行）
  - base 情報がない旧データは `Base: -` 表示
- **メソッド制約**:
  - 表示幅を既存レイアウトに合わせる
  - `base_sha` は先頭 7 文字だけ表示（full は `--show` 系コマンドが将来必要になったら別途）
- **検証コマンド**:
  - `cmux-team trace-task 243` を手元で流して表示崩れがないこと

### T243-8. docs/spec 更新

- **対象ファイル**: `docs/spec/01-skill-cmux-team.md`
- **完了条件**:
  - 「2. trace-task」セクションに trace DB 列一覧（または箇条書き）を追記。`base_branch` / `base_sha` / `base_source` を明示
  - `cmux-team trace-task` 出力例に Base 行を追加（T243-7 を実装する場合）
- **検証コマンド**:
  - `grep -n "base_branch\|base_sha\|base_source" docs/spec/01-skill-cmux-team.md`

### T243-9. CLAUDE.md 更新

- **対象ファイル**: `CLAUDE.md`
- **完了条件**:
  - 「トレーサビリティ（v3.4.0）」セクションに以下追記:
    - `task_sessions` に `base_branch` / `base_sha` / `base_source` が `event=assigned` 行にのみ記録される
    - 旧データは NULL
    - ついでに古い「`cmux-team trace --task <id>`」表記を `cmux-team trace-task <id>` に修正（既に 01-skill-cmux-team.md では修正済み）
- **検証コマンド**:
  - `grep -n "base_branch\|base_sha" CLAUDE.md`

### T243-10. CHANGELOG.md 追記

- **対象ファイル**: `CHANGELOG.md`
- **完了条件**:
  - Unreleased セクションに `- feat(trace-store): T243 task_sessions に base_branch/base_sha/base_source 列を追加（ALTER マイグレーション対応、event=assigned 行のみ書き込み）` を追加

### T243-11. スキル（trace-task）更新

- **対象ファイル**: `skills/trace-task/SKILL.md`
- **完了条件**:
  - 出力例（現在 L21-31）の「Worktree:」の下に「Base: origin/main @abcdef1 (config-origin)」の一行を追加
  - 分析観点リストに「worktree の base branch / 親 commit / 解決ソース（T243）」を追加
- **検証コマンド**:
  - `grep -n "Base:" skills/trace-task/SKILL.md`

---

## 5. リスク

### 既存機能への影響

- `insertTaskSession` のシグネチャ拡張は **optional field 追加**（破壊的変更なし）。既存呼び出し元（`conductor.ts` と test）は影響を受けない
- 既存 DB の `ALTER TABLE ADD COLUMN` は SQLite 仕様上 **atomic かつ高速**。バックアップ不要
- 新規 DB の初回 CREATE は SCHEMA 拡張版を直接作るため ALTER は走らない

### エッジケース

| ケース | 対処 |
|--------|------|
| 既存 DB で `task_sessions` が存在し列が欠けている | `PRAGMA table_info` → 欠損列だけ ALTER。`log("trace_db_migrated", ...)` で記録 |
| 既存 DB で `task_sessions` が存在し列が全部揃っている（2 回目の起動） | `PRAGMA table_info` の結果で既に存在と判定 → ALTER スキップ |
| 新規 DB（traces.db ファイル自体が無い） | `initDB` の `mkdirSync` → `new Database` → `db.exec(SCHEMA)` で初回作成。ALTER は no-op |
| `git rev-parse HEAD` が失敗（timeout / git corruption） | `base_sha=null` で insert 続行。`log("error", ...)` で残す |
| `resolveWorktreeBase` が `head-fallback` を返すケース | `base_branch="HEAD"`, `base_source="head-fallback"`, `base_sha=<現 HEAD sha>`。3 列とも埋まる |
| マイグレーション途中で crash（ALTER が 1 列目だけ成功、2/3 列目未発行） | 次回起動時に `PRAGMA table_info` が再度欠損を検出し再 ALTER する。冪等性は確保される |
| 旧レコードの `base_*` が NULL | `cmdTraceTask` で `Base: -` 表示。検索 CLI 側で NULL を例外扱いしないこと |
| 同一タスクが resume されて `assigned` が 2 回走る | 2 行目も base 情報付きで insert される。既存挙動（複数 assigned 行）と同じ |

### テスト戦略

- **unit**:
  - `trace-store.test.ts`: 新規 DB の insert / read、旧スキーマ DB からのマイグレーション、ALTER 冪等性
  - `conductor.test.ts`: `assignTask` が `base_branch/sha/source` を DB に書き込む結合ケース
- **手動 E2E**:
  - 既存 `.team/traces/traces.db`（dev 環境）をバックアップしてから `cmux-team start` → `PRAGMA table_info(task_sessions)` で 3 列追加を確認
  - 新タスクを 1 本投げて `cmux-team trace-task <id>` に Base 行が出ること
- **回帰確認**:
  - `bunx tsc --noEmit` exit 0
  - `bun test` 全 pass（T242 時点で 458 tests、新規 3-4 ケース追加で 461-462 想定）

---

## 6. 既存型エラーの先読み

実行（本 worktree、T242 未取り込み状態）:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-243-1776424220/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(trace-store\.ts|conductor\.ts|main\.ts|worktree-base)" || true
```

結果: **マッチ 0 件**（出力全体でも 0 件、exit 0）。本 worktree 時点で対象ファイル群に既存の型エラーはない。

T242 を取り込んだ後に再確認すべき:
- `conductor.ts` が `worktree-base.ts` から `resolveWorktreeBase` を import するようになる
- `schema.ts` に `WorktreeBaseResolution` / `WorktreeBaseSource` が増える
- 取り込み直後に `bunx tsc --noEmit` を再度走らせて 0 件維持を確認

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `base_sha` を worktree 作成前 or 後のどちらで取るか | **後（worktree の cwd で rev-parse HEAD）** | `git worktree add -b <new> <start-point>` は HEAD を start-point に揃える。worktree 作成後の HEAD こそが「実際に出発した commit」。start-point が branch ref だと後から移動する可能性があるため SHA スナップショットが必須 |
| D2 | 既存 DB へのマイグレーション方式 | **`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`** | `DROP/CREATE` は既存履歴を破壊する。SQLite の `ADD COLUMN` は NULL デフォルトで即時完了する。`IF NOT EXISTS` は ADD COLUMN には無いため手動チェック必須 |
| D3 | `base_source` 列の型（TEXT / INTEGER / CHECK 制約） | **TEXT、CHECK 制約なし** | TS 側の `WorktreeBaseSource` enum でコンパイル時チェック。DB CHECK 制約は将来の enum 追加時にマイグレーション負担になる。`hook_signals.type` と同じ方針 |
| D4 | `base_branch` に何を入れるか（raw ref か label か） | **`WorktreeBaseResolution.baseLabel`（表示ラベル）** | `dev` / `origin/dev` / `HEAD` の違いが事後に保持されるのが目的。`startPoint` は HEAD fallback 時に `null` になるため、一貫して非 null にしたい |
| D5 | 索引 `idx_task_sessions_base_branch` を追加するか | **追加しない** | 現行の検索経路は `task_id` / `session_id` / `task_run_id` のみ。base での集計需要が見えてから追加する（task.md も「必要なら」と記載） |
| D6 | base 情報を `assigned` 以外のイベントにも記録するか | **記録しない**（NULL のまま） | 冗長化すると更新漏れのバグ源になる。join/クエリ時に `event='assigned'` で絞れば十分 |
| D7 | `rev-parse` 失敗時に insert をどう扱うか | **`base_sha=null` で insert 続行、ログに記録** | trace DB への書き込み失敗で Conductor 起動自体を止めるのは過剰。既存 `try/catch` + `log("error", ...)` パターンに統一 |
| D8 | `base_branch` / `base_source` が null のケース | **理論上ゼロ**（`resolveWorktreeBase` は必ず 4 経路のいずれかを返す） | それでも型は optional/null 許容で書く（DB 側の後方互換と整合） |
| D9 | T242 を取り込む方法（merge vs rebase） | **merge origin/main** | rebase はブランチ既存コミットの SHA を書き換えて conductor が識別する `taskRunId/task` ブランチに影響する可能性がある。merge のほうが trace DB 側の記録と整合性を取りやすい。ただし conflict が無ければ rebase も可（実装時判断） |
| D10 | `cmdTraceTask` 出力拡張（T243-7）は必須か | **任意（推奨）** | task.md の完了条件に明示はないが、「事後診断できるようにする」背景には出力で見える化が自然。実装コスト低。plan としては推奨サブタスク扱い |

---

## 参考ファイル

- `skills/cmux-team/manager/trace-store.ts:38-108` — 現 SCHEMA と `insertTaskSession`
- `skills/cmux-team/manager/conductor.ts:303-410`（T242 取り込み後）— `resolveWorktreeBase` 呼び出しと `insertTaskSession` 呼び出し
- `skills/cmux-team/manager/worktree-base.ts`（T242 取り込み後）— `resolveWorktreeBase` の戻り値定義
- `skills/cmux-team/manager/schema.ts` の `WorktreeBaseResolution` / `WorktreeBaseSource`（T242 取り込み後）
- `skills/cmux-team/manager/main.ts:3277-3349` — `cmdTraceTask` の現在の出力フォーマット
- `skills/trace-task/SKILL.md:21-31` — trace-task スキルの出力例
- `CLAUDE.md:650-658` — トレーサビリティ説明
- `docs/spec/01-skill-cmux-team.md:109-114` — trace CLI セクション
