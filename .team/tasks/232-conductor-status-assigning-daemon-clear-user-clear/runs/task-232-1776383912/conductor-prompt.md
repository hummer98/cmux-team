# タスク割り当て

## タスク内容

---
id: 232
title: Conductor status に assigning を追加して daemon 起動の /clear を user_clear と誤認するバグを修正
priority: high
created_at: 2026-04-16T23:58:32.883Z
---

## タスク
## 背景・問題

daemon が Conductor にタスクを割り当てる際、自分で送った `/clear` に起因する `SESSION_CLEAR` hook を **ユーザー手動の /clear と誤認してタスクを abort する** race condition がある。

### 発生シーケンス（T230 で実観測）

1. daemon `assignTask` が `/clear` を送信（`conductor.ts:374` 付近）
2. `assignTask` の後処理で `conductor.status = "running"` をセット（`conductor.ts:416` 付近、~3 秒後）
3. Claude Code 側で `/clear` 処理完了 → `SessionEnd` hook が遅延発火（~10 秒後）
4. daemon は `SESSION_CLEAR` を受信。`daemon.ts:1481` 付近の分岐で `conductor.status === "running"` のため **user_clear と判定 → タスクを aborted に書き換え** → ジャーナルに `user_clear: C[NNN] taskRunId=...` と記録
5. 実際には Conductor はタスクを実行し続けているが、`task-state.json` 上は aborted 扱いで Master からは中断タスクに見える

ログ証拠は T230 (`.team/tasks/230-master-self-register/`) のジャーナルと `manager.log` を参照。

## やること

Conductor の status に **`assigning`** を新設し、「daemon が /clear を送信した直後 〜 Claude Code が再起動して SESSION_STARTED を返すまで」の窓を明示的に表現する。この窓の間の `SESSION_CLEAR` は daemon 起動と判定してスキップする。

### 変更点の骨子（調査の上で判断してください）

1. **`schema.ts:181`** `ConductorStatus` enum に `"assigning"` を追加
   - `"starting" | "idle" | "running" | "asking" | "disconnected"` → `+ "assigning"`

2. **`conductor.ts` の `assignTask`**
   - `/clear` 送信直前に `conductor.status = \"assigning\"` をセット
   - 現状 `conductor.ts:416` 付近で `/clear` 送信後に `status = \"running\"` を即時セットしているが、**この即時セットを削除**し、SESSION_STARTED 受信時の遷移に委ねる
   - taskId / taskRunId / taskTitle などのメタデータは従来通り assignTask で埋める

3. **`daemon.ts` の `SESSION_STARTED` ハンドラ（1010 付近）**
   - conductor.status が `\"assigning\"` の場合に `\"running\"` へ遷移させる分岐を追加
   - 現在の `starting/disconnected → idle` ロジックはそのまま
   - ログイベント名は `conductor_running` など妥当な名前に（命名は実装者判断）

4. **`daemon.ts` の `SESSION_CLEAR` ハンドラ（1481 付近、user_clear 判定）**
   - `conductor.status === \"assigning\"` の場合は **daemon 起動の /clear と判定し、user_clear 処理をスキップして早期 return**
   - ログには \`session_clear_expected\` 等で記録（debug 追跡用）
   - 既存の `status === \"running\"` 判定はユーザー手動 /clear のルートとして残す（assigning を抜けた後のみ該当）

5. **タイムアウトフォールバック**
   - `assigning` のまま SESSION_STARTED が届かない異常ケース（hook 配信失敗、Claude Code クラッシュ）に備え、30〜60 秒の timer で `assigning → disconnected` に倒す保険を入れる
   - 時間は実装者判断。他の PID watcher などとの整合を見て決める

### 注意

- `conductor.taskId` / `taskRunId` は assignTask の途中で既に埋まっているため、`assigning` 中の `SESSION_CLEAR` をスキップする際も task-state には触らない（書き戻し不要）
- 既存テスト（`main.test.ts` の hook 関連テスト、`classify-stop.test.ts`）を壊さないこと
- dashboard.tsx に Conductor status を描画している箇所があれば `assigning` も表示できるよう対応（列幅が足りなければ短縮表記でよい）

