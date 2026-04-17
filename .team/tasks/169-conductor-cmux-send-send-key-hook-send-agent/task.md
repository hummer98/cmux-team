---
id: 169
title: Conductor の cmux send/send-key を hook で禁止 + send-agent コマンド追加
priority: medium
created_at: 2026-04-12T04:26:06.439Z
---

## タスク
## 目的

Conductor が `cmux send` / `cmux send-key` を直接使用する問題を2段構えで解決する。

参照: hummer98/cmux-team#21 (乗っ取り問題), hummer98/cmux-team#22 (自己フォールバック問題)

## やること

### 1. PreToolUse hook でブロック（`generateConductorSettings` に追加）

ファイル: `skills/cmux-team/manager/main.ts`

Conductor の settings.json に PreToolUse hook を追加。Bash tool の `command` に
`cmux send` または `cmux send-key`（`cmux-team` は除外）が含まれる場合、
exit code 2 でブロック。

エラーメッセージ例:
```
cmux send / cmux send-key は Conductor から使用禁止です。
Agent へのメッセージ送信は cmux-team send-agent を使ってください。
```

hook のスクリプト設計は `.team/tasks/167-*/runs/*/plan.md` を参照すること。

### 2. `cmux-team send-agent` コマンドを新規追加

ファイル: `skills/cmux-team/manager/main.ts`（サブコマンド追加）

```bash
cmux-team send-agent --surface <agent-surface> "<message>"
```

仕様:
- 指定した surface が**このConductorが spawn したAgent**であることを検証
  - `traces.db` の `task_sessions` テーブルで `conductor_surface = $CMUX_SURFACE` かつ `surface = <target>` を確認
  - 不正な surface（他のConductor、自分自身等）はエラーで終了
- 正規なら `cmux send --surface <surface> "<message>"` + `cmux send-key return --surface <surface>` を実行
- `cmux-team spawn-agent` / `cmux-team kill-agent` と対称性を持たせる

### 3. conductor-role.md の更新

`skills/cmux-team/templates/ja/conductor-role.md` および `en/conductor-role.md` に
`cmux-team send-agent` の使用例を追記（Agent が API エラーで停止した場合の回復手順）。

## 完了条件

- Conductor の settings.json に PreToolUse hook が出力される
- `cmux send` を含む Bash tool_use がブロックされる
- `cmux-team send-agent --surface surface:382 "続けてください"` が動作する
- 不正な surface（他Conductor等）は拒否される
- テスト追加（hook の単体テスト + send-agent の動作確認）

## 注意

- hook ブロックの正規表現設計は旧 plan.md（task-167 の runs/）を流用してよい
- `cmux-team` バイナリ内部の `cmux send` 呼び出しは hook 対象外（Claude Code の Bash tool にのみ作用）
- デプロイ後は mado 等で経過観察すること（issue #21 参照）
