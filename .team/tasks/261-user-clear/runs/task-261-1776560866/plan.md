# T261 計画書: user_clear 誤判定の原因特定に必要な判定根拠スナップショット

## 1. 課題分析

### 現状の問題点

T253 × C[128] の 2026-04-18 21:10:42 → 21:10:45 の 3 秒間で、以下のシーケンスが観測された:

```
21:10:42 conductor_started task_id=253 C[128]        # assign 完了 / assigning セット + /clear 送信
21:10:44 session_stop_classified C[128] case=IDLE    # Stop hook → SESSION_IDLE 合成
21:10:44 conductor_running via=SESSION_IDLE          # T232 R1 保険: assigning → running
21:10:44 session_idle C[128]
21:10:45 task_aborted task_id=253 reason=user_clear  # ← 誤判定の疑い
```

再現読解（コード上の遷移）:
1. `assignTask` (`conductor.ts:444`) が `assigning` をセットし `/clear` を送信
2. `/clear` と新プロンプトを送り終える直前に、Claude 側の Stop hook が SESSION_STOP を push
3. daemon.ts:1738 が `classifyStopPayload` で IDLE 判定 → SESSION_IDLE に合成
4. SESSION_IDLE handler (daemon.ts:1824) の **T232 R1 保険経路** が `conductor.taskRunId` 有り・`assigning` を検知して `running` に遷移
5. その直後に `/clear` の遅延発火に由来する SESSION_CLEAR が到着
6. SESSION_CLEAR handler (daemon.ts:1953) は最早 `assigning` でないため `session_clear_expected` の早期 break を通過できず、`running` 分岐に落ち、`user_clear` として task_aborted

**ログ上「なぜ user_clear と判断したか」が追えない点**:
- どの事前状態（assigning / running など）から判定に入ったか不明
- clear 送信から何秒経過しているか不明
- SESSION_IDLE / SESSION_CLEAR の出所推定が無く、daemon 自送信か user 手動か区別できない
- assigning window が「いつ開いていつ閉じたか」のログが欠けている

### 根本原因の特定

本タスクのスコープは **観測性の改善** であり、根本修正（T232 R1 保険経路の見直しなど）は別タスクに切り出す。
ただし、R1 保険経路が原因である可能性を後続タスクで判定できるだけの情報を、ログに刻んでおく必要がある。

具体的には、以下のフィールドが欠けている:
- `prev_status` — 判定直前の Conductor status
- `assigning_set_at` / `clear_sent_at` / `session_started_clear_at` / `session_idle_at`
- `elapsed_since_clear_sent` — 1 行で窓の広さを示すための経過 ms
- `prompt_sent_at` / `prompt_bytes`
- `session_idle_source_guess` — SESSION_IDLE の出所推定（`clear_transient` / `user_clear` / `prompt_pending` / `assigned` / `unknown`）
- `decision_reason` — 分岐に入った理由の機械可読キー

### 影響範囲

- Manager daemon のロギングのみ。タスク割当ロジック・Conductor state machine は一切変更しない
- `ConductorState` にタイムスタンプ・bytes 保持のためのフィールドを数本追加（永続化は後述の通り一部のみ）
- `cmux.send` / `sendKey` ラッパーには手を入れない。**送信の意図（source）は呼び出し側（assignTask など）でログする**
- 既存テストへの影響は `daemon.test.ts` の assigning/R1 系テスト群が user_clear_snapshot 追加 log を拾う際の正規表現程度

## 2. 技術アプローチ

### 選択したアプローチ

**「判定に使う state をすべて ConductorState に集約し、判定点で 1 行の snapshot ログを出す」**。

- タイムスタンプ系（`clearSentAt`, `promptSentAt`, `sessionStartedClearAt`, `sessionIdleAtInAssigning`）と `promptBytes` を `ConductorState` に追加
- 書き込み点は `assignTask`（clear 送信直後 / prompt 送信直後）と daemon.ts の各 hook handler
- 判定瞬間（SESSION_CLEAR running 分岐の直前 + R1 保険経路 + `session_clear_expected`）で、1 行の snapshot ログを共通フォーマッタで出力
- SESSION_IDLE の出所推定は handler 内の **既に持っている state** から決定論的に導く（推定不能は `unknown`）

### 代替案と却下理由

