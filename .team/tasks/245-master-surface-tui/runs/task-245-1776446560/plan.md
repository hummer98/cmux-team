# T245 Implementation Plan

## 概要

Master surface が失われた後 `state.masters` に disconnected エントリが永続する問題を解消する。
方針は A013 に従い **(a) time-based GC を主 + (d) CLI `forget-master` を副** の併用とする。
`monitorConductors` と対称な `monitorMasters` を daemon の tick に組み込み、
`disconnectedAt` から `CMUX_TEAM_MASTER_GC_SEC`（デフォルト 600 秒）経過したエントリを
`removeMaster` で自動削除する。手動の escape hatch として `FORGET_MASTER` キューメッセージと
それを POST する `cmux-team forget-master --surface <id>` サブコマンドを追加する。

## 変更対象ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `ForgetMasterMessage` 型を追加し `QueueMessage` discriminated union に組み込む |
| `skills/cmux-team/manager/daemon.ts` | `MASTER_DISCONNECT_GC_SEC` 定数、`monitorMasters` 関数、`tick()` への組み込み、`handleMessage` の `FORGET_MASTER` case を追加 |
| `skills/cmux-team/manager/main.ts` | `cmdForgetMaster` 関数と `"forget-master"` サブコマンド switch を追加 |
| `skills/cmux-team/manager/i18n.ts` | `help_forget_master` ヘルプテキストを en/ja 両方に追加、`help_main` 一覧に 1 行追加 |
| `skills/cmux-team/manager/daemon.test.ts` | `monitorMasters` ユニット + `FORGET_MASTER` handler テストを追加 |
| `skills/cmux-team/manager/main.test.ts` | `cmdForgetMaster` の postMessage / 引数検証 smoke テストを追加 |
| `docs/spec/05-install-and-infrastructure.md` | `.team/masters/` セクションに GC / forget-master の挙動を追記 |
| `CHANGELOG.md` | 次期リリースのエントリに「T245: Master disconnected エントリの自動 GC と `cmux-team forget-master` 追加」を記載（リリース時） |

## 実装ステップ

コミット粒度は「テスト + 最小実装」の縦割り。各ステップで `bun test` が green になる状態を保つ。

---

### Step 1: `FORGET_MASTER` スキーマ追加

**TDD 順**:
1. `schema.ts` の既存 `QueueMessage.safeParse` を使ったテストを `daemon.test.ts` の既存 describe ブロックの延長で 1 件だけ書く（「`FORGET_MASTER` が discriminated union で parse できる」）
2. `schema.ts` に型を追加してテストを通す

**変更内容**:

- `skills/cmux-team/manager/schema.ts`
  - 追加識別子: `ForgetMasterMessage`（`z.object({ type: z.literal("FORGET_MASTER"), surface: z.string(), timestamp: z.string().datetime() })`）
  - `QueueMessage = z.discriminatedUnion("type", [...])` に `ForgetMasterMessage` を追記（L118-133）
  - `type ForgetMasterMessage = z.infer<typeof ForgetMasterMessage>` を L143 付近の type alias 群に追加

**検証**: `bun test skills/cmux-team/manager/schema.ts` 相当の既存テストと Zod parse が壊れないこと。

---

### Step 2: `MASTER_DISCONNECT_GC_SEC` 定数と `monitorMasters` 関数

**TDD 順**（テスト先行、`daemon.test.ts` に `describe("monitorMasters (T245)")` を追加）:

1. `閾値超過の disconnected Master は removeMaster で state と permanent file が消える`
   - state を作り、`state.masters.set("surface:67", { surface:"surface:67", status:"disconnected", disconnectedAt: new Date(Date.now()-601_000).toISOString(), startedAt: ... })` + `persistMasterFile`
   - `monitorMasters(state)` 呼び出し
   - `state.masters.has("surface:67") === false`、`.team/masters/surface_67.json` が存在しない
