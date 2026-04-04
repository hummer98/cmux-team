---
id: 053
title: Master/Conductor/Agent起動時にCMUX_NO_RENAME_TAB=1を設定
priority: high
created_at: 2026-04-03T04:24:03.575Z
---

## タスク
using-cmux v1.3.0 で追加された CMUX_NO_RENAME_TAB 環境変数を、cmux-team が起動する全セッションに設定する。cmux-team は rename-tab を自前で行っているため、using-cmux の SessionStart フックによる自動書き換えは不要。

対象箇所（skills/cmux-team/manager/main.ts）:
1. cmdConductor() (L513付近): process.env に CMUX_NO_RENAME_TAB=1 を追加
2. cmdLaunchMaster() (L547付近): process.env に CMUX_NO_RENAME_TAB=1 を追加  
3. cmdSpawnAgent() (L626-633付近): exports 配列に export CMUX_NO_RENAME_TAB=1 を追加

変更は環境変数の追加のみ。他のロジック変更は不要。
