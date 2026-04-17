# T230 実装計画書: Master の self-register 化

- **対象タスク**: T230 — 任意の pane から `cmux-team spawn-master` で daemon に Master を追加可能にする
- **依存**: T228 (Conductor self-register) / T229 (Master state Map 化)
- **作業 worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576`
- **ベース**: `b2c6c0a` (T229 完了直後の main)

---

## 1. 課題分析

### 現状の問題点

T229 で `state.masters: Map<string, MasterState>` / `.team/masters/<surface>.json` / `team.json.masters` 配列化まで整ったが、**Master の登録経路は依然として daemon が握っている**:

| ファイル:行 | 現状挙動 |
|-------------|---------|
| `daemon.ts:674-700 spawnAndRegisterMaster` | daemon プロセス内で `state.masters.set` → `persistMasterFile` を直接呼ぶ |
| `master.ts:105-129 spawnMaster` | pane 作成 + `cmux send 'cmux-team spawn-master'` + `renameTab` のみ返り値を呼び出し元に返す |
| `main.ts:1841-1887 cmdLaunchMaster` | `claude --append-system-prompt-file ...` を exec するだけ。daemon への通知は一切無い |

そのため:

1. **daemon 外から Master を増やせない** — `cmux-team spawn-master` を別 pane で叩いても claude は起動するが `state.masters` に登録されないため、`status` / `team.json` / TUI に現れず、PID watcher も起動しない
2. **boot 経路と手動経路が非対称** — boot は `spawnAndRegisterMaster` で state 直 mutation、手動経路は state 更新経路無し
3. **proxy-port 変化時の再 spawn 後も同じ問題** — `daemon.ts:718-719` で `removeMaster` + `cmux.closeSurface` して再 spawn する際、`spawnAndRegisterMaster` 経路に依存しているため「外部から Master を追加する」パターンと同じコードで扱えない

### 根本原因

Conductor と違い、Master の登録は **daemon 内部からの直接 state mutation** で完結していて、メッセージ経路 (`MASTER_REGISTERED`) が存在しない。T229 はデータ構造（Map / 永続ファイル）の変更のみで登録経路までは統一していない。

### 影響範囲

- `schema.ts` — message union に `MASTER_REGISTERED` を足す
- `main.ts` — `registerSelfAsMaster` helper + `cmdLaunchMaster` への組み込み
- `master.ts` — `spawnMaster` は pane 作成 + `cmux send` + `renameTab` に純化（`startedAt` の生成責務は daemon 側に移る）
- `daemon.ts` — `case "MASTER_REGISTERED":` 追加、`spawnAndRegisterMaster` の再編（直接 set をやめて POST 経路に寄せる or 復元のみ state 直 set）、proxy-port 変化時の再 spawn も新方式に揃える
- `daemon.test.ts` — 新規/既存/重複/proxy-port 再 spawn のテストケース追加
- `i18n.ts` — `help_spawn_master` に self-register の記述を追加
- `docs/spec/` — Master 登録経路の仕様更新

---

## 2. 技術アプローチ

### 選択したアプローチ

T228 (Conductor self-register) と **同一パターン** を Master に適用する。即ち:

```
[起動トリガー]
  spawnMaster (pane 作成 + cmux send "cmux-team spawn-master")
    ↓ pane 内で
  cmdLaunchMaster
    ↓ resolveCallerSurfaceOrExit 直後
  registerSelfAsMaster(surface)
    ↓ HTTP POST MASTER_REGISTERED
  daemon.handleMessage (case MASTER_REGISTERED)
    ↓ 既存 state があれば skip、無ければ新規登録 + .team/masters/<surface>.json 書き込み + PID watcher (pid 判明後)
  claude exec (cmdLaunchMaster 残部)
