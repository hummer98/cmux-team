# 検品結果: task-117

## 総合判定

**GO**

plan.md v2 と design-review.md v2 で要求された全項目が実装されている。単体テスト・統合テスト・型チェック（既存 dashboard.tsx を除く）はすべてグリーン。Critical / Major 級の指摘はない。

---

## チェックリスト結果

### 1. 仕様充足

| 観点 | 結果 | 根拠 |
|-----|------|------|
| preflight チェックが追加され cmdStart で呼ばれているか | ✅ | `main.ts:35` で import、`main.ts:200-204` で `cmdStart` 内 cmux 環境チェック直後・`createDaemon` 呼び出し前に実行 |
| preflight は全項目（git/claude/bun/書込権限）を検証しているか | ✅ | `preflight.ts:27-97` に `checkGitRepo` / `checkClaude` / `checkBun` / `checkWritable` 実装、`runPreflight` (L104-120) が全検証を走らせ issue を積む |
| preflight 失敗時に process.exit(1) しているか | ✅ | `main.ts:201-204` で `printPreflightIssues(preflight); process.exit(1);` |
| `AssignTaskError` クラスと `AssignFailureKind` 型が export されているか | ✅ | `conductor.ts:30` `export type AssignFailureKind`、`conductor.ts:32` `export class AssignTaskError` |
| assignTask の失敗点がすべて throw で分類されているか | ✅ | `conductor.ts:243` tasks dir 失敗→task、`:268` task file not found→task、`:281` git worktree add 失敗→task、`:328` prompt 生成失敗→task、`:347` cmux.send 失敗→conductor、`:392-395` catch-all→保守的 task |
| daemon.ts の scanTasks が AssignTaskError の kind で分岐しているか | ✅ | `daemon.ts:658-693` で `e instanceof AssignTaskError` → `e.kind === "task"` / `"conductor"` の 2 分岐 + defensive の 3 層構造 |
| task kind の場合は Conductor を idle のまま維持しているか | ✅ | `daemon.ts:660-675` で `idleConductor.status` は一切変更せず、task-state のみ `aborted` に更新して `continue` |
| conductor kind の場合は disconnected にしているか | ✅ | `daemon.ts:677-684` で `idleConductor.status = "disconnected"` + `disconnectedAt` セット + `conductor_disconnected` ログ |
| scanTasks が export されているか | ✅ | `daemon.ts:595` `export async function scanTasks(state: DaemonState): Promise<void>` |

### 2. テストの妥当性

| 観点 | 結果 | 根拠 |
|-----|------|------|
| preflight.test.ts が git/non-git ケースを検証しているか | ✅ | `preflight.test.ts:31-36` git リポジトリで not_git_repo が出ない、`:38-43` 非 git で ok=false + not_git_repo を検証 |
| preflight.test.ts が複数項目同時失敗・.team/ 非作成・テストファイル残骸を検証しているか | ✅ | `:45-61` 同時失敗、`:63-67` .team 非作成、`:69-73` `.cmux-team-preflight-test` 残骸なし |
| conductor.test.ts が task kind 分類を検証しているか | ✅ | `conductor.test.ts:58-71` タスクファイル不在→task kind + Conductor idle、`:73-89` git 未初期化→task kind + Conductor idle、`:91-101` タスク不在時 worktree 未作成 |
| daemon.test.ts に scanTasks 統合テストが追加されているか | ✅ | `daemon.test.ts:354-394` に `scanTasks: assignTask エラー分離` describe が追加。「git 未初期化で aborted / Conductor idle 維持」「idle Conductor 不在時は throttled」の 2 件 |
| `cd skills/cmux-team/manager && bun test` がグリーンか | ✅ | 62 pass / 0 fail / 138 expect() / 6 files, 649ms（実行済み。下記参照） |

### 3. ログフォーマット

| 観点 | 結果 | 根拠 |
|-----|------|------|
| task_aborted のログが `task_id=X title=Y journal_summary=Z` 形式か | ✅ | `daemon.ts:670-673` で `` `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}` `` |
| dashboard.tsx:277-282 のパーサと互換性があるか | ✅ | dashboard は `task_id=(\S+)` / `title=(.+?)(?:\s+\w+=|$)` / `journal_summary=(.+)` を使用。新ログは `title=` の後ろに ` journal_summary=` が続くため `.+?` の non-greedy 制約で title が正しく切れる。`main.ts:1554,1606` の既存 abort-task ログと同一フォーマット |

### 4. 隠れたバグ

