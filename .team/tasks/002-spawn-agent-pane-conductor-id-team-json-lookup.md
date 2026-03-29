---
id: 002
title: spawn-agent: pane を直接渡す方式に変更（conductor_id による team.json lookup 廃止）
priority: high
created_at: 2026-03-29T05:49:39.767Z
---

## タスク
## 目的

spawn-agent で Agent のタブを作成する際、conductor_id から team.json を lookup して paneId を取得する間接的な方式を廃止し、Conductor が自分の pane を直接渡す方式に変更する。

## 背景

- 現状: spawn-agent は --conductor-id で team.json を検索し paneId を取得 → paneId が見つからないとペイン分割にフォールバック
- 問題: daemon が設定する conductor_id（run-*）と team.json の slot ID（conductor-slot-*）が不一致の場合、paneId が解決できずタブではなくペイン分割になる
- 根本原因: conductor_id を pane 解決に使うのが間接的で脆い

## 変更内容

### 1. spawn-agent CLI に --pane オプション追加
- main.ts の cmdSpawnAgent() に --pane パラメータを追加
- --pane が指定されていれば cmux.newSurface(paneId) を直接呼ぶ
- --pane がなければ従来のフォールバック（team.json lookup → split）

### 2. Conductor テンプレート更新
- templates/conductor.md の Agent 起動手順を更新
- spawn-agent 呼び出しに --pane を追加
- pane の取得方法を記載（CMUX_PANE 環境変数 or cmux コマンド）

### 3. conductor_id の役割整理
- conductor_id は daemon への AGENT_SPAWNED 通知用にのみ使用
- pane 解決には使わない
- team.json lookup は --pane 未指定時のフォールバックとして残す

## テスト確認項目
- --pane 指定時: Agent がタブとして正しく作成されること
- --pane 未指定時: 従来のフォールバック動作が維持されること