```

**選択理由**:

1. **T228 と同じパターン** にすることで、cmux-team 内の登録経路を一本化できる。別パターンを作ると保守コストが二重化する。
2. **外部 pane からの self-register がそのまま動く** — Master を複数起動するのが本タスクの目的なので、経路は self-register 以外に合理的選択肢が無い。
3. **proxy-port 不在時に fail-fast** することで、壊れた状態のまま Master が claude だけ起動して daemon に繋がらない挙動を防げる。

### T228 実装との差分（Master 特有の事情）

| 項目 | T228 (Conductor) | T230 (Master) | 差分の処理 |
|------|-----------------|---------------|-----------|
| state 側の型 | `state.conductors: Map<string, ConductorState>` | `state.masters: Map<string, MasterState>` | 型の違いに応じて set 内容を調整 |
| 永続ファイル | 無し（taskRunId と taskId だけ task-state.json 経由） | `.team/masters/<normalized>.json` via `persistMasterFile` | **handler 側で persist も呼ぶ** |
| PID watcher | SESSION_STARTED 到達後に `spawnPidWatcher` | SESSION_STARTED 到達後に `spawnMasterPidWatcher` | 既存の SESSION_STARTED ハンドラで pid=message.pid を埋める経路はそのまま使える。REGISTERED 時点で pid 無しを許容 |
| soft cap | `state.maxConductors` 超過で warning ログ | Master には max 概念がない | soft cap 判定ロジックは追加しない |
| resume 経路 | `initializeConductorSlots` の pre-population を維持 | Master に resume 概念なし | 対応不要 |
| 復元経路 | `restoreConductors` なし（conductor は原則毎回 fresh） | `restoreMasters` が既存 | 復元 **だけ** は state 直 set を許容（D3）。復元は pid 既知 + 生存確認済みなので、MASTER_REGISTERED を擬似発火する必要は無い |
| spawn からの戻り値 | launchConductor は登録には関与しない | 現行 `spawnMaster` は `{ surface, startedAt }` を返し `spawnAndRegisterMaster` が使う | **`spawnAndRegisterMaster` を廃止** し、daemon からの spawn は「pane 立てて `cmux send` するだけ」にする。`startedAt` は MASTER_REGISTERED の `timestamp` を使う |

### 既存パターンとの整合性

- `registerSelfAsMaster` は T228 の `registerSelfAsConductor` と同一構造（proxy-port 解決 → fail-fast → POST → ログ）
- daemon 側 `case "MASTER_REGISTERED"` は T228 の `case "CONDUCTOR_REGISTERED"` と同じ「idempotent merge（既存あれば skip）」
- ログイベント名は T228 に準拠: `master_register_skipped` / `master_registered`（既存 `master_started` は別イベントなので残す）
- `formatSurface(surface, "U")` で `U[N]` 表記を使う

---

## 3. 変更対象

### 変更するファイル一覧

| ファイル | 概要 | 行番号目安 |
|----------|------|-----------|
| `skills/cmux-team/manager/schema.ts` | `MasterRegisteredMessage` Zod スキーマ追加、`QueueMessage` union 追加、型 export | L57-133 付近 |
| `skills/cmux-team/manager/main.ts` | `registerSelfAsMaster` 追加 / `cmdLaunchMaster` に組み込み | L1122-1168 付近（registerSelfAsConductor 直下に配置）/ L1846 付近 |
| `skills/cmux-team/manager/master.ts` | `spawnMaster` の戻り値から `startedAt` を除去（`{ surface }` のみ）、pane 作成 + send + renameTab に純化 | L105-129 |
| `skills/cmux-team/manager/daemon.ts` | `case "MASTER_REGISTERED"` handler 追加 / `spawnAndRegisterMaster` を spawn だけするヘルパーに改名（`spawnMasterPane`）/ `startMaster` の proxy-port 再 spawn 経路を新方式に対応 / `startMaster` の復元 0 件時の新規 spawn も spawn トリガーだけに | `case` は L1122 付近の直後に追加 / `spawnAndRegisterMaster`: L670-700 / `startMaster`: L702-729 |
| `skills/cmux-team/manager/daemon.test.ts` | `MASTER_REGISTERED` テストケース追加 | 末尾に append |
| `skills/cmux-team/manager/i18n.ts` | `help_spawn_master` に self-register 説明を加筆（EN / JA 両方） | L489-502, L1058-1070 付近 |
| `docs/spec/01-skill-cmux-team.md` | Master 登録経路の self-register 化を反映 | Master 関連セクション |
| `docs/spec/05-install-and-infrastructure.md` | `.team/masters/` の登録経路説明を self-register 方式に更新 | Master / masters layout セクション |
| `CLAUDE.md` | `team.json.masters` 項目名不一致の補正（T229 Inspector Minor finding） | `team.json` セクション |

### 新規作成するファイル

無し

### 削除するコードブロック（明示的削除タスク）

| 対象 | 理由 |
|------|------|
| `daemon.ts:674-700 spawnAndRegisterMaster` 内の `state.masters.set(master.surface, master)` + `persistMasterFile(state.projectRoot, master)` | MASTER_REGISTERED handler へ移管 |
| `master.ts:122 const startedAt = new Date().toISOString();` + 戻り値の `startedAt` | daemon 側 handler が `message.timestamp` を startedAt として使うため、spawnMaster 戻り値から外す |
| `launchConductor` 側の `conductor_registered_fallback` に相当する Master 向け fallback — **そもそも存在しない** ため、新規で作らないことを明示する（conductor.ts の経路を真似て master.ts 側に fallback ブロックを足したくなる誘惑を避ける） |

（ランタイムプロンプト `.team/prompts/master.md` 側の変更は不要 — 登録経路は daemon 側の内部実装）

---

## 4. サブタスク分割

実装順序を重要度・依存関係順に並べる。**並列実装禁止**。各サブタスクは前項が完了してから着手する。

### S1. `MASTER_REGISTERED` メッセージ型を schema.ts に追加

- **対象ファイル**: `skills/cmux-team/manager/schema.ts`
- **作業内容**:
  - `MasterRegisteredMessage` を Zod で定義 (`type: "MASTER_REGISTERED"`, `surface: string`, `pid: number.optional()`, `timestamp: string.datetime()`)
  - `QueueMessage` `z.discriminatedUnion` の配列に `MasterRegisteredMessage` を追加
  - `export type MasterRegisteredMessage = z.infer<typeof MasterRegisteredMessage>;` を追加
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - `grep -n "MasterRegisteredMessage" schema.ts` で 3 箇所以上
- **メソッド制約**: 既存の `ConductorRegisteredMessage` と同じ z.object 形式で定義すること
- **検証コマンド**:
  ```bash
  grep -nE "MASTER_REGISTERED|MasterRegisteredMessage" skills/cmux-team/manager/schema.ts | wc -l
  # expect: ≥ 3
  ```

### S2. `registerSelfAsMaster` ヘルパーを main.ts に追加

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **作業内容**:
  - `registerSelfAsConductor` (L1122-1168 付近) の直下に `registerSelfAsMaster(surface: string)` を追加
  - 挙動は T228 の `registerSelfAsConductor` と **同構造**（proxy-port 取得 → 不在なら exit 1 → POST → 失敗なら exit 1 → ログ）
  - `resolveProxyPort()` を使う
  - `fetch(`http://127.0.0.1:${port}/api/messages`, { method: "POST", body: { type: "MASTER_REGISTERED", surface, timestamp } })`
  - 成功時: `log("master_self_register", formatSurface(surface, "U"))`
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - `registerSelfAsMaster` が export されていない（module 内 private で OK、`registerSelfAsConductor` と同じ扱い）
- **メソッド制約**:
  - `resolveProxyPort()` を **必ず使う**（直接 `.team/proxy-port` を読まない）
  - `postMessage` は daemon 未起動時 silent skip なので **使わない**（`registerSelfAsConductor` の JSDoc 参照）
  - `formatSurface(surface, "U")` で U[N] 表記
- **検証コマンド**:
  ```bash
  grep -n "registerSelfAsMaster" skills/cmux-team/manager/main.ts
  # expect: definition 1 + call site 1（S3 完了後は 2）
  ```

### S3. `cmdLaunchMaster` に self-register を組み込む

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **作業内容**:
  - `cmdLaunchMaster` (L1841 付近) の `const surface = await resolveCallerSurfaceOrExit();` 直後に `await registerSelfAsMaster(surface);` を追加
  - 既存の `generateMasterPrompt` / 環境変数設定 / `execFileSync("claude", ...)` ロジックは維持
  - コメントに T230 の根拠を明記
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - `cmdLaunchMaster` の `resolveCallerSurfaceOrExit` の直後に `registerSelfAsMaster` の呼び出しがある
- **メソッド制約**: resolveCallerSurfaceOrExit の直後以外の場所に置かない（proxy-port 解決前に fail-fast する必要があるため、`await generateMasterPrompt` より前に配置）
- **検証コマンド**:
  ```bash
  grep -nB 1 "registerSelfAsMaster" skills/cmux-team/manager/main.ts | grep -A 1 "cmdLaunchMaster\|resolveCallerSurfaceOrExit"
  ```

### S4. `spawnMaster` から `startedAt` と state mutation 前提を除去

- **対象ファイル**: `skills/cmux-team/manager/master.ts`
- **作業内容**:
  - `spawnMaster` の戻り値型を `{ surface: string; startedAt: string }` → `{ surface: string }` に変更
  - 関数本体から `const startedAt = new Date().toISOString();` 削除
  - 戻り値 `return { surface, startedAt }` → `return { surface }`
  - ログ `master_spawned` はそのまま（spawn イベント自体の記録）
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ（daemon.ts 側の呼び出し箇所の型も合わせる必要あり — S5 と依存）
- **メソッド制約**:
  - **関数を残す** — daemon から pane を立てる際に依然使う。空関数化・削除はしない
  - pane 作成 + `cmux send 'cmux-team spawn-master\n'` + `renameTab` の 3 ステップを維持
- **検証コマンド**:
  ```bash
  grep -n "startedAt" skills/cmux-team/manager/master.ts
  # expect: 0 (persistMasterFile が受け取る型定義の payload 内で触る箇所だけは残る可能性あり → 実際は 0 件のはず)
  ```

### S5. daemon.ts に `case "MASTER_REGISTERED"` handler を実装

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **作業内容**:
  - `case "CONDUCTOR_REGISTERED":` の直後（L1152 付近）に新 case を追加
  - 挙動:
    1. `state.masters.has(message.surface)` なら skip → `log("master_register_skipped", ${formatSurface(surface, "U")} reason=already_registered existing_status=... existing_pid=...)`
    2. 新規登録: `state.masters.set(surface, { surface, status: "starting", startedAt: message.timestamp, pid: message.pid })`
       - MasterStateSchema は `"idle" | "running" | "disconnected"` のみ許容 → **重要: MasterStateSchema の status enum を確認し、"starting" を許容するか検討**
       - **Decision**: MasterStateSchema の enum はファイル永続化用（persistMasterFile が parse する）。ランタイム state 型 `MasterState` は Schema + `pidWatcherInterval` のみで、status 文字列は Schema enum を継承する。T228 Conductor は `ConductorState` の status が `"starting" | "idle" | ...` と runtime 型側で拡張されていた。Master にも同拡張を加える: `MasterStateSchema` enum に `"starting"` を追加するか、Conductor と同じく runtime 型で enum を広げる (D5 参照)。
    3. `persistMasterFile(state.projectRoot, master)` を try/catch で呼ぶ（失敗は log "error"）
    4. `notifyStateChanged("daemon.ts:handleMessage:master-registered")` を emit
    5. `log("master_registered", formatSurface(surface, "U") + " pid=" + (message.pid ?? "none"))`
  - PID watcher は **ここでは起動しない** — 既存の `case "SESSION_STARTED"` ハンドラ (L1010-1027) が `spawnMasterPidWatcher` を呼ぶ経路を利用する。MASTER_REGISTERED の `pid` は optional なので、pid 到達時点で watcher を起動する責務は SESSION_STARTED に寄せる。
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - `grep -n '"MASTER_REGISTERED"' skills/cmux-team/manager/daemon.ts` で case 1 箇所
- **メソッド制約**:
  - `state.masters.set` の引数は `MasterState` 型（`MasterStateSchema` + runtime 型）に適合させる
  - `persistMasterFile` を **必ず呼ぶ**（daemon 再起動時の `restoreMasters` が働くため）
  - `notifyStateChanged` の source 引数は `"daemon.ts:handleMessage:master-registered"` 形式
- **検証コマンド**:
  ```bash
  grep -nE "MASTER_REGISTERED|master_registered|master_register_skipped" skills/cmux-team/manager/daemon.ts
  ```

### S6. `MasterStateSchema.status` enum に `"starting"` を追加

- **対象ファイル**: `skills/cmux-team/manager/schema.ts`
- **作業内容**:
  - `MasterStateSchema` の `status` 定義を `z.enum(["idle", "running", "disconnected"])` → `z.enum(["starting", "idle", "running", "disconnected"])` に変更
  - 既存 `.team/masters/<surface>.json` に `idle` が書かれている場合でも parse 成功するので後方互換 OK
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - 既存ファイルの parse で `safeParse` が成功する（`restoreMasters` のテストが通る）
- **メソッド制約**: enum 値の順序は自由だが新規状態は末尾または先頭に追加
- **検証コマンド**:
  ```bash
  grep -nA 1 "MasterStateSchema = z.object" skills/cmux-team/manager/schema.ts
  ```

### S7. `spawnAndRegisterMaster` を解体し `spawnMasterPane` に改名

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **作業内容**:
  - 旧 `spawnAndRegisterMaster` (L674-700) の state mutation + persist ロジックを削除
  - 関数を `spawnMasterPane(state, daemonSurface?)` に改名。責務は「pane を立てて `cmux send 'cmux-team spawn-master'` を送るだけ」
  - 成功: `log("master_spawning" + "master_spawn_initiated", formatSurface(surface, "U"))`、null を返す（呼び出し側は MASTER_REGISTERED を待つ）
  - 失敗時は `log("master_spawn_failed", ...)` のみ
  - 呼び出し元 `startMaster` L727 を `await spawnMasterPane(state, daemonSurface)` に書き換え
  - 呼び出し元 proxy-port 変化ループも `spawnMasterPane` を使うように統一（S8 と連動）
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - `grep -n "spawnAndRegisterMaster" skills/cmux-team/manager/daemon.ts` で 0 件（関数定義 + 呼び出し全部消える）
  - `grep -n "spawnMasterPane" skills/cmux-team/manager/daemon.ts` で 2 箇所以上（定義 + startMaster 内呼び出し）
- **メソッド制約**:
  - `state.masters.set` を **絶対に呼ばない**（この関数は state mutation をしない）
  - `persistMasterFile` も **呼ばない**
- **検証コマンド**:
  ```bash
  grep -n "spawnAndRegisterMaster\|spawnMasterPane" skills/cmux-team/manager/daemon.ts
  # spawnAndRegisterMaster: 0 件 / spawnMasterPane: 2+ 件
  grep -n "state\.masters\.set" skills/cmux-team/manager/daemon.ts
  # MASTER_REGISTERED handler + restoreMasters のみ（L659 付近と新 handler の 2 箇所）
  ```

### S8. proxy-port 変化時の再 spawn 経路を新方式に対応

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **作業内容**:
  - `startMaster` L712-723 の proxy-port 変化ループを修正:
    - 既存ロジック: `removeMaster` → `cmux.closeSurface` （spawn トリガーは下流の `if (restored === 0) await spawnAndRegisterMaster(...)` で実行）
    - 新ロジック: `removeMaster` → `cmux.closeSurface` → `spawnMasterPane(state, daemonSurface)` を対象 Master 数だけ呼ぶ
    - ループ後に `state.proxyPortChanged = false; restored = 0;` はそのまま
    - 下流の「復元 0 件なら新規 spawn」分岐に入るようにフラグ制御
  - **T6 テスト要件**: proxy 再起動 → 全 Master 閉じて再 spawn → pane 内 cmdLaunchMaster → MASTER_REGISTERED → state 復活
- **完了条件**:
  - 既存テスト `daemon.test.ts` が通る
  - 新規テスト (S11 T6) が通る
- **メソッド制約**: `removeMaster` と `cmux.closeSurface` の順序は維持
- **検証コマンド**:
  ```bash
  grep -nA 10 "proxyPortChanged" skills/cmux-team/manager/daemon.ts
  ```

### S9. i18n.ts の `help_spawn_master` を更新

- **対象ファイル**: `skills/cmux-team/manager/i18n.ts`
- **作業内容**:
  - EN (L489 付近) / JA (L1058 付近) それぞれ:
    - Notes から「Internal command called automatically by daemon at startup」を削除（外部から叩いて OK になったため）
    - 「Registers itself with daemon via MASTER_REGISTERED (requires running daemon)」を追加
    - 「fails with exit 1 if daemon is not running」を追加
- **完了条件**:
  - `bunx tsc --noEmit` エラーゼロ
  - `help_spawn_master` に self-register の記述が含まれる
- **メソッド制約**: 既存の `help_spawn_conductor` (L476 付近、T228 で更新済み) と同じトーンで記述
- **検証コマンド**:
  ```bash
  grep -nA 10 "help_spawn_master:" skills/cmux-team/manager/i18n.ts
  ```

### S10. CLAUDE.md の `team.json.masters` 項目名を修正（T229 Minor finding）

- **対象ファイル**: `CLAUDE.md`
- **作業内容**:
  - `team.json` セクションの `team.json.masters` 記述 「`{ surface, status, startedAt, pid?, lastPromptPreview?, lastPromptAt? }`」から実装通りの「`{ surface, status, pid?, startedAt }`」に修正
  - 旧 `team.json.master`（単一オブジェクト）廃止済みの記述はそのまま維持
- **完了条件**:
  - CLAUDE.md の記述が `daemon.ts` の `updateTeamJson` が出力するフィールドと一致
- **メソッド制約**: 破壊的変更の注釈は残す
- **検証コマンド**:
  ```bash
  grep -n "team.json.masters" CLAUDE.md
  ```

### S11. daemon.test.ts に MASTER_REGISTERED テストケースを追加

- **対象ファイル**: `skills/cmux-team/manager/daemon.test.ts`
- **作業内容**: T228 の CONDUCTOR_REGISTERED テストを参考に、以下 4+2 ケースを `describe("handleMessage: MASTER_REGISTERED (T230)")` で追加:
  - **T1**: 新規 surface → `state.masters` に set される（status=starting, startedAt=timestamp, agents 不要）/ `.team/masters/<normalized>.json` が作成される / `master_registered` ログ
  - **T2**: 既存あり + 同 surface 2 回目 → skip ログ、status/pid/startedAt が破壊されない
  - **T3 (統合)**: daemon ブート後に `spawnMasterPane` → MASTER_REGISTERED POST → `state.masters.size === 1`（spawnMaster は本物の cmux に依存するため mock するか、start 経路はテストせずメッセージハンドラ単位で検証）
  - **T4 (fail-fast)**: main.ts の `registerSelfAsMaster` を直接 unit test する（proxy-port 不在 → exit 1）。これは main.ts の export が現状 module private のため、以下いずれか: (a) `registerSelfAsMaster` を `export` して直接呼ぶ / (b) daemon.ts 側の handler テストだけに留めて fail-fast は手動 E2E に任せる。推奨は (b) — T228 も unit test は handler のみ。
  - **T5**: 同 S11 T2 と重複するため T2 で兼ねる
  - **T6 (proxy-port 変化)**: `state.proxyPortChanged = true` かつ既存 Master 2 件 → `startMaster` 呼び出し → 2 件とも closeSurface された痕跡（cmux mock 呼び出し回数）+ 2 件とも state から除去される（後続の MASTER_REGISTERED で再登録される想定）
- **完了条件**:
  - `bun test daemon.test.ts` で新規ケース全て通過
  - `bun test` 全体（390+ 件）で 0 fail
- **メソッド制約**:
  - 既存の `createDaemon(testDir)` ヘルパーを使う
  - ファイル書き込みは `testDir/.team/masters/` を見て確認
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test daemon.test.ts 2>&1 | tail -20
  ```

