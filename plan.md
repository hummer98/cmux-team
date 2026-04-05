# T085: task_completed 二重記録バグの修正計画

## 根本原因

### 直接原因: `handleConductorDone` にステータスガードがない

`daemon.ts:353-365` の `CONDUCTOR_DONE` ハンドラは、Conductor の `status` を一切チェックせずに `handleConductorDone` を呼び出している。

```typescript
// daemon.ts:353-365
case "CONDUCTOR_DONE": {
  const isSuccess = message.success !== false;
  await log(...);
  const conductor = findConductor(state, message.surface);
  if (conductor) {
    await handleConductorDone(state, conductor);  // ← ステータスチェックなし
  }
  break;
}
```

1回目の `CONDUCTOR_DONE` 受信後、`handleConductorDone` → `resetConductor` が完了すると:
- `conductor.status = "idle"` (conductor.ts:352)
- `conductor.taskId = undefined` (conductor.ts:354)

2回目の `CONDUCTOR_DONE` が同じ surface で届いた場合、`findConductor` は surface で検索するため conductor を発見し、そのまま `handleConductorDone` が再度実行される。この時点で `taskId` は `undefined` なので `task_completed task_id=undefined` がログに記録される。

### 間接原因: CONDUCTOR_DONE が2回送信される構造的問題

Conductor は2つのテンプレートから「CONDUCTOR_DONE を送信せよ」という指示を受けている:

1. **`conductor-role.md`** (システムプロンプト `--append-system-prompt-file`): ステップ8で `cmux-team send CONDUCTOR_DONE` を指示
2. **`conductor-task.md`** (ユーザーメッセージ): 末尾に `cmux-team send CONDUCTOR_DONE` を指示

`conductor-role.md` は `--append-system-prompt-file` で渡される（`main.ts:733`）ため、`/clear` 後もシステムプロンプトとして残り続ける。AI エージェントが conductor-task.md の指示で CONDUCTOR_DONE を送信した後、conductor-role.md のステップ8に再度従って CONDUCTOR_DONE を送信する可能性がある。

さらに `resetConductor` (`conductor.ts:303-364`) は **`/clear` を送信しない**。つまり1回目の CONDUCTOR_DONE 処理後も Conductor のセッションは生きたまま、AI エージェントが引き続きコマンドを実行できる状態にある。

### タイムライン（再現シナリオ）

```
T+0:00  Conductor が close-task + CONDUCTOR_DONE を送信（conductor-task.md の指示）
T+0:00  daemon が CONDUCTOR_DONE を受信 → handleConductorDone → task_completed (taskId=082) ← 正常
T+0:01  resetConductor 完了 → conductor.status="idle", taskId=undefined
T+1:30  Conductor AI が conductor-role.md ステップ8 に従い再度 CONDUCTOR_DONE を送信
T+1:30  daemon が CONDUCTOR_DONE を受信 → handleConductorDone → task_completed (taskId=undefined) ← 異常
```

## 修正方針

**最小限の変更で確実に修正する。** daemon 側でガードを追加し、status が `"running"` でない Conductor からの CONDUCTOR_DONE を無視する。

テンプレートの重複指示は修正しない（防御的多重化として有用）。根本的に daemon が冪等に処理できることが重要。

## 修正箇所

### `daemon.ts` — CONDUCTOR_DONE ハンドラにステータスガードを追加

**ファイル**: `skills/cmux-team/manager/daemon.ts`
**箇所**: `handleMessage` 関数内の `case "CONDUCTOR_DONE"` (L353-365)

```typescript
// 修正前
case "CONDUCTOR_DONE": {
  const isSuccess = message.success !== false;
  await log(
    isSuccess ? "conductor_done_signal" : "conductor_error",
    `surface=${message.surface}...`
  );
  const conductor = findConductor(state, message.surface);
  if (conductor) {
    await handleConductorDone(state, conductor);
  }
  break;
}

// 修正後
case "CONDUCTOR_DONE": {
  const conductor = findConductor(state, message.surface);
  if (!conductor || conductor.status !== "running") {
    await log(
      "conductor_done_ignored",
      `surface=${message.surface} status=${conductor?.status ?? "not_found"} taskId=${conductor?.taskId} reason=not_running`
    );
    break;
  }
  const isSuccess = message.success !== false;
  await log(
    isSuccess ? "conductor_done_signal" : "conductor_error",
    `surface=${message.surface}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
  );
  await handleConductorDone(state, conductor);
  break;
}
```

**変更内容**:
- `conductor.status === "running"` ガードを追加（early return パターン）
- running 以外の場合は `conductor_done_ignored` をログに記録して `break`
- conductor 未発見の場合も同じパスで処理
- 修正は **1ファイル、1箇所のみ**

## テスト方法

1. **E2E テスト**: タスクを実行し、`manager.log` に `task_completed` が1回だけ記録されることを確認
2. **ガード動作確認**: `conductor_done_ignored` がログに記録されていれば、2回目の CONDUCTOR_DONE が正しく無視されている
3. **手動テスト**: 同一 surface に対して `cmux-team send CONDUCTOR_DONE` を連続2回送信:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface surface:490 --success true
   # → conductor_done_ignored (status=idle なので無視される)
   ```
   ※ idle 状態の surface に送信するだけでガードの動作を確認できる
