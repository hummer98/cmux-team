# タスク割り当て

## タスク内容

---
id: 261
title: user_clear 誤判定の原因特定に必要な判定根拠スナップショット
priority: medium
created_by: surface:130
created_at: 2026-04-18T14:23:46.439Z
depends_on: [260]
---

## タスク
## 背景

T253 × C[128] の事例（2026-04-18 21:10:42 → 21:10:45）で、daemon が送った `/clear` 直後の `SESSION_IDLE` を **`user_clear` と誤判定** し、assign したばかりの T253 を即 abort した疑いがある。

```
21:10:42 conductor_started task_id=253 C[128]        # assign 完了
21:10:44 session_stop_classified C[128] case=IDLE    # 2秒で idle 判定
21:10:44 conductor_running via=SESSION_IDLE
21:10:44 session_idle C[128]
21:10:45 task_aborted task_id=253 reason=user_clear  # ← 誤判定の疑い
```

現状のログでは「なぜ `user_clear` と判断したか」が追えない。
T260（disconnect/broken 周辺のログ拡充）は `user_clear` のトップレベル化までは含むが、**判定瞬間のスナップショット**は含まれていないため、本タスクで独立して対応する。

## 拡充したいログ

### 【高】1. user_clear 判定の根拠スナップショット

`session_stop_classified` や `task_aborted reason=user_clear` を発行する直前で、判定材料を 1 行に集約してログに出す。

含めるべきフィールド案:
- `prev_status=<assigning|running|...>` （判定時点の Conductor status）
- `assigning_set_at=<ISO>` / `clear_sent_at=<ISO>` / `session_started_clear_at=<ISO>` / `session_idle_at=<ISO>`
- `elapsed_since_clear_sent=<ms>`
- `prompt_sent_at=<ISO|null>` / `prompt_bytes=<N|null>`
- `case=<USER_CLEAR|IDLE|...>` と `decision_reason=<文字列>`

目的: 「clear 送信から 2 秒しか経っていない段階での idle を user_clear と判定した」ことを 1 ログで確認できる状態にする。

### 【高】2. daemon 送信イベントの明示的ログ

現状 `/clear` や新プロンプトの送信は低レベル cmux コマンドのラッパー層でしかログされず、**daemon の意図**と紐付いていない。

追加したいログ:
- `clear_sent C[N] source=<daemon_assign|daemon_reset|daemon_restart|...> taskRunId=<...>`
- `assign_prompt_sent C[N] task_id=<X> bytes=<N> prompt_file=<path>`

目的: 「daemon が送った /clear」と「ユーザーが送った /clear」の区別をログ上で可能にする。

### 【中】3. SESSION_IDLE の source 推定と不確実性の明示

hook push で届く `SESSION_IDLE` は「手動 /clear 後」「assign 直後のプロンプト未投入」「Agent 完了」等で発火しうるが、判定ロジックが推定している source をそのままログに出す。

追加したいログ:
- `session_idle_source_guess=<clear_transient|user_clear|prompt_pending|assigned|unknown>`
- 推定できない場合は `unknown` を明示（現状は暗黙 fallback されている可能性がある）

### 【中】4. assigning → running 遷移の窓ログ

T232 で `assigning` 状態を入れて race を塞いだが、**window が閉じる瞬間のログ**がない。

追加したいログ:
- `assigning_window_open C[N] task_id=X clear_sent_at=<ISO>`
- `assigning_window_close C[N] via=<SESSION_STARTED_clear|SESSION_IDLE|timeout> elapsed=<ms>`

目的: assigning → running に倒す瞬間の判定材料を後追い可能にする。

## 調査してほしい点

- `session_stop_classified` / `classifyStop` の実装箇所と、判定に使っている state を列挙する
- `/clear` や新プロンプトの送信時刻を既存 state に保持しているか（なければ追加する場所の特定）
- SESSION_IDLE hook を受信したときに、source を判別する既存ロジックがどこまで書かれているか
- T260 と統合するか、独立 PR にするか（状態スナップショット追加は T260 と密結合しうる）

## 参考

- `skills/cmux-team/manager/classify-stop.ts` / `classify-stop.test.ts`
- `skills/cmux-team/manager/daemon.ts` の SESSION_IDLE / SESSION_CLEAR ハンドラ
- `skills/cmux-team/manager/conductor.ts:420` 付近（T232 の assigning 導入箇所）
- CLAUDE.md 「ロギングポリシー」「hook 全送信ポリシー」
- 関連タスク: T254（Task の二重起動 unique 制約）、T260（disconnect/broken 周辺のログ拡充）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-261-1776560866` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-261-1776560866
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-261-1776560866/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/261-user-clear/runs/task-261-1776560866
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/261-user-clear/runs/task-261-1776560866/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