### S12. T229 Minor findings を可能な範囲で解消

スコープ内で軽微修正。重複作業を避けるため最後に実施。

- **S12-1. `normalizeSurfaceForPath` の二重定義解消**
  - daemon.ts:104 と master.ts:16 の同名関数を統合。`master.ts` 側を残し、`daemon.ts` から import する or 共通ヘルパーモジュールに切る
  - ただし正規化ルールが異なる（`[^a-zA-Z0-9_-]` vs `:` のみ）→ 共通化するなら仕様確定が必要
  - **保守的対応**: 名前を別名に変更（`normalizeSurfaceForMasterFile` / `normalizeSurfaceForAgentDone` 等）して同名衝突を避ける
- **S12-2. `normalizeSurfaceForPath("")` → throw**
  - master.ts 側の関数冒頭に `if (surface.length === 0) throw new Error("surface must be non-empty");`
- **S12-3. `stopDaemon` での `clearInterval` 全停止**
  - `shutdown()` 内で `state.masters.values()` と `state.conductors.values()` を iterate し `pidWatcherInterval` を個別 clearInterval
  - Node.js のプロセス終了挙動で実害はないが plan 要件なので対応
- **S12-4. `normalize` ユニットテスト**
  - `master.test.ts` が無ければ新規作成し、`normalizeSurfaceForPath("surface:100") === "surface_100"` / throw ケースを検証
