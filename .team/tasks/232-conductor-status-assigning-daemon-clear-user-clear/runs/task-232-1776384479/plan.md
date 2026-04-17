# T232 実装計画書

**タスク**: Conductor status に `assigning` を追加して daemon 起動 `/clear` の `user_clear` 誤認を修正する
**taskRunId**: task-232-1776384479
**対象**: `skills/cmux-team/manager/`

---

## 1. 課題分析

### 現象

`assignTask` 実行中に daemon 自身が送信した `/clear` が遅延して `SESSION_CLEAR` hook を発火させ、daemon がこれをユーザー手動 `/clear` と誤認して `task-state.json` を `aborted` に書き換える race condition。Conductor は実際にはタスクを実行し続けているが、`task-state.json` 上は aborted 扱いになり、**実行と状態の乖離**が発生する（T230 で実観測）。

### 根本原因

`skills/cmux-team/manager/conductor.ts:374-416` の `assignTask` は以下の順で動作する:

1. `cmux.send(conductor.surface, "/clear")`（L374）
2. `sleep(500)` → `sendKey return` → `sleep(2000)`（L375-377）
3. 新プロンプト送信（L380-385）
4. `conductor.status = "running"` を**即時セット**（L416、`/clear` 送信から約 3 秒後）

一方 Claude Code 側は `/clear` 処理完了後に `SessionEnd` → `SessionStart(source=clear)` hook を発火するが、この発火までに遅延（実測 ~10 秒以上）がある。

この間に daemon の `SESSION_CLEAR` ハンドラ（`daemon.ts:1450-1508`）が発火すると:

- L1481 の `conductor.status === "running"` 分岐に入る
- `conductor.taskId` は L410 で既に埋められているため、`task-state.json` が `aborted` に書き換わる（L1491）
- `resetConductor` により worktree 削除・ブランチ削除まで進む（L1505）

結果、**daemon 起因の `/clear` とユーザー起因の `/clear` を区別できない**ことが問題の本質。

### 影響範囲

- 影響 state: `conductor.status`, `conductor.taskRunId`, `conductor.taskId`, `conductor.pid`, `conductor.worktreePath`
- 影響ファイル: `.team/task-state.json`, git worktree（`.worktrees/<taskRunId>/`）, ブランチ（`<taskRunId>/task`）
- 発動条件: assignTask の `/clear` 送信後、SessionStart hook 到達前に SESSION_CLEAR hook が到達する場合

---

## 2. 技術アプローチ

### 採用案: `assigning` ステータス新設

`ConductorStatus` enum に `"assigning"` を追加し、**「daemon が `/clear` 送信直前 → SESSION_STARTED(source=clear) 受信まで」の窓**を明示的に表現する。この窓の間に届いた `SESSION_CLEAR` は daemon 起因と判定して user_clear 処理をスキップする。

状態遷移（新規分を太字）:

```
idle --assignTask--> **assigning** --/clear--> (claude restart)
                         │
                         ├--SESSION_STARTED(source=clear)--> running
                         ├--SESSION_CLEAR--> 早期 return（daemon 起因と判定、スキップ）
                         └--timeout 60s--> disconnected （保険）
```

`running` 状態での `SESSION_CLEAR` は従来どおりユーザー手動 `/clear` として処理する（回帰なし）。

### 代替案（却下）

| 代替案 | 却下理由 |
|--------|---------|
| **カウンタ方式** | `/clear` 送信回数を記録し、到達した SESSION_CLEAR で -1 していく。複数回の /clear（retry 等）で整合性が壊れやすい。状態が見えない |
| **時間窓方式** | assignTask から N 秒以内の SESSION_CLEAR を無視。N の決定が難しく、遅延が N を超えたら壊れる。本質的に race に対する heuristic |
| **/clear トークン方式** | hook 側から送信側を識別するトークンを仕込む。hook 側の実装変更が必要で、cmux hooks の shell はロジックを持たせない原則（CLAUDE.md）に反する |
| **assigning ステータス新設** | 採用。状態として明示される → 観察・ログ・テストが容易。SESSION_STARTED への遷移を自然に表現できる |

---

## 3. 変更対象

