# T351 ライブ TUI dashboard に pool capacity ヘッダー + per-surface handle/util 表示 — 計画書 (revision 2)

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-351-1777238188`

## 1. 概要 (Overview)

`cmux-team status` CLI と同じ pool capacity / per-surface handle 表示を Manager 常駐の Rezi TUI dashboard (`dashboard.tsx`) に取り込む。pool 機能 ON のプロジェクトでは Manager ペインを見るだけで pool 残量・各 surface に bind された token / 使用率が分かる状態を作る。pool 無効プロジェクトでは現状レイアウト・テスト挙動を 1 ピクセルも変えない。最終成果物は (a) dashboard 上で `pool capacity / next reset` ボックスが表示される、(b) Master / Conductor / Agent 行に `@handle <5h:X%/7d:Y%>` 等のサフィックスが付く、の 2 点。

## 2. 設計判断 (Design Decisions)

### 2.1 pool データ取得経路

dashboard は Manager daemon の **同一プロセス内で Rezi コンポーネントとして常駐**しており、`startDashboard(getState)` で daemon の state クロージャを直接受けている (`dashboard.tsx:1196-1200`)。一方 CLI 側 (`cmdStatus`) は別プロセスから `team.json` を読む構成で、tokens.db を直接 open する (`main.ts:1438-1492`)。dashboard でも tokens.db を直接 open するか、daemon → dashboard で `DaemonState` に pool snapshot を載せるかの判断が必要。

| 案 | pros | cons |
|---|---|---|
| (a) **daemon が周期的に pool snapshot を計算して `DaemonState.pool` に載せる** | dashboard のレンダラは純粋関数で副作用ゼロ / tokens.db open は daemon 内 1 箇所 / refresh debounce 100ms に組み込みやすい | snapshot の更新タイミングを明示的に設計する必要 |
| (b) dashboard が refresh ごとに tokens.db を直接 open | 既存 CLI と同じコードを再利用しやすい | 100ms debounce で refresh が走るたび SQLite を open / TUI が描画ループに blocking I/O を持つのは Rezi 側の design と合わない |
| (c) 別チャネル（HTTP / file watch）で daemon → dashboard へ push | proxy → daemon の `getState()` パターンと対称になる | 同一プロセス内なのに余計な間接層を増やす / マニフェストが増える |

**選定: (a) 採用**。理由:

1. dashboard は **daemon と同一プロセス**なので「daemon が state に載せて、dashboard はそれを読む」が最も自然。`DaemonState.rateLimit` (`daemon.ts:84`) と同じ「snapshot を state に載せて dashboard が読む」アクセスパターンを踏襲する（rateLimit は proxy が EventBus 経由で代入する別経路を持つので「daemon tick 由来」という点での対称ではない。データフローの「state に置けば dashboard が読む」という構造的対称性のみを根拠とする）。
2. token-store の `initTokenDB` は **キャッシュしない**（`token-store.ts:161-186`：毎回 `new Database(dbPath)` + `PRAGMA` + `CREATE TABLE IF NOT EXISTS` を実行するため、long-running daemon では tick 毎に呼ぶと file handle が累積し PRAGMA / DDL が無駄に走る）。したがって **`DaemonState.tokenDb: Database | null` を新設し、daemon 起動時 (`cmdStart` の初期化フェーズ) に 1 度だけ `initTokenDB()` を呼んでハンドルを保持する** 設計とする。CLI (`cmdStatus`) は 1-shot プロセスなので従来通り都度 open でよい（共有モジュール側は db 引数で受ける純関数を提供し、open/close 責務は呼び出し側に持たせる）。
3. proxy が `usage_snapshots` を throttled UPSERT する経路と独立した「読み取り専用 snapshot」なので race の心配なし。同一 SQLite ファイルを daemon が読み・proxy が書く形になるが、WAL モード (`token-store.ts:177`) で reader と writer は同時並行可能。
4. (a) はテストもしやすい — dashboard tests は `DaemonState.pool` に固定値を流し込むだけで pool 表示のレンダリングを検証できる。

実装: daemon に `refreshPoolSnapshot(state: DaemonState): Promise<void>` を追加し、内部で `state.tokenDb` が null（pool OFF / 初期化失敗）なら `state.pool = null`、そうでなければ `buildPoolSummary(state.tokenDb)` の結果を `state.pool` に代入する。呼び出し位置は §4 Step 3 で確定する（**`tick` 関数ではなく `main.ts:1119-1127` のメインループに挿入する** — `tick` 自体は `scanTasks → monitorConductors → proxy 死活` のみで `updateTeamJson` を呼ばない）。

### 2.2 共有モジュールの切り出し方

CLI (`main.ts:1433-1492`) には「pool ON/OFF 判定 → tokens.db 全件読み → `computePoolCapacity` → `computeNextReset` → `poolHandleData` Map 化」というロジックが in-line で書かれている。これを **dashboard と CLI の双方が呼べる純粋関数**として切り出す。

新規ファイル: `skills/cmux-team/manager/pool-summary.ts`

```ts
import type { Database } from "bun:sqlite";
import type { PoolHeaderInput } from "./pool-status-header";

