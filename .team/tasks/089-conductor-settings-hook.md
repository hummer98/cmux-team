---
id: 089
title: Conductor起動時に--settingsでhook設定を渡す
priority: high
created_at: 2026-04-06T05:07:29.963Z
---

## タスク
## 背景

Conductor のライフサイクル監視に必要な SessionStart/Stop hook（SESSION_STARTED, SESSION_IDLE, SESSION_ENDED, SESSION_CLEAR）が cmux-team プロジェクトの `.claude/settings.json` にしか定義されていない。そのため Dear 等の他プロジェクトで cmux-team を起動すると、Conductor が starting → disconnected になる。

## 原因

コミット 693081d で hook 方式に再設計した際、以前（f4d2c3f）使っていた `--settings` フラグによる per-conductor settings 注入を廃止し、プロジェクトローカルの `.claude/settings.json` に hook を直書きした。

## 修正内容

1. `main.ts` の `conductor` サブコマンド（L750付近）で claude 起動時に `--settings <path>` を追加
2. hook 設定を含む JSON を生成（`.team/prompts/conductor-settings.json` 等）して渡す
3. 必要な hook: SessionStart（SESSION_STARTED）、Stop（SESSION_IDLE）、SessionEnd（SESSION_CLEAR, SESSION_ENDED）
4. 現在 `.claude/settings.json` にある cmux-team 固有の hook（SessionStart の CONDUCTOR_ID チェック付きのもの、Stop の SESSION_IDLE、SessionEnd の SESSION_CLEAR/SESSION_ENDED）は `.claude/settings.json` から削除
5. PreToolUse の .team/tasks/ 書き込みガードは引き続き `.claude/settings.json` に残す（これは Master 向け）

## 参考

- 旧実装: コミット f4d2c3f（`--settings` 方式）
- 現行コード: `skills/cmux-team/manager/main.ts:750-766`（conductor サブコマンド）
- hook 定義: `.claude/settings.json:3-69`
- claude CLI: `--settings <file-or-json>` オプションで追加設定をマージ可能
