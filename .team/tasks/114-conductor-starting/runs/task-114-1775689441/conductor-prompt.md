# タスク割り当て

## タスク内容

---
id: 114
title: Conductor starting状態のステート遷移バグ修正
priority: high
created_at: 2026-04-08T23:04:01.026Z
---

## タスク
## 概要

Conductor が starting 状態のまま disconnected にフォールバックし、タスクを受け付けられなくなるバグを修正する。

## 原因分析

3つの問題が重なっている:

### Bug 1: レースコンディション — SESSION_STARTED が CONDUCTOR_REGISTERED より先に到着

`launchConductorOnSurface` で `cmux.send`（シェルコマンド送信）→ `renameTab` → `fetch(CONDUCTOR_REGISTERED)` の順で実行されるが、シェルコマンドが即座に実行され Claude が高速起動すると、SessionStart(startup) hook の SESSION_STARTED が CONDUCTOR_REGISTERED より先に daemon に届く。`findConductor()` が undefined を返し SESSION_STARTED が無視される。

**修正**: `launchConductorOnSurface` 内で `CONDUCTOR_REGISTERED` の HTTP POST を `cmux.send` の**前**に移動する（または `conductors.set()` を直接呼んでからシェルコマンドを送信）。

### Bug 2: SESSION_IDLE / SESSION_ACTIVE / SESSION_CLEAR が starting 状態を処理しない

daemon.ts の各ハンドラ:
- SESSION_IDLE (L541): `conductor.status === "disconnected"" のみチェック → starting を無視
- SESSION_ACTIVE (L520): 同上
- SESSION_CLEAR (L555): 同上

SESSION_STARTED が失われても SESSION_IDLE で starting → idle に遷移できるはずが、条件分岐に starting がないため遷移しない。

**修正**: 各ハンドラに `conductor.status === "starting"" の条件を追加。遷移先は idle（タスク未割当のため）。SESSION_ACTIVE の場合も idle にすること（disconnected → running とは意味が異なる）。

### Bug 3: /clear 後に SESSION_STARTED が送信されない

SessionStart hook の matcher が `"startup"` のみ。/clear は SessionEnd(clear) → SessionStart を発火するが、startup matcher にはマッチしない。そのため /clear 後も SESSION_STARTED が送られず復帰できない。

**修正**: Bug 2 の修正で SESSION_IDLE/SESSION_CLEAR 経由で復帰可能になるため、Bug 3 は Bug 2 の修正でカバーされる。追加の SessionStart hook は不要。

## 追加すべきログ

- SESSION_STARTED ハンドラで conductor が見つからない場合: `session_started_ignored surface=XXX reason=conductor_not_found`
- 各ハンドラで starting → idle 遷移時: `conductor_ready surface=XXX via=SESSION_IDLE` 等

## A003 との整合性

確認済み。Conductor が idle に確実に遷移することで、タスクの ready → assigned 消化が改善される。Task ステート遷移への悪影響なし。

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts` — SESSION_IDLE/SESSION_ACTIVE/SESSION_CLEAR ハンドラ修正 + ログ追加
- `skills/cmux-team/manager/conductor.ts` — launchConductorOnSurface の CONDUCTOR_REGISTERED 送信順序修正


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-114-1775689441` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-114-1775689441
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-114-1775689441/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/114-conductor-starting/runs/task-114-1775689441
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/114-conductor-starting/runs/task-114-1775689441/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