### ソース

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `ConductorState.status` enum に `"assigning"` を追加（L181） |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` の `/clear` 送信直前に `status = "assigning"` をセット。L416 の `status = "running"` 即時セットを削除 |
| `skills/cmux-team/manager/daemon.ts` | (a) `SESSION_STARTED` ハンドラに `assigning → running` 分岐追加（L1030 付近）。(b) `SESSION_CLEAR` ハンドラ先頭で `assigning` なら早期 return（L1450 付近）。(c) `monitorConductors` に `assigning` timeout 処理を追加（L1856 付近） |
| `skills/cmux-team/manager/statusline.ts` | `StatuslineConductor.status` 型に `"assigning"` を追加（L40） |
| `skills/cmux-team/manager/dashboard.tsx` | `assigning` 状態の描画対応（`buildConductorRow` L382 付近、ヘッダー集計 L857 付近） |

### テスト

| ファイル | 追加テスト |
|---------|-----------|
| `skills/cmux-team/manager/conductor.test.ts` | `assignTask` 後に status が `assigning` になること（`running` にならないこと） |
| `skills/cmux-team/manager/daemon.test.ts` | (a) `assigning` 中の SESSION_CLEAR が user_clear 処理をスキップすること。(b) SESSION_STARTED(source=clear) で `assigning → running` 遷移すること。(c) `running` 中の SESSION_CLEAR は従来どおり task_aborted すること（回帰防止）。(d) `assigning` のまま 60 秒で `disconnected` に倒れること |

---

## 4. サブタスク分割（実装順序）

実装は **schema → conductor → daemon（STARTED → CLEAR → timeout） → dashboard/statusline → test** の順で進める。型エラーが早期に出るため schema から着手する。

### Sub-task 1: schema.ts に `"assigning"` を追加

- **対象**: `skills/cmux-team/manager/schema.ts:181`
- **変更**: `ConductorState` 型の `status` union に `"assigning"` を追加
  ```ts
  status: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected";
  ```
- **完了条件**: `bunx tsc --noEmit` で新エラーが出るのみ（既存箇所で `assigning` 未対応として検出される）
- **検証**: `cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep assigning`

### Sub-task 2: conductor.ts の assignTask を修正

- **対象**: `skills/cmux-team/manager/conductor.ts:371-418`
- **変更**:
  1. `/clear` 送信直前（L374 直前）に `conductor.status = "assigning"` + `notifyStateChanged("conductor.ts:assignTask:status-assigning")` を追加
  2. L416 の `conductor.status = "running"` を削除（SESSION_STARTED 経由で遷移させる）
  3. L418 の `notifyStateChanged` は `conductor.ts:assignTask:assigned` など内容を反映した名称へ変更（状態遷移名ではなく「assigning 準備完了」を示す）
  4. taskId / taskRunId / taskTitle / worktreePath / outputDir / startedAt / agents の代入はそのまま維持
- **メソッド制約**: `assigning` は `/clear` 送信 **直前**に立てる（送信後ではない — 遅延発火した SESSION_CLEAR を確実に捕捉するため）
- **完了条件**: `assignTask` 完了後の `conductor.status === "assigning"` であり、`running` ではないこと
- **検証**: `bun test conductor.test.ts`（Sub-task 7 のテスト追加後に full green）

### Sub-task 3: daemon.ts SESSION_STARTED ハンドラに `assigning → running` 分岐追加

- **対象**: `skills/cmux-team/manager/daemon.ts:1030-1046`（Conductor 分岐）
- **変更**: L1033 の既存 `starting/disconnected → idle` 分岐に並列して `assigning → running` 分岐を追加
  ```ts
  if (conductor.status === "starting" || conductor.status === "disconnected") {
    // 既存ロジック（idle 遷移）
  } else if (conductor.status === "assigning") {
    conductor.status = "running";
    await log("conductor_running", `${formatSurface(message.surface, "C")} via=SESSION_STARTED source=${message.source ?? "-"}`);
  }
  ```
- **メソッド制約**:
  - ログイベント名は `conductor_running`（`conductor_ready`/`conductor_recovered` と対を成す）
  - `notifyStateChanged` は既存の L1046 を流用（1 回呼べば十分）
- **完了条件**: Sub-task 7 の「assigning + SESSION_STARTED(source=clear) → running」テストが通る

### Sub-task 4: daemon.ts SESSION_CLEAR ハンドラで `assigning` 早期 return

- **対象**: `skills/cmux-team/manager/daemon.ts:1450-1508`
- **変更**: Master 分岐（L1452）の直後、既存の `disconnected/starting → idle` 分岐（L1457）よりも前に `assigning` チェックを挿入:
  ```ts
  if (conductor && conductor.status === "assigning") {
    await log("session_clear_expected", `${formatSurface(message.surface, "C")} reason=daemon_assign_clear taskRunId=${conductor.taskRunId ?? "-"}`);
    break;
  }
  ```
- **メソッド制約**:
  - `break` で case を抜ける（`return` ではない。`handleMessage` は switch 内なので break）
  - **task-state.json を一切触らない**（destructive な書き換えに進ませない）
  - `resetConductor` を呼ばない（worktree 削除を防ぐ）
  - ログイベント名は `session_clear_expected`（`session_clear_stale` の語彙と揃える）
- **完了条件**: Sub-task 7 の「assigning + SESSION_CLEAR → task-state 変更なし」テストが通る

### Sub-task 5: monitorConductors に `assigning` timeout を追加

- **対象**: `skills/cmux-team/manager/daemon.ts:1856-1889`
- **変更**:
  1. ファイル上部の定数群（L1843 付近）に `const ASSIGNING_TIMEOUT_SEC = 60;` を追加
  2. `monitorConductors` の `starting` 分岐の直後に `assigning` 分岐を追加:
     ```ts
     if (conductor.status === "assigning") {
       const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
       if (elapsed > ASSIGNING_TIMEOUT_SEC) {
         conductor.status = "disconnected";
         conductor.disconnectedAt = new Date().toISOString();
         notifyStateChanged("daemon.ts:monitorConductors:assigning-timeout");
         await log(
           "conductor_assign_timeout",
           `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s taskRunId=${conductor.taskRunId ?? "-"}`
         );
       }
       continue;
     }
     ```
- **メソッド制約**:
  - `startedAt` は assignTask L414 で更新されるため、assigning 窓の計測基準として適切
  - タイムアウト後は `disconnected` に倒すため、既存の `DISCONNECT_TIMEOUT_SEC` (300s) → `forceCloseDisconnectedConductor` 経路で人間が認識できる形に落ちる（CLAUDE.md: 異常検知時のリカバリは人間に委ねる）
- **完了条件**: Sub-task 7 の「assigning のまま 60s で disconnected に倒れる」テストが通る

### Sub-task 6: statusline.ts / dashboard.tsx に `"assigning"` 表示対応

- **対象**:
  - `skills/cmux-team/manager/statusline.ts:40` — `StatuslineConductor.status` の union に `"assigning"` を追加
  - `skills/cmux-team/manager/dashboard.tsx:382-468` — `buildConductorRow` に `isAssigning = c.status === "assigning"` 分岐を追加（`starting` と同様の spinner + ラベル `assigning…`）
  - `skills/cmux-team/manager/dashboard.tsx:857` — ヘッダー集計に `assigningCount` を追加（既存 `startingCount` / `runningCount` / `askingCount` に並列、表示可否は既存の表示規則に合わせる）
  - `skills/cmux-team/manager/dashboard.tsx:1302-1303` — アクティブ判定（spinnerTick 駆動）に `c.status === "assigning"` を含めるか検討。`starting` は既に含まれているため `assigning` も含める
- **メソッド制約**:
  - dashboard の短縮表記は `assigning…`（`starting…` と同じトーン、省略記号付き）
  - アイコン色は CYAN（starting と同じ — 起動中と同類のフェーズ）
  - ヘッダー集計が 0 のときは既存規則どおり省略（UI が肥大化しないように）
- **完了条件**:
  - `bunx tsc --noEmit` でエラー 0
  - dashboard 実機確認は unit test 範囲外（E2E）

### Sub-task 7: テスト追加

- **対象**:
  - `skills/cmux-team/manager/conductor.test.ts` — assignTask 成功後の status 確認
  - `skills/cmux-team/manager/daemon.test.ts` — SESSION_CLEAR / SESSION_STARTED / monitorConductors の状態遷移
- **追加テストケース**:
  1. **conductor.test.ts**: `assignTask` が正常完了した場合、`conductor.status === "assigning"` であること（`"running"` ではないこと）
  2. **daemon.test.ts**: `status === "assigning"` の Conductor が `SESSION_CLEAR` を受信しても `task-state.json` が書き換わらず、`conductor.status` が `"assigning"` のままであること（`conductor.pid` も保持 or 未更新で OK）
  3. **daemon.test.ts**: `status === "assigning"` の Conductor が `SESSION_STARTED(source=clear)` を受信すると `status === "running"` に遷移し、`pid` が更新されること
  4. **daemon.test.ts**（回帰防止）: `status === "running"` の Conductor が `SESSION_CLEAR` を受信した場合、従来どおり `task_aborted` が記録されること
  5. **daemon.test.ts**: `status === "assigning"` のまま `ASSIGNING_TIMEOUT_SEC` (60s) を経過させ `monitorConductors` を走らせると `status === "disconnected"` に遷移すること（`startedAt` を 61 秒前に設定して即時判定）
- **メソッド制約**:
  - `assignTask` の `/clear` 送信部分は cmux.ts をモック化（既存 `conductor.test.ts` のパターンに合わせる）
  - `monitorConductors` テストは既存の starting timeout テストと同じパターン（`startedAt` を操作）
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test conductor.test.ts daemon.test.ts 2>&1 | tail -30
  ```