## 検証観点

1. **ユニットテスト**: `assignTask → SESSION_STARTED source=clear` の順で status が `assigning → running` に遷移し、途中で受信した `SESSION_CLEAR` が user_clear と判定されないこと
2. **ユーザー手動 /clear**: Conductor が通常の `running` 状態で `/clear` を打った場合、従来どおり task_aborted になること（既存動作の回帰がないこと）
3. **実機**: 本ワークツリーで `cmux-team start` → ready タスクを投入し、task-state.json が aborted にならずに closed まで行くこと
4. **タイムアウト**: 手動で SESSION_STARTED を遮断した状態で assigning のまま 60 秒放置し、disconnected に倒れるログが出ること（任意）

## 参考コード位置（起点として）

- `skills/cmux-team/manager/schema.ts:96-102` SessionClearMessage schema
- `skills/cmux-team/manager/schema.ts:181` ConductorStatus enum
- `skills/cmux-team/manager/conductor.ts:257-424` assignTask 全体
- `skills/cmux-team/manager/conductor.ts:374-416` /clear 送信 〜 status=running セット
- `skills/cmux-team/manager/daemon.ts:1010` SESSION_STARTED ハンドラ
- `skills/cmux-team/manager/daemon.ts:1481-1498` user_clear 判定分岐
- `skills/cmux-team/manager/daemon.ts:1500-1506` SESSION_CLEAR による pid クリア & resetConductor

## 参考: 検討したが不採用の案

- カウンタ方式（`expectedClearCount` を increment/decrement）: 状態の明示性が弱く、デバッグ時に数が合わない事故が起きやすい
- 時間窓方式（`lastDaemonClearAt` + grace 期間）: 遅延が可変なので窓幅の決め方が難しい
- `/clear` にトークン付加（`/clear DAEMON_TOKEN_xxx`）: Claude Code 側の slash command 引数解釈に依存し、UserPromptSubmit hook の発火順も不確定。実装が fragile

## 関連タスク

- T230（abort 済み。再実行の判断は別途）: 本バグの影響を受けた実例。修正後に再起票するか判断する

## 重要な注意（並行作業あり）

**T230 のワークツリーで別の作業が並行進行中**。task-state.json 上は T230 は aborted だが、本バグの影響で Conductor C[377] のセッションは実動作を続けており、`.worktrees/task-230-1776382576/` で human による手動 resume で完結させる予定。

T230 は **本タスクと同じファイル群** (`daemon.ts` / `conductor.ts` / `schema.ts`) を触る可能性が高い（Master self-register 化のため `state.masters` や SESSION_STARTED ハンドラに手を入れる）。したがって:

1. **main ベースで作業すること** — T230 のブランチには依存しない
2. **コミット前に `git fetch origin main && git log origin/main..HEAD` でズレを確認** — T230 が先に main にマージされた場合、worktree 内で `git merge origin/main` してコンフリクト解消すること
3. **コンフリクトしたら 1. まず merge で取り込み 2. 両方の変更が共存できるよう手動で統合** — T230 の `state.masters` 化と本タスクの `ConductorStatus "assigning"` 追加はどちらも重要なので、どちらかの変更を破棄せず両立させる
4. **テストは merge 後に再実行** — `bun test` が pass することを確認してから PR/マージへ

T230 が未マージのまま先に本タスクが完了した場合は、PR 説明に「T230 とのマージ順に注意」と明記すること。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-232-1776383912` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-232-1776383912
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-232-1776383912/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/232-conductor-status-assigning-daemon-clear-user-clear/runs/task-232-1776383912
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/232-conductor-status-assigning-daemon-clear-user-clear/runs/task-232-1776383912/summary.md` に書き出す。

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