| 代替案 | 却下理由 |
|------|---------|
| A. cmux.send に `source` オプションを足して低レベルでログする | 低レベル API は「誰が呼んだか」を知らない。意図を持つのは呼び出し側。高レベルで完結させる方針（CLAUDE.md ロギングポリシー準拠） |
| B. 既存の `session_clear_expected` / `task_aborted` をそのまま使い、snapshot 行を別の `user_clear_snapshot` イベントで並置 | 採用。**1 判定 = snapshot 1 行 + 結果 1 行** の 2 行ペアで追跡性を確保する |
| C. snapshot を `task_aborted` の detail に詰める | `task_aborted` の detail は既に cascade cleanup で他経路からも呼ばれ、detail 形式が膨らむ。独立イベントの方が grep しやすい |
| D. 判定ロジック自体を書き直して R1 保険を止める | T261 のスコープ外。観測性を上げてから後続タスクで判断する |

### 既存パターンとの整合性

- 既存の `formatConductorSnapshot` (daemon.ts:197, T260) と **同じスタイル**で `formatUserClearDecision` を追加する。`pid/alive/last_hook_at/elapsed_since_last_hook/taskRunId` は既に 1 行に集約される前例あり
- `log(event, detail)` + `formatSurface` / `formatPair` のみを使用（CLAUDE.md ロギングポリシー）
- `ConductorState` はランタイム主体の構造体なので、タイムスタンプ追加の永続化は最小限（後述 D3）

### T260 との統合可否

**T260 は既に main にマージ済み（2026-04-18 closed）**。T261 は T260 の上に独立 PR として乗せる。
根拠:
- T260 は disconnect/broken 周辺の「事後観測」（disconnect 発生時の snapshot）
- T261 は user_clear の「判定瞬間」の snapshot
- 対象イベントも書き込み経路も独立で、merge 順序依存もない

ただし T261 の `formatUserClearDecision` は T260 の `formatConductorSnapshot` と DRY 原則に従って同スタイルで書く（flat な `key=value` スペース区切り）。

## 3. 変更対象

### 変更するファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `ConductorState` に `clearSentAt`, `promptSentAt`, `promptBytes`, `sessionStartedClearAt`, `sessionIdleAtInAssigning` 追加（全 optional）。persist 対象は `clearSentAt` のみ（再起動後 user_clear 判定時の「clear からの経過」を保つため）。他はランタイム限定 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` 内で `/clear` 送信直後に `clearSentAt` を set + `clear_sent` ログ、prompt 送信直後に `promptSentAt` / `promptBytes` を set + `assign_prompt_sent` ログ。`resetConductor` でこれらを clear |
| `skills/cmux-team/manager/daemon.ts` | `formatUserClearDecision` 追加。SESSION_STARTED(source=clear) handler と SESSION_IDLE の R1 経路で該当タイムスタンプを埋める。`assigning_window_open` / `assigning_window_close` ログ。SESSION_CLEAR の `session_clear_expected` と `running` user_clear 分岐で snapshot ログを発行。SESSION_IDLE handler で `session_idle_source_guess` ログ |
| `skills/cmux-team/manager/daemon.test.ts` | snapshot ログ発行のアサーション・`assigning_window_open/close` ログ・`session_idle_source_guess` の分岐網羅テストを追加（8–10 本） |
| `skills/cmux-team/manager/conductor.test.ts` | `assignTask` の `clear_sent` / `assign_prompt_sent` ログ発行テスト（2 本） |

### 新規作成するファイル

なし。

## 4. サブタスク分割

> 実装順序は `schema → conductor → daemon(write) → daemon(read/log) → tests` の順。途中で型不整合が出たら同一サブタスク内で解消する（並列実装禁止）。

### 4.1 ConductorState にタイムスタンプ/サイズフィールドを追加する

- **対象**: `skills/cmux-team/manager/schema.ts`
- **完了条件**:
  - `ConductorState` に以下の optional field が追加されている（全て `z.string().datetime().optional()` / 数値は `z.number().optional()`）:
    - `clearSentAt`: 永続化対象（team.json に残す。daemon 再起動後も参照）
    - `promptSentAt`: ランタイム限定（永続化しない）
    - `promptBytes`: ランタイム限定（永続化しない）
    - `sessionStartedClearAt`: ランタイム限定
    - `sessionIdleAtInAssigning`: ランタイム限定
  - 永続化対象／非対象の区分を JSDoc にコメントする（T260 `lastHookAt` の前例を踏襲）
  - `bunx tsc --noEmit` が新規エラーを出さない
- **メソッド制約**: `z.object` schema 定義の末尾に追加。`ConductorState` type alias（line 224-231）には手を入れない（`z.infer` で自動展開されるため）

