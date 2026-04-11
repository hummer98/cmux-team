---
id: 159
title: エージェントプロンプトテンプレートの i18n 対応
priority: medium
depends_on: [158]
created_at: 2026-04-11T18:00:43.498Z
---

## タスク
## 背景

CLI help（i18n.ts）と README は日英対応済みだが、エージェントプロンプトテンプレート（templates/*.md）は日本語固定。英語圏ユーザーが使えない。

## 対象テンプレート（14ファイル）

skills/cmux-team/templates/ 配下:
architect.md, common-header.md, conductor-role.md, conductor-task.md, conductor.md, design-reviewer.md, dockeeper.md, implementer.md, inspector.md, manager.md, master.md, planner.md, researcher.md, task-manager.md

## やること

1. 各テンプレートの英語版を作成する
2. テンプレート展開時（template.ts）に locale を検出して適切な言語のテンプレートを選択する仕組みを実装
3. 言語検出は既存の i18n.ts の detectLocale() を再利用する

## 設計方針の検討（Agent に委ねる）

以下のいずれかのアプローチを調査・選択すること:

- **ファイル分離方式**: `templates/ja/master.md` と `templates/en/master.md` のようにディレクトリで分離
- **サフィックス方式**: `master.ja.md` / `master.en.md`
- **単一ファイル + セクション方式**: 1ファイル内で言語を切り替え

既存の template.ts のテンプレート読み込みロジックへの影響が最小になる方式を選ぶこと。

## 注意

- CLAUDE.md のコーディング規約に「テンプレートは `{{VARIABLE}}` プレースホルダーを使用」とあり、変数展開の仕組みは維持すること
- テンプレートの内容（指示の意味）は日英で同等であること。意訳はOKだが指示の省略・追加はNG
- デフォルト言語は英語（en）。ja の検出に失敗した場合は英語にフォールバック
