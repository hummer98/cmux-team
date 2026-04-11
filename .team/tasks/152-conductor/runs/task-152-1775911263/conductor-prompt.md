# タスク割り当て

## タスク内容

---
id: 152
title: Conductor 完了時にセッション上へ要約レポートを表示
priority: medium
created_at: 2026-04-11T12:41:03.560Z
---

## タスク
## 背景

Conductor はタスク完了時に summary.md をファイルに書き出すが、セッション画面には何も表示しない。ユーザーがタスクを監視していなくても「何をやったのか安心できる」レポートが画面上に欲しい。

次タスクのセッション（/clear）で上書きされるのは許容。詳細はsummary.mdに記録済み。

## 目的

タスクを監視していないユーザーが、完了後にConductorのペインをちらっと見るだけで安心できるようにする。

## レポートの内容（勘所だけ）

以下を簡潔に表示する。該当しない項目は省略:

- **設計判断**: 複数の選択肢があった場合、何を選びなぜ選んだか
- **試行錯誤**: エラーや失敗が発生した場合、何が起きてどう対処したか
- **自己判断**: タスク指示が曖昧で自分で判断した箇所
- **不明点・懸念**: 残った課題や確認が必要な点
- **成果**: マージ/PR URL、主な変更点（1-2行）

## やらないこと

- 作業ログの羅列（変更ファイル一覧、コマンド履歴など）
- Agent ごとの詳細な作業記録
- これらは summary.md に書けばよい

## 実装箇所

`skills/cmux-team/templates/conductor-task.md` の「完了通知」セクション（L37-42）と `conductor-role.md` の「完了時の処理」セクション（L158-）を修正。

CONDUCTOR_DONE 送信の前に、セッション上（標準出力）にレポートを表示するよう指示を追加する。テンプレートへのプロンプト追記のみで実装コード変更は不要のはず。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-152-1775911263` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-152-1775911263
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-152-1775911263/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/152-conductor/runs/task-152-1775911263
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/152-conductor/runs/task-152-1775911263/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