- **対象ファイル**: `skills/cmux-team/manager/daemon.ts` / `master.ts` / 新規 `master.test.ts` / `CLAUDE.md`（S10 で対応済み）
- **完了条件**: `bun test` + `bunx tsc --noEmit` 共に通過
- **スコープ判断**: S12-1 は影響範囲が読み切れない場合は **後続タスクに切り出す**（本タスクスコープから外す）

### S13. docs/spec 更新

- **対象ファイル**: `docs/spec/01-skill-cmux-team.md`, `docs/spec/05-install-and-infrastructure.md`
- **作業内容**:
  - Master 登録経路の図（あれば）を self-register 方式に差し替え
  - T228 の Conductor self-register セクションに揃えた記述を Master 側にも追加
  - `.team/masters/<normalized>.json` は handler 側で書き込まれることを明記
  - 複数 Master 起動手順（`cmux new-split` → その pane で `cmux-team spawn-master`）を運用手順として記載
- **完了条件**: 仕様と実装が一致すること

---

## 5. リスク

### 既存機能への影響

| リスク | 影響 | 緩和策 |
|--------|------|-------|
| `cmdStart` の「1 Master 自動 spawn」挙動破壊 | High — E2E の既定経路 | S7 で `spawnMasterPane` 化した後も `startMaster` の復元 0 件時の呼び出し箇所は維持する。claude exec → MASTER_REGISTERED POST が届くまでの時間差（100ms〜数秒）は許容（starting 状態で表示される） |
| proxy-port 変化時の再 spawn で race | Medium — close と POST のタイミング | `closeSurface` を `await` してから `spawnMasterPane` を呼ぶ。並列 close はしない |
| 既存 `.team/masters/<surface>.json` に `status="starting"` が入ると parse 失敗 | High — daemon 再起動不可 | S6 で `MasterStateSchema.status` に `"starting"` を追加しておくことで解決 |
| `MASTER_REGISTERED` POST 到達前に SESSION_STARTED が先に届く race | Medium — master state が初期化されないまま pid 更新要求が来る | 既存 SESSION_STARTED handler (L1012-1028) は `state.masters.get(surface)` で undefined ならスキップする（`if (master)` 分岐済み）。先に PID watcher を起こすケースを見落とさないよう T1 テストで確認。`case "MASTER_REGISTERED":` の中では **pid を optional** として扱い、後続の SESSION_STARTED で上書きできるよう設計 |

