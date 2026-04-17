# タスク割り当て

## タスク内容

---
id: 224
title: docs/spec 同期: trace-hooks / mainBranch / restart-task 反映
priority: medium
created_at: 2026-04-16T20:20:12.184Z
---

## タスク
## 背景

dockeeper スキルによる差分分析で、docs/spec/ 最終更新（T203, ec9d936）以降の実装変更のうち
以下 3 件が未反映と判明。

## 更新内容

### 1. docs/spec/03-commands.md — T217 trace-hooks 追加

L114 の `trace` コマンド記載の直後に新しいセクションを追加する:

- 追加: `cmux-team trace-hooks` サブコマンド
  - 用途: trace DB の hook_signals テーブルを検索・表示
  - オプション:
    - `--type <type>` : hook type でフィルタ (SessionStart / Stop / SessionEnd 等)
    - `--surface <surface>` : surface でフィルタ
    - `--task-run-id <id>` : taskRunId でフィルタ
    - `--limit <n>` : 返却件数制限（デフォルトは実装参照）
    - `--json` : JSON 形式で出力
  - 出力: タイムスタンプ / event / surface / task_run_id / payload 要約

実装は `skills/cmux-team/manager/main.ts` の \`cmdTraceHooks\` を読んで正確な挙動を記載する。

### 2. docs/spec/05-install-and-infrastructure.md — T213 mainBranch + T204 restart-task

#### L124 付近（.team/config.json スキーマ）

既存スキーマ:
- \`models\`
- \`envrcHookPromptSkipped\`
- \`autoUpdate\`

追加:
- \`mainBranch\` (string, optional) — プロジェクトの主開発ブランチ名。Conductor が worktree のベース・マージ先として使用する。
  - 解決順位: env \`CMUX_TEAM_MAIN_BRANCH\` > config.mainBranch > \`git symbolic-ref refs/remotes/origin/HEAD\` 自動検出 > fallback \"main\"
  - \`cmux-team start\` 実行時に config になければ検出結果を永続化し、\`main_branch_resolved\` をログ出力
  - source タグ: \`config\` / \`detected\` / \`fallback\`

正確な挙動は CLAUDE.md の「mainBranch の優先順位」セクションと実装 (\`main.ts\` cmdStart) を参照。

#### L134 付近（CLI サブコマンド表）

現状の \`restart-task\` 説明: 「assigned タスクの Conductor セッションを再起動（タスク自体は assigned のまま維持）」

T204 対応で aborted 状態からも実行可能になったため、以下いずれかに修正:
- 「assigned / aborted タスクの Conductor セッションを再起動」
- または表の記述を拡張して aborted 復帰ユースケースを併記

実装は \`cmdRestartTask\` を確認。

### 3. skills/cmux-team-guide/SKILL.md — T217 trace-hooks + T204 restart-task 誤記

#### L113-114 付近（CLI コマンド一覧表）

\`trace\` の直後に \`trace-hooks\` を追加（docs/spec/03 と同じ情報粒度で要約）。

#### L113 の restart-task 記述

現状: 「assigned → ready に戻す」(誤り)

実装は status を \`ready\` に戻さず、assigned 状態のまま Conductor セッションを再起動する。T204 で aborted 状態からも実行可能になった点も併記。

正確な一行説明に修正する。

## 検証観点

- 各ファイル内の他セクションとの整合性（特に CLI 一覧とレイアウト説明の整合）
- トリックリンク・相互参照切れが発生していないこと
- 既存の文体・見出しレベルを維持
- 差分はコミットメッセージに T217 / T213 / T204 を明記

## 参考

- T217: \`9d3a30d feat: T217 cmux-team trace-hooks サブコマンド追加\`
- T213: \`d1cb55b feat: T213 .team/config.json に mainBranch を追加...\`
- T204: \`07ba1ec feat(manager): restart-task が aborted 状態からも実行できるように対応 (T204)\`
- 実装ファイル: \`skills/cmux-team/manager/main.ts\`
- 既存仕様: \`CLAUDE.md\` の mainBranch / hook 全送信ポリシーセクション


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-224-1776370812` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-224-1776370812
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-224-1776370812/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/224-docs-spec-trace-hooks-mainbranch-restart-task/runs/task-224-1776370812
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/224-docs-spec-trace-hooks-mainbranch-restart-task/runs/task-224-1776370812/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