### Sub-task 8: 全体型チェック・全テスト緑化

- **対象**: 全ファイル
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bunx tsc --noEmit && bun test 2>&1 | tail -20
  ```
- **完了条件**:
  - `tsc --noEmit` がエラー 0
  - 全既存テスト + 新規追加テストが緑
  - `classify-stop.test.ts` は触らない（無関係）

---

## 5. リスク

### 既存機能への影響

| リスク | 緩和策 |
|--------|--------|
| `assigning` を識別しない他ファイルで型エラー | schema 変更で tsc が全参照を検出する（事前に Grep で `starting.\|idle.\|running.\|asking.\|disconnected` を洗い出し済み: `statusline.ts:40`, `dashboard.tsx`, `daemon.ts`, `conductor.ts`） |
| `assigning` 中に `SESSION_IDLE` / `SESSION_ACTIVE` が到達 | 既存ハンドラ（`daemon.ts:1256, 1328`）は `starting/disconnected/asking` の 3 種のみ遷移させるため、`assigning` はフォールスルー（pid と disconnectedAt の更新のみ）。これで問題なし — `assigning` からの正規遷移は SESSION_STARTED 経由のみに保つ |
| `assignTask` 失敗時の `status` 復旧 | `assignTask` は try-catch で全体を囲み、失敗時は `AssignTaskError` を throw する。呼び出し側（`daemon.ts:1602` の `assignTask` 呼び出し）は catch して Conductor 状態を復旧する必要があるため、**既存の catch で `status = "idle"` に戻す処理があれば** `assigning` の状態も同様に戻ること（確認必要、必要なら追加） |
| `/clear` 送信が途中失敗した場合に `assigning` のまま止まる | Sub-task 5 の 60 秒 timeout で `disconnected` に倒し、人間が認識できる形になる |

### エッジケース

1. **複数回の `/clear`**: 本変更後は `assigning` 中の `SESSION_CLEAR` は全てスキップされる。もし SESSION_STARTED 前に 2 回目の `/clear` が daemon 自身から送られる経路があれば同じく 2 度ともスキップされる（問題なし）。ユーザー手動 `/clear` は `running` 状態でのみ有効なので、assigning 中のユーザー `/clear` はスキップされる（実運用上問題なし — タスク実行中の手動 `/clear` は abort 扱いだが、 assigning 窓は高々 60 秒で十分短い）
2. **SESSION_STARTED が届かないが Conductor は生きている**: 60 秒の timeout で disconnected に倒す → DISCONNECT_TIMEOUT_SEC (300s) で forced close → `task_aborted` 記録 + 人間が対処（CLAUDE.md: 異常検知時のリカバリは人間に委ねる）
3. **SESSION_CLEAR が `taskRunId` を持ち conductor.taskRunId と不一致**: 既存の stale guard（L1470 付近）と本変更の順序関係 — `assigning` 早期 return を `stale guard` より **前**に置くことで、assigning 窓内の stale CLEAR も早期抜けできる（assigning 中の taskRunId 不一致は事実上起こらないが保険）

### テスト戦略

- **unit test 中心**: 状態遷移ロジックは `handleMessage` / `monitorConductors` に集約されているため、既存の `daemon.test.ts` の pattern に沿って追加可能
- **E2E**: 本タスクの範囲外（cmux 実機起動が必要）。ただし実装後に `cmux-team start` で疎通確認を推奨（task-state.json が誤って aborted にならないこと）

---

## 6. 既存型エラーの先読み

実行結果（対象ファイル: schema.ts, conductor.ts, daemon.ts, dashboard.tsx）:

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "^(schema\.ts|conductor\.ts|daemon\.ts|dashboard\.tsx)" || true
(出力なし)
$ echo "exit=$?"
exit=0
```

