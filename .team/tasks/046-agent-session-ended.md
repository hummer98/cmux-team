---
id: 046
title: Agent削除トリガーをSESSION_ENDEDに変更
priority: high
created_at: 2026-04-02T17:39:36.616Z
---

## タスク
## 概要
TUIのConductorツリーからサブエージェントを削除するトリガーを、現在の `AGENT_DONE`（明示的キューメッセージ）から `SESSION_ENDED`（Claudeフック自動発火）に変更する。

## 現状の問題
- `AGENT_DONE` は `cmux-team kill-agent` で明示的に書き込まれる
- Conductorが呼び忘れたりクラッシュするとゴーストエントリが残る

## 修正方針
1. daemon の `SESSION_ENDED` ハンドラで、surface が Agent のものであれば該当 Conductor の `agents` 配列から削除する
2. Agent タブの Claude セッション終了時にフックから `SESSION_ENDED` が発火することを確認する（Agent も Claude セッションなので発火するはず）
3. `AGENT_DONE` メッセージ型とハンドラは不要になれば削除（ただし `kill-agent` CLI から使われている場合は互換性を確認）

## 対象ファイル
- `skills/cmux-team/manager/daemon.ts` — SESSION_ENDED ハンドラの拡張、AGENT_DONE ハンドラの整理
- `skills/cmux-team/manager/schema.ts` — 必要に応じて型整理
