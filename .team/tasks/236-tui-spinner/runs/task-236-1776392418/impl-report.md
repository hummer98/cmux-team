# T236 TUI Agent Spinner 実装レポート

## 概要

Conductor と同じ `starting` / `running` / `idle` status を `AgentState` に導入し、dashboard TUI の Agent 行で spinner / role アイコンを動的に切り替えられるようにした。Conductor idle + Agent のみ running のケースでも `spinnerInterval` のアニメーションが継続する。

## Completed Tasks

| # | タスク | 状態 |
|---|-------|------|
| 1 | schema.ts: `AgentState` に `status` 追加 | ✅ |
| 2 | daemon.ts: `AGENT_SPAWNED` で `status: "starting"` | ✅ |
| 3 | daemon.ts: `SESSION_STARTED` Agent 分岐で `status="running"` | ✅ |
| 4 | daemon.ts: `SESSION_IDLE` Agent 分岐で `status="idle"` | ✅ |
| 5 | daemon.ts: `SESSION_CLEAR` に Agent 分岐追加（status → "running"） | ✅ |
| 6 | daemon.ts: `restoredAgents` で `status` 復元（fallback "idle"） | ✅ |
| 7 | daemon.ts: `updateTeamJson` で `status` シリアライズ | ✅ |
| 8 | dashboard.tsx: Agent 行に Spinner 描画分岐追加 | ✅ |
| 9 | dashboard.tsx: `needsAnimation` に Agent 条件追加 | ✅ |
| 11 | 旧 `${icon} ${label}` 固定描画の残骸確認（0 件） | ✅ |

（#10 の E2E 手動検証は daemon 稼働中の別プロセスでの動作確認が必要なため、Inspector / 人間に委ねる。）

## Files Changed

| パス | 変更概要 | 行数差分（目安） |
|-----|---------|---------------|
| `skills/cmux-team/manager/schema.ts` | `AgentState.status: "starting" \| "running" \| "idle"` を必須フィールドで追加 | +3 |
| `skills/cmux-team/manager/daemon.ts` | (a) AGENT_SPAWNED push に `status: "starting"`（+1）<br>(b) SESSION_STARTED Agent 分岐で `agent.status = "running"`（+2）<br>(c) SESSION_IDLE Agent 分岐で `agent.status = "idle"` + `notifyStateChanged`（+3）<br>(d) SESSION_CLEAR の Conductor 不一致フォールスルーで Agent を探索し `status="running"` + `session_clear_agent_reset` ログ（+15）<br>(e) restoredAgents に `status: (a.status as AgentState["status"]) ?? "idle"`（+4）<br>(f) updateTeamJson agents.map に `status: a.status`（+1） | +26 |
| `skills/cmux-team/manager/dashboard.tsx` | (a) Agent ループを `isAgentRunning` 分岐で書き換え（Spinner + CYAN / role アイコン + dim）（+18 / -5）<br>(b) `needsAnimation` に Agent の `running/starting` OR 条件を追加（+2） | +20 |
| `skills/cmux-team/manager/daemon.test.ts` | `AgentState` 必須化に伴うテストオブジェクトへの `status` 追加（10 箇所、`"starting"` or `"running"`） | +10 |

## Verification Results

### 1. 型検証（`bunx tsc --noEmit`）

```
cd skills/cmux-team/manager && bunx tsc --noEmit
exit=0
```

→ touched files: clean。新規エラーゼロ。

### 2. 既存テスト（`bun test`）

```
 445 pass
 0 fail
 989 expect() calls
Ran 445 tests across 21 files. [13.72s]
```

→ regression なし。

### 3. サブタスク別 grep 検証

#### #1: schema.ts の status 定義

```
$ rg -n 'status' skills/cmux-team/manager/schema.ts | rg -i 'starting|running|idle' | head
```

`AgentState` interface 内に `status: "starting" | "running" | "idle";` が定義されていることを確認。

#### #2: AGENT_SPAWNED で "starting"

```
$ rg -n "AGENT_SPAWNED" skills/cmux-team/manager/daemon.ts -A 10 | rg 'status.*"starting"'
# 1030 行目に `status: "starting",` が存在
```

#### #3: SESSION_STARTED で running

```
$ rg -n 'agent\.status\s*=\s*"running"' skills/cmux-team/manager/daemon.ts
1145:          agent.status = "running";
1690:          agent.status = "running";   ← SESSION_CLEAR Agent 分岐
```

#### #4: SESSION_IDLE で idle

```
$ rg -n 'agent\.status\s*=\s*"idle"' skills/cmux-team/manager/daemon.ts
1543:        agent.status = "idle";
```