### エッジケース

| ケース | 挙動 |
|--------|------|
| `cmux-team spawn-master` を daemon 停止中に手動実行 | `registerSelfAsMaster` の `resolveProxyPort` 失敗で exit 1（claude は起動しない） |
| 同じ surface から spawn-master を 2 回実行 | 1 回目: register 成功。2 回目: `master_register_skipped`。claude セッションは 2 つ目が前の pane を上書きせず起動するが、state は保護される |
| 大量 Master 同時 spawn (5+) | soft cap 無し。POST 毎に independent に handler が走り並列で persistMasterFile → 同一 surface なら skip、異 surface なら全て登録。各ファイル書き込みが衝突しないよう `persistMasterFile` は surface 別パスを使うため OK |
| daemon boot 時の 復元 + 新規 spawn が同時に走る | `restoreMasters` は同期 state 直 set、boot 後の `spawnMasterPane` 経由の新規分は MASTER_REGISTERED 経路 → handler 内 skip で衝突しない |

### テスト戦略

- **Unit (daemon.test.ts)**: S11 の T1 / T2 / T3 / T6 を追加
- **E2E (手動)**:
  - T1: `cmux-team start` → `cmux-team status` で masters に 1 件
  - T2: 別 pane で `cmux-team spawn-master` → `cmux-team status` で masters に 2 件
  - T3: `cmux-team stop` → `cmux-team start` → restoreMasters で 2 件復元
  - T4: proxy 停止 → 別 pane で `cmux-team spawn-master` → exit 1
  - T6: `.team/proxy-port` を書き換えて proxyPortChanged を trigger → 既存 master 再 spawn

