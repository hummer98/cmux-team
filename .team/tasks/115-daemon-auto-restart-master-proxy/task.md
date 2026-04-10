---
id: 115
title: daemon_auto_restart 後に Master が proxy を見失う問題を修正
priority: high
created_at: 2026-04-08T23:05:22.537Z
---

## タスク
## 概要

T112 の再投入（前セッションで Conductor クラッシュにより未完了）。

## 問題

`daemon_auto_restart` または `daemon_reload` 後に、既存の Master セッションが proxy を見失いハングする。

### 再現した事象（2026-04-09 03:00頃）

```
03:00:04 - daemon_auto_restart
03:00:05 - proxy_started port=60372  ← 新プロキシが起動（旧は終了済み）
03:00:07 - master_alive surface=surface:22  ← Masterは生きているが proxy 更新されず
03:06:09 - master_prompt_generated  ← ユーザーが手動で spawn-master を実行（回避策）
```

## 根本原因

`daemon_auto_restart` 時に旧プロキシが終了し、新プロキシが別のポートで起動する可能性がある。`startMaster()` は master_alive を確認して再 spawn をスキップするが、既存 Master の `ANTHROPIC_BASE_URL` は古いポートのまま更新されない。

## 修正方針（推奨: 修正案A）

proxy ポートの変化を検知したら Master を自動再起動する。main.ts のプロキシ起動部分で前回ポートと新ポートを比較し、変化があれば `master_port_changed` をログして Master を再起動する。

## 追加すべきログ

1. `proxy_port_changed prev=60372 new=60373` — ポート変化の検知
2. `master_spawn_proxy port=60372` — spawn-master 実行時に設定した ANTHROPIC_BASE_URL のポート

## 対象ファイル

- `skills/cmux-team/manager/main.ts` — proxy 起動後のポート変化検知、cmdLaunchMaster にログ追加
- `skills/cmux-team/manager/daemon.ts` — startMaster() に proxy ポート変化時の Master 再起動ロジック追加