#### #5: SESSION_CLEAR Agent 分岐

```
$ rg -n 'session_clear_agent_reset' skills/cmux-team/manager/daemon.ts
1693:            "session_clear_agent_reset",
```

分岐は `conductor === undefined`（Master / Conductor どちらにも該当しない）のときのみ発火する安全な構造。destructive 処理なし。

#### #6: restoredAgents の status 復元

```
$ rg -n 'restoredAgents' skills/cmux-team/manager/daemon.ts -A 10 | rg 'status'
 824-            // T236: 旧 team.json に status が無ければ "idle" にフォールバック。
 827-            status: (a.status as AgentState["status"]) ?? "idle",
```

#### #7: updateTeamJson の status シリアライズ

```
$ rg -n 'updateTeamJson' skills/cmux-team/manager/daemon.ts -A 40 | rg 'status: a\.status'
2231-        status: a.status,
```

#### #8: dashboard.tsx の Agent Spinner

```
$ rg -n 'SPINNER_FRAMES' skills/cmux-team/manager/dashboard.tsx
...
508:      const spinChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;   ← Agent 分岐
```

`isAgentRunning` で spinner / role アイコンを切り替え。

#### #9: needsAnimation に Agent 追加

```
$ rg -n 'needsAnimation' skills/cmux-team/manager/dashboard.tsx -A 10 | rg 'agents'
1341-        [...daemon.conductors.values()].some(c => (c.agents ?? []).some(a => a.status === "running" || a.status === "starting"));
```

#### #11: 旧 `${icon} ${label}` 固定描画の残骸

```
$ rg -n '\$\{icon\}\s+\$\{label\}' skills/cmux-team/manager/dashboard.tsx
（0 件）
```

idle 分岐は `${roleIcon} ${label}` にリネームしたため、旧形式は完全消滅。

## Issues Encountered

### I1. `daemon.test.ts` の `AgentState` 組み立て箇所（10 箇所）

`AgentState.status` を必須フィールドにしたため、既存のテストファイル内でインラインに `AgentState` を生成している箇所（10 箇所）が tsc エラーになった。

- 対応: 各テストオブジェクトに `status: "running" as const` または `status: "starting" as const` を追加（テスト意図に合わせて）。
- 影響: 元々のテスト意図（SESSION_STARTED 前・後の挙動検証）に矛盾しない値を選択。テストロジックには変更なし。
- 結果: 全 445 tests pass。

### I2. E2E 手動検証（#10）の留保

E2E 検証は daemon 稼働中の Agent spawn が必要で、Implementer プロセスからは `cmux-team start` 済みの別プロセスに干渉せざるを得ない。計画書の方針（"Implementer では実施しない、Inspector に任せる or 手動"）に従い、本実装では省略。Inspector / 人間が以下を確認すること:

1. `cmux-team start` 後、spawn-agent で Agent を起動し Agent 行に CYAN spinner が回る
2. SESSION_IDLE 到達後に spinner が止まり role アイコン + dim に戻る
3. Conductor が idle のまま Agent のみ running でも spinner フレームが前進する
4. `kill-agent` で agents から消える
5. `cmux-team stop` 後に `jq '.conductors[].agents[] | .status' .team/team.json` で status が persisted される

## Decision Log（実装判断の補足）

| ID | 判断 | 理由 |
|----|------|------|
| D-impl-1 | SESSION_CLEAR Agent 分岐は `conductor === undefined` のフォールスルー内に配置（既存 `idle 時は何もしない` コメントのすぐ下） | conductor 経路のいずれかの分岐に入ったら Agent 探索はしない（Master / Conductor の /clear と surface が一致することはないため安全） |
| D-impl-2 | dashboard idle 側は `roleIcon` にリネーム | `icon` という変数名は running 分岐の spinner との区別を曖昧にするため。動作は従来の `${icon} ${label}` と同じ |
| D-impl-3 | idle 時は `{ dim: true }` で dim 表示 | 計画書「idle のときは現行通り role アイコン + dim」に従う。`[surface]` 自体は CYAN のまま（tree prefix との視認性維持） |
| D-impl-4 | テスト `AgentState` に `status` を追加する値の選び方 | SESSION_STARTED 前の文脈では `"starting"`、それ以外の running/pid-watcher 検証では `"running"` を採用（テスト意図の maximum fidelity） |

## 納品

- ブランチ: `task-236-1776392418/task`
- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-236-1776392418`
- 変更: 未コミット（Conductor がコミット・マージ方針を判断）