---

## 6. 既存型エラーの先読み

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576/skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "^(main|master|daemon|schema|conductor)\.ts"
```

**結果: エラー 0 件**（exit 0）

スコープ内で解消するエラー: 該当なし。
後続タスクに分離するエラー: 該当なし。

型エラーが発生しそうな箇所（実装時に注意）:

1. **schema.ts の `QueueMessage` union 拡張** — 既存 handler の exhaustive check は `default: const _: never = message` パターンを使用しているか確認。使っていれば新 case 追加で TS2345 が発生するため S5 と S1 を同時に通す必要がある
2. **`MasterState` 型の status 拡張** — S6 で enum に `"starting"` を追加した後、dashboard.tsx / statusline.ts / proxy.ts の Master status 分岐が網羅しているか
3. **`spawnMaster` 戻り値型変更** — S4 の戻り値型変更は呼び出し元 (`daemon.ts:679-688 spawnAndRegisterMaster` 内) で `spawned.startedAt` を参照している → S7 でこの呼び出し自体を削除するため S4 → S7 の順で進める

---

## 7. Decision Log

| ID | 判断 | 理由 |
|----|------|-----|
| D1 | takeover なし（複数 Master 共存可能） | タスク指示明記。Conductor の soft cap 同様、hard reject すると本タスクの目的（複数 Master 運用）が達成できない |
| D2 | proxy-port 不在時は fail-fast (exit 1) | T228 と同じパターン。daemon 未起動で claude だけ起動しても state 同期されず挙動が破綻する |
| D3 | daemon boot 時の **復元** のみ `state.masters.set` 直書きを許容 | 復元は pid 既知 + 生存確認済みなので MASTER_REGISTERED 擬似発火の旨味が薄い。それ以外の経路は全て MASTER_REGISTERED 経由 |
| D4 | cmdStart が spawn する「最初の 1 個」も `spawnMasterPane` → pane 内 cmdLaunchMaster → self-register で統一 | 経路の非対称を排除するため。boot 直後に 1 瞬「masters: []」になる race は許容（既存の fallback 時間と同オーダー） |
| D5 | `MasterStateSchema.status` enum に `"starting"` を追加（T228 の ConductorState と同じ扱い） | MASTER_REGISTERED handler で status=starting を set する。既存永続ファイルは idle/running/disconnected のみなので後方互換 OK（enum 拡張は破壊的ではない） |
| D6 | MASTER_REGISTERED handler では PID watcher を **起動しない** | message.pid が optional のため。既存 SESSION_STARTED handler で pid 受信 → `spawnMasterPidWatcher` を呼ぶ経路が確立済み |
| D7 | spawn-master の E2E テストは手動 | `cmdLaunchMaster` の `execFileSync("claude", ...)` を mock するのは現実的でない。handler 単位の unit test で主要ケースをカバーし、手動 E2E で統合確認 |
| D8 | `spawnAndRegisterMaster` を `spawnMasterPane` にリネーム | 責務が「spawn + register」から「spawn のみ」に変わるため、名前が実体と乖離しないようリネーム |
| D9 | `registerSelfAsMaster` は main.ts のみに置く（共通モジュール化しない） | T228 の `registerSelfAsConductor` と対象モジュール（`main.ts`）を揃え、将来的に共通化する場合は両者を同時にリファクタリングする |
| D10 | T229 Minor findings のうち S12-1 (normalizeSurfaceForPath 二重定義解消) は影響範囲に応じて後続タスクに分離可 | 命名衝突の実害が無いため本タスク必須ではない |

---

## 受け入れ条件チェックリスト

- [ ] `MASTER_REGISTERED` が `schema.ts` に定義されている (S1)
- [ ] `cmdLaunchMaster` 内で `registerSelfAsMaster` が実行される (S3)
- [ ] 任意の pane で `cmux-team spawn-master` → 複数 Master が共存できる (E2E T2)
- [ ] daemon boot 時の復元以外で `state.masters` を直接 set している箇所がない（検索: `grep -n "state.masters.set" skills/cmux-team/manager/daemon.ts` で 2 箇所以下、うち 1 つは `restoreMasters`, もう 1 つは `case "MASTER_REGISTERED"`）
- [ ] 既存 1 Master 運用が壊れない (E2E T1)
- [ ] 重複 register で既存 state が破壊されない (unit T2)
- [ ] docs/spec 更新（Master 登録経路の変更を反映）(S13)
- [ ] T229 Inspector Minor findings 1,2,3,4,5 が可能な範囲で解消 (S12)
- [ ] `bun test` 390+ 件 / 0 fail
- [ ] `bunx tsc --noEmit` exit 0