2. `閾値未満なら no-op`（disconnectedAt=now() - 10s、600 秒閾値の既定）
3. `status !== "disconnected" は対象外（idle / running / starting で disconnectedAt 未定義のものを含む）`
4. `disconnectedAt が undefined のエントリはスキップ（破損データ保険）`
5. `CMUX_TEAM_MASTER_GC_SEC env で閾値を上書きできる`
   - env を `"30"` に設定 → 31 秒前の disconnected は消える、29 秒前は残る
   - **注意**: daemon.ts 側の `MASTER_DISCONNECT_GC_SEC` を **module-level 定数で評価してしまうと env 変更がテスト間で反映されない**。A013 の実装案を踏襲するが、テスト容易性のため **env 読みは `monitorMasters` 関数内で毎回行う** か、`Number(process.env.CMUX_TEAM_MASTER_GC_SEC) || 600` を `getMasterGcSec()` ヘルパーにする。Planner 判断: 関数内インライン取得を採用（`monitorConductors` の `DISCONNECT_TIMEOUT_SEC` は module-top 評価だが、Master 側は env 上書きテストを明示要件にしたいので逸脱する）。

**実装**:

- `skills/cmux-team/manager/daemon.ts`
  - L2087 付近（`DISCONNECT_TIMEOUT_SEC` 宣言直下）に以下を追加:

    ```ts
    /** Master disconnected 状態のタイムアウト（秒）— 超過で removeMaster（T245） */
    function getMasterGcSec(): number {
      return Number(process.env.CMUX_TEAM_MASTER_GC_SEC) || 600;
    }
    ```

  - `monitorConductors` 関数の直後（L2146 付近）に新規 export:

    ```ts
    /**
     * monitorMasters (T245) — disconnected 状態が CMUX_TEAM_MASTER_GC_SEC を超えた
     * Master エントリを removeMaster で掃除する。
     * monitorConductors → forceCloseDisconnectedConductor と対称の設計。
     */
    export async function monitorMasters(state: DaemonState): Promise<void> {
      const threshold = getMasterGcSec();
      for (const [surface, master] of state.masters) {
        if (master.status !== "disconnected") continue;
        if (!master.disconnectedAt) continue;
        const elapsed = (Date.now() - new Date(master.disconnectedAt).getTime()) / 1000;
        if (elapsed > threshold) {
          await log(
            "master_gc_disconnect_timeout",
            `${formatSurface(surface, "U")} elapsed=${Math.round(elapsed)}s threshold=${threshold}s`,
          );
          await removeMaster(state, surface, "gc_disconnect_timeout");
        }
      }
    }
    ```

**検証**: 追加した 5 テストが通る。既存 `monitorConductors` 系テスト（`daemon.test.ts` L2366 以降）が壊れないこと。

---

### Step 3: `tick()` への `monitorMasters` 組み込み

**TDD 順**:

1. 既存 `tick()` 経由の統合テストを 1 件追加（`describe("tick: monitorMasters 組み込み (T245)")`）
   - disconnectedAt が閾値超過の Master を state に入れて `await tick(state)` → state から消えていること
   - scanTasks / monitorConductors の副作用を壊さないこと（open task なし、Conductor なしの最小セット）

**実装**:

- `skills/cmux-team/manager/daemon.ts` の `tick()`（L914-937）:

  ```ts
  export async function tick(state: DaemonState): Promise<void> {
    state.lastUpdate = new Date();
    await scanTasks(state);
    await monitorConductors(state);
    await monitorMasters(state);  // ← 追加
    // ... 以下 proxy 死活チェック / sourceMtimes チェックは既存のまま
  }
  ```

**検証**: `bun test` 全体が green。tick の呼び出しフローを壊していないこと。

---

### Step 4: `FORGET_MASTER` ハンドラ

**TDD 順**（`daemon.test.ts` に `describe("handleMessage: FORGET_MASTER (T245)")`）:

1. `存在する disconnected Master を削除する`
   - state に surface:67 の disconnected Master を入れ persistMasterFile
   - `handleMessage(state, { type:"FORGET_MASTER", surface:"surface:67", timestamp: ... })`
   - `state.masters.has(...) === false`、ファイルも消えている
2. `存在しない surface は no-op（ログのみ、state 変化なし）`
   - handleMessage を呼んでも state.masters.size が変わらない
3. `生存中 pid の Master でも削除する（WARN ログが出る）`
   - cmux の isAlive を spy で true に差し替え、pid を持つ idle Master を削除
   - state から消えている。WARN 検証はログファイル読み込みで `master_forget_warning` を含むことを確認（既存 daemon.test.ts と同じく logger の writeFile を差し替えて collect する既存ヘルパーがあれば使う。無ければ logger を追加 import して `appendFile` を spyOn する — 既存テストの `formatSurface` 確認などで用いているパターンに合わせる）
