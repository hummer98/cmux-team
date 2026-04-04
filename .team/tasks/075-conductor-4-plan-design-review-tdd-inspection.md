---
id: 075
title: Conductor 実装フローを4フェーズ（Plan→Design Review→TDD→Inspection）に刷新
priority: medium
created_at: 2026-04-04T13:47:14.638Z
---

## タスク
## 背景

現在の Conductor は実装系タスクを受けると、汎用的な Implementer/Reviewer/Tester Agent を spawn するが、以下の問題がある:

- 実装前に設計/計画書がなく、後からタスクの意図を追跡できない
- AI が「変更が大きい」「影響範囲が広い」を理由に場当たり的な対処をしがち
- テスト作成と実装が分離されており TDD になっていない
- Review が意見交換的で、検品（合否判定）になっていない

## ゴール

Conductor の実装系タスクフローを以下の4フェーズに刷新する:

Phase 1: Plan（計画） → Planner Agent
Phase 2: Design Review（設計レビュー） → Design Reviewer Agent
Phase 3: TDD Implementation（テスト駆動実装） → Implementer Agent
Phase 4: Inspection（検品） → Inspector Agent

### 設計原則

- 生成と批評の分離: 同一セッションで生成物を自己レビューさせない。生成バイアスを避けるため、生成する Agent と批評する Agent を分ける
- フロー分岐: 全タスクに4フェーズを適用するのではなく、Conductor がタスク複雑度を判断してフロー深度を変える

## 変更内容

### 1. テンプレート追加・変更

- templates/planner.md (新規): 実装計画書（plan.md）を作成
- templates/design-reviewer.md (新規): plan.md をレビュー
- templates/implementer.md (改修): TDD サイクル（RED→GREEN→REFACTOR→VERIFY）
- templates/inspector.md (新規): 5観点で GO/NOGO 判定
- templates/tester.md (削除): TDD により Implementer に統合
- templates/reviewer.md (削除): Design Reviewer と Inspector に役割分割

### 2. conductor-role.md のフェーズ実行を更新

### 3. Conductor のフロー分岐ロジック追加
- 軽微（typo, 設定変更）→ Implementer のみ
- 中規模以上 → 全4フェーズ

### 4. Design Reviewer のレビュー観点
1. 根本対策か（場当たり的対症療法でないか）
2. AI の手抜き防止（工数を理由に妥協していないか）
3. 設計原則（DRY / SSOT / 不要な複雑さ）
4. セキュリティ
5. 既存パターンとの整合性

### 5. Inspector の GO/NOGO 判定基準
- GO: Critical 0件 AND Major 2件以下
- NOGO: Critical あり OR Major 3件以上

## 参考
- ~/git/sdd-orchestrator の spec-impl, spec-inspection, design-principles.md
