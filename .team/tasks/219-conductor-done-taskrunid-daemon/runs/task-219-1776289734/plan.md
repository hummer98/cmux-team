# T219 実装計画書

**タスク**: CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED に taskRunId 一致検証を導入し、stale signal による誤処理を構造的に遮断する

**対象**: `skills/cmux-team/manager/{schema.ts, main.ts, daemon.ts}`

---

## 1. 課題分析

### 1.1 現状の問題点

daemon のメッセージハンドラは、Conductor surface を使って `state.conductors` を逆引きし、その surface に現在アサインされているタスクに対して操作を行う。しかし **メッセージ自体にはどのタスクに対する完了通知かを示す情報が無い**ため、以下の条件下で誤処理が発生する:

1. **遅延配送** — キュー滞留中に Conductor が別タスクにアサインされる
2. **daemon 再起動** — in-memory state を失い、再起動後に届くメッセージが再構築後の state と突合される
3. **二重送信** — 同じ Conductor が CONDUCTOR_DONE を複数回送る（T214 で直接原因は解消済みだが、同じ構造脆弱性が残る）

対象ハンドラは 3 箇所ともに **destructive な副作用**（task-state の書き換え、resetConductor、worktree 削除）を伴うため、誤発火は致命的な state 乖離を生む。

### 1.2 根本原因の特定

`state.conductors[surface].taskRunId` は既に assignTask 時点で設定されている (`conductor.ts:430`)。一方、送信側メッセージ (CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED) は surface しか載せていないため、daemon 側では「このメッセージが対象にしていた taskRun」と「現在その surface に紐付く taskRun」の同一性を検証できない。

この非対称性が stale signal 誤処理の構造的原因。

### 1.3 影響範囲

| ハンドラ | 位置 | destructive 度合 | 事故事例 |
|----|----|----|----|
| CONDUCTOR_DONE | daemon.ts:720-751 | 高 (handleConductorDone → resetConductor) | 2026-04-16 T213 誤 reset (T214 修正済) |
| SESSION_CLEAR (running 分岐) | daemon.ts:1132-1157 | 高 (task-state aborted 書き換え + resetConductor) | 未発生だが手動 /clear の遅延配送で再現可能 |
| SESSION_STARTED (T203 分岐) | daemon.ts:803-829 | 中 (task-state[taskId].sessionId 上書き → resume 時に誤セッションを掴む) | 未発生 (日常稼働への影響は限定的だが daemon 再起動 resume で顕在化) |

---

## 2. 技術アプローチ

### 2.1 選択したアプローチ

**message に `taskRunId` を optional で乗せ、daemon 側で `conductor.taskRunId` との一致検証を行う。**

- schema に `taskRunId: z.string().optional()` を追加（optional ＝ 旧クライアント互換）
- 送信側 (main.ts) で conductor.taskRunId を拾って添付
- 受信側 (daemon.ts) で以下のガードを実施:

```ts
// 共通パターン（擬似コード）
if (message.taskRunId && conductor.taskRunId && message.taskRunId !== conductor.taskRunId) {
  await log("conductor_done_stale" /* or session_clear_stale */, ...);
  break;  // 処理スキップ
}
```

- **互換モード**: どちらか片方が undefined の場合は既存挙動を維持（旧クライアントや hook が taskRunId を知らない経路を壊さない）

### 2.2 代替案と却下理由

| 代替案 | 却下理由 |
|----|----|
| **taskRunId を必須化** | hook 経由の SESSION_CLEAR (Claude CLI の /clear hook) は taskRunId を知らない。必須化すると hook 配布物を必ず更新する必要があり、段階的ロールアウトができない |
| **全メッセージ共通の stale 検証ミドルウェア化** | 各ハンドラで surface → conductor 逆引きの位置が異なり、汎用化するとロジックが追いづらくなる。T219 スコープでは 3 箇所に直接書く方が根本対策としても読みやすい（タスクの「やらないこと」で明示除外されている） |
| **`sessionId` で同一性検証** | SESSION_STARTED の sessionId は「新セッションの ID」なので conductor.sessionId と突合できない。taskRunId は assignTask 単位で一意なので突合キーとして適切 |
| **surface に taskRunId を埋め込む** | cmux 側の surface ID 形式を壊す。採用不可 |

