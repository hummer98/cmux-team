---
id: 218
title: cmux-team-investigate スキルにhookシグナル追跡手段を明記
priority: medium
created_at: 2026-04-15T17:42:57.389Z
depends_on: [217]
---

## タスク
## 背景
T216/T217 で trace DB の hook_signals テーブルと cmux-team trace-hooks コマンドが追加される。
調査用スキル（cmux-team-investigate）にこの追跡手段を記載する。

## やること
- .claude/skills/cmux-team-investigate/SKILL.md を更新
- 追記内容:
  - hook_signals テーブルの存在と用途
  - `cmux-team trace-hooks` コマンドでのhookシグナル追跡方法
  - 「どのhookが実際に発火したか」を調べる手順

## 依存
T217（trace-hooks コマンド追加）
