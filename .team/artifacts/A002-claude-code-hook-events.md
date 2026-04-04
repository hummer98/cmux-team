---
id: A002
type: research
title: "Claude Code フックイベント完全リファレンス"
created: 2026-04-03T23:10:00+09:00
author: master
tags: [claude-code, hooks, reference]
---

## 概要

Claude Code で利用可能な全フックイベントの一覧。各イベントの発火タイミング、matcher 仕様、制御可否をまとめる。

## セッションライフサイクル

| Hook | 発火タイミング | matcher | 制御 |
|------|-------------|---------|------|
| **SessionStart** | セッション開始・再開 | `startup`, `resume`, `clear`, `compact` | ✅ |
| **UserPromptSubmit** | プロンプト送信前（処理開始） | なし | ✅ (exit 2 で棄却) |
| **Stop** | 回答完了（idle） | なし | ✅ (exit 2 で停止防止) |
| **StopFailure** | API エラー発生 | エラータイプ (`rate_limit`, `auth_failed` 等) | ✅ |
| **SessionEnd** | セッション終了 | 終了理由 (`clear`, `resume`, `logout`, `prompt_input_exit`) | ✅ |

## ツール関連

| Hook | 発火タイミング | matcher | 制御 |
|------|-------------|---------|------|
| **PreToolUse** | ツール実行直前 | ツール名 (`Bash`, `Edit`, `Write`, `mcp__.*` 等) | ✅ (allow/deny/ask/defer) |
| **PostToolUse** | ツール実行成功後 | ツール名 | ✅ (出力変更可) |
| **PostToolUseFailure** | ツール実行失敗後 | ツール名 | ✅ |
| **PermissionRequest** | パーミッション確認表示時 | ツール名 | ✅ (自動承認/拒否) |
| **PermissionDenied** | オートモードがツール拒否 | ツール名 | ✅ (retry 制御) |

## エージェント・タスク

| Hook | 発火タイミング | matcher | 制御 |
|------|-------------|---------|------|
| **SubagentStart** | サブエージェント起動 | エージェント型名 | ✅ |
| **SubagentStop** | サブエージェント終了 | エージェント型名 | ✅ |
| **TaskCreated** | タスク作成時 | なし | ✅ (exit 2 で防止) |
| **TaskCompleted** | タスク完了時 | なし | ✅ (exit 2 で防止) |
| **TeammateIdle** | チームメイトがアイドル | なし | ✅ |

## ファイル・コンテキスト

| Hook | 発火タイミング | matcher | 制御 |
|------|-------------|---------|------|
| **FileChanged** | 監視ファイル変更 | ファイル名 regex (`.env$` 等) | ✅ |
| **CwdChanged** | 作業ディレクトリ変更 | なし | ✅ |
| **InstructionsLoaded** | CLAUDE.md ロード | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` | ✅ |
| **ConfigChange** | 設定ファイル変更 | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` | ✅ (exit 2 でブロック) |

## 圧縮・通知

| Hook | 発火タイミング | matcher | 制御 |
|------|-------------|---------|------|
| **PreCompact** | コンテキスト圧縮直前 | `manual`, `auto` | ✅ |
| **PostCompact** | コンテキスト圧縮完了後 | `manual`, `auto` | ✅ |
| **Notification** | システム通知表示 | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog` | ✅ |
| **Elicitation** | MCP サーバーがユーザー入力要求 | MCP サーバー名 | ✅ (exit 2 で拒否) |
| **ElicitationResult** | ユーザーが MCP 入力に応答 | MCP サーバー名 | ✅ |

## Worktree

| Hook | 発火タイミング | matcher | 制御 |
|------|-------------|---------|------|
| **WorktreeCreate** | git worktree 作成時 | なし | ✅ |
| **WorktreeRemove** | git worktree 削除時 | なし | ❌ |

## Hook ハンドラータイプ

| タイプ | 説明 |
|-------|------|
| **command** | シェルスクリプト実行。最も柔軟 |
| **http** | 外部 API 呼び出し。環境変数注入可 |
| **prompt** | LLM ベース判定 |
| **agent** | 専用サブエージェント起動 |

## stdin 共通フィールド

全フックは JSON を stdin に受け取る:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

## Exit Code

| コード | 意味 | 効果 |
|------|------|------|
| **0** | 成功・許可 | stdout の JSON をパース |
| **2** | ブロック・拒否 | stderr をフィードバック |
| **その他** | 非ブロッキング | verbose モードでのみログ |

## cmux-team での活用

| TUI 状態 | Hook | メッセージ |
|----------|------|-----------|
| running | `UserPromptSubmit` | SESSION_ACTIVE |
| idle | `Stop` | SESSION_IDLE |
| idle | `SessionStart` (matcher: `clear`) | SESSION_STARTED |
| disconnected | `SessionEnd` | SESSION_ENDED |