4. `insertHookSignal が呼ばれる（trace DB 記録対象）` — 既存ハンドラ共通の事前処理を通っているか確認
   - L942-948 の挙動で全メッセージが trace DB に入ることを前提に、最小限は `state.traceDb` が真のとき insertHookSignal 呼び出し後にハンドラへ到達することだけ確認

**実装**:

- `skills/cmux-team/manager/daemon.ts` の `handleMessage` switch、`SHUTDOWN` case の前（L1735 付近の直前）に追加:

  ```ts
  case "FORGET_MASTER": {
    const master = state.masters.get(message.surface);
    if (!master) {
      await log(
        "master_forget_not_found",
        `${formatSurface(message.surface, "U")} reason=not_in_state_masters`,
      );
      break;
    }
    if (typeof master.pid === "number" && cmux.isAlive(master.pid)) {
      await log(
        "master_forget_warning",
        `${formatSurface(message.surface, "U")} pid=${master.pid} reason=alive_but_forgetting`,
      );
    }
    await removeMaster(state, message.surface, "forget_master");
    break;
  }
  ```

  - `cmux` は既存 import で解決済み（`daemon.ts` 冒頭で `import * as cmux from "./cmux"` または個別 import が存在することを確認の上、必要なら `isAlive` を個別 import に追加する）

**検証**: 追加テスト 3-4 件が通る。既存 handleMessage テストが壊れない。

---

### Step 5: `cmdForgetMaster` + CLI switch

**TDD 順**（`main.test.ts` に `describe("cmdForgetMaster (T245)")`）:

1. `--surface なしなら requireArg で exit 1`
2. `surface:67 指定で FORGET_MASTER が postMessage 経由で送信される`
   - postMessage を spy で差し替え、呼び出し内容が `{ type:"FORGET_MASTER", surface:"surface:67", timestamp: <ISO> }` であること
3. `UUID 指定時は normalizeSurfaceArg で surface:NNN に変換される`
   - 既存 `normalizeSurfaceArg` テストを参考に cmux.tree を spy して UUID → surface:NNN 変換経路を通す

**実装**:

- `skills/cmux-team/manager/main.ts`
  - `cmdCloseAgent` の直後（L2195 付近）に追加:

    ```ts
    async function cmdForgetMaster(): Promise<void> {
      if (hasHelpFlag()) showHelp(t("help_forget_master"));
      let surface: string;
      try {
        surface = await normalizeSurfaceArg(requireArg("surface"));
      } catch (e: any) {
        console.error(`Error: ${e?.message ?? e}`);
        process.exit(1);
      }
      await postMessage({
        type: "FORGET_MASTER",
        surface,
        timestamp: new Date().toISOString(),
      });
      console.log(`FORGET_MASTER sent: ${surface}`);
    }
    ```

  - サブコマンド switch（L3782-3784 `case "spawn-master":` の直後）に追加:

    ```ts
    case "forget-master":
      await cmdForgetMaster();
      break;
    ```

**検証**: main.test.ts 追加 3 テストが通る。既存 CLI ルーティングが壊れない。

---

### Step 6: i18n ヘルプ文言

**TDD 順**: なし（文字列追加のみ。型エラーで検出される）。

**実装**:

- `skills/cmux-team/manager/i18n.ts`
  - en オブジェクトに `help_forget_master` キーを追加（`help_spawn_master` の直後）:

    ```
    help_forget_master: `
    cmux-team forget-master -- remove a Master entry from state.masters (manual GC)

    Usage:
      cmux-team forget-master --surface <surface>

    Options:
      --surface <surface>     surface ID of the Master to remove (required; accepts "surface:NNN" or UUID)

    Notes:
      - Sends a FORGET_MASTER message to the daemon, which calls removeMaster
        (deletes both state.masters entry and .team/masters/<surface>.json).
      - Typically used as a manual escape hatch; disconnected entries are also
        auto-removed after CMUX_TEAM_MASTER_GC_SEC seconds (default 600).
      - A Master whose pid is still alive can still be removed; a WARN log is
        written (master_forget_warning) but the removal proceeds.

    Examples:
      cmux-team forget-master --surface surface:67
    `,
    ```

  - ja オブジェクトにも同じキーを追加（日本語訳）
  - `help_main` (en/ja) に `cmux-team forget-master --surface <surface>    Master entry を手動削除` 行を追加

**検証**: TS の型（`keyof typeof en`）が ja と en 両方に存在することを要求するため、欠落するとビルドが落ちる。

