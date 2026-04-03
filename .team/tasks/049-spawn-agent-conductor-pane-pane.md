---
id: 049
title: spawn-agentがConductorのpaneではなくフォーカスpaneにタブを作成するバグ修正
priority: high
created_at: 2026-04-03T00:59:37.919Z
---

## タスク
## 概要
spawn-agent でサブエージェントのタブを作成する際、Conductor のペインではなく現在フォーカスのあるペイン（多くの場合 Master）にタブが追加されてしまう。

## 原因
cmdSpawnAgent() (main.ts) で cmux.newSurface() を呼ぶ際に paneId を渡していないパスがある。cmux は --pane 省略時にフォーカスペインを使用する。

spawn-agent CLI には --pane オプションがあり、team.json から conductor の paneId を lookup するコードもあるが、Conductor が spawn-agent を呼ぶ際に --pane を渡していない可能性が高い。

## 修正方針
1. cmdSpawnAgent() で conductor の paneId を確実に解決する（team.json lookup → getPaneIdForSurface() フォールバック）
2. cmux.newSurface(paneId) に paneId を渡す
3. Conductor テンプレートで spawn-agent 呼び出し時に --pane が渡されるようにする

## 対象ファイル
- skills/cmux-team/manager/main.ts — cmdSpawnAgent() の paneId 解決ロジック
- skills/cmux-team/templates/conductor.md — spawn-agent 呼び出し時の引数確認
