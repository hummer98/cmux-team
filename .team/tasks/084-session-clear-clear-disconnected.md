---
id: 084
title: SESSION_CLEAR メッセージ追加: /clear 時の disconnected 回復
priority: high
created_at: 2026-04-05T03:07:30.569Z
---

## タスク
## 背景

/clear 実行時に SessionEnd(clear) が発火するが、現在 matcher で除外している（012aead）。
理由: SESSION_ENDED が送信されると TUI 上で Conductor が一時的に disconnected 表示になるため。

しかしこの除外により、cmux send タイムアウト等で disconnected になった Conductor に /clear を送っても回復しない問題が発生。

## 解決策

SESSION_CLEAR という新メッセージを追加し、/clear 時に専用のハンドリングを行う。

- 通常時（idle/running）: 何もしない（TUI チラつき防止）
- disconnected 時: idle に回復

## 修正内容

### 1. hooks 設定（.claude/settings.json）

SessionEnd を2つのエントリに分離:

```json
"SessionEnd": [
  {
    "matcher": "clear",
    "hooks": [{
      "type": "command",
      "command": "bash -c '[ -z \"\$CONDUCTOR_ID\" ] && exit 0; cmux-team send SESSION_CLEAR --conductor-id \"\$CONDUCTOR_ID\" --surface \"\${CMUX_SURFACE:-unknown}\" --pid \"\$PPID\" 2>/dev/null || true'",
      "timeout": 5000
    }]
  },
  {
    "matcher": "logout|prompt_input_exit",
    "hooks": [（既存の SESSION_ENDED 送信 — 変更なし）]
  }
]
```

### 2. スキーマ追加（schema.ts）

SESSION_CLEAR メッセージスキーマを追加:
```ts
z.object({
  type: z.literal("SESSION_CLEAR"),
  surface: z.string(),
  conductorId: z.string().optional(),
  pid: z.number().optional(),
  timestamp: z.string(),
})
```

### 3. daemon ハンドラ追加（daemon.ts）

handleMessage に SESSION_CLEAR case を追加:
```ts
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);
  if (conductor && conductor.status === "disconnected") {
    conductor.status = "idle";
    conductor.disconnectedAt = undefined;
    if (message.pid) conductor.pid = message.pid;
    await log("conductor_recovered", `surface=${message.surface} via=SESSION_CLEAR new_status=idle`);
  }
  // idle/running 時は何もしない（TUI チラつき防止）
  break;
}
```

### 4. CLI send サブコマンド（main.ts）

`cmux-team send SESSION_CLEAR` の case を追加。

## 対象ファイル
- `.claude/settings.json` — SessionEnd hook 分離
- `skills/cmux-team/manager/schema.ts` — SESSION_CLEAR スキーマ
- `skills/cmux-team/manager/daemon.ts` — handleMessage
- `skills/cmux-team/manager/main.ts` — send サブコマンド + usage
