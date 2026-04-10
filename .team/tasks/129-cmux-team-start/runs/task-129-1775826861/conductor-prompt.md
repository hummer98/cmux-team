# タスク割り当て

## タスク内容

---
id: 129
title: cmux-team start 時にワークスペース名を起動フォルダ名に設定
priority: high
created_at: 2026-04-10T13:14:21.359Z
---

## タスク
## 問題
cmux-team start を実行すると、cmux のワークスペース一覧で表示されるタイトルが「cmux-team start」（コマンド名そのまま）になってしまう。

## 期待動作
ワークスペースのタイトルを起動時のフォルダ名（パスではなくフォルダ名のみ、例: cmux-team）にする。

## 修正方法

### 1. cmux.ts に renameWorkspace 関数を追加

```typescript
export async function renameWorkspace(title: string, workspace?: string): Promise<void> {
  const args = ["rename-workspace"];
  if (workspace) args.push("--workspace", workspace);
  args.push(title);
  await execFile("cmux", args).catch(() => {});
}
```

### 2. main.ts の cmdStart() で、daemon タブタイトル設定の直後にワークスペース名を設定

場所: main.ts 393行目付近（`// Conductor スロット作成` の前）

```typescript
// ワークスペース名を起動フォルダ名に設定
const folderName = basename(PROJECT_ROOT);
await cmux.renameWorkspace(folderName, state.workspace);
```

basename は path モジュールから import する（既に import 済みの場合はそのまま使用）。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-129-1775826861` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-129-1775826861
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-129-1775826861/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/129-cmux-team-start/runs/task-129-1775826861
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/129-cmux-team-start/runs/task-129-1775826861/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