### 2.3 既存パターンとの整合性

- **`ConductorState.taskRunId`** (`schema.ts:147`): 既に optional string として定義済み。assignTask で set (`conductor.ts:430`)、resetConductor で clear (`conductor.ts:516`)。本タスクでは **schema 拡張不要**。
- **`TaskState.taskRunId`** (`task.ts:34`): 既に task-state.json 側にも記録されている。SESSION_STARTED の検証で `current.taskRunId === conductor.taskRunId` 比較に利用可能。
- **`team.json.conductors[].taskRunId`** (`daemon.ts:1618`): 既に書き出されている。close-task / abort-task / restart-task は team.json から conductor を引くため、taskRunId をそのまま拾える (close-task の trace DB 挿入で `conductor?.taskRunId` 参照済 `main.ts:2394`)。
- **stale ログの既存例**: `session_ended_ignored` (daemon.ts:889), `conductor_done_ignored` (daemon.ts:723), `conductor_done_late_cleanup` (daemon.ts:739) — ログフォーマットは `reason=<理由>` を末尾に付ける統一形式。本タスクで追加する `conductor_done_stale` / `session_clear_stale` / `task_session_update_skipped` も同形式に揃える。

---

## 3. 変更対象

### 3.1 `schema.ts` — メッセージ schema 拡張

**対象**: `ConductorDoneMessage` (19-28 行) / `SessionClearMessage` (95-100 行)

```diff
 export const ConductorDoneMessage = z.object({
   type: z.literal("CONDUCTOR_DONE"),
   sessionId: z.string().optional(),
   transcriptPath: z.string().optional(),
   surface: z.string(),
+  taskRunId: z.string().optional(),
   success: z.boolean(),
   reason: z.string().optional(),
   exitCode: z.number().optional(),
   timestamp: z.string().datetime(),
 });
```

```diff
 export const SessionClearMessage = z.object({
   type: z.literal("SESSION_CLEAR"),
   surface: z.string(),
+  taskRunId: z.string().optional(),
   pid: z.number().optional(),
   timestamp: z.string().datetime(),
 });
```

**SESSION_STARTED は schema 変更なし**。hook 配布物が taskRunId を知らないため。daemon 側で `conductor.taskRunId` と `task-state.json[conductor.taskId].taskRunId` の突合のみ行う。

**補足**: `TaskCreatedMessage` / `TaskUpdatedMessage` 等は対象外（destructive な処理を伴わない）。

### 3.2 `main.ts` — 送信側 taskRunId 添付

#### 3.2.1 `cmdCloseTask` (2333-2406 行)

```diff
   const conductor = teamJson?.conductors?.find((c: any) => c.taskId === taskId);
   if (conductor?.surface) {
     await postMessage({
       type: "CONDUCTOR_DONE",
       surface: conductor.surface,
+      taskRunId: conductor.taskRunId,
       success: true,
       timestamp: new Date().toISOString(),
     });
   }
```

#### 3.2.2 `cmdAbortTask` (2737-2838 行)

```diff
   // 7. CONDUCTOR_DONE メッセージ送信
   await postMessage({
     type: "CONDUCTOR_DONE",
     surface: conductor.surface,
+    taskRunId: conductor.taskRunId,
     success: false,
     reason: "aborted",
     timestamp: new Date().toISOString(),
   });
```

#### 3.2.3 `cmdRestartTask` (2907-3009 行)

```diff
   // 5. CONDUCTOR_DONE メッセージ送信
   await postMessage({
     type: "CONDUCTOR_DONE",
     surface: conductor.surface,
+    taskRunId: conductor.taskRunId,
     success: false,
     reason: "restarted",
     timestamp: new Date().toISOString(),
   });
```

#### 3.2.4 `send CONDUCTOR_DONE` サブコマンド (main.ts:873-884)

CLI 経由で CONDUCTOR_DONE を送る手動ルートに `--task-run-id` optional フラグを追加。SESSION_CLEAR にも同様に追加する。

