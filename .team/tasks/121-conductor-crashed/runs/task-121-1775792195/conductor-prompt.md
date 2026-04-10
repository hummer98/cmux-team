# タスク割り当て

## タスク内容

---
id: 121
title: conductor_crashed 誤検出バグの再発確認と確実な修正
priority: high
run_after_all: true
created_at: 2026-04-10T03:36:35.017Z
---

## タスク
## 背景

T119 が「conductor_crashed 誤検出と cleanup 漏れを修正」というタイトルで動いていたが、その T119 の Conductor 自身が実行中に同じバグを踏んだ。具体的には 2026-04-10T12:16:00 頃、monitorConductors が Conductor-168 (T119) と Conductor-169 (T120) を crashed 誤検出し、TUI 上は idle 表示になった。一方、実際は Conductor の Claude プロセスも surface も生きており、サブエージェント (planner/design-reviewer/impl) が継続して spawn され作業していた。

このタスクは T119 が close された後に実行される (run_after_all)。T119 の修正内容と現実の挙動を突き合わせ、**現象が再発していないか動作確認**し、再発している場合は追加修正する。

## 調査観点

1. `skills/cmux-team/manager/conductor.ts` の `checkConductorStatus` (現行は validateSurface が false で即 crashed 判定)
   - validateSurface が一時的に false を返すタイミング (cmux 側の race / タブ遷移中 / サブエージェント spawn 直後など) がないか検証
   - 1回の false で即 crashed 判定するのはフラッキー。複数回連続で消失している場合のみ crashed 判定するなどの堅牢化を検討
2. `skills/cmux-team/manager/daemon.ts` の monitorConductors の crashed 処理 (現行 daemon.ts:796-804)
   - crashed 判定時に `taskId` だけクリアして `taskRunId`, `taskTitle`, `worktreePath`, `outputDir`, `agents` を残している (team.json の歪な状態の原因)
   - resetConductor を呼ぶか、一貫して全フィールドクリアすべき
3. サブエージェント spawn 中に親 Conductor surface が (一時的にも) 見えなくなる条件があるか

## 再現手順 (当時のログ)

```
11:35:03  conductor_started task_id=119 surface=surface:168
11:37:47〜 agent_spawned (T119 の Conductor がサブエージェントを連続 spawn)
12:16:00  conductor_crashed surface=surface:168  ← ★誤検出
12:16:30  conductor_crashed surface=surface:169  ← ★誤検出
12:16:43以降も agent_spawned が続く (= Conductor は実際には生きている)
```

## 受け入れ基準

- 現行コードで再発が起きていないか確認 (T119 のマージ結果を include した状態で)
- 起きている場合: 追加修正
- 起きていない場合: T119 の修正内容を docs/spec に反映し、本タスクを close
- いずれにせよ crashed 判定時の cleanup が taskRunId/agents を含めて完全になっていること
- TUI 上、サブエージェント実行中の Conductor が "running" 表示を維持すること

## 参考

- T119 の成果物: `.team/tasks/119-conductor-crashed-cleanup/runs/task-119-1775788497/`
- 関連ファイル: conductor.ts:465-475 (checkConductorStatus), daemon.ts:774-820 (monitorConductors)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-121-1775792195` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-121-1775792195
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-121-1775792195/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/121-conductor-crashed/runs/task-121-1775792195
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/121-conductor-crashed/runs/task-121-1775792195/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
