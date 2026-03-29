---
id: 020
title: Stop hook + main.ts send による Conductor エラー検知の統一
priority: high
status: ready
created_at: 2026-03-27T12:30:00+09:00
---

## タスク

Conductor/Agent の終了イベントを `main.ts send` CLI 経由で Manager に通知する仕組みを構築する。
現状は画面監視（pull 型）でしか完了を検知できず、正常終了とエラー終了を区別できない。
また hook 用のシェルスクリプトが散在しており、`main.ts send` に統一する。

### 1. `CONDUCTOR_DONE` スキーマ拡張

`schema.ts` の `ConductorDoneMessage` に以下を追加:

```typescript
success: z.boolean(),
reason: z.string().optional(),    // エラー時の理由
exitCode: z.number().optional(),  // Claude の exit code
```

### 2. `main.ts send CONDUCTOR_DONE` の引数追加

```bash
main.ts send CONDUCTOR_DONE \
  --conductor-id xxx \
  --surface surface:N \
  --success false \
  --reason "API rate limit" \
  --exit-code 1
```

### 3. Conductor settings に `Stop` hook 追加

`conductor.ts` の settings 生成部分を変更:

```jsonc
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "${PROJECT_ROOT}/skills/cmux-team/manager/main.ts send AGENT_SPAWNED --conductor-id ${CONDUCTOR_ID} ..."
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "${PROJECT_ROOT}/skills/cmux-team/manager/main.ts send CONDUCTOR_DONE --conductor-id ${CONDUCTOR_ID} --surface ${SURFACE} --success true"
      }]
    }]
  }
}
```

注意: Stop hook で渡される環境変数（`$CLAUDE_EXIT_CODE` 等）を確認し、エラー判定に利用する。

### 4. `hook-agent-spawned.sh` の廃止

- `.team/scripts/hook-agent-spawned.sh` を削除
- `conductor.ts` の `PostToolUse` hook を `main.ts send AGENT_SPAWNED` 直接呼び出しに置換

### 5. `daemon.ts` のエラー時リカバリ

`handleConductorDone` で `success: false` の場合:
- ログに `conductor_error` を記録（reason 付き）
- worktree のクリーンアップを実行
- タスクを closed に移動（エラーでも回収する）
- ダッシュボードにエラー履歴を表示可能にする（019 と連携）

## 対象ファイル

- `skills/cmux-team/manager/schema.ts` — `ConductorDoneMessage` 拡張
- `skills/cmux-team/manager/main.ts` — `cmdSend()` に `--success` / `--reason` / `--exit-code` 引数追加
- `skills/cmux-team/manager/conductor.ts` — settings 生成で Stop hook 追加、hook-agent-spawned.sh 参照を削除
- `skills/cmux-team/manager/daemon.ts` — `handleConductorDone` でエラー分岐追加
- `.team/scripts/hook-agent-spawned.sh` — 廃止（削除）

## 残作業（前回の未マージ分）

前回の実装で AGENT_SPAWNED/AGENT_DONE は main にマージ済み（`f4d2c3f`）。
以下が未実装のまま残っている:

1. `CONDUCTOR_DONE` スキーマに `success` / `reason` / `exitCode` 追加（Agent が途中まで書いたが未マージ）
2. `main.ts send CONDUCTOR_DONE` の引数追加
3. Conductor settings に `Stop` hook 追加
4. `hook-agent-spawned.sh` の廃止 → `main.ts send AGENT_SPAWNED` 直接呼び出しに置換
5. `daemon.ts` の `handleConductorDone` でエラー分岐追加

注意: 前回の worktree（`conductor-1774599837`）は既にクリーンアップ済みの可能性あり。main の現在のコードから作業すること。

## 完了条件

- Conductor が正常終了した場合、Stop hook 経由で `CONDUCTOR_DONE (success=true)` が Manager に届く
- Conductor がエラー終了した場合、`CONDUCTOR_DONE (success=false, reason=...)` が Manager に届く
- Manager がエラー時に worktree クリーンアップとタスククローズを実行する
- `hook-agent-spawned.sh` が廃止され、`main.ts send AGENT_SPAWNED` に置換されている
- シェルスクリプトへの依存がなくなり、全イベント通知が `main.ts send` に統一されている
