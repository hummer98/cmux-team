---
id: 016
title: Conductor テンプレートにレビュー判断ステップを追加
priority: medium
status: ready
created_at: 2026-03-24T16:40:00Z
---

## タスク

Conductor テンプレート (`skills/cmux-team/templates/conductor.md`) のフェーズ実行に、レビュー判断ステップを追加する。

Conductor 自身がタスクの性質を判断し、コード変更を伴う場合のみ Reviewer Agent を起動する。

### 変更内容

1. `templates/conductor.md` のフェーズ実行セクションを更新:
   - 「結果統合」の後に「レビュー判断」ステップを追加
   - コード変更がある場合（`git diff` で検出）→ Reviewer Agent を起動
   - 調査・ドキュメントのみの場合 → レビューをスキップ

2. Reviewer Agent の起動手順を記述:
   - Agent 起動と同じ方法（`cmux new-split` + `claude --dangerously-skip-permissions`）
   - レビュー指示: worktree の diff を確認し、問題があれば指摘
   - Conductor がレビュー結果を確認し、必要に応じて修正 Agent を再起動

### 設計方針

- Conductor テンプレートは 1本のまま。ロール別の特殊化はしない
- レビューが必要かの判断は Conductor の自律判断に委ねる
- 判断基準の例: `cd {{WORKTREE_PATH}} && git diff --stat` の出力にコードファイルの変更があるか
- `spawn-conductor.sh` の変更は不要

## 対象ファイル

- `skills/cmux-team/templates/conductor.md`

## 完了条件

- Conductor テンプレートにレビュー判断ステップが追加されていること
- コード変更を伴うタスクでのみレビューが走る判断基準が明記されていること
- テンプレートが 1本のまま維持されていること（特殊化していないこと）