| 観点 | 結果 | 根拠 |
|-----|------|------|
| `cmux.renameTab` が個別 try/catch で握りつぶされているか | ✅ | `conductor.ts:355-359` で個別 try/catch + `log("error", ...)`。catch-all に捕まって task abort される問題を回避 |
| worktree 作成後に失敗した場合の cleanup 処理が入っているか | ✅ | `conductor.ts:234` `let worktreeCreated = false;`、`:279` 成功時に `worktreeCreated = true;`、`:377-390` catch で `worktreeCreated` フラグを見て `git worktree remove --force` + `git branch -D` を実行（Design Review v2 追加指摘 #1 対応） |
| `Bun.which()` で claude/bun を検証しているか | ✅ | `preflight.ts:47` `Bun.which("claude")`、`:59` `Bun.which("bun")`。`execFile("which", ...)` は使用していない |
| `team_dir_not_writable` 検証が `.team/` を勝手に作らない設計になっているか | ✅ | `preflight.ts:73` で `projectRoot` 直下の `.cmux-team-preflight-test` に書く。`.team/` 配下は一切触らない。`preflight.test.ts:63-67` で `.team/` 非作成を検証 |
| spawnConductor の assignTask 呼び出しが try/catch でラップされているか | ✅ | `conductor.ts:531-541` で `try/catch`、`AssignTaskError` は kind/reason を log して `null` を返す（既存 `Promise<ConductorState \| null>` 仕様維持） |

### 5. 型整合性

| 観点 | 結果 | 根拠 |
|-----|------|------|
| `bunx tsc --noEmit` が通るか（dashboard.tsx 既存エラー除く） | ✅ | 実行結果（下記）は `dashboard.tsx(342,5)` と `dashboard.tsx(862,11)` の `WidgetVariant` 既存エラー 2 件のみ。preflight.ts / conductor.ts / daemon.ts / 全テストファイルは 0 エラー |
| 新規コードに明示的な型が付いているか | ✅ | `PreflightIssue` / `PreflightResult` / `AssignFailureKind` / `AssignTaskError` すべて export 型定義あり。`daemon.ts:655` `let updated: ConductorState;`（Design Review v2 追加指摘 #2 対応、`\| null` を外した） |

### 6. スタイル

| 観点 | 結果 | 根拠 |
|-----|------|------|
| 既存 logging ポリシーに従っているか | ✅ | `log(event, detail)` 形式を維持。`conductor.ts:358` `renameTab` catch は CLAUDE.md の「冪等な後処理は握りつぶし可」に整合。`preflight.ts:78-80` `unlink` catch は「書き込めたのに削除できない特殊ケース」のコメント付きで意図的に許容 |
| 既存のエラー処理パターンと揃っているか | ✅ | `task_aborted` ログフォーマットを `main.ts:1554,1606` の既存実装と同一にそろえている。`AssignTaskError` の re-throw パターンも standard |

---

## テスト実行結果

`cd skills/cmux-team/manager && bun test`:

```
bun test v1.3.11 (af24e281)

 62 pass
 0 fail
 138 expect() calls
Ran 62 tests across 6 files. [649.00ms]
```

新規 11 件（preflight.test.ts 9 件 + conductor.test.ts 3 件 ※ ただし見かけ上 3 ファイル増）+ 既存 scanTasks テスト 2 件の拡張を含め、全 62 テスト green。

---

## 型チェック結果

`cd skills/cmux-team/manager && bunx tsc --noEmit`:

```
dashboard.tsx(342,5): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
dashboard.tsx(862,11): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
```

`dashboard.tsx` の 2 件は本タスク範囲外の既存エラー（WidgetVariant 型不整合）。`preflight.ts`, `preflight.test.ts`, `conductor.ts`, `conductor.test.ts`, `daemon.ts`, `daemon.test.ts`, `main.ts` は全てエラーなし。

---

## 指摘事項

### [Critical]

なし。

### [Major]

なし。

### [Minor]

#### Minor 1: `printPreflightIssues` の hint 行インデントが二重になる可能性

`preflight.ts:139-141` で `issue.hint.split("\n")` した各行を `    ${line}` で prefix している。一方で `hint` 側（例: `preflight.ts:37-41`）は既に行頭に `  `（2 スペース）や `解決方法:\n` を含めており、`runPreflight` が生成する実メッセージは `    解決方法:` / `      cd /path` のようにネストしたインデントで出力される。plan L63-78 の期待出力例（`  解決方法:` / `    cd ...`）とは 2 スペース分ずれる。

- 影響: 見た目のインデント揺れのみ。機能上の問題はない
- 優先度: スタイル。cosmetic なので GO を阻害しない
- 推奨: `hint` 側の行頭スペースを削る or `printPreflightIssues` 側の prefix を調整

#### Minor 2: `conductor.test.ts:22` の `process.env.PROJECT_ROOT` は未使用

beforeEach で `process.env.PROJECT_ROOT = testDir;` を設定しているが、`assignTask(conductor, taskId, projectRoot)` は引数で `testDir` を直接受け取るため参照されていない。afterEach で delete しているので副作用はないが、読み手にとってノイズ。

