---
id: 072
title: Conductor 実装フローを4フェーズ（Plan→Design Review→TDD→Inspection）に刷新
priority: medium
created_at: 2026-04-04T13:46:40.022Z
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

```
Phase 1: Plan（計画） → Planner Agent
Phase 2: Design Review（設計レビュー） → Design Reviewer Agent
Phase 3: TDD Implementation（テスト駆動実装） → Implementer Agent
Phase 4: Inspection（検品） → Inspector Agent
```

### 設計原則

- **生成と批評の分離**: 同一セッションで生成物を自己レビューさせない。生成バイアス（確証バイアス、anchoring、sycophancy の変形）を避けるため、生成する Agent と批評する Agent を分ける
- **フロー分岐**: 全タスクに4フェーズを適用するのではなく、Conductor がタスク複雑度を判断してフロー深度を変える

## 変更内容

### 1. テンプレート追加・変更

| ファイル | 操作 | 内容 |
|---------|------|------|
| templates/planner.md | 新規 | 実装計画書（plan.md）を作成。課題分析・技術アプローチ・変更対象・サブタスク分割・リスク |
| templates/design-reviewer.md | 新規 | plan.md をレビュー。観点: 根本対策か / AI の手抜き防止 / 設計原則(DRY,SSOT) / セキュリティ / 既存パターン整合 |
| templates/implementer.md | 改修 | TDD サイクル（RED→GREEN→REFACTOR→VERIFY）を明示的に指示。テスト基盤がない場合の手動検証フォールバック |
| templates/inspector.md | 新規 | 5観点で GO/NOGO 判定: 計画充足 / Dead・Zombie Code / テスト / 設計原則 / 統合 |
| templates/tester.md | 削除 | TDD により Implementer に統合 |
| templates/reviewer.md | 削除 | Design Reviewer と Inspector に役割分割 |

### 2. conductor-role.md のフェーズ実行を更新

現在の7ステップを4フェーズに書き換え:

- Phase 1: Planner Agent spawn → plan.md 生成 → git commit + .team/output/ にもコピー
- Phase 2: Design Reviewer Agent spawn → Approved / Changes Requested（最大2往復）
- Phase 3: Implementer Agent spawn（TDD）
- Phase 4: Inspector Agent spawn → GO/NOGO（NOGO 時は修正→再検品、最大2回）

### 3. Conductor のフロー分岐ロジック追加

conductor-role.md にタスク複雑度の判断基準を追加:

- **軽微**（typo, 設定変更, ドキュメント修正）→ Implementer のみ
- **中規模以上**（機能追加, バグ修正, リファクタリング）→ 全4フェーズ

### 4. Design Reviewer のレビュー観点（sdd-orchestrator の design-principles.md から蒸留）

1. **根本対策か**: 場当たり的な対症療法ではないか（緊急対応を除く）
2. **AI の手抜き防止**: 「変更が大きい」「影響範囲が広い」を理由に妥協していないか。AI に工数の概念はない
3. **設計原則**: DRY / SSOT / 不要な複雑さ
4. **セキュリティ**: コマンドインジェクション、パス traversal 等
5. **既存パターンとの整合性**: コードベースの慣習に沿っているか

### 5. Inspector の GO/NOGO 判定基準

| 観点 | 確認方法 | Severity |
|------|---------|----------|
| 計画充足 | plan.md の各項目が実装されているか | Critical if 未実装 |
| Dead/Zombie Code | 不要コード残存、旧実装との並行 | Major |
| テスト | 存在・通過・既存テスト未破壊 | Critical if 破壊 |
| 設計原則 | DRY / SSOT / 不要な複雑さ | Major |
| 統合 | エントリーポイント接続、import 整合 | Critical if 未接続 |

- **GO**: Critical 0 件 AND Major 2 件以下
- **NOGO**: Critical あり OR Major 3 件以上

## 参考

- ~/git/sdd-orchestrator の spec-impl, spec-inspection, design-principles.md
- 「生成と批評の分離」の設計判断（同一セッション内の自己レビューは生成バイアスにより機能しにくい）

## 確認ポイント

- Conductor が軽微タスクと中規模タスクでフロー深度を切り替えること
- plan.md が worktree 内に git commit され、.team/output/ にもコピーされること
- Design Reviewer が Planner とは別セッションで動作すること
- Implementer が TDD（テスト先行）で進めること
- Inspector が GO/NOGO を明確に判定し、NOGO 時に修正→再検品が回ること
