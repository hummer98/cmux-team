# 実装計画: メモリリーク修正

## 概要
daemon.ts と proxy.ts の3箇所のメモリリーク/リソースリークを修正する。

## 修正箇所

### 1. spawnPidWatcher の interval 重複（daemon.ts:653-679）

**問題**: SESSION_STARTED を受け取るたびに新しい setInterval が作成されるが、古い interval への参照が失われる。

**修正**:
- ConductorState に `pidWatcherInterval?: ReturnType<typeof setInterval>` フィールドを追加（schema.ts）
- spawnPidWatcher() 呼び出し前に既存の interval を clearInterval する

### 2. spawnMasterPidWatcher の interval 重複（daemon.ts:681-702）

**問題**: Master の SESSION_STARTED でも同様の問題。

**修正**:
- DaemonState に `masterPidWatcherInterval?: ReturnType<typeof setInterval>` フィールドを追加
- spawnMasterPidWatcher() 呼び出し前に既存の interval を clearInterval する

### 3. fs.watch の未クローズ（daemon.ts:138-157）

**問題**: `for await` ループを break しても `watcher.close()` が呼ばれない。

**修正**:
- watch() の返り値を変数に保持
- try/finally で watcher.close() を呼ぶ

### 4. proxy.ts drainAndLog の未 catch（proxy.ts:253）

**問題**: drainAndLog() の Promise に catch がなく、unhandled rejection の可能性。

**修正**:
- `.catch((e) => log("error", ...))` を追加

## 変更対象ファイル
- skills/cmux-team/manager/daemon.ts
- skills/cmux-team/manager/proxy.ts

## 確認ポイント
- daemon の通常動作（タスク割当・Conductor監視）が正常であること
- Conductor の再接続時に古い interval がクリアされること
- daemon 停止時に fs.watch が正しくクローズされること
