# タスク割り当て

## タスク内容

---
id: 167
title: Conductor の cmux send/send-key を PreToolUse hook で全面禁止
priority: medium
created_at: 2026-04-12T04:00:18.854Z
---

## タスク
## 目的

Conductor が cmux send / cmux send-key で他 surface を直接操作する問題を
PreToolUse hook でブロックする。

参照: hummer98/cmux-team#21

## やること

1. `generateConductorSettings()` に PreToolUse hook を追加
   - ファイル: `skills/cmux-team/manager/main.ts`
   - Bash tool の `command` に `cmux send` または `cmux send-key` が含まれる場合、
     exit code 2 でブロック
   - エラーメッセージ例:
     「cmux send / cmux send-key は Conductor から使用禁止です。
       エージェント起動は cmux-team spawn-agent を使ってください。」

2. hook の形式を確認して正しい JSON 構造で生成する
   - 既存の Conductor settings 生成コードを参照
   - PreToolUse の matcher は "Bash"

3. mado 等の実プロジェクトで動作確認
   - Conductor が spawn-agent を呼んだ場合は通過すること
   - Conductor が cmux send を呼んだ場合はブロックされること

## 完了条件

- hook が Conductor の settings.json に出力される
- cmux send を含む Bash tool_use がブロックされる
- spawn-agent / kill-agent / read-screen などの正当な操作は通過する

## 注意（経過観察）

影響が完全には読めないため、デプロイ後は以下を観察すること:
- hook ブロックが過剰に発生していないか
- Conductor がタスクを完遂できているか
- 問題が多発する場合は禁止対象を絞る（/exit のみ等）方向で再検討


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-167-1775966418` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-167-1775966418
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-167-1775966418/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/167-conductor-cmux-send-send-key-pretooluse-hook/runs/task-167-1775966418
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/167-conductor-cmux-send-send-key-pretooluse-hook/runs/task-167-1775966418/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
