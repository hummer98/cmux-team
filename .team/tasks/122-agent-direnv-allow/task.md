---
id: 122
title: Agent起動時の環境変数をシェルに焼き付け + direnv allow 自動化
priority: high
created_at: 2026-04-10T06:19:47.578Z
---

## タスク
## 背景

現在、Agent/Conductor 起動時に環境変数をワンライナー（`export VAR=x && claude ...`）で渡している。これにより:
- コマンド文字列が冗長
- プロセス死亡時に環境変数が消失
- worktree での direnv allow が未実行で OAuth トークンが引き継がれない

## やること

1. **シェルへの環境変数焼き付け**: Conductor/Agent の pane 初期化時に、`cmux send` で `export` コマンドを先に送信し、シェルセッションに環境変数を永続化する
2. **direnv allow 自動化**: worktree 作成後、Agent 起動前に `direnv allow` を pane のシェルで実行する
3. **ワンライナーの簡素化**: 環境変数が焼き付け済みなので、起動コマンドから export 部分を除去

## 対象ファイル

- `skills/cmux-team/manager/main.ts` — spawn-agent, conductor 起動部分
- `skills/cmux-team/manager/conductor.ts` — assignTask() の worktree 作成後処理

## 焼き付け対象の環境変数

- `ANTHROPIC_BASE_URL`（proxy port）
- `PROJECT_ROOT`
- `CONDUCTOR_ID`
- `CMUX_SURFACE`
- `CMUX_NO_RENAME_TAB`
- `CMUX_CLAUDE_HOOKS_DISABLED`
- その他、現在ワンライナーで export している変数すべて

## 処理フロー

```
1. pane 作成
2. cmux send: export VAR1=... VAR2=... （環境変数焼き付け）
3. cmux send: direnv allow （worktree の場合）
4. cmux send: claude --dangerously-skip-permissions ... （起動コマンド）
```

## 注意

- Conductor は `execFileSync` で claude を exec しているケースと、`cmux send` で送信しているケースがある。両方を確認すること
- `direnv allow` は .envrc が存在する場合のみ実行（存在チェック付き）
- 環境変数の焼き付けと direnv allow の間に適切な wait を入れること
