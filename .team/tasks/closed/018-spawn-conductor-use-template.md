---
id: 018
title: spawn-conductor.sh をテンプレートベースのプロンプト生成に切り替え
priority: high
status: ready
created_at: 2026-03-25T07:30:00Z
---

## タスク

`spawn-conductor.sh` のプロンプト生成を、ハードコードされた heredoc から `templates/conductor.md` テンプレートの変数置換に切り替える。

### 背景

現在 `spawn-conductor.sh` は最小限のインラインプロンプトを heredoc で生成している。一方、`templates/conductor.md` にはレビューフロー、Agent 起動手順、エラーリカバリ等の詳細な指示がある。この二重管理により、テンプレートに追加した機能（タスク 016 のレビュー判断等）が実際の Conductor に渡っていない。

### 変更内容

`spawn-conductor.sh` の §4 (Conductor プロンプト生成) を以下に変更:

1. `templates/conductor.md` を読み込む（plugin キャッシュまたはリポジトリ内から）
2. `{{COMMON_HEADER}}` を `templates/common-header.md` の内容で展開
3. テンプレート変数を `sed` で置換:
   - `{{WORKTREE_PATH}}` → `$WORKTREE_PATH`
   - `{{OUTPUT_DIR}}` → `$OUTPUT_DIR`
   - `{{PROJECT_ROOT}}` → `$PROJECT_ROOT`
   - `{{ROLE_ID}}` → `$CONDUCTOR_ID`
4. タスク内容をプロンプトに埋め込む（テンプレートのタスクセクションを実際のタスク内容で置換）
5. 結果を `.team/prompts/${CONDUCTOR_ID}.md` に書き出す

### テンプレートの検索順序

1. `${PROJECT_ROOT}/skills/cmux-team/templates/conductor.md`（リポジトリ内）
2. `~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/templates/conductor.md`（plugin キャッシュ）
3. `~/.claude/skills/cmux-team/templates/conductor.md`（手動インストール、フォールバック）

見つからない場合は既存の heredoc にフォールバック。

## 対象ファイル

- `.team/scripts/spawn-conductor.sh`

## 完了条件

- `spawn-conductor.sh` がテンプレートから変数置換でプロンプトを生成すること
- テンプレートが見つからない場合に既存の heredoc にフォールバックすること
- レビュー判断フロー（タスク 016）が Conductor に渡ること
