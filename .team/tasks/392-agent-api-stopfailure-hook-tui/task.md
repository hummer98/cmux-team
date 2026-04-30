---
id: 392
title: Agent の API エラーを StopFailure hook で TUI に可視化する
priority: high
created_by: surface:141
created_at: 2026-04-30T08:49:55.197Z
---

## タスク
## 背景

cmux-team の TUI で Agent の API エラー（rate_limit / auth / billing / server）が可視化されていない。`AgentState.status` は `starting | running | idle | asking` の 4 値のみで、API エラー専用バリアントがない。dashboard 上は API エラーで詰まった Agent も "running" のまま表示される。

実機検証（A025）の結果、Claude Code の `StopFailure` hook が以下の payload で発火することを確認:

```json
{
  "hook_event_name": "StopFailure",
  "error": "rate_limit | authentication_failed | billing_error | server_error",
  "last_assistant_message": "<エラー文言>",
  "session_id": "...",
  "transcript_path": "..."
}
```

| API エラー | StopFailure.error | 発火タイミング |
|---|---|---|
| 429 (rate_limit) | `rate_limit` | 即 |
| 401 (auth) | `authentication_failed` | ~4s |
| 403 (permission) | `authentication_failed` | ~1s |
| 400 (credit) | `billing_error` | 即 |
| 529 (overloaded) | `server_error` | ~3 分 (10 リトライ完走後) |
| 500 (server) | `server_error` (推定) | ~3 分 (推定) |

5xx 系は claude が自動リトライで復帰する場合があり、復帰すれば通常の Stop hook が来て実害なし。復帰しなければ 3 分後に StopFailure 確定。**沈黙タイマー等の補助検知は不要**（過剰設計）。

詳細は `.team/artifacts/A025-api-error-hook-probe.md` 参照。

## 方針

**proxy 改造ゼロ**、**StopFailure hook の追加 + state 拡張のみ**で完結。

## 変更内容

### 1. settings.json への StopFailure hook 追加

`skills/cmux-team/manager/main.ts` の `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` で生成する settings.json の `hooks` セクションに `StopFailure` を追加（既存 Notification と同じく `cmux-team send STOP_FAILURE --from-stdin` 形式）。

参考実装位置:
- generateMasterSettings: main.ts L1962-2010 付近（Notification と並ぶ）
- generateConductorSettings: main.ts L2120 付近（推定。要確認）
- generateAgentSettings: main.ts L2019-2080 付近（Notification と並ぶ）

### 2. cmux-team CLI の send サブコマンドに STOP_FAILURE 受け口

`main.ts` の `cmdSend` （L1389 付近の Usage で type 列挙されている所）に `STOP_FAILURE` を追加。

QueueMessage schema (`schema.ts`) に `STOP_FAILURE` バリアントを追加:
```ts
{
  type: "STOP_FAILURE",
  surface: string,
  pid?: number,
  payload: {
    session_id?: string,
    transcript_path?: string,
    error: string,         // "rate_limit" | "authentication_failed" | "billing_error" | "server_error" | string (forward-compat)
    last_assistant_message?: string,
  },
  timestamp: string,
}
```

### 3. AgentState 拡張

`schema.ts:214-229` の AgentState を拡張:

```diff
 export interface AgentState {
   surface: string;
   role?: string;
   taskTitle?: string;
   spawnedAt: string;
   sessionId?: string;
   pid?: number;
   pidWatcherInterval?: ReturnType<typeof setInterval>;
-  status: "starting" | "running" | "idle" | "asking";
+  status: "starting" | "running" | "idle" | "asking" | "error";
   tokenHandle?: string;
+  /** T391: StopFailure hook で受信した最新の API エラー情報。
+   *  hook 受信時に上書き、AGENT_SPAWNED / SESSION_STARTED で undefined に戻す。 */
+  lastApiError?: {
+    kind: "rate_limit" | "authentication_failed" | "billing_error" | "server_error" | string;
+    message?: string;
+    at: string;  // ISO8601
+  };
 }
```

`MasterState` / `ConductorState` も同様に `lastApiError` を持たせる（同じ payload を受けるため）。

### 4. daemon の handleMessage に STOP_FAILURE ハンドラ

`daemon.ts handleMessage` に case を追加:
```ts
case "STOP_FAILURE": {
  // surface から target (master / conductor / agent) を解決し
  // target.status = "error"
  // target.lastApiError = { kind: payload.error, message: payload.last_assistant_message, at: timestamp }
  // logger に WARN
  // events.jsonl に書き出し
  break;
}
```

### 5. dashboard.tsx で error 表示

`buildConductorRow` の Agent サブツリー (L688-739) に `isAgentError` 分岐を追加:

```ts
const isAgentError = a.status === "error";
if (isAgentError) {
  const kind = a.lastApiError?.kind ?? "unknown";
  const icon = {
    "rate_limit": "⏳",
    "authentication_failed": "🔒",
    "billing_error": "💰",
    "server_error": "⚡",
  }[kind] ?? "⚠";
  const msg = (a.lastApiError?.message ?? "").slice(0, 80);
  // RED + icon + label + truncated message
}
```

Conductor / Master 行も同様に `error` 状態の表示を追加。

### 6. Conductor の await-agent 出力 STATUS 拡張

既存: `STATUS=completed | crashed | ask`

拡張: `STATUS=completed | crashed | ask | api_error`
追加列: `KIND=<error.kind>` (api_error 時のみ)

`spec/07-state-machine.md` / `spec/08-runtime-boundary.md` を併せて更新。

### 7. spec / docs 更新

- `docs/spec/07-state-machine.md`: AgentState の status バリアント、StopFailure 受信時の遷移
- `docs/spec/04-templates.md` 周辺で hook 一覧を持っているなら StopFailure を追加
- README で必要なら hook 一覧に追記

### 8. テスト

- `daemon.test.ts`: STOP_FAILURE ハンドラの単体テスト（surface→agent 解決、state 更新、idempotent）
- `dashboard-conductor.test.tsx`: Agent error 表示のスナップショット
- 既存テストの破壊回帰がないこと

## 受け入れ基準

- [ ] Master / Conductor / Agent の settings.json に `StopFailure` hook が登録される
- [ ] `cmux-team send STOP_FAILURE --from-stdin` が動作する（手動で stdin に dummy payload を流して動作確認）
- [ ] `AgentState` に `lastApiError` + `status: "error"` バリアントが追加される
- [ ] daemon が `STOP_FAILURE` 受信で `state.error` を更新し、events.jsonl に記録する
- [ ] dashboard で error 状態が kind 別アイコン + 短縮 message で赤表示される
- [ ] Conductor の await-agent が `STATUS=api_error KIND=<kind>` を出力する
- [ ] artifact A025 と spec の整合性が取れている
- [ ] 既存テスト (daemon / dashboard / state-machine) が pass する

## スコープ外

- 5xx 中の hook 沈黙時間の早期検知（自動復帰に任せる、過剰設計）
- 自動 retry / token 切替（後続タスク）
- proxy 経路からの API エラー検出（ステート複雑化を避けるため不採用）
- ANTHROPIC_API_KEY 経路の挙動差吸収（cmux-team は OAuth 経路前提）

## 関連

- artifact: `.team/artifacts/A025-api-error-hook-probe.md`
- 検証スクリプト残骸: `/tmp/api-error-probe/` （タスク完了後にユーザーが手動削除）
- 検証 surface: workspace:1 surface:479 "API-Error-Probe" （タスク完了後に close-surface）