### 4.2 assignTask で clear/prompt 送信時刻と bytes を記録する

- **対象**: `skills/cmux-team/manager/conductor.ts` (`assignTask` 付近: line 440-461 / `resetConductor`)
- **完了条件**:
  - `cmux.send(conductor.surface, "/clear")` の成功直後に `conductor.clearSentAt = new Date().toISOString()` を設定
  - 同じ場所で `log("clear_sent", \`${formatSurface(conductor.surface, "C")} source=daemon_assign taskRunId=${taskRunId}\`)` を発行
  - `cmux.send(conductor.surface, \`${promptFile} を読んで...\`)` 成功直後に `conductor.promptSentAt = new Date().toISOString()` と `conductor.promptBytes = Buffer.byteLength(<送った文字列>, "utf8")` を設定
  - 同じ場所で `log("assign_prompt_sent", \`${formatSurface(conductor.surface, "C")} task_id=${taskId} bytes=${bytes} prompt_file=${promptFile}\`)` を発行
  - `assigning_window_open C[N] task_id=<X> clear_sent_at=<ISO>` を clear_sent の直後に発行
  - `resetConductor` で 5 フィールドすべてを undefined に戻す（stale 値で次の割当を汚染しないため）
- **メソッド制約**:
  - `log(event, detail)` + `formatSurface` のみを使う（直接 console.error や `fs.appendFile` は禁止）
  - `cmux.send` 失敗時は既存の try/catch（line 446-461）の中で AssignTaskError に寄せる既存挙動を保持。`clearSentAt` set は `cmux.send` 成功後にのみ行う

### 4.3 assigning → running 遷移点で窓クローズを記録する

- **対象**: `skills/cmux-team/manager/daemon.ts`
- **完了条件**:
  - SESSION_STARTED handler (line 1357-1364) の `assigning → running` 遷移で、`conductor.sessionStartedClearAt = message.timestamp` を set してから `assigning_window_close C[N] via=SESSION_STARTED_clear elapsed=<ms>` を発行（`elapsed` は `message.timestamp - clearSentAt`。`clearSentAt` 不在時は `elapsed=-`）
  - SESSION_IDLE handler (line 1824-1832) の R1 保険経路で `conductor.sessionIdleAtInAssigning = message.timestamp` を set してから `assigning_window_close C[N] via=SESSION_IDLE elapsed=<ms>` を発行
  - `monitorConductors` の assigning timeout（forceCloseDisconnectedConductor へ落とす経路, daemon.ts:2468 付近）でも `assigning_window_close C[N] via=timeout elapsed=<ms>` を出す
  - 既存の `conductor_running via=SESSION_STARTED source=-` / `conductor_running via=SESSION_IDLE` ログは削除しない（並列ログ禁止ポリシーに抵触しないよう、**semantics が異なる**新イベントを追加する形で並立させる）
- **メソッド制約**:
  - elapsed 計算は inline で行う（ヘルパ新設不要）
  - `formatSurface(surface, "C")` を使う
  - R1 経路は T232 の `SESSION_IDLE` / `SESSION_ACTIVE` 両方あり。今回は `SESSION_IDLE` のみでよい（`SESSION_ACTIVE` も同パターンで行けるが、user_clear は Stop hook → SESSION_IDLE 経由が主因なので最小スコープで留める）

### 4.4 user_clear 判定点に snapshot ログを追加する

- **対象**: `skills/cmux-team/manager/daemon.ts` (`case "SESSION_CLEAR"`, line 1936-2042)
- **完了条件**:
  - `formatUserClearDecision(conductor, message)` を `formatConductorSnapshot` の隣に追加。以下を 1 行にまとめて返す:
    ```
    prev_status=<X> clear_sent_at=<ISO|null>
    assigning_set_at=<ISO|null> session_started_clear_at=<ISO|null>
    session_idle_at=<ISO|null> elapsed_since_clear_sent=<ms|null>
    prompt_sent_at=<ISO|null> prompt_bytes=<N|null>
    decision_reason=<string>
    ```
    ※ 実際は**半角スペース区切りの単一行**。上記は視認用の改行
  - `session_clear_expected` 早期 break 直前で `log("user_clear_decision_snapshot", \`${formatSurface(surface, "C")} case=session_clear_expected ${decision}\`)` を発行（decision_reason=`daemon_assign_clear`）
  - `running` 分岐での `task_aborted reason=user_clear` 直前で `log("user_clear_decision_snapshot", \`${formatSurface(surface, "C")} case=user_clear ${decision}\`)` を発行（decision_reason=`running_with_taskid`）
  - snapshot ログは `task_aborted` **より前**に出す（時系列で原因→結果の順にする）
  - 永続化: `clearSentAt` は team.json 経由で daemon 再起動を跨ぐため、state 復元処理に破壊的変更を加えない（schema 更新で `.passthrough()` 不要、z.infer 側が自動展開）
