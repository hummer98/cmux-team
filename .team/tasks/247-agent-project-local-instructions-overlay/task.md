---
id: 247
title: Agent ロール別 project-local instructions overlay 機構の追加
priority: medium
created_by: surface:47
created_at: 2026-04-17T11:20:45.107Z
---

## タスク
## 背景

実装/検査系の Agent（Planner / Design-reviewer / Implementer / Inspector 等）にプロジェクト固有の追加指示を渡せるようにしたい。現状はテンプレートが配布物（npm パッケージ）で固定されており、プロジェクト固有の規約（命名・テスト方針・禁止パターン等）を反映する手段がない。

## 設計方針（Master ↔ ユーザー合意済み）

- **対象**: 全 Agent ロール（researcher, architect, planner, design-reviewer, implementer, inspector, dockeeper, task-manager）。4 ロールに限定しない
- **適用タイミング**: spawn-agent のプロンプト生成時に overlay を読み取り展開（起動スナップショット方式 — 実行中の変更は反映しない）
- **git 管理**: する（`.team/.gitignore` に追加しない）。チーム全員で overlay を共有できる
- **TUI**: 閲覧のみ（read-only）。編集は CLI 経由

## 要求される挙動

### 1. ストレージ

```
.team/agent-instructions/
├── planner.md
├── design-reviewer.md
├── implementer.md
├── inspector.md
├── researcher.md
├── architect.md
├── dockeeper.md
└── task-manager.md
```

- 各ファイルはプレーンな Markdown（frontmatter なし、任意の本文）
- 該当ファイルが無ければ overlay なしとして扱う

### 2. テンプレート統合

- 全 Agent ロールテンプレート（`skills/cmux-team/templates/ja/*.md` と `templates/en/*.md`）に `{{PROJECT_INSTRUCTIONS}}` プレースホルダを追加
- 適切な位置: ロール固有指示の後、タスク本文（`{{TASK_DESCRIPTION}}`）の前あたり
- テンプレート展開時（`skills/cmux-team/manager/template.ts`）に `.team/agent-instructions/<role>.md` を読み取り:
  - ファイル有: 内容を展開（前後に適切な区切り見出し、例: `## プロジェクト固有の追加指示`）
  - ファイル無: 空文字に置換（余分な空行を残さない）

### 3. CLI（`skills/cmux-team/manager/main.ts`）

- `cmux-team get-agent-instructions --role <role>` — 現在の overlay 内容を出力（無ければ空文字 + exit 0）
- `cmux-team set-agent-instructions --role <role> --body "..."` — 上書き保存
- `cmux-team set-agent-instructions --role <role> --from-file <path>` — ファイルから読み込んで保存
- `cmux-team delete-agent-instructions --role <role>` — 削除
- `cmux-team list-agent-instructions` — 全ロール × overlay 有無を一覧表示（例: `implementer ✓ 142 bytes` / `inspector ✗`）

role の値は許容リストで検証（上記 8 ロール）。未知ロールはエラー。

### 4. TUI Settings タブ（`dashboard.tsx`）

- 既存ダッシュボードに新タブ `Settings` を追加（キーボードショートカットで切替）
- レイアウト（推奨）:
  - 左カラム: 設定項目一覧
    - セクション 1: `Agent Instructions` — ロール一覧 + overlay 有無（`✓`/`✗`）
    - セクション 2: `Project Config` — `.team/config.json` の主要フィールド（layout, autoUpdate, mainBranch）
  - 右カラム: 選択項目の内容プレビュー（read-only）
- 編集はせず「編集するには `cmux-team set-agent-instructions --role <role>` を実行」と表示

### 5. スキル（対話向け）

- 既存の `cmux-team` スキルに「overlay の用途・編集方法」を追記
- 会話中に Master が「この規約は overlay に追加しましょうか？」と提案できるよう、SKILL.md に典型パターンを記載

## 実装範囲

### コード
- `skills/cmux-team/manager/main.ts` — CLI 4 コマンド追加（`get/set/delete/list-agent-instructions`）
- `skills/cmux-team/manager/template.ts` — `{{PROJECT_INSTRUCTIONS}}` の展開ロジック
- `skills/cmux-team/manager/dashboard.tsx` — Settings タブ実装
- （必要なら）`skills/cmux-team/manager/schema.ts` — role enum の共通化

### テンプレート
- `skills/cmux-team/templates/ja/{researcher,architect,planner,design-reviewer,implementer,inspector,dockeeper,task-manager}.md` — `{{PROJECT_INSTRUCTIONS}}` プレースホルダ追加
- `skills/cmux-team/templates/en/` 配下も同様

### ドキュメント
- `CLAUDE.md` — 「テンプレート変数仕様」節に `{{PROJECT_INSTRUCTIONS}}` を追加、新セクション「Agent Instructions overlay」を追加
- `docs/spec/04-templates.md` — プレースホルダ一覧に追加
- `docs/spec/03-commands.md` — 新 CLI 4 つを追記
- `docs/spec/01-skill-cmux-team.md` — overlay の概念を追記
- `README.md` / `README.ja.md` — ユーザー向けの概要説明を追加

### スキル
- `skills/cmux-team/SKILL.md` — overlay の用途・ユースケース・Master による提案パターンを追記

## 検証観点

- 8 ロール全てのテンプレート（ja/en）に `{{PROJECT_INSTRUCTIONS}}` が含まれる
- overlay ファイルがある場合、生成されるプロンプト（`.team/prompts/*.md`）に内容が展開される
- overlay ファイルが無い場合、プロンプトに余分な空行や `{{...}}` 残骸が残らない
- CLI `get/set/delete/list` の round-trip が正しい
- CLI が未知ロール名を拒否する
- TUI Settings タブでロール一覧と overlay 内容が表示される
- Settings タブから編集できない（read-only）こと
- `.team/agent-instructions/` が git 管理対象（`.team/.gitignore` に追加されない）
- CLI 出力（list）のフォーマットが人間可読

## 未決事項（実装時に判断）

- overlay 内容の最大サイズ制限（過剰に大きい場合の警告）
- overlay 内で `{{VARIABLE}}` 記法を使えるようにするか（再帰展開は複雑化するため、初版は禁止でよい）
- TUI Settings タブのキーボードショートカット（`s`? 既存タブと衝突しないもの）