---

### Step 7: `docs/spec/05-install-and-infrastructure.md` の更新

`.team/masters/` セクションのライフサイクル箇条書き末尾に以下を追記:

```markdown
- **disconnected エントリの自動 GC（T245）**: daemon の tick（`monitorMasters`）が
  `status=disconnected` かつ `disconnectedAt` から `CMUX_TEAM_MASTER_GC_SEC`
  （デフォルト 600 秒）経過したエントリを `removeMaster` で掃除する。
  `team.json.masters[]` と `.team/masters/<surface>.json` も自動的に同期される。
  復帰安全性: 同 surface で後から Master が起動した場合、`MASTER_REGISTERED` ハンドラが
  新規 entry を作り、`SESSION_STARTED` fallback も未登録 surface を仮登録するため
  削除後の再登録経路は壊れない。
- **手動 forget（T245）**: `cmux-team forget-master --surface <id>` で即時削除可能。
  daemon に `FORGET_MASTER` メッセージを POST し、ハンドラが `removeMaster` を呼ぶ。
  生存中 pid を持つ Master を指定しても削除はブロックせず、`master_forget_warning`
  を出して続行する（deadlock 解消のための escape hatch を狭めないため）。
```

**検証**: Markdown の lint（既存 CI には無い想定だが目視確認）。表記揺れチェック（他のセクションと「T245」タグの付け方を揃える）。

---

### Step 8: E2E smoke（手動）

自動テストは無いが、以下を README レベルで手動検証する（CLAUDE.md「テスト方法」参照）:

1. `cmux-team start` で daemon を起動
2. `cmux-team spawn-master`（別 pane）で Master を起動 → `.team/team.json` / `.team/masters/surface_NN.json` に追加されていること
3. Master pane を手動 close → SESSION_ENDED で `status=disconnected` になる
4. `cmux-team forget-master --surface surface:NN` → `master_removed reason=forget_master` ログが出て即座にエントリが消える
5. 別の Master を起動 → `.team/masters/` に pane を閉じるまで `CMUX_TEAM_MASTER_GC_SEC=30` で短縮した場合、30 秒後に消えることを `grep master_gc_disconnect_timeout .team/logs/manager.log` で確認

---

## 環境変数と定数

| 名称 | 既定値 | 役割 |
|------|-------|------|
| `CMUX_TEAM_MASTER_GC_SEC` | `600`（10 分） | `monitorMasters` の disconnected → GC 閾値（秒） |
| `MASTER_DISCONNECT_GC_SEC` (internal) | `getMasterGcSec()` ヘルパーで env 読み取り | テスト容易性のため module-top 定数ではなく関数経由で参照 |

既存の `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC`（Conductor 側の 300 秒）とは **別の定数** として扱う。
Master は意図的な再開を 10 分スパンで許容する前提（A013 リスク緩和策参照）。

## テスト戦略

### 新規ユニットテスト（すべて `bun:test` / `describe`+`test`）

| ファイル | describe | テストケース数 |
|---------|---------|---------------|
| `daemon.test.ts` | `monitorMasters (T245)` | 5（閾値超過 / 閾値未満 / 非 disconnected / disconnectedAt 欠落 / env 上書き） |
| `daemon.test.ts` | `tick: monitorMasters 組み込み (T245)` | 1（tick 経由で GC が発火） |
| `daemon.test.ts` | `handleMessage: FORGET_MASTER (T245)` | 3（存在する / 存在しない / 生存 pid + WARN ログ） |
| `main.test.ts` | `cmdForgetMaster (T245)` | 3（引数欠落 / surface 正常系 / UUID 経由） |

### 既存テストへの退行チェック

- `monitorConductors: assigning timeout (T232)` (`daemon.test.ts` L2366-) — 既存。`monitorMasters` 追加によって `tick` の副作用が増えるが、Conductor 監視自体のロジックは触らないため退行リスクは低い。
- `crashed → disconnected 遷移 (T121/T195)` (`daemon.test.ts` L590-) — `removeMaster` と `monitorConductors` が関わる。`monitorMasters` は独立した Map (`state.masters`) を触るので干渉しない。
- `master.test.ts` — `persistMasterFile` / `deleteMasterFile` のテスト。`removeMaster` はこれらを呼び出すため、退行が起きれば Step 4 の「state と permanent file が消える」テストが即検出する。
- `main.test.ts` の `normalizeSurfaceArg (T206)` — cmdForgetMaster が再利用するため、既存テストが通る限り UUID 経路も動く。

