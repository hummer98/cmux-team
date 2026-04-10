# タスク割り当て

## タスク内容

---
id: 128
title: cmux-team resume: restart時にConductorセッションをresumeで再開する機能
priority: high
created_at: 2026-04-10T07:59:31.113Z
---

## タスク
## 背景

cmux-team start（restart）時、既存のworktreeが残っていてもConductorは常に新規セッションで起動される。
assignedだったタスクは宙に浮き、作業が無駄になる。

`claude --resume <session-id>` で以前の会話コンテキストが完全復元できることを実験で確認済み（surface:364 で T119 のセッションを resume し、worktree 内で動作することを検証）。

## やること

### 1. task-state.json に resume 用情報を記録

`assignTask` 時に以下を task-state.json に追加保存する:

- `sessionId`: Conductor の Claude セッションID（SESSION_STARTED イベントで取得されるもの）
- `worktreePath`: `.worktrees/task-NNN-TIMESTAMP` の絶対パス
- `taskRunId`: `task-NNN-TIMESTAMP`
- `conductorSlot`: conductor-slot-N

**注意:** sessionId は assignTask 時点では未確定（Claude 起動後に SESSION_STARTED で届く）。
SESSION_STARTED ハンドラで ConductorState.sessionId が設定された時点で task-state.json にも書き込む。

### 2. `cmux-team resume <task-id>` サブコマンド新設

`cmdConductor` の亜種として実装する。処理フロー:

1. task-state.json から `sessionId`, `worktreePath`, `taskRunId` を取得
2. worktree の存在確認（なければエラー）
3. sessionId の存在確認（なければエラー）
4. 環境変数設定（cmdConductor と同じ: CMUX_SURFACE, ANTHROPIC_BASE_URL, CONDUCTOR_ID, PROJECT_ROOT 等）
5. conductor-settings.json 生成（hooks — cmdConductor と同じ）
6. `execFileSync("claude", ["--resume", sessionId, "--dangerously-skip-permissions", "--settings", settingsPath, "--model", model, "--append-system-prompt-file", rolePromptFile], { cwd: worktreePath })`

### 3. `cmux-team start` での resume 統合

`initializeConductorSlots` または daemon の boot 完了後に:

1. task-state.json で status=assigned のタスクを検索
2. 各タスクの worktreePath が存在するか確認
3. 各タスクの sessionId が記録されているか確認
4. 条件を満たすタスクについて、idle Conductor に `cmux send surface "cmux-team resume <task-id>"` を送信
5. 条件を満たさないタスクは status を ready に戻して通常フローへ

### 4. team.json に sessionId を出力

`updateTeamJson` で conductors[].sessionId を出力に追加（現在は省略されている）。

## 実験で確認済みの事実

- `claude --resume <session-id> --append-system-prompt-file <file>` は動作する
- resume 後の cwd は `cd` で移動した先（worktree）になる
- 会話コンテキスト（過去のツール呼び出し履歴含む）は完全に復元される
- `--dangerously-skip-permissions` と `--settings` も併用可能

## 注意点

- resume するセッションの Claude projects ディレクトリパスは worktree のパスに紐づく（`~/.claude/projects/-Users-yamamoto-git-cmux-team--worktrees-task-NNN-TIMESTAMP/`）
- proxy port は restart 後に変わる可能性があるが、環境変数で上書きするので問題なし
- CMUX_SURFACE も新しい surface に上書きするので問題なし


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-128-1775808254` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-128-1775808254
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-128-1775808254/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/128-cmux-team-resume-restart-conductor-resume/runs/task-128-1775808254
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/128-cmux-team-resume-restart-conductor-resume/runs/task-128-1775808254/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