export interface PerHandleSummary {
  util5h: number | null;
  util7d: number | null;
  capPct: number | null;
}

export interface PoolSummary {
  /** buildPoolHeaderLines にそのまま渡せる入力 */
  header: PoolHeaderInput;
  /** handle ごとの per-surface 表示用 lookup */
  perHandle: Map<string, PerHandleSummary>;
}

/** tokens.db を引数で受ける純粋関数（テスト時はモック DB を渡せる、open/close 責務は呼び出し側） */
export function buildPoolSummary(
  db: Database,
  nowIso?: string,
): PoolSummary;

/** pool OFF / DB 読込失敗時は null を返す高レベル wrapper（CLI 用：都度 open）。
 *  daemon は long-running なので buildPoolSummary を直接呼び、DaemonState.tokenDb を共有する */
export function loadPoolSummary(
  projectRoot: string,
  nowIso?: string,
): Promise<PoolSummary | null>;
```

- `buildPoolSummary` は token-store の `listTokens` / `getLatestUsageSnapshot` / `computePoolCapacity` / `computeNextReset` を組み合わせる純粋関数（Database のみが副作用境界）。**daemon は state.tokenDb を渡してこの関数を直接呼ぶ**。
- `loadPoolSummary` は `isTokenPoolEnabled(projectRoot)` を呼び、ON なら `initTokenDB()` で都度 open → `buildPoolSummary` に委譲、OFF / 失敗なら null を返す **CLI 専用の 1-shot wrapper**。
- CLI 側 `cmdStatus` は L1433-1492 のロジックを `loadPoolSummary` 1 行に置き換え、`poolHandleData` 構築も summary.perHandle を再利用する形に縮める。

### 2.3 表示レイアウト

#### pool ヘッダーの位置

CLI 出力は「ヘッダー → token pool box → Master セクション → Conductors セクション → Tasks セクション」の順で、pool ヘッダーは **Master の上**にある (`main.ts:1431-1502`)。

dashboard も同じ順序を採用する。下記レイアウト中の `173%` は **2 token 合算を仮定した架空のレイアウト例**であり、§5 case A の単一 token 50% とは別物（capacity_pct は token を跨いで合算される — §1 case B 参照）。

```
─ cmux-team v4.12.1 :3000 ─────────────────  rate-limit ...
┌─ token pool ─────────────────────────────┐
│ pool capacity: 173%                       │   ← 2 token 合算想定の架空レイアウト例
│ next reset: @kddi 5h in 30m  (+20 pts)    │
└──────────────────────────────────────────┘
─ Master ──────────────────────────────────────────────
  ● [100] @kddi <5h:2%/7d:33%>  cap:80%
─ Conductors 1 running ────────────────────────────────
  ▖ [200] @tayo <5h:5%/7d:12%>  cap:60%   T351  demo
     └─ [300] @kami <5h:0%/7d:8%>  ⚙ planner