### 実行コマンド

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-245-1776446560/skills/cmux-team/manager
bun install   # 初回のみ
bun test                                # 全体
bun test daemon.test.ts                 # daemon 周辺のみ
bun test main.test.ts                   # CLI のみ
bun test master.test.ts                 # 永続ファイル層の退行確認
```

## 非スコープ

A013 に列挙済みの以下は本タスクでは扱わない:

- **(c) TUI dismiss キー**: `dashboard.tsx` の `focusedArea` に `masters` を追加する UI 拡張。(a)+(d) で問題は解消するため見送り。将来必要になったら別タスクで。
- **disconnected の長期履歴保全**: 「最近削除された Master」タブや Artifact 化は不要。`.team/logs/manager.log` の `master_session_ended` / `master_gc_disconnect_timeout` / `master_removed reason=forget_master` ログで追跡可能。
- **閾値の自動調整**: tick ごとにアクセス頻度を見て閾値を動的に変える仕組みは過剰。環境変数 + デフォルト固定値で十分。
- **Conductor の GC 閾値変更**: 既存 `DISCONNECT_TIMEOUT_SEC=300` は変更しない。Master（600）と Conductor（300）で意図的に差を付ける。
- **Master 再生成の自動化**: GC で削除した Master を再 spawn するロジックは入れない（CLAUDE.md「異常検知時のリカバリーは人間に委ねる」準拠）。
- **cmux tree ベースの surface 生存確認**: A011 / T195 の方針違反のため採用しない。

## Open questions

### Q1: `MASTER_DISCONNECT_GC_SEC` を module-top 定数にするか関数内読み取りにするか

**Planner 判断**: 関数内読み取り（`getMasterGcSec()` ヘルパー）を採用する。

**理由**:
- env 上書きのユニットテストを明示要件にしたい（A013 リスク表「GC 閾値が短すぎて短時間の pane 切り替えで削除される」への緩和策の検証）
- module-top 定数にすると `process.env.CMUX_TEAM_MASTER_GC_SEC = "30"` をテストで差し込んでも既に評価済みの定数は変わらず、`describe` / `beforeEach` でのモジュールリロードが必要になる
- `monitorConductors` 側の `DISCONNECT_TIMEOUT_SEC` は module-top 評価だが、こちらは env 上書きテストが存在しないため既存設計と整合。新規導入の Master 側は素直にテスト容易性を優先して逸脱する

逸脱の影響は 1 tick あたり `Number()` + `process.env.X` 読み取り 1 回のみ。性能上のオーバーヘッドは無視できる。

### Q2: `cmux-team forget-master` 実行時に生存 pid を持つ Master を削除することを許容するか

**Planner 判断**: A013 のとおり **許容する（WARN ログのみ）**。`--force` フラグは MVP では導入しない。

**理由**:
- deadlock 解消手段としての escape hatch なので、生存チェックでブロックすると用途が狭まる
- WARN ログ（`master_forget_warning`）で痕跡は残る
- 将来的に誤削除事例が出たら `--force` を後付けで導入できる（後方互換の破壊なし）

### Q3: `removeMaster` の reason 文字列規約

**Planner 判断**: 既存の命名慣習（`removeMaster` の reason は snake_case のイベント分類）に合わせて:
- 自動 GC: `"gc_disconnect_timeout"`
- 手動 forget: `"forget_master"`

既存コードベース内の reason 文字列（`"proxy_port_changed"`, `"agent_spawned_late"` 等）と一貫性を保つ。

### Q4（Design Reviewer 相談事項）: trace DB の `hook_signals` 行数膨張

`FORGET_MASTER` を discriminated union に加えると `insertHookSignal` がこれも記録対象にする。
頻度は低い（手動 forget のみ）ので問題にはならない想定だが、GC 由来のイベントは **handleMessage を通らない**（daemon 内部の tick から `removeMaster` を直呼び）ため `hook_signals` には入らない点に留意。

Design Reviewer には「hook_signals に自動 GC イベントを入れる設計（`monitorMasters` から handleMessage 合成経由）にする方が一貫するか、現案（直呼び + manager.log のみ）で良いか」を確認いただきたい。Planner の初期判断は **現案維持**（他の tick 由来イベント — `conductor_disconnect_timeout` 等 — も hook_signals に入れていないので対称）。
