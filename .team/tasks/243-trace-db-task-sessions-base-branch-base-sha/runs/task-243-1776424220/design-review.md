# T243 Design Review — plan.md

- taskRunId: `task-243-1776424220`
- 担当 role: design-reviewer
- レビュー日: 2026-04-17
- 対象: `/Users/yamamoto/git/cmux-team/.team/tasks/243-trace-db-task-sessions-base-branch-base-sha/runs/task-243-1776424220/plan.md`

---

## Verdict: Approved

## Summary

plan は T243 の目的（trace DB `task_sessions` に base_branch / base_sha / base_source を保存して worktree 起点の事後診断を可能にする）を正しく捉え、T242 依存、ALTER マイグレーションの冪等性、NULL 許容後方互換、`WorktreeBaseSource` enum 共有、`rev-parse HEAD` 失敗時の継続処理すべてを明示している。サブタスクは T243-0〜T243-11 で変更対象ファイル群を網羅し、テスト戦略（unit + 結合 + 手動 E2E）も十分。Critical / Major findings は 0、Minor の改善提案のみ。

## Findings

### 1. (minor) T243-1 のログ手段の判断が実装フェーズに持ち越されている

plan L129 で「`log("trace_db_migrated", ...)` を出す。既存 `log` import は trace-store からは使われていないため、追加するか `console.warn` で済ますかは実装時に決定」と書かれている。

- 観点: 既存の `trace-store.ts` は `logger.ts` を import していない（L157-193 の `insertHookSignal` で payload truncation を `console.warn("[trace-store] hook_signal_payload_truncated ...")` で出している）。
- これは「trace-store は自己完結・低レベル」の意図的な設計だと読めるため、plan 側で「既存パターンに揃え `console.warn("[trace-store] task_sessions_migrated col=<name>")` で出す」と確定させたほうが曖昧さが消える。
- 影響: 実装時ブレは小さく CRITICAL ではないため minor 扱い。

### 2. (minor) T243-4 の `rev-parse` timeout が既存 `worktree-base.ts` と不揃い

plan L181 で `rev-parse HEAD` の timeout を 10s とあるが、既存 `worktree-base.ts:58` の `execFileAsync` は `timeout: 30000`（30s）で統一されている。

- 観点: ローカル git 呼び出しなので 10s でも実用上問題ないが、同じモジュール群（conductor.ts / worktree-base.ts）内で timeout 値が混在すると「なぜ違うのか」の疑問を将来のレビュアーに生む。
- 推奨: 既存に合わせて 30s、または `conductor.ts` で既に使われている timeout 値（あれば）に揃える。

### 3. (minor) T243-6 のモック戦略が具体性を欠く

plan L206-210 で conductor.test.ts のモック方針が 2 案併記（「DI にする」 or 「environment fixture で `mainBranch` を渡して `config-origin` に倒す」）のまま残っている。

- 観点: `conductor.ts:308` の `resolveWorktreeBase` 呼び出しは現状 DI されていない。既存 T242 系テストが `execFile` をどうスタブしているかに合わせる必要がある（既存テストが env + execFile stub パターンなら、新ケースも `git worktree add` と `git rev-parse HEAD` の両方を stub すれば足りる）。
- 推奨: plan 側で「既存 T242 `describe` と同じ execFile stub パターンを踏襲し、`rev-parse HEAD` 呼び出しに対して 40 文字 hex を返すスタブを追加する」と確定させる。DI 改修まで踏み込む必要はない。

### 4. (minor) T243-7（`cmdTraceTask` 出力拡張）が「任意」となっているが事後診断価値の観点で必須寄り

D10 で「任意（推奨）」となっているが、T243 のゴール「事後診断できるようにする」は DB に保存しただけでは未完成で、少なくとも trace-task CLI で見えて初めて完結する。

- 観点: plan L219-225 の実装コストは低く（`Base: <label> @<short-sha> (source=<src>)` 1 行追加）、サブタスクとして含まれている。
- 推奨: 「任意」から「必須（低コスト）」に格上げし、T243-8（docs/spec）の出力例記載とも整合させる。なお T243-8 は既に T243-7 実装前提で書かれているため、plan 内でのロジカルな不整合が解消される。

### 5. (minor) `base_sha` 保存タイミングとロールバック時の扱いが未言及

plan L170 で「worktree 作成（`git worktree add ...`）の成功直後」に `rev-parse HEAD` を発行とあるが、その後の settings copy / npm install / prompt generation / cmux send のいずれかで例外が出たとき、`AssignTaskError` で catch されると `worktreeCreated=true` のブランチに入り worktree 削除 + DB へは assigned 行が **insert されない**（L402-418 の try が後段にあるため）。

- 観点: これは既存挙動（T243 以前でも同じ）であり、plan の設計で変わるわけではない。ただし「worktree 作成に成功して rev-parse も成功したが、後段で assign 失敗」のケースで DB に `base_sha` が残らない点は、事後診断の目的上は「記録したかった情報が欠落する」クラスのエッジケース。
- 推奨: plan の「リスク/エッジケース」表に 1 行追加しておくと実装者・将来のレビュアーに親切（必須ではない）。