─ Tasks ...
```

`buildPoolHeaderLines` (`pool-status-header.ts`) は文字列 array を返す既存の純粋関数。dashboard では各行を `ui.text(line, { dim: true })` で囲み、capacity 値の閾値だけ色を変える（後述）。Update バナー (`daemon.updateAvailable`) と Master セクションの間に挟む。

#### pool 無効プロジェクトでの非表示

`state.daemon.pool == null`（pool OFF or 失敗）のとき pool ヘッダーは挿入せず、Master / Conductor / Agent 行のサフィックスも追加しない。これにより既存 dashboard test (`dashboard-conductor.test.tsx` 等) は完全に従来挙動を維持する。

#### per-surface handle 表示 — `buildSurfaceRowSuffix` の API 確定（**案 X 採用**）

CLI 側 `formatSurfaceRow` (`pool-surface-row.ts:34-56`) は `[surface] @handle  <5h:X%/7d:Y%>  cap:Z% ⚠` の **`[surface]` を含む full row** を返す。一方 dashboard の `buildMasterSection` (`dashboard.tsx:466,481,492`) と `buildConductorRow` (`dashboard.tsx:522,540,549,564` 他) は既に `ui.text("[" + surface + "]")` を独立 node として描画している。

**dashboard 側の責務分担を変えず、suffix を末尾に append する案 X を採用する**:

- 新関数 `buildSurfaceRowSuffix(input: SurfaceRowInput): UiNode[]` は `[surface]` を **含まない** suffix のみを返す。
- 戻り値の構造（bind 済み）: `[ui.text("@kddi"), ui.text("<5h:X%/7d:Y%>"), ui.text("cap:Z%"), ui.text("⚠"?, YELLOW)]` の順序固定。スタイル指定は dim / fg などを各 ui.text に付与。
- bind なし: `[ui.text("(no token)", { dim: true })]`。
- pool OFF (perHandle == null): 空配列 `[]` を返し、呼び出し側で append しても何も足されない。

dashboard 側の各 row 構築コードは既存 `ui.row({ gap: 1 }, [spinChar, ui.text("[" + surface + "]"), ...statusParts])` の末尾に `...buildSurfaceRowSuffix(input)` を spread で append するだけ。dashboard 側で `[surface]` の出力位置を変えないため、surface ラベル描画責務は完全に dashboard 側に残る（pool-surface-row.ts には移管しない）。CLI は `formatSurfaceRow` を引き続き使う（行全体置換）ため、CLI / dashboard で「surface ラベルを誰が描画するか」の分担が異なるが、それぞれの責務境界内で完結している。

- 警告: `5h>80% / 7d>90% / cap<20%` のいずれかで `⚠` を YELLOW で末尾追加。
- Agent 行のサブツリーも同様に `...buildSurfaceRowSuffix(input)` を末尾 append。

「surface 表記が出力ツリー内に 1 度しか現れないこと」を assertion とする test ケースを §5 に追加（`buildSurfaceRowSuffix` の戻り値を `JSON.stringify` し、配列内のテキストノードに `[100]` のような surface 表記が含まれないことを確認）。

#### 色分け閾値

`docs/spec/09-token-pool.md:271-278` より:

| capacity_pct | 意味 | dashboard 色 |
|---|---|---|
| ≥ 100% | 通常運用 | GREEN |
| 40 〜 100% | 手加減推奨 | YELLOW |
| < 40% | reset 待ちを検討 | RED |

`pool capacity: 173%` の数値部分のみこの色マップに従う。`buildPoolHeaderLines` は文字列 array なので、dashboard 側で「capacity 行は数値だけ色分け」「next reset 行は dim」のように row を再構築する小ヘルパーを `dashboard.tsx` 内に追加する（純粋ロジックを増やさず、表示マッピングだけを dashboard 側に閉じ込める）。

### 2.4 既存テストへの非互換ゼロを保証

- pool 関連 state は **default で `null`**。`DaemonState.pool: PoolSummary | null` を明示 null とする（daemon が周期的に再計算する前提）。
- `buildMasterSection` (`dashboard.tsx:455`) は **export されていない内部関数**。test ファイルから直接呼ばれる経路もないため、signature 拡張は自由。本実装では可読性のため `buildMasterSection(state: DaemonState, perHandle: Map<string, PerHandleSummary> | null)` のように第 2 引数を追加するが、optional default はあくまで保険であり既存呼び出しを破壊する懸念はない（呼び出し元 `dashboard.tsx` 側で同時に第 2 引数を渡すよう修正する）。
- `dashboard-conductor.test.tsx:12` は `buildConductorRow, formatConductorsSectionLabel` を import している。`buildConductorRow` は **export されている**ため signature 互換が必要。新関数 `buildConductorRowWithPool(c, repoUrl, frame, perHandle)` を別 export で追加し、既存 `buildConductorRow` は `buildConductorRowWithPool(c, repoUrl, frame, null)` を呼ぶ薄いシムにする。
- これにより既存テストは引数 3 個版を呼んだまま GREEN を維持する。新規テストだけが新 4 引数版を叩く。

## 3. 影響範囲 (Affected Files)

| ファイル | 種別 | 変更内容 |
|---|---|---|
| `skills/cmux-team/manager/pool-summary.ts` | 新規 | `buildPoolSummary` / `loadPoolSummary` の 2 関数（CLI と dashboard で共有） |
| `skills/cmux-team/manager/pool-surface-row.ts` | 修正 | `buildSurfaceRowSuffix(input): UiNode[]` を追加（`[surface]` を含まない suffix）。既存 `formatSurfaceRow` は据え置き |
| `skills/cmux-team/manager/daemon.ts` | 修正 | `DaemonState.pool: PoolSummary \| null` 追加 / `DaemonState.tokenDb: Database \| null` 追加 / `refreshPoolSnapshot(state)` を追加 |
| `skills/cmux-team/manager/main.ts` | 修正 | (a) `cmdStart` 初期化で `state.tokenDb = initTokenDB()` を一度だけ実行（pool OFF なら null）、(b) メインループ `tick → updateTeamJson → updateSidebarStatus` の後に `refreshPoolSnapshot(state)` を挿入、(c) `cmdStatus` の pool 処理を `loadPoolSummary` 呼び出しに置き換え |
| `skills/cmux-team/manager/dashboard.tsx` | 修正 | (a) pool ヘッダーを Master の上に挿入、(b) `buildMasterSection` に `perHandle` 引数追加 + handle/util サフィックス append、(c) `buildConductorRow` を `buildConductorRowWithPool` のシム化、(d) Agent サブツリーにも handle/util を append |
| `skills/cmux-team/manager/pool-summary.test.ts` | 新規 | `buildPoolSummary` の純関数テスト（fixture token list で capacity / perHandle Map / nextReset を検証） |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | 新規 | dashboard の pool ヘッダー / Master / Conductor / Agent サフィックスのレンダリング確認、surface 表記の二重出力を assertion で禁止 |

## 4. 実装ステップ (Implementation Steps)

TDD 順 (failing test → 実装 → green) で進める。

### Step 1: `pool-summary.ts` を切り出す（共有モジュール）

1. `pool-summary.test.ts` を作成。fixture として `[{handle:"@kddi", plan_ratio:20, util_5h:0.5, util_7d:0.5, reset_5h_at: now+5h, reset_7d_at: now+168h, ...}]` を用意し、§5 case A の expected 値（`header.capacityPct ≈ 50` / `perHandle.get("@kddi") = {util5h:0.5, util7d:0.5, capPct:~50}`）を expect。
2. `pool-summary.ts` を実装。`main.ts:1444-1483` のロジックをそのまま移植（`listTokens` → 各 token に `getLatestUsageSnapshot` → `computePoolCapacity` → `computeNextReset` → Map 化）。`buildPoolSummary` は Database を引数で受ける（テスト容易性）。`loadPoolSummary(projectRoot)` は `isTokenPoolEnabled` で gate して null / PoolSummary を返す **CLI 専用** wrapper。
3. test green を確認。

### Step 2: `cmdStatus` を `loadPoolSummary` に切り替え（リファクタ、無回帰）

1. 既存 CLI status の挙動を確認（pool ON プロジェクトで `cmux-team status > before.txt` を一度実行）。
2. `main.ts:1433-1492` を `const summary = await loadPoolSummary(PROJECT_ROOT); ...` に置き換え。`poolEnabled = summary != null` に簡略化、`poolHandleData = summary?.perHandle ?? null`、`buildPoolHeaderLines(summary?.header ?? null)` でそのまま再利用。
3. `cmux-team status > after.txt; diff before.txt after.txt` で出力差分ゼロを確認（pool ON / OFF 両方）。差分があれば Step 1 fixture / 移植ロジックを再点検。
4. **回帰防止 test**: `pool-summary.test.ts` に下記 case を追加（reviewer 指摘 5 / Recommendation 5）:
   - **case D**: `selectable=0` の token は `header.nextReset` の対象として残る（`computeNextReset` の入力に `selectable: t.selectable` を含めて渡す現行実装と同等）が、capacity 算出（`computePoolCapacity`）には `plan_ratio == null` の場合のみ除外される（selectable は capacity 計算には影響しない）。
   - **case E**: `perHandle` Map のキー集合が `listTokens` の handle 集合と一致する（`plan_ratio` の有無に関わらず全 token が perHandle に登録される — capPct は null になりうる）。

### Step 3: `DaemonState.tokenDb` / `DaemonState.pool` を追加し daemon が周期的に snapshot 更新

1. `daemon.ts` の `DaemonState` interface に下記を追加:
   - `pool: PoolSummary | null`（default null）
   - `tokenDb: Database | null`（default null。pool OFF / 初期化失敗時は null）
2. `daemon.ts` に `refreshPoolSnapshot(state: DaemonState): Promise<void>` を追加。`state.tokenDb` が null なら `state.pool = null` で早期 return、そうでなければ `try { state.pool = buildPoolSummary(state.tokenDb) } catch (e) { state.pool = null; await log("error", ...) }`。
3. `main.ts` の `cmdStart` 初期化フェーズ（state を組み立てる箇所）で `try { const decision = await isTokenPoolEnabled(PROJECT_ROOT); state.tokenDb = decision.enabled ? initTokenDB() : null } catch { state.tokenDb = null }` を実行する。**daemon 起動中の config 切替には追従しない**（§7.7 で proxy と挙動を揃える方針として明記、follow-up あり）。
4. `main.ts:1119-1127` のメインループを下記に変更:
   ```ts
   await tick(state);
   await updateTeamJson(state);
   await updateSidebarStatus(state);
   await refreshPoolSnapshot(state);  // ← 追加
   scheduleRefresh();
   ```
   `tick` 関数本体は触らない（`tick` は `scanTasks → monitorConductors → proxy 死活` の責務に閉じる）。
5. `daemon.test.ts` 等 tick / メインループのテストがあれば壊れないかを確認。

### Step 4: `pool-surface-row.ts` に `buildSurfaceRowSuffix` を追加（**案 X**: `[surface]` を含まない）

1. test を `dashboard-pool.test.tsx` に追加（`pool-surface-row.test.ts` ではなく dashboard 側 test に置く方が UiNode を扱いやすい）:
   - **bind 済み**: `buildSurfaceRowSuffix({surface:"surface:100", handle:"@kddi", util5h:0.02, util7d:0.33, capPct:80})` の戻り値を `JSON.stringify` して `"@kddi"`, `"<5h:2%/7d:33%>"`, `"cap:80%"` を含むこと、かつ `"[100]"` / `"[surface:100]"` を **含まない** こと（surface 表記の二重出力禁止 assertion）。
   - **bind なし**: `handle: undefined` で `(no token)` を含み `[surface]` を含まないこと。
   - **警告**: `util5h:0.85` で `⚠` を含み YELLOW 相当のスタイルが付くこと。
   - **pool OFF（perHandle に該当 handle なし相当の入力 = capPct:null, util:null）**: 空の `cap:` セクションが省略されること（既存 `formatSurfaceRow` の挙動に揃える）。
2. `formatSurfaceRow` のロジックをほぼ流用し、文字列セグメントごとに `ui.text(seg, style)` を返す純関数を実装。**戻り値先頭に surface ラベルは含まない**。CLI 互換のため既存 `formatSurfaceRow` は触らない。

### Step 5: dashboard に pool ヘッダーを挿入

1. `dashboard-pool.test.tsx` に「`buildPoolHeader(summary)` が summary=null なら空 array、summary=有効なら `pool capacity: 173%` 等を含む node array を返す」test を追加。
2. dashboard.tsx に `buildPoolHeader(summary: PoolSummary | null): UiNode[]` を追加（capacity 行のみ閾値で色分け、それ以外は dim）。
3. `buildViewWithApp` 内で Update バナーと「Master セクション」の間に `...buildPoolHeader(state.daemon.pool)` を spread で挿入。

### Step 6: Master / Conductor / Agent 行に handle/util を追記

1. test ケース:
   - **pool OFF (state.daemon.pool=null, perHandle=null)**: `buildMasterSection(daemon, null)` の出力に `@` 文字が含まれないこと（既存挙動）。surface ラベル `[100]` は 1 度だけ出現すること。
   - **pool ON で master.tokenHandle="@kddi"**: 出力に `@kddi` と `<5h:` が含まれ、surface ラベル `[100]` は依然 1 度だけ出現すること。
   - **bind なし agent (tokenHandle=undefined) かつ pool ON**: `(no token)` を含み、surface ラベルは 1 度だけ出現すること。
2. `buildMasterSection(state, perHandle)` に第 2 引数を追加し、各 master 行の末尾に `...buildSurfaceRowSuffix(...)` を append。**`buildMasterSection` は内部関数なので signature 変更は自由**。
3. `buildConductorRow` を `buildConductorRowWithPool(c, repoUrl, frame, perHandle)` にラップ。既存 `buildConductorRow` は `buildConductorRowWithPool(c, repoUrl, frame, null)` を呼ぶ薄いシムにする（既存テストへの impact ゼロ）。
4. Agent サブツリーも同様に `perHandle` を見て suffix を末尾 append。

### Step 7: 完了条件の最終確認

1. `bunx tsc --noEmit` → 0 errors。
2. ファイル単位テスト走査（CLAUDE.md の禁忌を回避）:
   ```
   cd skills/cmux-team/manager
   bun test --timeout 30000 pool-summary.test.ts
   bun test --timeout 30000 pool-surface-row.test.ts
   bun test --timeout 30000 dashboard-conductor.test.tsx
   bun test --timeout 30000 dashboard-issues.test.tsx
   bun test --timeout 30000 dashboard-metrics.test.tsx
   bun test --timeout 30000 dashboard-pool.test.tsx
   ```
3. pool ON プロジェクト（例: 自リポジトリ）で `cmux-team start` を実行し、Manager dashboard 上で pool ヘッダーと per-surface サフィックスが表示されることを目視確認。
4. pool OFF プロジェクト（例: `tokenPool.enabled=false`）で同 dashboard を起動し、レイアウトが従来通りであることを目視確認。

## 5. テスト方針 (Test Plan)

### 既存 dashboard test を壊さないこと

- `dashboard-conductor.test.tsx` / `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx` は引数を増やさない既存 export (`buildConductorRow` / `formatConductorsSectionLabel` 等) のみを呼ぶ。pool 機能は新 export (`buildConductorRowWithPool` / `buildPoolHeader` / `buildSurfaceRowSuffix`) として追加するため、引数互換は崩れない。
- `buildMasterSection` は **export されていない内部関数** (`dashboard.tsx:455`) なので signature 拡張は自由。dashboard.tsx 内の呼び出し元と同時に修正する。

### 新規テストファイル

#### `pool-summary.test.ts`

`computePoolCapacity` の式は `flow = min(remaining_5h * plan_ratio / t_5h, remaining_7d * plan_ratio / t_7d)`、`cap_pct = (flow / REFERENCE_FLOW) * 100`、`REFERENCE_FLOW = 20.0/168 ≈ 0.119` (`token-store.ts:732-766`)。fixture からはこの式を使って expected 値を導出する。

- **case A**: 単一 token (`@kddi`, `plan_ratio=20`, `util_5h=0.5`, `util_7d=0.5`, `reset_5h_at = now+5h`, `reset_7d_at = now+168h`)。
  - `t_5h = 5`, `t_7d = 168`, `remaining_5h = remaining_7d = 0.5`
  - `flow_5h = 0.5 * 20 / 5 = 2.0`, `flow_7d = 0.5 * 20 / 168 ≈ 0.0595`
  - `flow = min(2.0, 0.0595) = 0.0595`, `cap_pct = 0.0595 / (20/168) * 100 = 50%`
  - **expected**: `header.capacityPct ≈ 50.0`（許容誤差 ±0.1）、`perHandle.get("@kddi") = {util5h:0.5, util7d:0.5, capPct:~50}`。
- **case B**: 2 token (`@kddi`, `@tayo`) いずれも case A と同条件 → `capacity_pct ≈ 100`（合算）、`perHandle` size は 2、`perHandle.get("@kddi").capPct ≈ 50` / `@tayo` 同。`§2.3` の `173%` レイアウト例は **2 token を別条件で合算した架空値** であることをここで注釈（fixture には載せない）。
- **case C**: 全 token `plan_ratio=null` → `capacity_pct = 0`、`perHandle` は **全 token を含む**が各 entry の `capPct: null`（reviewer 指摘 5: perHandle のキー集合は listTokens の全 handle と一致）。
- **case D**: `selectable=0` の token を含む fixture → `header.nextReset` の入力対象として selectable=0 token が残ること（`computeNextReset` の入力に `selectable: t.selectable` を渡す現行実装と同等）。capacity 計算には selectable は影響しない（`plan_ratio` の有無のみ判定軸）。
- **case E**: `perHandle` Map のキー集合 `[...summary.perHandle.keys()].sort()` が `listTokens(db).map(t => t.handle).sort()` と一致する。
- **case F**: `loadPoolSummary` (CLI 用 wrapper) は pool 機能 OFF プロジェクトで null を返す（`isTokenPoolEnabled` のモックで gate）。

#### `dashboard-pool.test.tsx`

- **case 1**: `buildPoolHeader(null)` → `[]`。
- **case 2**: `buildPoolHeader(summary)` で `pool capacity: NN%` 文字列が node 配下に含まれる（NN は fixture から計算した値）。
- **case 3**: capacity 173% のとき GREEN (`fg = rgb(0,160,0)`) が適用される（しきい値 ≥100% 検証用に capacity_pct=173 の synthetic summary を使う）。
- **case 4**: capacity 30% のとき RED (`fg = rgb(180,40,40)`) が適用される。
- **case 5**: capacity 60% のとき YELLOW が適用される。
- **case 6**: pool ON / `master.tokenHandle="@kddi"` / `perHandle` に @kddi の summary がある状態で、`buildMasterSection(state, perHandle)` の出力に `@kddi` と `<5h:` が含まれる。**かつ `[100]` のような surface ラベルは出力ツリー全体で 1 度しか現れない**（reviewer 指摘 3: 二重出力禁止）。
- **case 7**: pool OFF (`state.pool=null`, `perHandle=null`) で master 行に `@` 文字が含まれない（既存挙動）。surface ラベルは 1 度だけ出現する。
- **case 8**: agent.tokenHandle=undefined のとき `(no token)` が rendering される。surface ラベルは 1 度だけ出現する。
- **case 9**: util_5h=0.85（警告閾値超過）で `⚠` が含まれる。
- **case 10**: `buildSurfaceRowSuffix` の戻り値を直接 `JSON.stringify` し、配列内に `[100]` / `[surface:` の文字列が含まれないこと（API 契約: suffix は surface を含まない）。

### 共有 fixture

`pool-summary.test.ts` の case A fixture token 配列を `dashboard-pool.test.tsx` でも import 再利用し、CLI と dashboard で同じ `header.capacityPct` 値（≈50.0）になることを 1 ケース cross-validate する。

## 6. 完了基準 (Definition of Done) — Inspector チェックリスト

- [ ] `.team/config.json` で `tokenPool.enabled=true` のプロジェクトで Manager dashboard を起動すると pool capacity ヘッダーが表示される
- [ ] pool 無効プロジェクトでは何も表示されない（既存レイアウトを壊さない）
- [ ] 各 Conductor / Agent 行に handle が表示される（bind されていない場合は `(no token)`）
- [ ] Master 行にも handle / util が表示される
- [ ] 各行において surface ラベル `[N]` は 1 度だけ表示される（二重出力ゼロ）
- [ ] 既存の dashboard test (`dashboard-conductor.test.tsx` / `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx`) が pass
- [ ] 新規テスト (`pool-summary.test.ts` / `dashboard-pool.test.tsx`) が pass
- [ ] `bunx tsc --noEmit` が 0 errors
- [ ] CLI (`cmux-team status`) の pool 表示が `loadPoolSummary` 経由に切り替わっても挙動が変わっていない（pool ON / OFF 両方で `diff before.txt after.txt` がゼロ）
- [ ] daemon は `state.tokenDb` を起動時 1 度だけ open し、メインループでは `buildPoolSummary(state.tokenDb)` を呼ぶ（毎 tick で `initTokenDB` を呼ばない）
- [ ] 全体 `bun test` の禁忌に従い、変更ファイル単位での `bun test --timeout 30000 <file>` で全て pass

## 7. リスク・懸念 (Risks)

### 7.1 token-store の I/O コスト（reviewer 指摘 1 反映）

`token-store.ts:161-186` の `initTokenDB` は **キャッシュを持たない**: 毎回 `new Database(dbPath)` を生成し、`PRAGMA journal_mode=WAL` / `PRAGMA foreign_keys=ON` / `CREATE TABLE IF NOT EXISTS` / `ensureTokensColumns` 等を毎呼び出しで実行する。close もされない。したがって **long-running daemon プロセスで毎 tick (10s 既定) に `initTokenDB()` を呼ぶと file handle が累積し、PRAGMA / DDL が無駄に走る**。

→ 対策: §2.1 / Step 3 で `DaemonState.tokenDb: Database | null` を新設し、daemon 起動時 (`cmdStart`) に 1 度だけ `initTokenDB()` してハンドルを保持する。`refreshPoolSnapshot` は `state.tokenDb` を `buildPoolSummary` に渡すだけ。CLI は 1-shot プロセスなので従来通り `loadPoolSummary` 経由で都度 open。

`buildPoolSummary` は内部で `listTokens` + `getLatestUsageSnapshot`(per token) で 1 + N クエリ走る。token 数が増えても高々 数十クエリ / 数秒で I/O は無視できる範囲。万一さらに高頻度化すれば throttle を入れる余地を残す（`state.poolLastComputedAt` で N 秒未満なら skip 等）が、初版では入れない。

### 7.2 Rezi の再描画頻度

dashboard は `scheduleRefresh` で 100ms debounce、`spinnerInterval` で 180ms tick している (`dashboard.tsx:2112-2130`)。pool snapshot は daemon メインループで更新されるので、dashboard は読むだけ（純粋 read）。再描画コストは pool 行が増えた分だけ増えるが、Master/Conductor 行の text 数行追加なので diff レンダリングのコスト増は無視できる。

### 7.3 テスト実行コスト

CLAUDE.md に「`bun test` 全体実行禁忌（O(N²) 級劣化で 13 分以上ハング）」の記載あり。本タスクでも個別ファイル単位での `bun test --timeout 30000 <file>` を使う。CI も同 pattern (`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test ... done`) なので、新規追加の `dashboard-pool.test.tsx` / `pool-summary.test.ts` も自動で対象に入る（glob でマッチ）。

### 7.4 既存 export 互換性

`buildConductorRow` の signature 変更は外部テスト影響大なので、新関数 `buildConductorRowWithPool` を別 export で追加して既存 `buildConductorRow` をシム化する設計を厳守する。`buildMasterSection` は **内部関数（非 export）** であり test から呼ばれないため signature 拡張は自由（reviewer 指摘 6 反映）。

### 7.5 警告閾値の display vs blocker の混同

`pool-surface-row.ts` の冒頭コメントが既に明記している通り、display 警告閾値（5h>80% / 7d>90% / cap<20%）は selectToken のブロッカー判定（5h>=95%）とは独立。本実装ではこのコメントの精神を踏襲し、警告閾値を別途いじらない。dashboard の色分け閾値も `09-token-pool.md` の 100% / 40% を使い、display 警告閾値とは独立した 2 軸を維持する。

### 7.6 `state.pool = ...` / `state.tokenDb = ...` 直接代入は CLAUDE.md の "task-state" ルールに抵触するか

CLAUDE.md「task-state は `applyTaskEvent` / `updateTaskSessionId` 経由のみ」のルールは **task の status 管理**に対するもの。`DaemonState.pool` / `DaemonState.tokenDb` は task 状態とは別 axis のランタイム snapshot で、`DaemonState.rateLimit`（proxy 由来）と同じく直接代入で更新する既存パターンに従う。これは既存 design と整合する（rate limit / proxy port も `state.X = Y` で更新されている）。

### 7.7 pool 機能 OFF → ON 切替の挙動と proxy / dashboard の対称性（reviewer 指摘 7 反映）

proxy 側は **起動時に 1 回だけ `isTokenPoolEnabled` を評価してクロージャに束縛する** 設計（`docs/spec/09-token-pool.md:296-297` の auto-discover 節）。

本初版でも **dashboard / daemon 側も同じく boot 時 1 回評価で固定する** 方針を採る:

- `cmdStart` 初期化フェーズで `isTokenPoolEnabled` を評価し、`state.tokenDb` を `initTokenDB()` または `null` に固定。
- daemon 稼働中の config 切替には追従しない（proxy と挙動を揃える）。
- 切替を反映するには **daemon 再起動が必要**（A019 の「設定変更は daemon 再起動を伴う前提」と整合）。

**Follow-up**: dashboard 表示の挙動 (boot 時 1 回評価で固定) を `docs/spec/09-token-pool.md` の auto-discover 節に追記する別タスクを起票する（本タスクの DoD には含めない、ただしセッション履歴 / CLAUDE.md 改善候補として残す）。

---

## 改訂履歴 (revision 2)

design-review.md (2026-04-27) Recommendations 1〜7 を取り込んだ修正対応表:

| Rec # | 反映先セクション | 主な変更内容 |
|---|---|---|
| **1** | §2.1 採用理由 #2 / §3 影響範囲 / §4 Step 3 / §7.1 / §6 DoD | `initTokenDB` キャッシュ前提を撤廃。`DaemonState.tokenDb: Database \| null` を新設し、daemon 起動時 1 度だけ open する設計に変更。`pool-summary.ts` の API も `buildPoolSummary(db)` を daemon が直接呼ぶ形に明記、`loadPoolSummary` は CLI 専用 wrapper と明記。 |
| **2** | §2.1 末尾 / §4 Step 3 | 「`tick(state)` の末尾（`updateTeamJson` の後）」という誤認を削除。`tick` には触れず `main.ts:1119-1127` のメインループで `tick → updateTeamJson → updateSidebarStatus → refreshPoolSnapshot` の順に挿入する案 (b) で確定。`DaemonState.rateLimit` との「対称性」根拠は「state に snapshot を置いて dashboard が読むデータフローの対称性のみ」と限定し、tick 由来の対称性主張は削除。 |
| **3** | §2.3 per-surface handle 表示 / §4 Step 4 / §5 case 6/7/8/10 | `buildSurfaceRowSuffix` の API を **案 X (`[surface]` を含まない)** で確定。dashboard 側は既存 `ui.text(surfaceLabel)` の後ろに `...buildSurfaceRowSuffix(input)` を spread で append。surface 表記が出力ツリー全体で 1 度しか現れないことを §5 case 6/7/8/10 で assert。`formatSurfaceRow` (CLI 用) は full row 返しのまま据え置き。 |
| **4** | §2.3 レイアウト例の注釈 / §4 Step 1 / §5 case A | `§2.3` の `173%` レイアウト例は「2 token 合算想定の架空値」と明示。case A の fixture を実値で書き直し: `util_5h=0.5, util_7d=0.5, t_5h=5, t_7d=168` で `cap_pct = 0.0595/(20/168)*100 ≒ 50%`。算式の式変形を §5 case A の本文に明記。 |
| **5** | §4 Step 2 / §5 case D / case E / DoD | 「目視確認のみ」を撤廃。Step 2 に `cmux-team status > before.txt; ...; diff before.txt after.txt` の手順を明文化。`pool-summary.test.ts` に case D（`selectable=0` の token は nextReset 対象に残るが capacity 算出には影響しない）と case E（perHandle のキー集合 = listTokens の全 handle 集合）を追加。 |
| **6** | §2.4 / §7.4 / §4 Step 6 #2 | `buildMasterSection` は **export されていない内部関数** であり test から呼ばれないため signature 拡張は自由、と明示。optional default はあくまで可読性の保険であると注記。 |
| **7** | §7.7 | proxy 側 auto-discover はクロージャ束縛、本初版では dashboard / daemon も **boot 時 1 回評価で固定** して proxy と挙動を揃える方針に切替。`docs/spec/09-token-pool.md` への追記は follow-up タスクとして残す（DoD には含めない）。 |

旧 plan の意図（TDD 順 / 既存 export 互換 / pool OFF で完全に何も挿入しない / DoD checklist）はそのまま維持している。
