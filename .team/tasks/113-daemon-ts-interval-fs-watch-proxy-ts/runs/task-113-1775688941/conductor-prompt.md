# タスク割り当て

## タスク内容

---
id: 113
title: メモリリーク修正: daemon.ts の interval 重複・fs.watch 未クローズ・proxy.ts エラーハンドリング
priority: medium
created_at: 2026-04-08T22:55:41.069Z
---

## タスク
## 背景

調査により、manager/ に3箇所のメモリリーク・リソースリークが見つかった。

## 修正内容

### 1. spawnPidWatcher の interval 重複（高優先度）

**ファイル**: skills/cmux-team/manager/daemon.ts

**問題**: session_started メッセージを受け取るたびに spawnPidWatcher が新しい setInterval を作成するが、Conductor が再接続するたびに古い interval への参照が失われる。頻繁な再接続で interval が積み重なる。

**修正方針**:
- ConductorState に `pidWatcherInterval?: ReturnType<typeof setInterval>` フィールドを追加
- spawnPidWatcher 呼び出し前に既存の interval を clearInterval する
- spawnMasterPidWatcher も同様に DaemonState に `masterPidWatcherInterval` を追加して対処

### 2. fs.watch の未クローズ（高優先度）

**ファイル**: skills/cmux-team/manager/daemon.ts:149–158

**問題**: `for await` ループを break しても `watcher.close()` が呼ばれないため、OS のファイルディスクリプタが残る。

**修正方針**:
```typescript
const watcher = watch(dir);
try {
  for await (const _event of watcher) {
    if (!state.running) break;
    state.wakeup?.();
  }
} catch (e: any) {
  log("error", `file watcher failed: dir=${dir} ${e.message}`);
} finally {
  watcher.close();
}
```

### 3. proxy.ts drainAndLog の未 catch（中優先度）

**ファイル**: skills/cmux-team/manager/proxy.ts:253

**問題**: `drainAndLog()` の Promise が await も .catch() もされておらず、unhandled rejection でプロセスがクラッシュする可能性がある。

**修正方針**:
```typescript
drainAndLog(logStream, { ... }).catch((e: any) =>
  log("error", `drainAndLog failed: ${e.message}`)
);
```

## 確認ポイント

- 修正後も daemon の通常動作（タスク割当・Conductor監視）が正常であること
- Conductor の再接続時に古い interval がクリアされること
- daemon 停止時に fs.watch が正しくクローズされること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-113-1775688941` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-113-1775688941
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-113-1775688941/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/113-daemon-ts-interval-fs-watch-proxy-ts/runs/task-113-1775688941
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/113-daemon-ts-interval-fs-watch-proxy-ts/runs/task-113-1775688941/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
