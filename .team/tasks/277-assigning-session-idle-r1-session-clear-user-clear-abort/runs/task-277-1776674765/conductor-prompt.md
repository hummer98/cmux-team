# タスク割り当て

## タスク内容

---
id: 277
title: assigning中のSESSION_IDLE保険(R1)を撤去 — SESSION_CLEAR遅着で誤user_clear abortする事故を防ぐ
priority: medium
created_at: 2026-04-20T08:30:55.585Z
---

## タスク
## 背景

T276 run #1（task-276-1776673135）で、daemon 自身が送った /clear が誤って user_clear と
判定され task が abort された痕跡を発見。

manager.log 抜粋:
\`\`\`
17:18:58 clear_sent C[285] source=daemon_assign taskRunId=task-276-1776673135
17:18:58 assigning_window_open clear_sent_at=08:18:58.042Z
17:19:01 assign_prompt_sent / conductor_started
17:19:08 SESSION_IDLE → assigning_window_close via=SESSION_IDLE elapsed=9958
17:19:08 conductor_running via=SESSION_IDLE
17:19:09 user_clear_decision_snapshot case=user_clear decision_reason=running_with_taskid
         elapsed_since_clear_sent=11131 session_started_clear_at=null
17:19:09 task_aborted task_id=276 reason=user_clear   ← 誤検知
17:19:12 session_started source=clear  ← 本来の SESSION_STARTED は abort 後に到着
\`\`\`

## 原因

\`daemon.ts:1937-1955\` の **T232 R1 分岐**（assigning 中の SESSION_IDLE で
assigning → running に倒す保険）が、daemon /clear 由来の SESSION_IDLE で発火し、
直後に到達した SESSION_CLEAR が \`running\` 状態の handler（\`daemon.ts:2119\`）
に落ちて user_clear と誤判定された。

- daemon が /clear を送ると Claude セッション終了 → Stop hook で SESSION_IDLE 到達
- これは「assign プロンプトを処理し終わった」信号ではなく /clear のついでの idle
- assigning → running 遷移はもともと \`SESSION_STARTED source=clear\` (\`daemon.ts:1456-1469\`) が担う設計
- R1 は「SESSION_STARTED が逆順遅着する race の保険」だったが、逆向きの事故
  （SESSION_IDLE が SESSION_CLEAR より先に到達し window を早閉めする）を引き起こした

## 改修

\`skills/cmux-team/manager/daemon.ts:1937-1955\` の R1 分岐を削除（または no-op 化）:

\`\`\`typescript
// 削除対象
} else if (conductor.status === "assigning" && conductor.taskRunId) {
  // T232 R1: SESSION_STARTED が配送順逆転で後着する race の保険。
  conductor.status = "running";
  conductor.sessionIdleAtInAssigning = message.timestamp;
  ...
  await log("assigning_window_close", \`... via=SESSION_IDLE elapsed=\${...}\`);
  await log("conductor_running", \`... via=SESSION_IDLE ...\`);
}
\`\`\`

assigning 中の SESSION_IDLE は **何もしない**（後続の \`session_idle\` ログのみ残す）。
window close は以下 3 経路に一本化:

1. \`SESSION_STARTED source=clear\` 到達（\`daemon.ts:1456-1469\` の正規経路）
2. \`SESSION_CLEAR\` 到達（\`daemon.ts:2079\` の daemon_assign_clear 経路）
3. timeout（\`daemon.ts:2784\` の via=timeout 経路、disconnected フォールバック）

## 修正後の T276 シナリオ（期待挙動）

\`\`\`
17:19:08 SESSION_IDLE       → 無視（assigning 維持）
17:19:09 SESSION_CLEAR      → daemon_assign_clear（既存 line 2079 経路）
17:19:12 SESSION_STARTED    → assigning → running（T232 メイン経路）
\`\`\`

abort されない。

## 対象ファイル

- \`skills/cmux-team/manager/daemon.ts\` — R1 分岐削除
- \`skills/cmux-team/manager/daemon.test.ts\` — R1 経路の test があれば更新/削除
- \`docs/spec/\` — T232 / T261 関連の記述で R1 経路に触れている箇所があれば更新
- \`CLAUDE.md\` — 「Conductor 監視」セクションで触れている場合は更新

## 検証

1. T276 と同様の race（daemon /clear 後 SESSION_IDLE が SESSION_CLEAR より先着）を
   再現し、abort されないこと
2. SESSION_STARTED source=clear が正常到達するケースで window close が動作すること
3. SESSION_STARTED が永遠に来ないケースで timeout 経路が disconnected に倒すこと
4. 既存の T232 / T261 関連 test が pass すること

## 関連

- 発生事例: T276 run #1 (2026-04-20 17:19)
- T232: assigning 中の SESSION_CLEAR は daemon_assign_clear 扱い
- T261: user_clear_decision_snapshot による判断トレース


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-277-1776674765` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-277-1776674765
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-277-1776674765/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/277-assigning-session-idle-r1-session-clear-user-clear-abort/runs/task-277-1776674765
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/277-assigning-session-idle-r1-session-clear-user-clear-abort/runs/task-277-1776674765/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
