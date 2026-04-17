---
task: T242
role: design-reviewer-1
reviewed_at: 2026-04-17
reviewer_model: claude-opus-4-7
---

# T242 plan.md 設計レビュー

## Verdict: Approved

## Summary

worktree start-point がローカル HEAD に暗黙依存する根本原因を正しく特定し、`main-branch.ts` の DI パターンを忠実に踏襲した純粋関数 `resolveWorktreeBase` を提案している。フォールバックチェーン（explicit → origin/<mainBranch> → local <mainBranch> → HEAD）は妥当で、fetch をデフォルト OFF としつつ opt-in を残す判断も CLAUDE.md のポリシー（offline 対応・レート制限回避）と整合する。実装対象・テスト・docs 更新まで全変更が 10 項目のサブタスクに展開されており、CRITICAL チェック項目をすべて満たす。

## CRITICAL チェック項目

| 項目 | 結果 | 根拠 |
|------|------|------|
| サブタスクカバレッジ | ✅ | 3-1/3-2 の全変更対象（schema.ts, worktree-base.ts, worktree-base.test.ts, conductor.ts, conductor.test.ts, 01-skill-cmux-team.md, CLAUDE.md, CHANGELOG.md）がサブタスク 1-8 に対応 |
| 統合テスト/検証 | ✅ | サブタスク 5（conductor.test.ts への新規テスト追加）+ サブタスク 9（`bun test` 全体回帰）の 2 層で担保 |
| 削除タスクの完全性 | ✅ | 新規モジュールを追加して assignTask 内インラインコードを置換する設計のため、独立した「削除」は存在せず、サブタスク 4（conductor 組込み）の置換作業に内包される |
| 既存テストへの影響 | ✅ | conductor.test.ts の既存 4 ケース（エラー分類）は assignTask のエラーパスのみを検証しており、worktree 作成後の経路には触らないため破壊的影響なし。サブタスク 5 で成功パス 1 本を追記して正常系カバレッジを担保 |

## Findings

### 1. (minor) fetch opt-in 時の timeout 未規定

2-3 節で `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` 時に `git fetch --quiet origin <mainBranch>` を実行するが、timeout / abort signal の指定がない。origin が到達不能・HTTPS 認証で hang するケースで assignTask 全体がブロックされる可能性がある。実装時に `execFile("git", [...], { timeout: 30000 })` 等の上限を設けるとより安全。opt-in で明示的に選択したユーザー責任の範囲内のため minor。

### 2. (minor) env 値パース — 他フラグとの一貫性

計画の擬似コード `process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1"` は "1" のみ受理する。一方 `CMUX_TEAM_AUTO_UPDATE` は `normalizeAutoUpdate` で `"off"/"notify"/"task"/true/false` を柔軟に解釈する（schema.ts:279）。今後 `"true"` を試したユーザーが無反応に戸惑う可能性。現状の `CMUX_TEAM_TRACE_EVENTS=1` 等と揃っており機能的には問題ないため minor。実装時に "1" / "true" / "yes" のいずれも許容する小ヘルパーを導入してもよいが、必須ではない。

### 3. (minor) `log()` 呼び出しの `await` 一貫性

2-1 節の擬似コード `log("worktree_created", ...)` は `await` なしで書かれている。`main-branch.ts:53` 等は `await log(...)` で書かれている。既存 `conductor.ts:317` も `await` なしで統一されているため、conductor.ts 側の置換では `await` なしのままで問題ない。ただし新規 `worktree-base.ts` 内で log を呼ぶ場合は `main-branch.ts` と揃えて `await log(...)` 形式にするのが自然。

### 4. (minor) origin が local より古い場合の扱い

5-1 節「逆に origin/dev が local dev より古い場合は『欲しい commit が無い worktree』ができる可能性」をドキュメント誘導で対処している。この挙動は本タスクの意図（origin を真実のソースにする）の論理的帰結であり正しい設計判断。ただし Master が「push 忘れのローカル commit を含めたい」ケースへの配慮として、`base_branch:` に `HEAD` を明示指定すれば従来挙動に戻せることが docs で触れられていると利用者に親切。CLAUDE.md 更新時に一文追加を推奨。

### 5. (informational) セキュリティ — コマンドインジェクション

`execFile("git", [...], ...)` を使用しているため shell 経由の注入は不可能。`baseBranch` は `task.md` frontmatter（チーム管理下）、`mainBranch` は `.team/config.json` または `git symbolic-ref` 出力（git が検証済み）であり、外部ユーザー入力が直接 ref 名に流入する経路はない。`resolveWorktreeBase` 内で追加の ref 名バリデーションは不要。5-2 節「`mainBranch` に不正文字（空白等）」への trim 対応で十分。

### 6. (informational) 既存パターン整合性の確認

- DI シグネチャ `git?: (args: string[]) => Promise<string>` は `ResolveMainBranchOptions.git` と完全一致 ✅
- 戻り型 `{ startPoint, source, baseLabel }` は `{ branch, source }` を素直に拡張した形で合理的 ✅
- `WorktreeBaseSource` を `z.enum` として schema.ts に追加する方針は `MainBranchSource` と対称で SSOT を維持 ✅
- ログフォーマット `worktree_created branch=... base=... source=... path=...` はロギングポリシー（key=value スペース区切り）および既存行（conductor.ts:317）と一貫 ✅

### 7. (informational) create-task --base-branch の実装確認

1-4 節の既存実装調査は、`main.ts:2401`（`getArg("base-branch")`）、`main.ts:2417`（`baseBranch` プロパティ渡し）、`task.ts:270-350` の `baseBranch` → frontmatter 書き出し、i18n help、docs/spec/01/05 の記載まで網羅しており正確。新規実装スコープから除外する判断は正しい。サブタスク 6（docs/spec 更新）で整合性を再確認する運用で十分。

## 総合評価

- **根本対策**: ✅ 「start-point がローカル HEAD に暗黙依存」という根本原因を正しく捉え、config.mainBranch を worktree 作成経路に正しく結線する設計
- **AI の手抜き防止**: ✅ 妥協なく純粋関数化 + DI + unit test + 統合テスト + docs 更新までフルカバレッジ
- **設計原則 (DRY/SSOT)**: ✅ `main-branch.ts` パターンを再利用、schema.ts の enum で型の真実のソースを一元化
- **既存パターンとの整合性**: ✅ DI・ログフォーマット・エラーハンドリング（throw せずフォールバック）すべて既存コードと同じ書き味
- **セキュリティ**: ✅ execFile 使用、入力源は信頼済み、trim で空白対応

Critical findings 0件、すべての CRITICAL チェック項目パス、よって **Approved**。

## Recommendations

Verdict が Approved のため修正必須事項はなし。以下は実装時の任意提案:

1. (任意) fetch opt-in 実行時に `execFile("git", ["fetch", ...], { timeout: 30000 })` で 30 秒 timeout を付与
2. (任意) `worktree-base.ts` 内で log を呼ぶ箇所は `await log(...)` 形式（`main-branch.ts` と揃える）
3. (任意) CLAUDE.md 更新時に「ローカル未 push commit を含めたい場合は `base_branch: HEAD` を明示」と一文追加
