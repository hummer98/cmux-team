---
id: 058
title: SessionEnd hookのmatcherからclearを除外
priority: high
created_at: 2026-04-03T14:16:14.526Z
---

## タスク
## 背景

/clear 実行時に SessionEnd(clear) が発火して SESSION_ENDED が送信され、TUI 上で Conductor が一時的に disconnected 表示になる問題。

/clear はプロセス終了ではなく会話リセットなので、disconnected にすべきではない。

## 変更

.claude/settings.json の SessionEnd hook の matcher を変更:

変更前:
```json
"SessionEnd": [{ "matcher": "", ... }]
```

変更後:
```json
"SessionEnd": [{ "matcher": "logout|prompt_input_exit", ... }]
```

## 対象ファイル

- .claude/settings.json（リポジトリルート直下）

## テスト

変更後に以下を確認:
1. plugin を再インストール（`claude plugin uninstall cmux-team@hummer98-cmux-team && claude plugin install cmux-team@hummer98-cmux-team`）
2. Conductor にタスクを割り当て（/clear + プロンプト送信が発生する）
3. TUI で Conductor が disconnected にならずに running に遷移することを確認
4. Claude Code プロセスを手動終了した場合は PID ウォッチャーにより disconnected になることを確認
