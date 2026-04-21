---
id: 260
title: Conductor disconnect/broken 周辺のログ拡充
priority: medium
created_by: surface:130
created_at: 2026-04-18T14:06:02.510Z
---

## タスク
## 背景

T254 × C[128] の調査（2026-04-18）で、Conductor が disconnect → broken に遷移する前後のログが不足しており、「broken なのに T254 の Agent が spawn され続けている」現象の原因特定に時間がかかった。

本タスクでは、今後の同種調査で「1 本のログを読めば状態が分かる」ようにログを拡充する。

## 実例タイムライン（T254 × C[128]）

- 21:11:02 T254 を C[128] に assign
- 21:12:03 `conductor_assign_timeout` (62s)
- **21:12:03 〜 21:17:13 の 5 分間: C[128] に関するログが一切ない**
- 21:17:13 `conductor_disconnect_timeout` → T254 `task_aborted`
- 21:17:15 `conductor_broken C[128]`
- 22:40 以降: broken の C[128] から `agent_spawned` が繰り返し発生（Conductor プロセスは生存継続）

## 拡充したいログ（優先度順）

### 【高】1. disconnect 期間のスナップショット

`conductor_disconnected` 遷移時と `conductor_disconnect_timeout` 発火時に、1 本で状態が分かるログを出す。

含めるべきフィールド案:
- `pid=X alive=true|false`（`process.kill(pid, 0)` の結果）
- `last_hook_at=<ISO>` （最後の SESSION_* push の時刻）
- `elapsed_since_last_hook=Ns`
- `taskRunId=...`

### 【高】2. broken 後の Conductor プロセス生存可視化

- `conductor_broken` 時に `pid=X alive=true|false` を必ず併記
- broken 中に Conductor から push や spawn-agent リクエストが来たら `broken_conductor_still_alive C[N] pid=X event=spawn_agent|session_idle|...` を出す（現在の `session_event_ignored_broken` だけでは「プロセス生存中」という危険状態が伝わらない）

### 【中】3. abort 通知の有無

`task_aborted` 時に、Conductor 側へ停止シグナルを送ったか/送っていないかを明示的にログする。
- `abort_signal_sent C[N] task_id=X method=none|send|kill`
- 「何もしていない」こともログとして残すことが重要（現状は無言で Conductor が走り続けるのが追えない）

### 【中】4. user_clear / その他 abort 理由のトップレベル化

現状 `user_clear` は task-state.json の journal 文字列にしか現れない。`task_aborted task_id=N reason=user_clear|disconnect_timeout|assign_failed|...` の形式で **トップレベルイベント化** し、reason を機械可読にする。

### 【中】5. spawn-agent の発行元情報

`agent_spawned C[N]>A[M]` に以下を追加:
- `caller_pid=X` （呼び出した Conductor プロセスの PID）
- `caller_surface=Y` （Manager 経由か手動かの区別）

今回のような「broken 扱いのはずの Conductor から Agent が生える」現象の発生源が即特定できるようになる。

## 調査してほしい点

- 各イベントでログに含められる情報（PID 生存状態、最終 hook 時刻など）が既存の state から取得可能か
- 特に「broken 後も Conductor プロセスが生きている」状態を検知するフック/タイマーが現状あるか、なければどこで検知するのが適切か
- reason を機械可読にする場合、既存の journal 互換性をどう保つか
- 上記 5 項目を 1 PR にまとめるか、優先度ごとに分割するか

## 参考

- `skills/cmux-team/manager/daemon.ts` の disconnect/broken 遷移箇所
- `skills/cmux-team/manager/conductor.ts` の `spawnPidWatcher`
- `skills/cmux-team/manager/logger.ts`
- CLAUDE.md 「ロギングポリシー」