- **メソッド制約**:
  - `formatUserClearDecision` は純関数（引数から全て導出、I/O なし）
  - 既存 `formatConductorSnapshot` パターンを踏襲。`key=value` スペース区切り、`null` は文字列リテラル `null`

### 4.5 SESSION_IDLE に source_guess を付記する

- **対象**: `skills/cmux-team/manager/daemon.ts` (`case "SESSION_IDLE"`, line 1765-1871)
- **完了条件**:
  - SESSION_IDLE handler の末尾 `log("session_idle", ...)` を発行する直前で、以下の決定論的ガイド関数 `guessSessionIdleSource` の結果を `session_idle_source_guess=<X>` 形で detail に追記する:
    - prev_status === `assigning` && `clearSentAt` あり && `elapsed < 5000ms` → `clear_transient`
    - prev_status === `assigning` && `promptSentAt` 未設定 → `prompt_pending`
    - prev_status === `running` && taskRunId あり → `assigned`
    - prev_status === `disconnected` → `recovered`
    - それ以外 → `unknown`
  - R1 保険経路（assigning→running）では、上記 guess を `conductor_running via=SESSION_IDLE` 行にも同じキーで併記
  - Agent surface（line 1858 `agent_done`）には付けない（user_clear 調査に無関係）
- **メソッド制約**:
  - `guessSessionIdleSource(conductor, message)` を daemon.ts ローカルに追加
  - prev_status は **分岐に入る前にローカル変数にスナップショット**してから使う（分岐で `conductor.status` 書き換えた後に読むと誤りになる）

### 4.6 テスト追加（daemon.test.ts）

- **対象**: `skills/cmux-team/manager/daemon.test.ts`
- **完了条件** (8–10 test 追加):
  1. **assigning + SESSION_CLEAR → `user_clear_decision_snapshot case=session_clear_expected` が出る** (既存 T232 test 拡張)
  2. **running + SESSION_CLEAR → snapshot が `case=user_clear decision_reason=running_with_taskid` で出る**
  3. **SESSION_STARTED(source=clear) → `assigning_window_close via=SESSION_STARTED_clear elapsed=<数値>` が出る**
  4. **SESSION_IDLE R1 → `assigning_window_close via=SESSION_IDLE` が出る**
  5. **SESSION_IDLE prev=assigning + clearSentAt 直後 → `session_idle_source_guess=clear_transient`**
  6. **SESSION_IDLE prev=running + taskRunId あり → `session_idle_source_guess=assigned`**
  7. **SESSION_IDLE prev=assigning + promptSentAt 未設定 → `session_idle_source_guess=prompt_pending`**
  8. **assigning timeout → `assigning_window_close via=timeout`**
  9. **snapshot 出力順: `user_clear_decision_snapshot` が `task_aborted` より前の行に出る** (ログ読み込みで行番号比較)
  10. **clearSentAt が team.json 復元後に保持される** (persistence smoke test、`persistTeamJson` / `restoreConductors` の既存テストパターンを流用)
- **メソッド制約**:
  - 既存 `createDaemon(testDir)` + `state.conductors.set(...)` パターンを流用。新しい test helper は追加しない

### 4.7 テスト追加（conductor.test.ts）

- **対象**: `skills/cmux-team/manager/conductor.test.ts`
- **完了条件** (2 test 追加):
  1. **assignTask 成功 → `clear_sent source=daemon_assign` + `assign_prompt_sent task_id=... bytes=...` が manager.log に順序通り記録される**
  2. **assignTask 成功 → `conductor.clearSentAt` / `promptSentAt` / `promptBytes` が set される**
- **メソッド制約**:
  - 既存 `conductor.test.ts:162` (T232) のテストパターンを踏襲（cmux.send は vi.mock 不要、bun test ネイティブ構成で動作する既存パターン）

## 5. リスク

### 既存機能への影響

- **低リスク**: ログ追加と ConductorState の optional field 追加のみ。state machine 分岐判定は変更しない
- **唯一懸念**: `clearSentAt` を team.json に永続化することで、daemon 再起動直後に restore された古い値が user_clear 判定の elapsed 計算に混ざる可能性。ただし judgement 自体はログのみで、分岐には影響しない → 許容
- `ConductorState` を `.parse` する経路（team.json 読み込み）で optional field の不在は問題ない（zod の `.optional()` 仕様）

