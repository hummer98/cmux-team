---
id: 104
title: Conductor hook の .team/tasks/ 書き込み制限を runs/ 許可に緩和
priority: medium
depends_on: [102]
created_at: 2026-04-07T06:05:37.503Z
---

## タスク
## 背景

T102（フォルダ集約）により指示書が `.team/tasks/T100-xxx/runs/` に配置されるようになる。現在の PreToolUse hook は `.team/tasks/` を含むパスへの Write/Edit を全てブロックしているため、Conductor が指示書を書けなくなる。

## 現在の hook（.claude/settings.json:27-38）

`.team/tasks/` を含むパスへの Write/Edit を無条件でブロック。

## 変更内容

判定ロジックを精緻化:

| パス | 許可/禁止 |
|------|----------|
| `.team/tasks/*/task.md` | **禁止**（タスク定義本体） |
| `.team/tasks/*.md`（フラット形式） | **禁止** |
| `.team/tasks/*/runs/**` | **許可**（指示書・出力） |
| `.team/tasks/*/sessions.json` | **許可** |

判定の考え方:
- `.team/tasks/` 配下かつ `/runs/` を含まない → ブロック
- `.team/tasks/T100-xxx/runs/...` → 許可

## 対象ファイル

- .claude/settings.json（PreToolUse hook）
