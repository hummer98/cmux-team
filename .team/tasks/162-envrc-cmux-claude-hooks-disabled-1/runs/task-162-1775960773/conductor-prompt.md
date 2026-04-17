# タスク割り当て

## タスク内容

---
id: 162
title: 初回起動時にプロジェクトルートの .envrc へ CMUX_CLAUDE_HOOKS_DISABLED=1 追記を提案
priority: medium
created_at: 2026-04-12T02:26:13.653Z
---

## タスク
## 背景

プロジェクトルートで直接 `claude` を起動すると cmux claude-hook による通知が発生し、cmux-team の通知制御と重複することがある。.envrc に `export CMUX_CLAUDE_HOOKS_DISABLED=1` を追記すれば解決するが、.envrc はユーザー所有ファイルなので黙って編集するのは避けたい。

## 原則

「**ツール領域は黙って、ユーザー領域は聞く**」
- .team/ 配下や worktree 内の自動生成は現状通り（黙って実行）
- プロジェクトルートの .envrc はユーザー所有なので明示的同意を取る

## やること

### TUI 起動前チェック（初回のみ）

daemon 起動時、Master spawn の前に:

1. プロジェクトルートに .envrc が存在するか確認
2. .envrc に `CMUX_CLAUDE_HOOKS_DISABLED` が既に含まれていないか確認
3. .team/config.json に `envrcHookPromptSkipped: true` がないか確認
4. 上記全て満たす場合のみ、ユーザーに対話プロンプトを表示

### 対話プロンプト

```
.envrc が見つかりました。
Claude Code の通知重複を防ぐため、以下を追記しますか？

  export CMUX_CLAUDE_HOOKS_DISABLED=1

[Y] 追記する    [n] スキップ（今回のみ）    [N] 今後聞かない
```

### 分岐処理

| 回答 | 動作 |
|------|------|
| Y（追記） | .envrc に追記し `direnv allow` を実行。`envrc_hook_disabled_added` をログ |
| n（今回のみ） | 何もしない。次回起動時にまた聞く |
| N（今後聞かない） | .team/config.json に `envrcHookPromptSkipped: true` を記録 |

### エッジケース

- .envrc が存在しない → 何もしない（新規作成はしない）
- direnv が入っていない → 追記はするが警告ログを出す（ユーザーが後で direnv 有効化できる）
- 既に `CMUX_CLAUDE_HOOKS_DISABLED` がある（値に関わらず）→ スキップ

## 実装箇所

- daemon.ts の initInfra または startMaster 前
- TUI 起動前に同期的に実行（対話プロンプトがあるため）
- .team/config.json の schema 拡張（`envrcHookPromptSkipped` フィールド追加）

## 注意

- 対話プロンプトは stdin/stdout を使う標準的な y/n 形式でよい
- 自動テスト環境では `CMUX_TEAM_NO_PROMPT=1` 等でスキップできるようにする
- 既存の初期化フローを壊さないこと


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-162-1775960773` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-162-1775960773
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-162-1775960773/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/162-envrc-cmux-claude-hooks-disabled-1/runs/task-162-1775960773
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/162-envrc-cmux-claude-hooks-disabled-1/runs/task-162-1775960773/summary.md` に書き出す。

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