### エッジケース

1. `clearSentAt` が未設定で SESSION_CLEAR が届くケース（e.g. daemon 再起動直後）:
   - `elapsed_since_clear_sent=null` として出力。判定分岐への影響なし
2. `promptSentAt` 未設定で SESSION_IDLE が届くケース:
   - `prompt_pending` として guess 出力
3. `promptBytes=0` のケース（空プロンプト送信バグ想定）:
   - そのまま `prompt_bytes=0` で記録。後続タスクでの診断材料になる
4. `SESSION_IDLE` handler で R1 保険→running 遷移した直後に SESSION_CLEAR → user_clear 判定:
   - **本事案の再現経路**。snapshot 1 行で `sessionIdleAtInAssigning` と `clearSentAt` の時間差が明示される
5. `session_stop_classified case=IDLE` → SESSION_IDLE 合成経路でも snapshot 記録に差異なし（合成メッセージにも timestamp が付くため）

### テスト戦略

- `daemon.test.ts` 既存 T232 test 群（line 2236-2303）の **拡張方針**:
  - 既存アサーションを壊さない。`user_clear_decision_snapshot` と `assigning_window_close` の行検証を追加
  - 既存 `conductor.status` / `loadTaskState` アサーションはそのまま保持
- `classify-stop.test.ts` には変更なし（classifier は触らない）
- `logger.test.ts` への変更なし（新イベント名は既存 `log(event, detail)` シグネチャで動く）
- E2E テスト: 不要（ロギング追加のため）
- bun test スクリプトで全体 green 確認

## 6. 既存型エラーの先読み

`bunx tsc --noEmit 2>&1 | grep -E "^(classify-stop|daemon|conductor|cmux|schema|logger)"` の結果:

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

**いずれも本タスク範囲外の既存エラー**:

- `conductor.ts:197`: `initializeConductorSlots` のシグネチャで `mainBranch: string` が optional 引数の後ろ。T253 導入時の副作用。スコープ外（**cleanup 分離**）
- `daemon.test.ts:3650`: 存在しない `source: "new_session"` を使う既存テスト。スコープ外（**cleanup 分離**）

T261 の変更で新規エラーが増えないことのみ確認する。上記 2 件は既存エラーとして放置し、必要なら別タスクで対応。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `source` を cmux.send 低レベル層に足すか | 否 | 低レベルラッパーは意図を知らない。呼び出し側でログする方が責任配置として自然（CLAUDE.md ロギングポリシー） |
| D2 | snapshot を `task_aborted` の detail に詰めるか | 否 | `task_aborted` は cascade / forced close 経路も使う共通イベント。独立イベント `user_clear_decision_snapshot` にすることで grep 性と責務分離を確保 |
| D3 | `clearSentAt` は永続化するか | する | daemon 再起動直後の判定でも「clear からの経過」を示せる。team.json サイズ影響は軽微（timestamp 1 本） |
| D4 | その他のタイムスタンプも永続化するか | しない | ランタイム限定で十分。persist 負債を最小化 |
| D5 | T260 と統合 PR にするか | 否 | T260 は既に main にマージ済み（2026-04-18 closed）。T261 は独立 PR で build on top |
| D6 | R1 保険経路自体を削除/修正するか | 否（別タスク） | T261 は観測性のみ。判定ロジック変更は snapshot 取得後の後続タスクで判断 |
| D7 | `assigning_window_close` と既存 `conductor_running via=X` の重複 | 許容 | 意味が異なる（window close は T232 race 可視化、conductor_running は state 遷移）。「並列ログ禁止」の趣旨は旧ログ温存でなく、**同一 semantic の重複ログ禁止**と解する |
| D8 | SESSION_ACTIVE 経由の R1 も同様に instrument するか | 否（最小スコープ） | T253 事例は SESSION_IDLE 経由のみ。SESSION_ACTIVE 経由が後続で観測されたら別タスクで追加 |
| D9 | `promptBytes` は UTF-8 byte 長か文字数か | UTF-8 byte 長 | `Buffer.byteLength(s, "utf8")` を採用。bytes というキー名と整合、API レート制限の byte 感覚とも揃う |
| D10 | `session_idle_source_guess` の `unknown` は出すか | 出す | 「推定不能」を明示することも診断情報。サイレントに omit すると後続で「ログバグか、そもそも guess が走らなかったか」が判別不能 |
