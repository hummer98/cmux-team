# タスク割り当て

## タスク内容

---
id: 156
title: await-task CLI コマンドと配布スキルの追加
priority: high
created_at: 2026-04-11T17:27:31.361Z
---

## タスク
## 背景

AIがタスク完了を待つ場面が頻繁にあるが、現状は cmux-team status でポーリングするしかなく非効率。
`cmux-team await-task` コマンドを追加し、Claude Code の `Bash run_in_background` と組み合わせてノンブロッキングで完了待ちできるようにする。

## やること

### 1. CLI コマンド `cmux-team await-task`

- `cmux-team await-task --task-id NNN` で指定タスクが closed になるまでブロック
- task-state.json を `fs.watch` で監視（ポーリングではない）
- 完了時: タスクの summary（runs 内の summary.md）を stdout にダンプして exit 0
- abort 時: abort 理由を出力して exit 1
- `--timeout SECONDS` オプション（デフォルトは無制限 or 1時間、要検討）
- 複数タスク待ち: `--task-id 108,109` で全部 closed になるまで待つ（余裕があれば）

### 2. 配布用スキル

plugin として配布するスキル（skills/ 配下）も追加する。
Master や他のエージェントが await-task の存在と使い方を知り、適切に活用できるようにする。

想定される使い方:
```bash
# Master が Bash run_in_background で起動
cmux-team await-task --task-id 108
# → 完了通知が届く + summary が読める
```

### 3. skill-creator での検証

実装後、skill-creator スキルを使ってスキルの品質を検証すること。

## 設計メモ

- surface ポーリングより圧倒的に軽量・高速
- Claude Code の Bash run_in_background と組み合わせることで Master がブロックされない
- depends-on による自動チェーンとは異なり「結果を見てから次を判断」するケースに対応

## 参考: 実装場所

- CLI: `skills/cmux-team/manager/main.ts` にサブコマンド追加
- スキル: `skills/` 配下に配布用スキル or 既存スキルのテンプレートに使い方を追記


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-156-1775928685` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-156-1775928685
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-156-1775928685/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/156-await-task-cli/runs/task-156-1775928685
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/156-await-task-cli/runs/task-156-1775928685/summary.md` に書き出す。

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
