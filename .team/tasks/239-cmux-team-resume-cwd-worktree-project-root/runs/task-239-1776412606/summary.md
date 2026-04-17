# T239: cmux-team resume の cwd バグ修正

## 変更内容

`skills/cmux-team/manager/main.ts` の `cmdResume` 関数内、`execFileSync("claude", ...)` の `cwd` を `ts.worktreePath` から `PROJECT_ROOT` に変更した。

```diff
       stdio: "inherit",
       env: process.env,
-      cwd: ts.worktreePath,
+      cwd: PROJECT_ROOT,
```

## 原因

Conductor の通常起動 (`cmdConductor`) は `cwd: PROJECT_ROOT` で claude を exec するため、Claude Code はセッション JSONL を `~/.claude/projects/-<PROJECT_ROOT をスラッシュ置換>/` に保存する。一方 `cmdResume` は `cwd: ts.worktreePath` で起動していたため、Claude は worktree 側のプロジェクトディレクトリを探しに行き `No conversation found with session ID: ...` で resume に失敗していた。

## 修正後の動作

`cmdResume` も Conductor の通常起動と同じ project root で claude を exec するため、保存されたセッション JSONL がヒットし resume が成功する。「Conductor は project root、Agent は worktree」という設計にも整合する。

## 変更ファイル

- `skills/cmux-team/manager/main.ts`（1 行変更）

## 検証

- `git diff` の出力が想定通り 1 行変更のみ
- 本リポジトリ自身の daemon 再起動 → `task_resumed ... (via boot)` 経路での Conductor 復帰動作は、リリース後に Dear 等で実機確認予定

## 作業経路

- Implementer Agent を spawn し 1 行修正を委譲
- Agent 完了後、Conductor が diff を検証
