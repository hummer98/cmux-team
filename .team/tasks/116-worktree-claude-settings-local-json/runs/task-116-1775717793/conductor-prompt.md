# タスク割り当て

## タスク内容

---
id: 116
title: worktree 作成時に .claude/settings.local.json をコピー
priority: high
created_at: 2026-04-09T06:56:33.642Z
---

## タスク
## 背景

`spawn-agent` で起動した Agent が worktree CWD で Claude Code を起動するため、`.claude/settings.local.json`（untracked）が見つからず初回セットアップ画面（テーマ選択等）で停止する事象が発生。

詳細: `.team/artifacts/A005-agent-worktree-cwd-decision.md`

## 発生事例

- KDG-lab T005 の inspector agent (surface:83) が初回セットアップ画面で停止

## 要件

worktree 作成時に、プロジェクトルートの `.claude/settings.local.json` を worktree の `.claude/` にコピーする。これにより Agent が worktree CWD で Claude を起動してもパーミッション設定が引き継がれる。

## 実装内容

### 対象ファイル

`skills/cmux-team/manager/conductor.ts` の `assignTask` 関数

### 変更箇所

`git worktree add` 実行直後（現状の L248 付近、npm install ブロックの前）に以下を追加:

```typescript
// .claude/settings.local.json を worktree にコピー
// （untracked なので worktree に含まれないが、Agent 起動時に必要）
const settingsSrc = join(projectRoot, ".claude/settings.local.json");
if (existsSync(settingsSrc)) {
  const settingsDst = join(worktreePath, ".claude/settings.local.json");
  await mkdir(dirname(settingsDst), { recursive: true });
  await copyFile(settingsSrc, settingsDst);
  await log("settings_copied_to_worktree", `worktree=${worktreePath}`);
}
```

必要な import:
- `copyFile` from `node:fs/promises`
- `dirname` from `node:path`（既に `join` がある）

### ログ

成功時: `settings_copied_to_worktree worktree=<path>`
失敗時: catch で `log("error", ...)` を記録（ただし失敗しても worktree 作成自体は成功扱いにする。settings.local.json がなくても動くケースはあるため、fatal にしない）

## 検証手順

1. cmux-team を rebuild / reinstall
2. cmux-team stop && start
3. テストタスクを作成して Conductor に割り当て
4. Conductor ペインで `ls .worktrees/task-XXX/.claude/` を実行し `settings.local.json` が存在することを確認
5. Agent を spawn して初回セットアップ画面が出ないことを確認

## 非目標

- Conductor 自体の CWD 変更（A005 の選択肢 A/C）は今回対象外
- `.envrc` や他の untracked 設定ファイルのコピーは対象外
- hooks による worktree 外書き込みブロックは対象外

これらはリスク最小対応として保留し、必要に応じて別タスクで対応する。

## 関連

- Artifact: A005 (Agent/Conductor の worktree CWD 問題)
- 発生環境: ~/git/KDG-lab


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-116-1775717793` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-116-1775717793
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-116-1775717793/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/116-worktree-claude-settings-local-json/runs/task-116-1775717793
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/116-worktree-claude-settings-local-json/runs/task-116-1775717793/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