```diff
     case "CONDUCTOR_DONE":
       message = {
         type: "CONDUCTOR_DONE",
         surface: normalizedSurface!,
+        taskRunId: getArg("task-run-id"),
         success: getArg("success") !== "false",
         reason: getArg("reason"),
         exitCode: getArg("exit-code") ? Number(getArg("exit-code")) : undefined,
         sessionId: getArg("session-id"),
         transcriptPath: getArg("transcript-path"),
         timestamp: now,
       };
       break;
```

```diff
     case "SESSION_CLEAR":
       message = {
         type: "SESSION_CLEAR",
         surface: normalizedSurface!,
+        taskRunId: getArg("task-run-id"),
         pid: getArg("pid") ? Number(getArg("pid")) : undefined,
         timestamp: now,
       };
       break;
```

**送信側での SESSION_CLEAR 実運用**: hook スクリプト (SessionStart / SessionEnd) は Claude CLI が直接走らせるため、taskRunId を環境変数経由で知ることが難しい。本タスクでは `--task-run-id` フラグを CLI に用意するのみで、hook 配布物側の taskRunId 取得改修は別タスクに分離する（タスク定義の「やらないこと」と整合）。

### 3.3 `daemon.ts` — 受信側検証ロジック

#### 3.3.1 `CONDUCTOR_DONE` ハンドラ (daemon.ts:720-751)

現状の no_task / not_found ガードの直後に taskRunId 検証を追加:

