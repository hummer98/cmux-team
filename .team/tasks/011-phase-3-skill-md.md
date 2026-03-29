---
id: 011
title: Phase 3: SKILL.md — 通信方式・プロトコル記述の更新
priority: medium
created_at: 2026-03-29T06:43:04.507Z
---

## タスク
## 対象ファイル
- skills/cmux-team/SKILL.md

## 変更箇所（8箇所）
1. 通信方式テーブル (§0) — Conductor ← Agent の手段を read-screen から list-status に更新
2. §1 Master の行動原則 — cmux read-screen の記述を list-status に置換
3. §2.2 Conductor へのタスク割り当て — idle 判定を list-status で Idle に変更
4. §2.3 Conductor 監視 — フォールバック記述の更新
5. §3.3 Agent 起動 — 起動確認方法の更新
6. §3.4 Agent 監視 — read-screen → list-status に完全置換
7. §4 Agent プロトコル — 上位が cmux read-screen で検出する の更新
8. §5 通信プロトコル — cmux コマンド通信テーブルに list-status 追加

## 注意
read-screen を完全削除するのではなく、状態判定から画面内容取得に役割を再定義する。
