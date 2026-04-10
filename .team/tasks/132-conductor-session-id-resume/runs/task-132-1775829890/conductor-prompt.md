# タスク割り当て

## タスク内容

---
id: 132
title: Conductor 起動時に --session-id を指定して resume 可能にする
priority: high
created_at: 2026-04-10T14:04:50.818Z
---

## タスク
## 背景

resume 機能が動作しない。原因は SessionStart hook で $SESSION_ID 環境変数を参照しているが、Claude Code は session_id を stdin JSON で渡すため常に空になる。加えて、hook 発火と conductor.taskId 設定のタイミング競合もある。

## 方針

SESSION_STARTED hook による事後通知方式をやめ、Conductor の Claude セッション起動時に Manager 側で UUID を生成し `--session-id <uuid>` で渡す方式に変更する。

- sessionId はタスク割り当て時に確定 → タイミング問題なし
- hook で stdin JSON をパースする必要なし → 通知方法の問題もなし
- resume 時は `claude --resume <uuid>` でそのまま再開可能

## 実装手順

### Phase 1: --session-id の仕様調査（先にやること）

`claude --session-id <uuid>` の「valid UUID」が何を指すか試験する。

- `crypto.randomUUID()` で生成した UUID v4 が受理されるか
- ハイフンなし UUID は受理されるか
- UUID 以外の文字列（例: `task-042-1712345678`）は拒否されるか
- 同じ session-id で 2 回起動した場合の挙動（resume 相当？エラー？）
- `--session-id` と `--resume` の併用は可能か

試験結果を .team/tasks/ 内の runs ディレクトリに記録すること。

### Phase 2: 実装

Phase 1 の結果を踏まえて以下を実装:

1. `conductor.ts` の `assignTask` で UUID を生成し、task-state.json に即座に書き込む
2. Conductor の Claude セッション起動コマンドに `--session-id <uuid>` を追加
3. `main.ts` の `cmdResume` で `claude --resume <sessionId>` を使用（既存の実装を活用）
4. SessionStart hook から `--session-id` パラメータの送信を削除（不要になるため）
5. daemon.ts の SESSION_STARTED ハンドラから sessionId 保存ロジックを削除（不要になるため）

### 確認ポイント

- タスク割り当て → Conductor 起動 → タスク完了の一連フローが動作すること
- `cmux-team start`（restart）時に assigned タスクの resume が成功すること
- session_id_saved ログが不要になること（割り当て時に書き込むため）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-132-1775829890` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-132-1775829890
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-132-1775829890/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/132-conductor-session-id-resume/runs/task-132-1775829890
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/132-conductor-session-id-resume/runs/task-132-1775829890/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
