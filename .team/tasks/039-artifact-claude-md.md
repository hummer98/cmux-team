---
id: 039
title: /artifact スキル + フロントマター規約 + CLAUDE.md 追記
priority: medium
created_at: 2026-04-02T06:47:06.818Z
---

## タスク
## タスク

Artifacts システムの基盤構築。会話中の知見を構造化して保存する仕組みを作る。

## 背景

リサーチや対話の内容がタスクや issue として明示的に出力しない限り失われる。ログは存在するが、人間が認知するのに最適な粒度のレポートや、AIが次のセッションで参照する中間生成物が必要。

## 成果物

1. commands/artifact.md — /artifact スラッシュコマンド
2. フロントマター仕様の確定（id, type, title, created, updated, author, task, tags）
3. CLAUDE.md に Artifacts 規約セクション追記
4. skills/cmux-agent-role/SKILL.md に Artifact 出力ガイドライン追記

## 仕様

- 配置先: .team/artifacts/Axxx-slug.md
- 採番: 既存最大番号 + 1（A001〜、ゼロ埋め3桁）
- type: research | decision | session | spec | report
- /artifact [type] "タイトル" で会話コンテキストから要約生成・保存
- /artifact list で一覧、/artifact show Axxx で内容表示
