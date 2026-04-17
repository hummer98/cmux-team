---
id: 221
title: cmux-team プラグインの SessionStart hook を削除
priority: medium
created_at: 2026-04-15T22:45:29.719Z
---

## タスク
## 背景
Master spawn 時、plugin.json の SessionStart hook が `[ -z \"$CMUX_SURFACE\" ]` を条件にタブを `[NUM] Claude Code` に上書きし、daemon 側の `renameTab(\"[NUM] Master\")` を無効化していた（Master のタブだけ "Claude Code" 表示になるバグ）。

### 調査結果
- `.claude-plugin/plugin.json` の `hooks.SessionStart` が犯人
- `cmdLaunchMaster` (main.ts:1692付近) は `CMUX_SURFACE` を env に設定していない → hook の条件 `[ -z \"$CMUX_SURFACE\" ]` が真 → rename 発動
- Conductor (`cmdConductor` main.ts:1570) と Agent (`cmdLaunchAgent` main.ts:1849付近) は `CMUX_SURFACE` を設定しているので hook は skip されていた
- `master.ts:29` で既に `renameTab(surface, \"[NUM] Master\")` を呼んでいるので、hook さえ消せば daemon 側の rename が効く

### 重複
- `using-cmux` プラグインにも同等の hook があり `$CMUX_NO_RENAME_TAB` で skip される設計になっている
- cmux-team プラグインの hook は役目が重複しており、条件も脆弱（`$CMUX_SURFACE` 未設定で発火）

## やること
1. `.claude-plugin/plugin.json` から `hooks.SessionStart` ブロックのみ削除
2. `hooks.PreToolUse` は従来通り残す（別機能 — team.json/task-state.json 直接編集ガード）
3. コード変更なし — `master.ts:29` の renameTab が既に存在するため追加修正不要

## 検証
- リリース後、新規 `cmux-team start` で Master タブが `[NUM] Master` になること
- Conductor / Agent / Manager のタブは従来通り表示されること
- `ps eww -p <master claude pid> | tr ' ' '\n' | grep CMUX_` で env が従来通りであること（`CMUX_SURFACE` は相変わらず未設定で問題なし）

## 参考ファイル
- `.claude-plugin/plugin.json`（修正対象）
- `skills/cmux-team/manager/master.ts:29`（既存 renameTab、変更不要）
- `skills/cmux-team/manager/main.ts:1692-1707`（cmdLaunchMaster、変更不要）
