---
id: 213
title: Conductor の merge 先ブランチを config で指定可能にする
priority: high
created_at: 2026-04-15T17:00:41.585Z
---

## タスク
## 背景

現在の Conductor プロンプト（`conductor-role.md` / `conductor-task.md`）は暗黙的に `main` ブランチへマージする前提になっている。しかしプロジェクトによっては `develop` / `master` / 独自名のブランチを主開発ブランチとして使うため、プロジェクト毎に設定できるようにしたい。

## 仕様

### config への追加

- `.team/config.json` に `mainBranch`（string）フィールドを追加
- 優先順位: **明示設定（config） > 自動検出 > フォールバック（`main`）**
- `cmux-team start` 時に `mainBranch` が未設定なら以下の手順で自動検出し config に書き込む:
  1. `git symbolic-ref refs/remotes/origin/HEAD` で origin のデフォルトブランチを取得
  2. 失敗したら現在の HEAD が指すブランチ名を試す
  3. それも失敗したら `main` にフォールバックし `log("main_branch_fallback", ...)` で警告
- 検出結果は config に永続化（次回起動時の再検出を避ける）

### テンプレート変数の注入

- `template.ts` に `{{MAIN_BRANCH}}` プレースホルダーを追加
- Conductor プロンプト生成時に config の `mainBranch` を置換

### テンプレート修正

以下のテンプレートの「main にマージ」「main ブランチ」等の記述を `{{MAIN_BRANCH}}` に置換:

- `skills/cmux-team/templates/conductor-role.md`
- `skills/cmux-team/templates/conductor-task.md`
- `skills/cmux-team/templates/ja/conductor-role.md`
- `skills/cmux-team/templates/ja/conductor-task.md`
- `skills/cmux-team/templates/en/conductor-role.md`
- `skills/cmux-team/templates/en/conductor-task.md`

（該当する全箇所をまず grep で洗い出すこと。`main` という文字列は他の文脈でも出現するため機械的な置換ではなく意味的な判断が必要）

### schema / ロガー更新

- `schema.ts` の config スキーマに `mainBranch: z.string().optional()` を追加
- 起動時ログ: `main_branch_resolved branch=<name> source=<config|detected|fallback>`

## 変更対象ファイル（要調査）

- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/main.ts` または `daemon.ts`（config 読み込み・自動検出）
- `skills/cmux-team/manager/template.ts`（テンプレート変数置換）
- `skills/cmux-team/manager/conductor.ts`（プロンプト生成呼び出し箇所）
- 上記 6 つの conductor テンプレート
- `CLAUDE.md` の「テンプレート変数仕様」に `{{MAIN_BRANCH}}` を追記
- `docs/spec/04-templates.md` の該当箇所を更新

## 確認ポイント

1. **既存プロジェクト（main ブランチ）**: 起動時に自動検出され config に `"mainBranch": "main"` が書き込まれる。Conductor プロンプトで main が参照される
2. **develop ブランチ運用**: `.team/config.json` に `"mainBranch": "develop"` を手動設定すると Conductor プロンプトに反映される
3. **origin/HEAD 未設定**: フォールバックが動き警告ログが出る
4. **後方互換性**: 既存の `.team/config.json` に `mainBranch` がなくても正常動作する（=自動検出される）

## 非対象（やらないこと）

- `cmux-team config set main-branch <name>` のような CLI サブコマンドの追加（初手は config 直接編集で十分。必要になったら別タスクで）
- `mainBranch` 以外の git 関連 config の追加
