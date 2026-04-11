# Inspection Report: テンプレート i18n 対応

## 判定: GO

## サマリー

テンプレート i18n 対応の実装は計画書に沿って正確に実施されている。ディレクトリ分離方式の採用、template.ts のロケール解決ロジック、i18n.ts のエラーメッセージ追加、全14テンプレートの日英対応、パッケージング設定のいずれも適切に実装されており、検品基準を満たしている。

## チェック結果

### 1. 構造検証: PASS

- `templates/` 直下に .md ファイルが存在しないことを確認 (Glob で `templates/*.md` が 0 件)
- `templates/ja/` に14ファイル存在: architect.md, common-header.md, conductor-role.md, conductor-task.md, conductor.md, design-reviewer.md, dockeeper.md, implementer.md, inspector.md, manager.md, master.md, planner.md, researcher.md, task-manager.md
- `templates/en/` に14ファイル存在: 同上の14ファイル
- `diff <(ls ja/ | sort) <(ls en/ | sort)` で差分なし — ファイル名が完全一致

### 2. プレースホルダー整合性: PASS

全14ファイルについて `grep -oE '\{\{[A-Z_]+\}\}' | sort -u` で ja/ と en/ のプレースホルダーを比較し、全ファイルで差分なしを確認。

コードブロック内のコマンド一致も以下のファイルで確認:
- `conductor-task.md`: `cmux-team send`, `cd {{WORKTREE_PATH}}` — 同一
- `conductor.md`: `cmux-team spawn-agent`, `cmux list-status`, `git diff`, `git commit`, `cmux-team close-task` — 同一
- `conductor-role.md`: `git merge`, `git push`, `git worktree remove`, `cmux-team close-task` — 同一
- `master.md`: `cmux-team create-task`, `cmux send`, `cmux tree`, `cmux-team update-task`, `cmux-team delete-task` — 同一
- `implementer.md`: `grep -r`, `bun run`, `bun build` — 同一

### 3. template.ts: PASS

- **`resolveLocalizedDir()` ヘルパー** (L10-18): 正しく実装。`locale` サブディレクトリを優先し、存在しなければ `en/` にフォールバック。`master.md` の存在で検証。
- **`findTemplateDir()`** (L20-34): daemon 相対パス → プロジェクトローカルの2段階で `resolveLocalizedDir()` を呼び出し。計画通りの実装。
- **`BASE_BRANCH` デフォルト値** (L109): `locale === "ja" ? "main（デフォルト）" : "main (default)"` — 計画通り。
- **エラーメッセージの `t()` 置き換え**:
  - L45: `t("template_dir_not_found")`
  - L57: `t("conductor_role_template_not_found")`
  - L85: `t("conductor_task_template_not_found")`
- **import** (L8): `import { locale, t } from "./i18n"` — 正しく追加。

### 4. i18n.ts: PASS

- **en メッセージ** (L59-65): 3件追加。セクションコメント付きで既存構造に合致。
  - `template_dir_not_found`: "Template directory not found. Please run: npm install -g @hummer98/cmux-team"
  - `conductor_role_template_not_found`: "Conductor role template not found. Please run: npm install -g @hummer98/cmux-team"
  - `conductor_task_template_not_found`: "Conductor task template not found. Please run: npm install -g @hummer98/cmux-team"
- **ja メッセージ** (L542-548): 3件追加。日英混在スタイル（英語メッセージ + 日本語アクション）が既存パターンと一致。
  - `template_dir_not_found`: "Template directory not found. npm install -g @hummer98/cmux-team を実行してください"
  - 他2件も同様のスタイル

### 5. 翻訳品質: PASS

サンプリング対象: conductor-task.md, implementer.md, master.md, conductor.md, conductor-role.md

- **構造**: 全ファイルで見出しレベル、セクション順序が日英同一
- **指示の同等性**: 省略・追加なし。意味が正確に対応
- **コードブロック**: bash コマンド、変数名が同一
- **プレースホルダー内テキスト**: `<タスク概要>` → `<task summary>` 等、適切に翻訳

**Minor observation** (非ブロッカー):
- en 版 conductor.md L63, conductor-role.md L28 で `--journal "<one-line Japanese summary>"` と表記。英語テンプレートでありながら "Japanese" が残っているが、プロジェクト運用上 journal は日本語で記録する設計のため、意図的と判断。気になる場合は後続タスクで `"<one-line summary>"` に変更可能。

### 6. パッケージング: PASS

- **`package.json` の `files` フィールド** (L17): `"skills/cmux-team/templates/"` — ディレクトリ指定は再帰的にサブディレクトリを含むため、`templates/ja/` と `templates/en/` は自動的にパッケージに同梱される。
- **`.npmignore`**: テンプレート関連の除外ルールなし。`*.test.ts` や `docs/spec/` 等のみ除外。

## Fix Required

なし（GO 判定）。

## Optional Improvements（後続タスクで検討可）

1. en 版 conductor.md / conductor-role.md の `--journal "<one-line Japanese summary>"` → `"<one-line summary>"` への変更検討