既存エラーなし。本タスクで発生する型エラーは全て今回の変更起因として検出できる。

---

## 7. Decision Log

### D1: タイムアウト値 = 60 秒

- **根拠**: `/clear` 送信から SESSION_STARTED(source=clear) 到達までの実測遅延は ~10 秒（T230 観測）。10 倍のマージンを取って 60 秒とする
- **却下値**: 30 秒（マージン不足 — hook 遅延のワースト値が不明）、120 秒以上（長すぎて異常状態が隠蔽される）
- **設定化**: 環境変数での override は**追加しない**（`STARTING_TIMEOUT_SEC` も固定値のため揃える）。将来必要なら追加

### D2: ログイベント名

| イベント | 発火箇所 | 名称 | 根拠 |
|---------|---------|------|------|
| assigning → running | SESSION_STARTED ハンドラ | `conductor_running` | `conductor_ready`（starting → idle）, `conductor_recovered`（disconnected → idle/running）と対を成す |
| assigning 中の SESSION_CLEAR スキップ | SESSION_CLEAR ハンドラ | `session_clear_expected` | 既存 `session_clear_stale`（taskRunId 不一致）と語彙を揃える |
| assigning timeout | monitorConductors | `conductor_assign_timeout` | 既存 `conductor_start_timeout`（starting timeout）と対を成す |

