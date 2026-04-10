# タスク割り当て

## タスク内容

---
id: 130
title: Conductor/Agent spawn 時に CMUX_CLAUDE_HOOKS_DISABLED=1 を設定
priority: high
created_at: 2026-04-10T13:35:41.690Z
---

## タスク
## 問題

cmux の Claude Code 自動連携（claude ラッパーによる hook 注入）が Conductor・Agent のシェルで無効化されていないため、サイドバーに Running/Idle/Needs input が cmux 側から表示されてしまう。

cmux-team は独自の hook（`--settings` 経由）で状態管理するため、cmux ラッパーの自動 hook は不要。

## 現状の問題箇所

### 1. Agent spawn（main.ts L1086-1095）

`spawn-agent` で Agent のシェルに環境変数を export する際、`CMUX_CLAUDE_HOOKS_DISABLED=1` が含まれていない。

```typescript
const exportVars = [
  \`ROLE=${role}\`,
  \`PROJECT_ROOT=${PROJECT_ROOT}\`,
  \`CMUX_SURFACE=${surface}\`,
  \`CMUX_NO_RENAME_TAB=1\`,
  // ← ここに CMUX_CLAUDE_HOOKS_DISABLED=1 が必要
];
```

### 2. Conductor spawn（conductor.ts L97, L171, L545）

Conductor は `cmux send` で `cmux-team conductor <surface>` を送信して起動する。`cmux-team conductor` コマンド内では `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` を設定してから `execFileSync("claude", ...)` を呼ぶので、claude プロセスには渡る。

ただし `execFileSync("claude", ...)` は PATH 上の claude を呼ぶため cmux ラッパーを通る。ラッパーは `CMUX_CLAUDE_HOOKS_DISABLED=1` を見てバイパスするので **Conductor 側は実は正しく動いている可能性がある**。

→ 念のため conductor.ts の `cmux send` で起動する際にも `export CMUX_CLAUDE_HOOKS_DISABLED=1 &&` を前置するか、確認すること。

## 修正方法

### Agent（確実に修正が必要）

main.ts L1086-1095 の `exportVars` 配列に追加:

```typescript
exportVars.push(\`CMUX_CLAUDE_HOOKS_DISABLED=1\`);
```

### Conductor（要確認）

conductor.ts で `cmux-team conductor` を実行する前に環境変数を export する、または `cmux-team conductor` 起動コマンドの前に `CMUX_CLAUDE_HOOKS_DISABLED=1` を付与:

```typescript
await cmux.send(surface, \`export CMUX_CLAUDE_HOOKS_DISABLED=1 && cmux-team conductor ${surface}\n\`);
```

## 確認方法

修正後、`cmux list-status` でワークスペースに `claude_code=Running` 等が表示されないことを確認。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-130-1775828141` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-130-1775828141
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-130-1775828141/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/130-conductor-agent-spawn-cmux-claude-hooks-disabled-1/runs/task-130-1775828141
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/130-conductor-agent-spawn-cmux-claude-hooks-disabled-1/runs/task-130-1775828141/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
