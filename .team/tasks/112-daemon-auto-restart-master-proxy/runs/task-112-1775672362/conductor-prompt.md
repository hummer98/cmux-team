# タスク割り当て

## タスク内容

---
id: 112
title: daemon_auto_restart 後に Master が proxy を見失う問題を修正
priority: high
created_at: 2026-04-08T18:17:56.506Z
---

## 問題

`daemon_auto_restart` または `daemon_reload` 後に、既存の Master セッションが proxy を見失いハングする。

### 再現した事象（2026-04-09 03:00頃）

```
03:00:04 - daemon_auto_restart
03:00:05 - proxy_started port=60372  ← 新プロキシが起動（旧は終了済み）
03:00:07 - master_alive surface=surface:22  ← Masterは生きているが proxy 更新されず
03:06:09 - master_prompt_generated  ← ユーザーが手動で spawn-master を実行（回避策）
```

Master が API コールを送ってもレスポンスが返ってこずハング。ユーザーが手動 spawn-master で回避。

## 根本原因

`daemon_auto_restart` 時に旧プロキシが終了し、新プロキシが別のポートで起動する可能性がある。`startMaster()` は master_alive を確認して再 spawn をスキップするが、既存 Master の `ANTHROPIC_BASE_URL` は古いポートのまま更新されない。今回はたまたま同じポート(60372)が再利用されたが、OSのポート割り当ては保証されない。

加えて、`spawn-master`（`cmdLaunchMaster`）実行時に何のポートで `ANTHROPIC_BASE_URL` を設定したかがログに残っておらず、診断が困難。

## 修正方針

**修正案 A（推奨）**：proxy ポートの変化を検知したら Master を自動再起動する。

main.ts のプロキシ起動部分で前回ポートと新ポートを比較し、変化があれば master_port_changed をログして Master を再起動する。

**修正案 B**：proxy ポートを固定（設定可能）にし、暗黙のポート変更を防ぐ。

## 追加すべきログ（診断用）

1. proxy_port_changed prev=60372 new=60373 — ポート変化の検知
2. proxy_reused_check port=60372 alive=true/false — alive チェック結果
3. master_spawn_proxy port=60372 — spawn-master 実行時に設定した ANTHROPIC_BASE_URL のポート（現在ログなし）
4. master_spawn_proxy_missing — resolveProxyPort() が undefined を返したまま spawn を続けた場合

## 対象ファイル

- skills/cmux-team/manager/main.ts — proxy 起動後のポート変化検知、cmdLaunchMaster にログ追加
- skills/cmux-team/manager/daemon.ts — startMaster() に proxy ポート変化時の Master 再起動ロジック追加


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-112-1775672362` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-112-1775672362
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-112-1775672362/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/112-daemon-auto-restart-master-proxy/runs/task-112-1775672362
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/112-daemon-auto-restart-master-proxy/runs/task-112-1775672362/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
