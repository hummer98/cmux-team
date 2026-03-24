---
id: 9
title: 001〜008 の全変更を反映してドキュメントを全面同期する
priority: high
status: ready
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

本日の一連の改修（001〜008 + 追加修正）をドキュメント全体に反映する。

### 反映すべき変更の全容

1. **issue → task リネーム（006）** — ローカルタスクは「task」、GitHub は「issue」
   - `.team/issues/` → `.team/tasks/`
   - コマンド名 `team-issue` → `team-task`
   - テンプレート名 `issue-manager` → `task-manager`
   - テンプレート変数 `{{OPEN_ISSUES_LIST}}` → `{{OPEN_TASKS_LIST}}`
2. **task の status フロー（004）** — `status: draft` → `status: ready` の2段階
3. **Manager のイベント駆動起床（002, 007）** — アイドル時は停止、Master が `[TASK_CREATED]` で通知
4. **Manager の Haiku 化（007）** — `--model haiku` で起動
5. **status.json スリム化（003, 008）** — 現在の状態のみ保持、loop_count 削除、completed_tasks をログに移動
6. **ログ導入（008）** — `.team/logs/manager.log` に履歴を追記形式で記録
7. **Conductor 起動方法（007）** — コマンドライン初期プロンプト方式、`new-split down` でペイン作成

### 同期対象

ドキュメントと実装コード（テンプレート・コマンド・スキル）を突き合わせ、乖離をすべて修正する:

1. **README.md / README.ja.md** — アーキテクチャ説明、使い方、フロー図
2. **CLAUDE.md** — リポジトリ構造、テンプレート変数一覧、テスト方法、既知の注意点
3. **skills/cmux-team/SKILL.md** — Manager 動作説明、status.json スキーマ、通信プロトコル
4. **docs/seeds/** — シードドキュメントと現在の実装の乖離を修正

## 対象ファイル

- `README.md`
- `README.ja.md`
- `CLAUDE.md`
- `skills/cmux-team/SKILL.md`
- `docs/seeds/00-project-overview.md`
- `docs/seeds/01-skill-cmux-team.md`
- `docs/seeds/02-skill-cmux-agent-role.md`
- `docs/seeds/03-commands.md`
- `docs/seeds/04-templates.md`
- `docs/seeds/05-install-and-infrastructure.md`
- `docs/seeds/06-implementation-tasks.md`

## 完了条件

- ドキュメント内に旧用語（`.team/issues/`、`loop_count`、`completed_tasks` in status.json）が残っていないこと
- Manager の動作説明がアイドル停止 + Haiku モデルと一致していること
- task の status フロー（draft/ready）が記載されていること
- `.team/logs/` の説明が含まれていること
