---
id: 005
title: TUI ダッシュボードの Agent 欄に taskTitle を表示
priority: high
created_at: 2026-03-29T06:00:02.151Z
---

## タスク
## 目的

TUI ダッシュボードの Agent 表示が role のみ（impl, docs 等）で、何の作業をしているか分からない。taskTitle を表示する。

## 現状
├─ [396] impl
├─ [397] docs

## 期待
├─ [396] ⚙ docs/seeds 仕様書同期
├─ [397] 📝 specs 仕様書同期

## 変更箇所

### 1. schema.ts — AGENT_SPAWNED メッセージに taskTitle を追加
- AgentSpawnedMessage に taskTitle: z.string().optional() を追加

### 2. main.ts — spawn-agent で taskTitle を送信
- cmdSpawnAgent() の AGENT_SPAWNED メッセージ送信部分に taskTitle を追加（既に変数として存在）

### 3. daemon.ts — agent push 時に taskTitle を保存
- conductor.agents.push に taskTitle を含める

### 4. dashboard.tsx — Agent 表示に taskTitle を使用
- 275行目の {a.role && <Text> {a.role}</Text>} を taskTitle 優先表示に変更
- role アイコン + taskTitle のフォーマット

## 注意
- spawn-agent の --task-title 引数は既に存在する（タブ名に使用済み）。daemon 通知に含めるだけ
