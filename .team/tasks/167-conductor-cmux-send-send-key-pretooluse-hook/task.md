---
id: 167
title: Conductor の cmux send/send-key を PreToolUse hook で全面禁止
priority: medium
created_at: 2026-04-12T04:00:18.854Z
---

## タスク
## 目的

Conductor が cmux send / cmux send-key で他 surface を直接操作する問題を
PreToolUse hook でブロックする。

参照: hummer98/cmux-team#21

## やること

1. `generateConductorSettings()` に PreToolUse hook を追加
   - ファイル: `skills/cmux-team/manager/main.ts`
   - Bash tool の `command` に `cmux send` または `cmux send-key` が含まれる場合、
     exit code 2 でブロック
   - エラーメッセージ例:
     「cmux send / cmux send-key は Conductor から使用禁止です。
       エージェント起動は cmux-team spawn-agent を使ってください。」

2. hook の形式を確認して正しい JSON 構造で生成する
   - 既存の Conductor settings 生成コードを参照
   - PreToolUse の matcher は "Bash"

3. mado 等の実プロジェクトで動作確認
   - Conductor が spawn-agent を呼んだ場合は通過すること
   - Conductor が cmux send を呼んだ場合はブロックされること

## 完了条件

- hook が Conductor の settings.json に出力される
- cmux send を含む Bash tool_use がブロックされる
- spawn-agent / kill-agent / read-screen などの正当な操作は通過する

## 注意（経過観察）

影響が完全には読めないため、デプロイ後は以下を観察すること:
- hook ブロックが過剰に発生していないか
- Conductor がタスクを完遂できているか
- 問題が多発する場合は禁止対象を絞る（/exit のみ等）方向で再検討