### D3: `assigning` 中の SESSION_CLEAR の扱い

- **スキップタイミング**: Master 分岐の**直後**、`disconnected/starting → idle` 分岐よりも**前**
- **根拠**:
  - 早期 return で destructive な処理を全てバイパス
  - `disconnected/starting → idle` は assigning 窓中には起こらないはず（`disconnected` からは直接 `assigning` には遷移しないため）が、念のため順序を固定して副作用を防ぐ
  - task-state.json / resetConductor / pid クリアなどの destructive 処理を一切行わない

### D4: dashboard 表示の短縮表記

- **表記**: `assigning…`（starting と同じトーン、spinner + 省略記号）
- **色**: CYAN（starting と同じ — 起動・遷移中のフェーズであることを示す）
- **根拠**: ユーザーには「タスク割り当て準備中」と「Claude 起動中」は視覚的に同じカテゴリとして扱う方がわかりやすい（どちらも「running 直前」）

### D5: assignTask L416 の即時 running セット削除

- **決定**: 完全削除する（コメントアウトではなく）
- **根拠**: SESSION_STARTED(source=clear) で確実に `running` 遷移するため即時セットは不要。むしろ残すと race が再現する。`notifyStateChanged` は L418 に残す（状態が `assigning` になったことを TUI に伝えるため、Sub-task 2 の通り `assigning` セット直後にも呼ぶ）

### D6: SESSION_IDLE / SESSION_ACTIVE での assigning 遷移は**追加しない**

- **決定**: SESSION_STARTED 経由のみで `assigning → running` 遷移させる
- **根拠**:
  - `/clear` 後は Claude が必ず SessionStart hook を発火する（source=clear）。SESSION_IDLE / ACTIVE が先に来るケースは想定されない
  - 複数の経路で遷移させると「どの経路で遷移したか」がログから追いにくくなり、デバッグ性が下がる
  - 万一 SESSION_STARTED が届かないケースは 60 秒 timeout で救う

---

## 8. 成果物

- 本計画書: `/Users/yamamoto/git/cmux-team/.team/tasks/232-conductor-status-assigning-daemon-clear-user-clear/runs/task-232-1776384479/plan.md`
- 実装者がこの plan に沿って以下を変更する:
  - `skills/cmux-team/manager/schema.ts`（L181）
  - `skills/cmux-team/manager/conductor.ts`（L371-418 付近）
  - `skills/cmux-team/manager/daemon.ts`（L1030, L1450, L1843, L1856 付近）
  - `skills/cmux-team/manager/statusline.ts`（L40）
  - `skills/cmux-team/manager/dashboard.tsx`（L382, L857, L1302 付近）
  - `skills/cmux-team/manager/conductor.test.ts`（assignTask 状態テスト追加）
  - `skills/cmux-team/manager/daemon.test.ts`（SESSION_CLEAR/STARTED/timeout テスト追加）

## 9. 検証コマンド（実装後）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-232-1776384479/skills/cmux-team/manager

# 型チェック
bunx tsc --noEmit

# 全テスト
bun test 2>&1 | tail -30

# 変更対象ファイルのテストのみ
bun test conductor.test.ts daemon.test.ts 2>&1 | tail -30
```

全て緑であれば実装完了。
