---
id: A012
type: research
title: "Master fallback 誤作成の根本原因と対策 (T244)"
created: 2026-04-17T17:13:37.225Z
author: surface:45
---

# T244 Research: Master fallback 誤作成の根本原因

## 概要

タスク背景では「reload 時に surface:67 に Master が誤作成された」とされていたが、Dear の manager.log を時系列で精読すると、実態は **reload 事象ではない**。Conductor C[61] が inspector Agent を spawn した際、SessionStart hook が POST する `SESSION_STARTED` メッセージが、`cmdSpawnAgent` が最後に送る `AGENT_SPAWNED` メッセージよりも daemon に先着する競合が発生しており、daemon 側の SESSION_STARTED fallback 経路（`daemon.ts:1156-1187`）が「事前登録が無い = master」と誤判定して `state.masters` に仮登録している。その後 Agent は通常経路で state.conductors.agents にも追加され、同一 surface が二重管理される状態になる。ユーザーが pane を閉じた時の SESSION_ENDED は `state.masters` を先にヒットするため Master 経路で `disconnected` として永続化され、`.team/masters/surface_67.json` が消えない。

## 事例の時系列（Dear `~/git/Dear/.team/logs/manager.log`）

reload 関連（問題とは無関係な部分）:

- `17:27:24 master_restored U[50] pid=78596 via=pid` — boot 時復元
- `17:27:42 master_session_ended U[50] pid=78596 reason=pid_watcher` — U[50] 死亡
- `17:28:43 master_restore_discarded U[50] reason=pid_missing path=.../surface_50.json` — 次 boot 時 discard
- `17:28:43 master_spawned U[62]` — U[62] 新規 spawn 成功
- `17:28:50 master_session_started U[62] pid=7367` — 正常経路

問題箇所（18:37 前後）:

- `18:34:37 session_ended_other_ignored S[66] reason=other` — 前の Agent A[66] の終了
- `18:34:38 agent_pid_watcher_noop C[61]>A[66] reason=already_removed pid=30475`
- `18:37:09 session_started C[61] pid=6357 source=compact` — C[61] の session 継続
- `18:37:29 master_session_started_fallback U[67] pid=97409 reason=master_registered_not_received_yet` ← **事件発生**
- `18:37:31 agent_spawned C[61]>A[67] role=inspector` ← 2 秒遅れで Agent として登録
- `18:40:20 master_session_started U[67] pid=97409` — idempotent path 経由の再通知
- `18:45:17 session_stop_classified C[67] case=IDLE` + `master_session_idle U[67]`
- `19:07:58 master_session_ended U[67] reason=close-agent` — close-agent CLI により Master 経路で disconnected 化
- `19:36 以降 master_state_surface_ambiguous masters=2, masters=3` — state.masters に残存した surface:67 が原因で Master 状態判定が曖昧化

## Q1-Q5 への回答

### Q1. restoreMasters で既存 Master が検出されなかった理由

**前提が誤っている。** surface:67 は reload 時には存在していない。18:37:29 の事件時点で daemon は既に稼働中（boot 時の restoreMasters は 17:28:43 に完了済み）であり、`restoreMasters` は surface:67 を検出する必要がなかった。タスク背景の「reload 時に誤作成」は実際には「Agent spawn 時に fallback 経路が暴発して Master として仮登録された」現象。

参照: `daemon.ts:663-705` (restoreMasters), `daemon.ts:707-754` (startMaster)

### Q2. MASTER_REGISTERED と SESSION_STARTED の順序（真の問題: AGENT_SPAWNED と SESSION_STARTED）

本件で問題なのは **AGENT_SPAWNED と SESSION_STARTED の順序**。`cmdSpawnAgent` (`main.ts:1925-2108`) の実行順は:

1. L2013 `cmux.newSurface(targetPane)` で surface 取得
2. L2044 `cmux.send(surface, "export ROLE=... CMUX_SURFACE=...")`
3. L2049-2052 `cmux.send(surface, "cd ... && direnv allow")`
4. L2068 `cmux.send(surface, claudeCmd + "\n")` ← **Claude 起動**
5. L2072 `cmux.renameTab`
6. L2075 `postMessage({type: "AGENT_SPAWNED", ...})` ← **daemon への事前登録が最後**