- 影響: なし
- 優先度: Cosmetic
- 推奨: 次回クリーンアップで削除してよい

#### Minor 3: `daemon.ts:655` 宣言後の assignment が TypeScript 厳格環境で `Variable 'updated' is used before being assigned` と見なされないか

`let updated: ConductorState;` 宣言後、try の内側で代入、catch ではすべて `continue` で抜けているため実行パスとしては使用前参照はありえない。今回の tsc では問題なくパス済み（実行済み型チェック結果より）。設計上問題ないが、`strict: true` の別プロジェクトで使い回す際に `definite assignment` 警告が出る可能性に留意。

- 影響: 現プロジェクトではなし（tsc パス済み）
- 優先度: 情報提供のみ
- 推奨: 将来 noUncheckedIndexedAccess 等を有効化する際に再検討

#### Minor 4: worktree cleanup の順序

`conductor.ts:377-390` の cleanup 手順は `git worktree remove --force` → `git branch -D` の順。`git worktree remove --force` で worktree を削除すれば、リンクしていた `branch` 自体はまだ残存するため `git branch -D` は正当。ただしブランチが remote tracking を持つ等のエッジケースでは `-D` でも失敗する可能性がある（その場合は `log("error", ...)` のみで続行する設計）。現状挙動として妥当だが、cleanup 失敗時にユーザーへフォローするログはあるとベターかもしれない。

- 影響: なし（失敗は log される）
- 優先度: 情報提供のみ

#### Minor 5: `Bun.which` のテストが環境依存で省略されている件

`preflight.test.ts` は `claude_not_found` / `bun_not_found` のテストを含まない。plan L386 の通り CI 環境依存のため意図的スキップ。実装レポートの「想定外対処点 2」で `process.env.PATH = ""` でも `Bun.which` が claude を解決してしまう旨の記録があり、テスト省略判断は妥当。

- 影響: なし
- 優先度: 情報提供のみ
- 将来改善: `Bun.which` をモック可能な形に抽出すれば検証できる

---

## Design Review v2 追加指摘への対応確認

| # | 指摘 | 対応状況 |
|---|------|---------|
| 1 | worktree 作成後の cleanup | ✅ `conductor.ts:234,279,377-390` に `worktreeCreated` フラグ + catch 内 `git worktree remove --force` + `git branch -D` 実装済み |
| 2 | `updated: ConductorState \| null = null;` → `ConductorState` のみに | ✅ `daemon.ts:655` `let updated: ConductorState;` に修正済み（`\| null` を外した） |
| 3 | `task.ts` の `markTaskAborted` helper 新設 | ⭕ optional 指摘のため見送り（既存 `main.ts:1543,1595` と同一のインライン形式を維持）。将来リファクタで吸収可 |
| 4 | `team_dir_not_writable` テストで root skip | ✅ `preflight.test.ts:47,77` `if (process.getuid?.() === 0) return;` 追加済み |

すべて追加指摘は対応済み（3 の optional 見送りは実装レポートで明示されており受け入れ可能）。

---

## 完了条件チェック（plan.md L530-541）

- [x] `preflight.ts`, `preflight.test.ts`, `conductor.test.ts` が追加されている
- [x] `main.ts` に preflight 呼び出しが入っている（`main.ts:200-204`）
- [x] `preflight.ts` は `Bun.which()` を使用し、書込テストは `.cmux-team-preflight-test` で行い `.team/` を作成しない
- [x] `printPreflightIssues` は `console.error` を使用（`preflight.ts:129-143`）
- [x] `conductor.ts` に `AssignTaskError` が追加され、`assignTask` が kind 付きで throw
- [x] `conductor.ts:356` の `cmux.renameTab` が個別 try/catch で包まれている
- [x] `daemon.ts` の `scanTasks` が `export` され、`AssignTaskError` を受けて `task`/`conductor` で分岐
- [x] `task_aborted` ログが既存フォーマット（`task_id=`, `title=`, `journal_summary=` キー）と一致
- [x] `bun test` が全てグリーン（62/62）
- [ ] 手動 E2E — 自動テストの範囲外、本検品でもスキップ（CLAUDE.md の方針どおり人手確認）
- [ ] 手動 E2E dashboard 描画確認 — 同上

手動 E2E 2 項目はスコープ外（CLAUDE.md『テスト方法 - 自動テストはない』）。コードパス・ログフォーマット互換性はスタティックに検証済みのため GO を妨げない。

---

## Fix Required

**なし（GO）**。Minor 指摘 5 件は cosmetic / 情報提供レベルで、Implementer への修正要求は行わない。将来のリファクタで吸収すればよい。
