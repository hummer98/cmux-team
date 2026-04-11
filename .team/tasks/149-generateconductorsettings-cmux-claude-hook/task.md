---
id: 149
title: generateConductorSettings から cmux claude-hook を全削除
priority: high
created_at: 2026-04-11T02:21:07.063Z
---

## タスク
## 背景

`generateConductorSettings()`（main.ts:763-865）で Conductor の settings.json を生成する際、cmux-team 独自の hooks に加えて cmux 用の hooks（`cmux claude-hook *`）を再注入している。

これは T092 で `CMUX_CLAUDE_HOOKS_DISABLED=1` により cmux ラッパーを無効化した際、cmux のサイドバー表示等のために意図的に入れ直したもの。しかし通知制御は Manager 側で行う方針のため、cmux への自動通知は不要。

## やること

`skills/cmux-team/manager/main.ts` の `generateConductorSettings()` から以下の `cmux claude-hook` エントリをすべて削除:

- L780: `cmux claude-hook session-start`（SessionStart 内の2番目のエントリ）
- L798: `cmux claude-hook stop`（Stop 内の2番目のエントリ）
- L822: `cmux claude-hook session-end`（SessionEnd 内の3番目のエントリ）
- L829-837: `Notification` セクション全体
- L839-848: `UserPromptSubmit` セクション全体（`cmux claude-hook prompt-submit`）
- L849-859: `PreToolUse` セクション全体（`cmux claude-hook pre-tool-use`）

## 残すもの

cmux-team 独自の hooks は残す:
- `cmux-team send SESSION_STARTED`（SessionStart 内）
- `cmux-team send SESSION_IDLE`（Stop 内）
- `cmux-team send SESSION_CLEAR`（SessionEnd 内、matcher: clear）
- `cmux-team send SESSION_ENDED`（SessionEnd 内、matcher: logout|prompt_input_exit）

## 確認ポイント

- 削除後も `cmux-team send *` による daemon 通知は正常に動作すること
- settings.json の JSON 構文が壊れていないこと
- SessionStart / Stop / SessionEnd のセクションが空にならないこと（cmux-team send エントリが残る）
