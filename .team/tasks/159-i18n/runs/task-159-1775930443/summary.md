# Task 159: エージェントプロンプトテンプレートの i18n 対応 — 完了サマリー

## 判定: GO（検品合格）

## 完了したサブタスク

1. Phase 1: Plan — ディレクトリ分離方式を選択、実装計画書作成
2. Phase 2: Design Review — Changes Requested → 計画修正 → Approved 相当
3. Phase 3: Implementation — 全 Step 実装完了（13分32秒）
4. Phase 4: Inspection — 全6チェック PASS、GO 判定

## 設計判断

- **ディレクトリ分離方式**（`templates/ja/`, `templates/en/`）を採用
- `findTemplateDir()` のみ変更、呼び出し側3関数はエラーメッセージ置き換えのみ
- `resolveLocalizedDir()` ヘルパーで重複ロジックを共通化
- デフォルト言語は英語、ja 検出失敗時は en にフォールバック

## 変更ファイル一覧（31ファイル、+1306/-14行）

### 修正
- `skills/cmux-team/manager/template.ts` — ロケール解決ロジック追加
- `skills/cmux-team/manager/i18n.ts` — エラーメッセージ3件追加

### 移動（ja/ へ）
- conductor-role.md, conductor-task.md, conductor.md, design-reviewer.md, implementer.md, inspector.md, manager.md, master.md, planner.md（9ファイル）

### 移動（en/ へ）
- architect.md, common-header.md, dockeeper.md, researcher.md, task-manager.md（5ファイル）

### 新規作成（en/）
- conductor-role.md, conductor-task.md, conductor.md, design-reviewer.md, implementer.md, inspector.md, manager.md, master.md, planner.md（9ファイル）

### 新規作成（ja/）
- architect.md, common-header.md, dockeeper.md, researcher.md, task-manager.md（5ファイル）

## マージ

ローカルマージ完了: `task-159-1775930443/task` → `main`
