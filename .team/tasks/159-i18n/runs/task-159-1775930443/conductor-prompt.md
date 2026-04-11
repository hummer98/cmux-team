# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-159-1775930443` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-159-1775930443
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-159-1775930443/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/159-i18n/runs/task-159-1775930443
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/159-i18n/runs/task-159-1775930443/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