```ts
case "CONDUCTOR_DONE": {
  const conductor = findConductor(state, message.surface);
  if (!conductor) {
    await log("conductor_done_ignored", `${formatSurface(message.surface, "C")} reason=not_found`);
    break;
  }
  if (conductor.status !== "running" && !conductor.taskRunId) {
    await log("conductor_done_ignored", `${formatSurface(message.surface, "C")} status=${conductor.status} reason=no_task`);
    break;
  }

  // === 追加: taskRunId 一致検証 ===
  if (
    message.taskRunId &&
    conductor.taskRunId &&
    message.taskRunId !== conductor.taskRunId
  ) {
    await log(
      "conductor_done_stale",
      `${formatSurface(message.surface, "C")} message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
    );
    break;
  }
  // ===

  if (conductor.status !== "running") {
    await log("conductor_done_late_cleanup", ...);
  }
  const isSuccess = message.success !== false;
  await log(...);
  await handleConductorDone(state, conductor);
  break;
}
```

**ガード順序の理由**: `conductor_done_ignored reason=no_task` の後に置くことで、taskRunId 未添付の旧クライアントからのメッセージ（message.taskRunId=undefined）は既存ガードで弾くか通すかが決まり、taskRunId 検証は「両方ある場合の追加防御」として機能する。

#### 3.3.2 `SESSION_CLEAR` ハンドラ (daemon.ts:1122-1160)

running 分岐の先頭で検証を追加:

```ts
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);

  // === 追加: running 分岐直前で taskRunId 一致検証 ===
  if (
    conductor &&
    conductor.status === "running" &&
    message.taskRunId &&
    conductor.taskRunId &&
    message.taskRunId !== conductor.taskRunId
  ) {
    await log(
      "session_clear_stale",
      `${formatSurface(message.surface, "C")} message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
    );
    break;
  }
  // ===

  if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
    // 既存: idle 復帰
  }
  if (conductor && conductor.status === "running") {
    // 既存: task abort + reset
  }
  break;
}
```

**注意**: disconnected / starting → idle 遷移分岐は destructive ではないので検証不要（ただし stale で復帰させるのも微妙だが、idle 復帰は無害なのでここではガードしない）。running 分岐のみ守る。

#### 3.3.3 `SESSION_STARTED` T203 分岐 (daemon.ts:803-829)

task-state.json 更新ブロックに、`current.taskRunId === conductor.taskRunId` の突合を追加:

```ts
// T203 C3: assigned タスクに対する /clear シミュレーションで task-state.json 同期
if (
  message.sessionId &&
  prevSessionId !== message.sessionId &&
  conductor.taskId
) {
  try {
    const ts = await loadTaskState(state.projectRoot);
    const cur = ts[conductor.taskId];

    // === 追加: taskRunId 一致検証 ===
    if (
      cur &&
      conductor.taskRunId &&
      cur.taskRunId &&
      cur.taskRunId !== conductor.taskRunId
    ) {
      await log(
        "task_session_update_skipped",
        `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} task_state_task_run_id=${cur.taskRunId} conductor_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`
      );
    } else if (
      cur &&
      cur.status === "assigned" &&
      cur.sessionId !== message.sessionId
    ) {
      ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
      await saveTaskState(state.projectRoot, ts);
      await log("task_session_updated", ...);
    }
    // ===
  } catch (e: any) {
    await log("error", `task-state update failed on session_started: ${e?.message ?? e}`);
  }
}
```

**補足**: SESSION_STARTED は schema 変更しない。検証は daemon 内部で持つ 2 つの情報 (`conductor.taskRunId` と `task-state[taskId].taskRunId`) のみで行う。これらは assignTask で同一値にセットされるため、整合する限り検証を通過する。不一致は assignTask/resetConductor の境界を跨いだ state 破れを示す。

---

## 4. サブタスク分割

### 4.1 Schema 拡張 (schema.ts)

- **対象**: `skills/cmux-team/manager/schema.ts`
- **変更**: `ConductorDoneMessage` / `SessionClearMessage` に `taskRunId: z.string().optional()` を追加
- **完了条件**: `bunx tsc --noEmit` が通る
- **検証コマンド**:
  ```bash
  rg 'taskRunId: z\.string\(\)\.optional\(\)' skills/cmux-team/manager/schema.ts | wc -l
  # → 期待値: 2
  ```

### 4.2 送信側 taskRunId 添付 (main.ts close-task / abort-task / restart-task)

- **対象**: `skills/cmux-team/manager/main.ts`
- **変更**: 3 箇所の `postMessage({ type: "CONDUCTOR_DONE", ... })` に `taskRunId: conductor.taskRunId` を追加
- **完了条件**: 3 箇所の CONDUCTOR_DONE postMessage 呼び出しが全て taskRunId を含む
- **検証コマンド**:
  ```bash
  rg -A5 'type: "CONDUCTOR_DONE"' skills/cmux-team/manager/main.ts | rg -c 'taskRunId: conductor\.taskRunId'
  # → 期待値: 3
  ```

### 4.3 送信側 CLI サブコマンド拡張 (main.ts send)

- **対象**: `skills/cmux-team/manager/main.ts` の `send` サブコマンド (854-969 行)
- **変更**: `CONDUCTOR_DONE` / `SESSION_CLEAR` ケースで `taskRunId: getArg("task-run-id")` を追加
- **完了条件**: `cmux-team send CONDUCTOR_DONE --surface X --task-run-id task-042-...` が schema validation を通る
- **検証コマンド**:
  ```bash
  rg 'taskRunId: getArg\("task-run-id"\)' skills/cmux-team/manager/main.ts | wc -l
  # → 期待値: 2 (CONDUCTOR_DONE / SESSION_CLEAR)
  ```

### 4.4 受信側検証ロジック追加 (daemon.ts)

- **対象**: `skills/cmux-team/manager/daemon.ts`
- **変更**:
  - CONDUCTOR_DONE ハンドラ (720-751 行付近): taskRunId 不一致で `conductor_done_stale` ログ + break
  - SESSION_CLEAR ハンドラ (1122-1160 行付近, running 分岐前): taskRunId 不一致で `session_clear_stale` ログ + break
  - SESSION_STARTED T203 分岐 (803-829 行付近): `cur.taskRunId !== conductor.taskRunId` で `task_session_update_skipped` ログ + sessionId 書き込みスキップ
- **完了条件**: 3 箇所で検証ブロックが追加され、互換モード（どちらかが undefined）では既存挙動を維持
- **検証コマンド**:
  ```bash
  rg -n 'conductor_done_stale|session_clear_stale|task_session_update_skipped' skills/cmux-team/manager/daemon.ts
  # → 期待値: 各 1 行以上ヒット
  ```

### 4.5 ログメッセージ統一確認

- **対象**: daemon.ts の追加 3 箇所
- **変更**: ログフォーマットを既存の stale 系 (`session_ended_ignored` 等) と揃える — `<event_name> <surface> message_task_run_id=<id> current_task_run_id=<id> reason=stale_task_run_id`
- **完了条件**: 3 イベントともに `reason=stale_task_run_id` で統一される
- **検証コマンド**:
  ```bash
  rg 'stale_task_run_id' skills/cmux-team/manager/daemon.ts | wc -l
  # → 期待値: 3
  ```

### 4.6 Type check

- **対象**: 全体
- **変更**: なし（検証のみ）
- **完了条件**: `bunx tsc --noEmit` が exit 0
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bunx tsc --noEmit; echo exit=$?
  # → 期待値: exit=0
  ```

---

## 5. リスク

### 5.1 既存メッセージ互換性

- **リスク**: 旧クライアント（taskRunId を送らない）からの CONDUCTOR_DONE / SESSION_CLEAR が stale 扱いで弾かれる
- **対策**: 検証条件を `message.taskRunId && conductor.taskRunId && message.taskRunId !== conductor.taskRunId` にする。どちらかが undefined なら既存挙動を維持。
- **検証**: 通常の `cmux-team close-task` が taskRunId 添付で動く・hook 配布物の手動 /clear がブロックされないこと

### 5.2 conductor.taskRunId が存在するタイミング

- **リスク**: `assignTask` 実行中の half-state で conductor.taskRunId が undefined のままメッセージが来る
- **対策**: 互換モードにより undefined 側は検証をスキップ。resetConductor 実行後 (taskRunId=undef) も同様。`conductor.status === "running"` のときに限り taskRunId がセットされていることは assignTask 末尾で保証される (conductor.ts:430-437 の順序)。
- **補足**: CONDUCTOR_DONE の既存の `conductor.status !== "running" && !conductor.taskRunId` ガードが先に走るので、late cleanup 経路でも taskRunId 検証が意味を持つ状態でのみ評価される

### 5.3 SESSION_STARTED 分岐の比較条件

- **リスク**: `current.status === "assigned"` 以外（running 遷移後）の扱い
- **現状動作**: running 遷移後は task-state.json 側の status が `assigned` のままである（run 中は status は変わらない、close / abort 時に変わる）。running は `ConductorState.status` 側の概念。task-state.json の status は (draft|ready|assigned|closed|aborted|deleted) で「assigned」が実行中を意味する。
- **対策**: 既存の `cur.status === "assigned"` チェックを残しつつ、新しい taskRunId 検証をその前に置く。不一致 → 書き込みスキップ + ログ。一致かつ status が assigned でなければ既存どおり no-op (sessionId は更新しない)。

### 5.4 taskRunId 必須化のタイミング

- **リスク**: 長期的に optional のままだとガードが効かない旧経路が残る
- **対策**: 本タスクでは optional を維持。全送信経路を taskRunId 添付に移行できた段階で後続タスクで必須化を検討（Decision Log D1 参照）。

---

## 6. 既存型エラーの先読み

### 対象ファイル: schema.ts / main.ts / daemon.ts

実行コマンド:
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-219-1776289734/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "(schema\.ts|main\.ts|daemon\.ts)" || echo "clean"
```

結果: **clean** (該当なし)

- **6.1 本タスクスコープで解消**: 該当なし
- **6.2 後続タスクに分離**: 該当なし

本タスクで追加する変更のみによる型エラー発生がないことを、実装前・実装後に `bunx tsc --noEmit` で確認する。

---

## 7. Decision Log

| ID | 決定内容 | 理由 | 代替案 | 日付 |
|----|----|----|----|----|
| D1 | **taskRunId は optional で導入** | 旧クライアント・hook 配布物 (SESSION_CLEAR) と段階的に共存するため。必須化は後続タスクで全経路移行完了後に実施 | 必須化 → hook 配布物を同時更新する必要があり、破壊的リリースになる | 2026-04-16 |
| D2 | **SESSION_STARTED は schema 変更せず、`conductor.taskRunId` と `task-state[taskId].taskRunId` の内部突合で検証** | Claude CLI の SessionStart hook は taskRunId を環境変数経由で知ることができない (hook 側実装改修は別タスク)。一方 daemon は両側の taskRunId を知っている | schema に taskRunId を追加 → hook 配布物の改修も必要となり本タスクスコープ外 | 2026-04-16 |
| D3 | **検証条件は `message.taskRunId && conductor.taskRunId && 不一致` とする** | 片方 undefined を stale 扱いにすると旧クライアント互換が壊れる。両方ある場合のみ比較する「ベストエフォート防御」とする | 必須化 / undefined を常に通す / undefined を常に弾く — いずれも副作用が大きい | 2026-04-16 |
| D4 | **ログイベント名を `*_stale` で統一 (`conductor_done_stale` / `session_clear_stale` / `task_session_update_skipped`)** | 既存の `*_ignored` / `*_late_cleanup` と区別し、grep で容易に検出できるようにする。`reason=stale_task_run_id` を末尾に付けて運用時に根本原因を追跡可能にする | `stale_detected` 単一イベント — 3 種の区別がつかず運用困難 | 2026-04-16 |
| D5 | **ガード配置は既存 `conductor_done_ignored reason=no_task` の後ろに置く** | 「no_task 状態のメッセージは無視」という既存挙動は taskRunId 検証と直交する。既存ガードが先に走ることで論理が明快になる | 先頭に置く → no_task + message.taskRunId ありのエッジケースで stale 判定が先に走ってしまい、ログが混乱する | 2026-04-16 |
| D6 | **close-task / abort-task / restart-task は team.json から conductor.taskRunId を拾う** | team.json は daemon が定期更新する真のソース。既存コードも同じパターンで conductor を引いている (close-task の trace DB 挿入で `conductor?.taskRunId` を参照済) | 別途 conductor-state を引く — 経路を増やす意味がない | 2026-04-16 |
| D7 | **SESSION_CLEAR の disconnected/starting → idle 分岐には検証を入れない** | 該当分岐は destructive でない (単なる状態遷移)。stale signal で idle 復帰が起きてもタスク被害はない。running 分岐のみ守れば十分 | 全分岐に検証 → 複雑化するだけで実利益なし | 2026-04-16 |

---

## 8. 実装順序（推奨）

1. **schema.ts** — `ConductorDoneMessage` / `SessionClearMessage` に `taskRunId` 追加 → `bunx tsc --noEmit` で型の土台を作る
2. **main.ts 送信側** — close-task / abort-task / restart-task / send サブコマンド 4 箇所に taskRunId 添付。schema 拡張の型補完を利用
3. **daemon.ts 受信側** — 3 ハンドラに検証ロジック追加。ログフォーマット統一
4. **Type check** — `bunx tsc --noEmit` で exit 0 確認
5. **動作確認 (手動)**:
   - `cmux-team close-task --task-id 999 --journal "test"` 後に `.team/logs/manager.log` で `task_completed` が出ること (stale 扱いされない)
   - `rg 'taskRunId=' .team/logs/manager.log` で close-task 経路のメッセージに taskRunId が付いていることを確認
   - 可能なら模擬 stale メッセージ: `cmux-team send CONDUCTOR_DONE --surface <C> --task-run-id task-999-0000000000` を送り、`conductor_done_stale` ログが出ること

---

## 9. 完了条件チェックリスト

タスク側の「完了条件」との対応:

- [ ] schema.ts に CONDUCTOR_DONE / SESSION_CLEAR の taskRunId フィールド追加 → §4.1
- [ ] main.ts の close-task / abort-task / restart-task / send CONDUCTOR_DONE で taskRunId 添付 → §4.2, §4.3
- [ ] daemon.ts の 3 ハンドラで一致検証ロジック追加 → §4.4
- [ ] 既存の正常系が壊れないこと (taskRunId 未添付メッセージが stale 扱いされない互換性) → D3, §5.1
- [ ] log フォーマット `conductor_done_stale` / `session_clear_stale` / `task_session_update_skipped` が出ること → §4.5, D4

実装完了後は各項目を `[x]` にチェックし、手動動作確認結果を §8 の手順に沿って記録すること。