ステップ 4 で Claude が起動すると `SessionStart` hook が即座に発火し `SESSION_STARTED` を daemon に POST する。Claude 起動 → hook POST → daemon 受信は数秒のオーダー。一方ステップ 6 の `postMessage` も数百 ms 〜 秒オーダー。どちらが先に daemon の handleMessage キューに届くかはタイミング依存で、速いマシン・温まった cache・短い prompt では SESSION_STARTED が先着する。

daemon の SESSION_STARTED ハンドラ (`daemon.ts:1137-1187`):

```ts
// T195: Agent surface か？ 全 Conductor の agents 配列を逆引き
let agentMatched = false;
for (const c of state.conductors.values()) {
  const agent = c.agents.find(a => a.surface === message.surface);
  if (agent) { ... agentMatched = true; break; }
}
if (!agentMatched) {
  // T230 F1: master/conductor/agent どれにも該当しない場合の fallback。
  // agent/conductor は事前登録（AGENT_SPAWNED / CONDUCTOR_REGISTERED）が先行する
  // プロトコルなので、ここに到達した SESSION_STARTED は実質 master のみ。
  const fallback: MasterState = { surface, status: "starting", startedAt, pid, fallback: true };
  state.masters.set(message.surface, fallback);
  spawnMasterPidWatcher(state, surface, pid);
  log("master_session_started_fallback", ...);
}
```

**コード中コメント「agent/conductor は事前登録が先行する」が実装されていない。** AGENT_SPAWNED POST は L2075（claudeCmd 送信より後）にあるため、Claude 起動時 hook の SESSION_STARTED より遅い可能性があり、fallback 経路が確率的に暴発する。

さらに **fallback 後に AGENT_SPAWNED が届いても掃除されない**。`AGENT_SPAWNED` ハンドラ (`daemon.ts:1022-1050`) は state.masters に fallback=true のエントリがあっても何もせず、`state.conductors.agents` に append するだけ。`CONDUCTOR_REGISTERED` ハンドラには `daemon.ts:1191-1207` に late register 時の master fallback 掃除ロジックがあるが、AGENT_SPAWNED 側には対称的なロジックが欠落している。

### Q3. Master spawn 時の pid 記録タイミング

Agent の場合のタイミングは以下（`main.ts`）:

- L2013 `newSurface` — surface 取得、claude プロセスはまだ起動していない
- L2068 `cmux.send(surface, claudeCmd)` — Claude 起動、**この時点で pid が確定し、SessionStart hook が pid 付きで SESSION_STARTED POST**
- L2075 `postMessage(AGENT_SPAWNED, {... no pid ...})` — pid なしで POST

Master の場合 (`master.ts:28-` / `main.ts:cmdLaunchMaster`):

- `spawnMaster` → new-surface → cd + claude 起動
- `cmdLaunchMaster` 内の `registerSelfAsMaster` が `MASTER_REGISTERED` を pid=none で POST
- 直後に Claude 起動 → SessionStart hook が pid 付きで SESSION_STARTED POST → daemon が master の pid を埋める

fallback 経路 (`daemon.ts:1156-1187`) では `message.pid` をそのまま `MasterState.pid` に流し込み、`spawnMasterPidWatcher` を起動する。persist もその pid を書き込むので、`.team/masters/surface_67.json` には **誤検出された Agent の pid** が Master の pid として書き込まれる。

### Q4. reason=close-agent の意味

`close-agent` reason は `cmdCloseAgent` (`main.ts:2166-2189`) が明示的に送る値。`cmux-team close-agent --surface <s>` CLI 経由で呼ばれる:

```ts
await cmux.closeSurface(surface);
await postMessage({
  type: "SESSION_ENDED",
  surface,
  reason: "close-agent",
  timestamp: new Date().toISOString(),
});
```

事例では、ユーザーがタブを手動で閉じたのか `cmux-team close-agent` を呼んだのか、どちらかが該当する。どちらにしても、SESSION_ENDED ハンドラ (`daemon.ts:1299-1377`) は:

1. Master チェック — `state.masters.get(surface)` — **surface:67 は誤登録されているため Master として検出される**
2. Master だった → `status="disconnected"`, `persistMasterFile` — `.team/masters/surface_67.json` が disconnected として永続化
3. break — Agent のクリーンアップ（`state.conductors.agents` からの削除、`writeAgentDone`）が実行されない

つまり close-agent reason 自体が問題ではなく、**surface が master に誤登録されているため Master 経路に吸い込まれる** ことが Agent クリーンアップを阻害する。

hook shell は T216 で「全送信」ポリシーのため、Master/Agent/Conductor の区別を行わず reason もハードコードしない。reason は明示的に送信する側（CLI コマンドや cmux 本体）が決める。

### Q5. 再現手順

1. cmux-team 稼働中に、Conductor が `cmux-team spawn-agent --conductor-surface <C> --role <R> --prompt-file <P>` を実行
2. Claude 起動が高速（プロンプト短い・cache warm）だと SessionStart hook POST が `cmdSpawnAgent` 末尾の AGENT_SPAWNED POST より先に daemon に届く
3. daemon 側 handleMessage で SESSION_STARTED が先に処理され、state.conductors/agents/masters のいずれにも該当しないため fallback 経路で master 仮登録
4. 2 秒後に AGENT_SPAWNED が届き state.conductors.agents にも追加 → 同一 surface が Master と Agent の二重登録
5. ユーザーがその Agent surface を `cmux-team close-agent` / `cmux-team kill-agent` / pane 手動 close すると、SESSION_ENDED が Master 経路で処理され disconnected として永続化
6. `state.masters` に残ったエントリが `master_state_surface_ambiguous masters=2/3` 警告を発生させ、TUI/CLI の Master 判定を曖昧化

**再現しやすくする条件:**

- 短いプロンプトファイル（Claude 起動〜hook POST までが速い）
- warm cache（Claude 起動が速い）
- 同時に他の daemon 処理が詰まっていて AGENT_SPAWNED の処理が遅延する

## 根本原因

`cmdSpawnAgent` が AGENT_SPAWNED を Claude 起動後に POST している（`main.ts:2075` は L2068 `send(claudeCmd)` より後）。コード中コメント `daemon.ts:1162` は「agent/conductor は事前登録が先行する」と前提を書いているが、実装はその前提を満たしていない。SESSION_STARTED 到達時点で agent entry が未登録だと、fallback 経路が確率的に master として仮登録する。

さらに、CONDUCTOR_REGISTERED ハンドラは late register 時の master fallback 掃除 (`daemon.ts:1192-1207`) を持つのに対し、AGENT_SPAWNED ハンドラには対称の掃除ロジックが無い。そのため一度 fallback で master 登録されると二度と解除されない。

## 対策の方向性

### 本タスクで実施する修正（リスク小）

#### A. cmdSpawnAgent で AGENT_SPAWNED を Claude 起動前に POST

`main.ts:2075` の `postMessage({type: "AGENT_SPAWNED", ...})` を、L2044 の `cmux.send(surface, "export ...")` より前（すなわち surface 作成直後）に移動する。これにより:

- daemon 側の state.conductors.agents に surface が事前登録される
- その後 Claude 起動 → SessionStart hook → SESSION_STARTED POST が届いた時点では、agentMatched 経路に入る
- fallback 経路の暴発を **根本的に** 防げる

変更箇所:
- `main.ts:cmdSpawnAgent` 関数内で postMessage 位置を移動（L2013 直後）
- コメント更新（「agent は事前登録が先行する」が実装で保証されることを明記）

リスク: 極めて低い。AGENT_SPAWNED の payload に pid/sessionId は含まれないため、Claude 起動前でも情報は揃っている。既存の二重 POST は発生しない（1 箇所に集約）。

#### B. AGENT_SPAWNED ハンドラに master fallback 掃除ロジックを追加（保険）

CONDUCTOR_REGISTERED ハンドラ (`daemon.ts:1192-1207`) と対称的に、AGENT_SPAWNED ハンドラに以下を追加:

```ts
case "AGENT_SPAWNED": {
  // T234 対称: SESSION_STARTED F1 fallback で同 surface が master として仮登録されていたら掃除
  const staleMaster = state.masters.get(message.surface);
  if (staleMaster?.fallback) {
    await removeMaster(state, message.surface, "agent_spawned_late");
    await log("master_fallback_cleanup", `${formatSurface(message.surface, "U")} reason=agent_spawned_late`);
  }
  // ... 既存処理 ...
}
```

対策 A が効けばそもそも race が起きないため不要だが、以下のケースで保険になる:
- daemon の handleMessage キュー詰まり
- 将来的に AGENT_SPAWNED の POST タイミングが変わった場合
- 手動で POST されたケース

リスク: 低い。`removeMaster` は pidWatcher 停止 + state 削除 + ファイル削除の冪等操作。

### follow-up タスクに分割する設計変更（リスク中〜大）

#### C. SessionStart hook の payload に role を含める

settings.json / 環境変数 `ROLE` を使って、SessionStart hook が POST する SESSION_STARTED メッセージに role 情報を付加する。daemon 側 fallback 経路で role を見て、Master なら master 登録、Agent なら一時的に buffer して AGENT_SPAWNED 待ち、という設計にする。

規模大: hook shell の payload 構造変更、`schema.ts` の型変更、daemon の全ハンドラに影響。T216 の「hook 側でフィルタしない」ポリシーとのバランスも検討必要。

#### D. close-agent / kill-agent の role 検証

`cmdCloseAgent` / `cmdKillAgent` を呼ぶ前に、surface が実際に state.conductors.agents に属することを確認する（state.masters にあるなら拒否 or 警告）。誤操作時の副作用を最小化する。

#### E. 既存 disconnected master の清掃手順

Dear プロジェクトに残存する `.team/masters/surface_67.json` (disconnected) を安全に掃除する CLI サブコマンド追加、または起動時のゴミ掃除ロジック。

本タスクでは Dear の手動清掃手順のみ summary.md に記載する。

## 推奨する次のアクション（優先度順）

1. **[本タスク] 対策 A 実装**: `main.ts:cmdSpawnAgent` の AGENT_SPAWNED POST を Claude 起動前に移動
2. **[本タスク] 対策 B 実装**: `daemon.ts` AGENT_SPAWNED ハンドラに master fallback 掃除を追加
3. **[本タスク] 関連テスト追加**: `daemon.test.ts` / `main.test.ts` に race シナリオのユニットテスト
4. **[本タスク] 既存 Dear の清掃手順を summary.md に記載**: ユーザーが手で消すべきファイル
5. **[follow-up タスク化] 対策 C**: hook payload に role を含める設計
6. **[follow-up タスク化] 対策 D**: close-agent/kill-agent の role 検証
7. **[follow-up タスク化] 対策 E**: 起動時の fallback=true 古いマスター掃除ロジック

## コード参照サマリ

| 項目 | ファイル:行 |
|------|----------|
| `cmdSpawnAgent` | `skills/cmux-team/manager/main.ts:1925-2108` |
| AGENT_SPAWNED POST（問題箇所） | `skills/cmux-team/manager/main.ts:2074-2082` |
| `cmdCloseAgent` | `skills/cmux-team/manager/main.ts:2166-2189` |
| SESSION_STARTED ハンドラ | `skills/cmux-team/manager/daemon.ts:1063-1188` |
| SESSION_STARTED fallback 経路 | `skills/cmux-team/manager/daemon.ts:1156-1187` |
| AGENT_SPAWNED ハンドラ | `skills/cmux-team/manager/daemon.ts:1022-1050` |
| CONDUCTOR_REGISTERED ハンドラ | `skills/cmux-team/manager/daemon.ts:1191-1238` |
| MASTER_REGISTERED ハンドラ | `skills/cmux-team/manager/daemon.ts:1240-1297` |
| SESSION_ENDED ハンドラ（Master 優先判定） | `skills/cmux-team/manager/daemon.ts:1299-1377` |
| `restoreMasters` | `skills/cmux-team/manager/daemon.ts:663-705` |
| `startMaster` | `skills/cmux-team/manager/daemon.ts:707-754` |
| `removeMaster` | `skills/cmux-team/manager/daemon.ts:760-` |