### 6. (minor) D9 の rebase/merge 判断の根拠が弱い

D9 で「merge のほうが trace DB 側の記録と整合性を取りやすい」とあるが、T243 の trace DB 変更と T242 取り込み方法（rebase vs merge）に直接の因果は見えない。実際には「rebase すると taskRunId ブランチ名で切られた本 worktree ブランチ（task-243-1776424220）を含むコミットの SHA が書き換わる」という整合性の話であり、理由をより明確に書いたほうが良い。

- 観点: 実装判断自体（merge 優先、conflict なければ rebase 可）は妥当だが理由の説明が実装者に誤解を与えうる。
- 推奨: 「merge のほうが既存 conductor ブランチの commit SHA を保持でき、`task-243-*` ブランチの履歴改変リスクがない」に書き換える。

## Recommendations

Approved のため必須の修正はないが、以下を plan 側で確定させると実装フェーズの判断ブレが減る:

1. **T243-1 のログ手段を確定**: `console.warn("[trace-store] task_sessions_migrated col=<name>")` に統一する旨を追記（既存 `insertHookSignal` の warn パターンに揃える）。
2. **T243-4 の timeout を 30s に揃える**: 既存 `worktree-base.ts` との一貫性。
3. **T243-6 のモック戦略を確定**: 既存 T242 `describe` の execFile stub パターンを踏襲し、`rev-parse HEAD` 用の 40 文字 hex stub を追加する旨を明記。
4. **T243-7 を必須サブタスクに格上げ**: 事後診断価値の完結性の観点から。D10 の記述も「必須（低コスト）」に更新。
5. **D9 の理由を明確化**: 「`task-243-*` ブランチの履歴改変リスクがない」等、rebase を避けるべき具体的理由に置き換える。

## CRITICAL チェック項目の結果

| 項目 | 結果 |
|------|------|
| サブタスクカバレッジ（plan 内変更対象すべて分割されているか） | ✅ T243-1〜T243-11 で trace-store.ts / conductor.ts / テスト / main.ts / skill / docs / CLAUDE.md / CHANGELOG 全て分割済み |
| 統合テスト/検証（コンポーネント接続検証サブタスクの存在） | ✅ T243-6 conductor.test.ts 結合テスト + 手動 E2E（L290-295）あり |
| 既存テストへの影響（破壊時の修正タスク含有） | ✅ optional field 追加のため破壊的変更なし、既存テスト影響は plan で明示 |
| 依存関係（T243-0 T242 取り込みの存在） | ✅ T243-0 で明示、完了条件・検証コマンドも記載 |
| マイグレーション冪等性 | ✅ D2 + リスク節 + T243-1 の PRAGMA + ADD COLUMN 方式で担保、途中 crash でも次回起動で再 ALTER |
| NULL 許容（既存データとの後方互換） | ✅ TaskSessionRecord 側は `string \| null`、DB 側は ALTER ADD COLUMN で既存行 NULL 維持 |
| base_source enum 型の共有（DB / TS 一元管理） | ✅ T243-2 で `WorktreeBaseSource` を schema.ts から type-only import |
| rev-parse HEAD 失敗処理（Conductor 起動を止めない設計） | ✅ T243-4 + D7 で `base_sha=null` で insert 継続、`log("error", ...)` で記録 |
| セキュリティ（SQLite injection） | ✅ `$`-prefix parameterized binding を維持 |
| セキュリティ（git rev-parse 引数制御） | ✅ `execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath })` で shell を介さず引数固定 |

---

## 参考: 実ファイル確認結果

main ブランチ側を Read して以下を確認:

- `trace-store.ts:13-23` — 現 `TaskSessionRecord` に base 列が無いこと確認、plan L143-149 の追加案と整合
- `trace-store.ts:38-68` — `SCHEMA` 定数確認、plan L126 の追加位置（末尾）と整合
- `trace-store.ts:72-90` — `initDB` 実装確認、plan L128 の「`db.exec(SCHEMA)` 直後に `ensureTaskSessionsColumns(db)`」と整合
- `trace-store.ts:157-193` — `insertHookSignal` が `console.warn` を使うパターン確認（Finding 1 の根拠）
- `worktree-base.ts:1-110` — `resolveWorktreeBase` / `WorktreeBaseResolution` / timeout=30s を確認（Finding 2 の根拠）
- `schema.ts:268-282` — `WorktreeBaseSource` enum / `WorktreeBaseResolution` interface を確認、plan T243-2 と整合
- `conductor.ts:15-16` — `initDB, insertTaskSession` / `resolveWorktreeBase` import を確認
- `conductor.ts:307-328` — `resolveWorktreeBase` 呼び出しと `worktree_created` ログを確認、plan L178 の「`sha=<short>` 追記」の対象箇所と整合
- `conductor.ts:402-418` — 既存 `insertTaskSession(assigned)` 呼び出しを確認、plan L172-177 の 3 フィールド追加と整合（AssignTaskError で中断した場合は insert されない点は Finding 5 で指摘済み）

以上より plan の主張は main ブランチ実装と整合している。
