---
id: 11
title: 001〜010 の全変更を反映してドキュメントを全面同期する
priority: high
status: ready
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

本日の一連の改修（001〜010）をドキュメント全体に反映する。009 で不十分だった範囲を含む。

### 反映すべき変更の全容

1. **issue → task リネーム（006）** — ローカルタスクは「task」、GitHub は「issue」
2. **task の status フロー（004）** — `status: draft` → `status: ready` の2段階
3. **Manager のイベント駆動起床（007）** — アイドル時は停止、Master が `[TASK_CREATED]` で通知
4. **Manager の Haiku 化（007）** — `--model haiku` で起動
5. **Manager の権限制限** — `--settings .team/settings.manager.json` で Bash/Read のみ許可、Edit/Write 禁止
6. **status.json スリム化（008）** — 現在の状態のみ保持、completed_tasks をログに移動
7. **ログ導入（008）** — `.team/logs/manager.log` に履歴を追記形式で記録
8. **Conductor 起動スクリプト化（010）** — `.team/scripts/spawn-conductor.sh`
9. **テンプレート変数** — `{{OPEN_ISSUES_LIST}}` → `{{OPEN_TASKS_LIST}}`
10. **コマンド名** — `team-issue` → `team-task`、`issue-manager` → `task-manager`

### 同期対象

1. **README.md / README.ja.md** — アーキテクチャ説明、使い方
2. **CLAUDE.md** — リポジトリ構造、テンプレート変数一覧、テスト方法、既知の注意点
3. **skills/cmux-team/SKILL.md** — Manager 動作説明、通信プロトコル
4. **docs/seeds/** — シードドキュメントと実装の乖離を修正

## 対象ファイル

- `README.md`
- `README.ja.md`
- `CLAUDE.md`
- `skills/cmux-team/SKILL.md`
- `docs/seeds/` 配下の全ファイル

## 完了条件

- ドキュメント内に旧用語（`.team/issues/`、`loop_count`、`completed_tasks` in status.json）が残っていないこと
- Manager の動作説明がアイドル停止 + Haiku + 権限制限と一致していること
- Conductor 起動がスクリプト化されている旨が記載されていること
