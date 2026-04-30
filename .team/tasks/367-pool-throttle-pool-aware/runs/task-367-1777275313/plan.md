# T367 実装計画: pool 有効時の THROTTLE 判定を pool-aware に（rev2）

## 0. 改訂履歴と Reviewer 指摘トレース

| Reviewer 指摘 | 対応箇所 | 一行サマリ |
|---|---|---|
| Major #1 (判定ソース統一) | §2.1 / §2.2 / §3.2-A,D,E | dashboard / computeSidebarStatus / scanTasks すべて `state.tokenDb !== null` で統一。helper 単一エントリ化 |
| Major #2 (閾値整合) | §2.3 / §0.1 Open Q1 | `selectToken` の `> 0.95` を唯一の真理。`THROTTLE_5H_THRESHOLD` を別途定義しない |
| Major #3 (policy/lease 整合) | §2.3 / §3.1-B / §0.1 Open Q2 | `token-store.ts` に `canSelectAnyToken` を切り出し方針 (a) を採用 |
| Major #4 (default 昇格) | §2.3 (canSelectAnyToken 経由で自動追従) | `effectiveDefault` 解決を共有関数に内包 |
| Major #5 (boot/running ガード) | §2.2 / §3.2-A,B,D | helper の opts に `running` / `bootReady` を取り、boot 中は throttle 判定 skip |
| Minor #6 (`hasPoolHeadroom` 置き場) | §2.4 / §0.1 Open Q3 | 純粋関数 `hasPoolHeadroomFromSummary` を `pool-throttle.ts` に同居。Ink 側はそれを呼ぶ |
| Minor #7 (`selectable` 追加被影響) | §2.5 / Step 3 (§6) | 着手前 grep を Step 3 に明記。被影響テスト列挙 |
| Minor #8 (`countAvailablePoolTokens` 戻り値) | §2.6 | `{ enabled, selectable, available, total, stale }` に分解 |
| Minor #9 (proxy fallback 重複) | §2.2 (helper 集約) | `isThrottled5h` 単一関数で吸収 |
| Minor #10 (ログ表記) | §2.7 | `mode=single` / `mode=pool`、pool 系は `pool=N/M` 併記 |
| Minor #11 (daemon 側 selectable=0) | §2.3 (canSelectAnyToken 経由で自動追従) | Major #3/#4 と連動 |
| Minor #12 (シグネチャ) | §2.2 | helper を `(db, rl, opts) => boolean` に縮める |
| Open Q1 (閾値) | §2.3 / §0.1 | `> 0.95` 単一閾値で確定 |
| Open Q2 (Major #3 方針) | §2.3 / §0.1 | (a) `canSelectAnyToken` 切り出しで確定 |
| Open Q3 (`hasPoolHeadroom` 置き場) | §2.4 / §0.1 | `pool-throttle.ts` 純粋部分で確定 |
| Open Q4 (`docs/spec/09-token-pool.md` 更新) | §0.1 / Step 9 | 「`canSelectAnyToken` 共有による構造的保証」と明記 |
| Open Q5 (proxy 独立モード) | §2.8 | 維持 (`throttled: false, pool: null`) |
| Open Q6 (`tokenDb` 初期化失敗 warning) | §2.9 / §3.2-G | 本タスクで scanTasks tick ごと 1 回 + 起動時に強調 warning を 1 行追加 |

### 0.1 Open Question の確定

- **Q1 (閾値)**: `selectToken` 側の `util_5h > 0.95` ブロッカーを唯一の真理とする。`THROTTLE_5H_THRESHOLD (=0.90)` は本タスクで pool-aware 経路から参照しない。pool 無効経路（`state.tokenDb === null`）の従来判定では引き続き `THROTTLE_5H_THRESHOLD` を使う（後方互換のため変更しない）。
- **Q2 (Major #3 方針)**: (a) `canSelectAnyToken(db, holder, policy, nowIso): boolean` を `token-store.ts` に切り出し、`selectToken` と admit 判定（exclude / lease / stale / blocker > 0.95 / default 昇格 / include / OSS / tag マッチ）を共有する。pool-throttle helper はそれを 1 回呼ぶだけ。
- **Q3 (`hasPoolHeadroom` 置き場)**: 純粋関数 `hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[]): boolean` を `pool-throttle.ts` に同居させ、Ink 側 (`pool-header-display.ts` / `dashboard.tsx`) はそれを import する。SQLite 依存ファイルと純粋部分が同居しても、Ink 側からは純粋 export のみ参照するので問題ない（既に `schema.ts` も同様の構造）。
- **Q4 (`docs/spec/09-token-pool.md` 更新)**: 「pool-throttle と spawn-agent の admit 整合性は `canSelectAnyToken` を共有することで構造的に保証される（ロジック分岐の規約レベルではなく実装レベルで一意）」と仕様文を入れる。
- **Q5 (proxy 独立モード)**: 維持。`opts?.getState` 不在のとき `throttled: false, pool: null` を返す。Plan §2.8 で明文化。
- **Q6 (`daemon.tokenDb` 初期化失敗の警告)**: 本タスクに含める（低コスト・即効性高い）。具体的には:
  - 起動時 `main.ts:694-697` の既存 `error` ログ（`initTokenDB failed`）を `warn`/`error` 二重出力にし、強調 prefix `[POOL_DISABLED]` を付ける（`tail -f` で目視しやすく）。
  - scanTasks の throttle ログにも `pool_intended=on pool_active=off reason=db_init_failed` のような diagnostic フィールドを 1 度だけ含める（毎 tick は冗長なので daemon state に `tokenDbInitFailed: boolean` フラグを 1 個持って 1 度だけ）。

## 1. 背景・問題（rev1 から変更なし）

現状の THROTTLE 判定は `state.rateLimit.unified5hUtilization >= THROTTLE_5H_THRESHOLD (=0.90)` のみを参照する。`state.rateLimit` は **直近の Anthropic API レスポンスで観測した「単一アカウント」の 5h utilization** であり、proxy が receive 順に上書きしている (`proxy.ts:117`, `proxy.ts:288`)。

token pool が有効な場合 (`tokens.db` に複数 token が登録されており `selectToken` が回している場合) でも、判定軸は単一アカウントの最新観測値のままなので、**pool 全体に余裕があっても 1 つのアカウントが 90% を踏むと THROTTLED 扱いになって全 spawn が止まる**。これにより spawn-agent (exit 75)・scanTasks の assignment・dashboard / sidebar の ⏸ 表示が pool の実情と乖離する。

THROTTLE 判定は pool 有効時のみ pool-aware に切り替え、pool 無効時は完全に従来挙動を保つ。

## 2. 設計方針

### 2.1 pool 有効/無効の切替条件 — `state.tokenDb` で全箇所統一【Major #1 対応】

判定箇所ごとに以下のソースで pool 有効性を判別する。**全箇所で `state.tokenDb !== null` を一次ソースとして使う**（rev1 で採用していた `daemon.pool != null` ベースは破棄）。

| 箇所 | pool 有効性ソース |
|---|---|
| `daemon.ts: scanTasks` | `state.tokenDb !== null` |
| `daemon.ts: computeSidebarStatus` | `state.tokenDb !== null`（引数型に `tokenDb` を追加して渡す） |
| `proxy.ts: /rate-limit` | proxy 起動時にクロージャ束縛した `tokenPoolEnabled` + `getTokensDB()` の組み合わせ。両方非 null で pool 有効 |
| `dashboard.tsx: isThrottled` | `daemon.tokenDb !== null`（`AppState.daemon: DaemonState` に既に含まれる。`dashboard.tsx:2082` で前例あり） |
| `main.ts: spawn-agent` | 変更不要。`/rate-limit` の `throttled` を信頼する |

**根拠の訂正**: rev1 で「dashboard は別プロセスで `state.tokenDb` を直接参照できない」と書いたのは事実誤認。dashboard.tsx は同一 daemon プロセスで Ink 描画する TUI 層であり、`AppState.daemon: DaemonState` に `tokenDb` が含まれる。さらに `pool != null` ベース判定は `refreshPoolSnapshot` の例外時 fallback (`daemon.ts:412-416`) で pool ON でも `state.pool=null` になる経路を持ち、判定軸として不適切（本タスクが解消したい現象が残る）。

### 2.2 helper 集約 — `isThrottled5h(db, rl, opts)`【Major #1, #5, Minor #9, #12 対応】

新規ファイル `skills/cmux-team/manager/pool-throttle.ts` に **単一エントリ helper** を置く。proxy / scanTasks / computeSidebarStatus / dashboard.tsx の 4 箇所はすべてこの 1 関数を呼ぶ。

```ts
// pool-throttle.ts (シグネチャ)
import type { Database } from "bun:sqlite";
import type { RateLimitInfo } from "./schema";
import type { SelectTokenPolicy } from "./token-store";
import type { PerHandleSummary } from "./pool-summary";

export interface ThrottleOpts {
  running: boolean;     // daemon が running 状態か
  bootReady: boolean;   // bootPhase === "ready" か
  policy?: SelectTokenPolicy; // pool 有効時のみ参照（resolveProjectTokenPool 由来）
  holder?: string;      // canSelectAnyToken に渡す。実 spawn と同じ holder を使えるならそれが望ましいが、
                        // throttle 判定は holder を lease 取得まではしないので "throttle-probe" 固定でよい
}

export function isThrottled5h(
  db: Database | null,
  rl: RateLimitInfo | null,
  opts: ThrottleOpts,
  nowIso?: string,
): boolean;

// 純粋関数。Ink 側からのみ呼ぶ（SQLite 依存なし）。
export function hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[]): boolean;

// 集計用。/rate-limit の `pool` フィールド組み立て、ログの `pool=N/M` 表記に使う。
export function countPoolTokens(
  db: Database,
  policy: SelectTokenPolicy,
  nowIso?: string,
): { enabled: boolean; selectable: number; available: number; total: number; stale: number };
```

擬似コード:

```
function isThrottled5h(db, rl, opts, nowIso):
  // boot/running ガード（Major #5）
  if (!opts.running || !opts.bootReady) return false;

  // pool 有効経路
  if (db !== null) {
    return !canSelectAnyToken(db, opts.holder ?? "throttle-probe", opts.policy ?? defaultPolicy, nowIso);
  }

  // pool 無効経路（従来ロジック完全保持）
  return !isStale5h(rl) &&
    (rl?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;
```

呼び出し側はすべてこの 1 関数経由。proxy の `/rate-limit` での `throttled` 算出も、scanTasks の throttle ガードも、computeSidebarStatus も、dashboard.tsx の `isThrottled` も同じシグネチャ。

### 2.3 `canSelectAnyToken` の切り出し【Major #2, #3, #4 対応 / Open Q1, Q2 確定】

`token-store.ts` に新規 export を追加し、`selectToken` の admit ループから lease 取得直前までを peek 関数として切り出す。

```ts
// token-store.ts (新規)
/**
 * pool に admit 可能な token が 1 つでもあるかを判定する peek 関数。
 * `selectToken` から lease 取得を除いた admit ループと同一ロジック。
 * 副作用: `expireLeases` のみ（既存の selectToken と同じ。これは pool の DB 一貫性維持に必要）。
 * leaseは取らない。
 *
 * @returns true = admit 候補が 1 つ以上ある（throttled=false）
 */
export function canSelectAnyToken(
  db: Database,
  holder: string,
  policy: SelectTokenPolicy | string[] = ["any"],
  nowIso: string = new Date().toISOString(),
): boolean;
```

**実装方針**: `selectToken` 内の admit ループ（`token-store.ts:872-919`）を共通の private 関数に extract:

```
function admitCandidates(db, policy, nowIso): Token[] {
  // 現 selectToken の 875-918 をそのまま実行し、admit に通った token の配列を返す
  // exclude / selectable=0 default 昇格 / lease / stale / >0.95 / admit 判定（default/include/OSS/tag）
}
```

`selectToken` は `admitCandidates` から得た配列を sort して `acquireLease`、`canSelectAnyToken` は `admitCandidates` の length > 0 を返すだけ。

**閾値の整合**【Open Q1】: pool-throttle 経路は `canSelectAnyToken` の真偽だけを使う。`selectToken` 側 `> 0.95` ブロッカーがそのまま閾値になり、`THROTTLE_5H_THRESHOLD (=0.90)` を pool-aware 経路では参照しない。これにより `[0.91, 0.93]` のように 90% は超えるが 95% 未満の token は admit され、pool-throttle は throttled=false を返す（rev1 の false positive を解消）。

**`policy` の取得**【Major #3 (a) を採用】: `policy` は `resolveProjectTokenPool(PROJECT_ROOT)`（`config.ts` 推定）から得る。
- daemon 内では起動時に 1 度評価して `state.poolPolicy: SelectTokenPolicy | null` にキャッシュ（`state.tokenDb` の隣に追加）。
- proxy の `/rate-limit` では proxy 起動時にクロージャ束縛（既存 `tokenPoolEnabled` と同じパターン）。
- runtime config 切替には追従しない（既存 `state.tokenDb` も 1 度評価で固定）。

### 2.4 `pool-throttle.ts` の純粋部分と SQLite 部分の分離【Minor #6 / Open Q3 対応】

`pool-throttle.ts` 内部で:

- **SQLite 依存 export**: `isThrottled5h(db, rl, opts)`, `countPoolTokens(db, policy)`
- **純粋 export**: `hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[])`

Ink 側 (`pool-header-display.ts`) と `dashboard.tsx` は **純粋 export のみ** import する。重複ロジックは作らず、Ink 側でも util5h が `selectable=true` の token のうち 1 つでも `< 0.95` (or null) なら headroom ありを返す（`canSelectAnyToken` と同じ閾値）。

`hasPoolHeadroomFromSummary` の擬似コード:

```ts
export function hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[]): boolean {
  for (const ph of perHandle) {
    if (!ph.selectable) continue;          // selectable=0 は default 昇格を考慮しない近似
    if (ph.util5h == null) return true;    // snapshot 未取得 = 未使用 = 余裕あり
    if (ph.util5h < 0.95) return true;     // selectToken の閾値と一致
  }
  return false;
}
```

**注意**: `hasPoolHeadroomFromSummary` は selectable=0 default 昇格を考慮しないため、daemon 側 (`scanTasks` / `computeSidebarStatus`) で SQLite を直接見る経路と微小に乖離する可能性がある。dashboard 表示は cosmetic（⏸ icon）なので許容するが、ヘルプテキストで「正確な判定は daemon 側で行う」と明記する余地あり。実装時に `dashboard-pool.test.tsx` にこの近似の境界を明示するテストを追加する（§4 B6）。

### 2.5 `PerHandleSummary.selectable` 追加と被影響範囲【Minor #7 対応】

`pool-summary.ts:27-31` の `PerHandleSummary` に `selectable: boolean` を追加。`buildPoolSummary` 内 (`pool-summary.ts:73`) で `t.selectable` を埋める。

実装着手前（Step 3 冒頭）に必ず実行:

```sh
grep -rn "PerHandleSummary\|perHandle\.set\|perHandle:" skills/cmux-team/manager
```

予想される被影響箇所（事前調査による暫定リスト、Step 3 冒頭で実機確認）:
- `pool-summary.ts:27, 37, 70, 73`（型と build 本体）
- `pool-summary.test.ts`（型と fixture）
- `pool-header-display.ts` / `pool-header-display.test.ts`
- `dashboard.tsx:551, 618, 663, 867`（perHandle を関数引数で受ける箇所）
- `dashboard-conductor.test.tsx:14, 130, 131`
- `dashboard-pool.test.tsx:15, 38, 41, 158, 196, 226`
- CLI 側 `cli-status-pool.test.ts` 系（`buildPoolSummary` 経由なら影響あり）
- `dashboard-metrics-pool-tokens.test.tsx` 系の fixture

Step 3 はこれらすべてに `selectable: true` (or 適切な値) を追加してから daemon / proxy 変更に進む。

### 2.6 `countPoolTokens` の戻り値を分解【Minor #8 対応】

`{ enabled, selectable, available, total, stale }` の 5 フィールドで返す。`/rate-limit` の `pool` フィールドはこれをそのまま `pool` に詰める。dashboard / status 系で内訳を出したいときに情報を落とさない。

| フィールド | 定義 |
|---|---|
| `enabled` | `db !== null` か否か。常に `true`（呼び出されたなら pool 有効） |
| `total` | `listTokens(db, { selectableOnly: false }).length`。default 昇格対象も含む全 token 数 |
| `selectable` | `listTokens(db, { selectableOnly: true }).length`。selectable=1 の数 |
| `available` | `canSelectAnyToken` 内部で集計可能（admitCandidates 配列長）。policy 適用後に admit 通った数 |
| `stale` | `listTokens` の各 token のうち `getLatestUsageSnapshot` が stale だった件数 |

### 2.7 ログ表記の統一【Minor #10 対応】

| 箇所 | フォーマット |
|---|---|
| scanTasks `throttled_rate_limit` | `mode=pool pool=2/4 selectable=4 stale=0 5h_utilization=92.0% threshold=95% reset=...` |
| scanTasks `throttled_rate_limit` (single) | `mode=single 5h_utilization=92.0% threshold=90% reset=...` |
| spawn-agent `spawn_agent_throttled` | `conductor=… role=… task_id=… mode=pool pool=0/4 util=95.5% unified5hReset=...` |
| spawn-agent `spawn_agent_throttled` (single) | `conductor=… role=… task_id=… mode=single util=95.5% unified5hReset=...` |

`mode=` は 2 値（`single` / `pool`）。pool モードでは `pool=available/total` を必ず併記。`threshold` も pool/single で表示閾値が異なる（pool: 95%、single: 90%）ことを明示する。

### 2.8 proxy.ts 独立モードの維持【Open Q5】

`opts?.getState` 不在で proxy が CLI から単独起動するケース（プラットフォーム経路: `cmux-team proxy --port`）では:

- `tokenPoolEnabled` の解決はクロージャ束縛で行われるが、`isThrottled5h` を呼ぶには `running` / `bootReady` の状態を知る必要がある。
- daemon 不在のため `running=false` 相当として扱い、結果として `isThrottled5h` は **常に false** を返す。
- レスポンス: `{ throttled: false, pool: null, ... }`（pool フィールドも null で埋める）。

この方針は rev1 から維持。安全側挙動（独立モードでは throttling しない）として明文化。

### 2.9 `daemon.tokenDb` 初期化失敗時の警告【Open Q6】

既存挙動: `main.ts:694-697` で `initTokenDB()` が throw すると `error` ログだけ残して `state.tokenDb=null` のまま起動する。pool ON のつもりだが pool OFF として動作する。

本タスクで追加する仕組み:

1. `main.ts:694-697` の catch 内で:
   - 既存 `await log("error", "initTokenDB failed: ...")` に加え、`await log("warn", "[POOL_DISABLED] tokens.db init failed; pool ON config but running as pool OFF: <reason>")` を 1 行追加。
   - `state.tokenDbInitFailed = true` フラグを立てる（DaemonState に新規追加。`state.tokenDb` の隣）。

2. scanTasks の throttle ログで `state.tokenDbInitFailed` を見て、pool 無効経路に落ちている時に diagnostic を 1 度だけ追加（state に `tokenDbInitFailedLogged: boolean` を持って 1 度きり）:
   ```
   mode=single (pool_intended=on pool_active=off reason=db_init_failed) ...
   ```

これにより `tail -f .team/logs/manager.log` で `[POOL_DISABLED]` を grep するだけで設定意図と挙動の乖離を発見できる。

## 3. 変更箇所一覧

### 3.1 新規ファイル

#### A. `skills/cmux-team/manager/pool-throttle.ts`（新規）

§2.2 / §2.4 / §2.6 の API。

```ts
import type { Database } from "bun:sqlite";
import { canSelectAnyToken, listTokens, getLatestUsageSnapshot, type SelectTokenPolicy } from "./token-store";
import { isStale5h } from "./rate-limit-persistence";
import { THROTTLE_5H_THRESHOLD, type RateLimitInfo } from "./schema";
import type { PerHandleSummary } from "./pool-summary";

export interface ThrottleOpts {
  running: boolean;
  bootReady: boolean;
  policy?: SelectTokenPolicy;
  holder?: string;
}

export function isThrottled5h(
  db: Database | null,
  rl: RateLimitInfo | null,
  opts: ThrottleOpts,
  nowIso: string = new Date().toISOString(),
): boolean { /* §2.2 擬似コード参照 */ }

export function countPoolTokens(
  db: Database,
  policy: SelectTokenPolicy,
  nowIso: string = new Date().toISOString(),
): { enabled: boolean; selectable: number; available: number; total: number; stale: number } { /* §2.6 */ }

export function hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[]): boolean { /* §2.4 */ }
```

#### B. `skills/cmux-team/manager/token-store.ts` への追加（新規 export）

§2.3 の `canSelectAnyToken` を追加し、`selectToken` から admit ループを extract。

```ts
// admit 判定の純粋抽出（lease 取得・スコア計算・候補ソートなし）
function admitCandidates(db, policy, nowIso): Token[] { /* token-store.ts:872-919 を抽出 */ }

export function canSelectAnyToken(
  db: Database,
  holder: string,
  policy: SelectTokenPolicy | string[] = ["any"],
  nowIso: string = new Date().toISOString(),
): boolean {
  const p = normalizePolicy(policy);
  expireLeases(db, nowIso);
  return admitCandidates(db, p, nowIso).length > 0;
}

// selectToken 内部を refactor して admitCandidates 経由に
export function selectToken(...) {
  ...
  const candidates = admitCandidates(db, p, nowIso);
  if (candidates.length === 0) return null;
  // 既存の score 計算とソート、acquireLease
  ...
}
```

`holder` は admit 判定では使わないが（lease 取得しないため）、API consistency のため取る。将来 holder-aware policy を追加する余地を残す。

`selectToken` の振る舞いは行レベルで完全保持。既存 `selectToken` テストはそのまま緑であること（refactoring 検証）。

### 3.2 既存ファイル変更

#### A. `daemon.ts:2730-2742` (scanTasks throttle ガード)【Major #1, #5, Minor #10, #11 対応】

**変更後**:

```ts
const throttled5h = isThrottled5h(state.tokenDb, state.rateLimit, {
  running: state.running,
  bootReady: state.bootPhase === "ready",
  policy: state.poolPolicy ?? undefined,
});
if (throttled5h && allExecutable.length > 0) {
  const util = state.rateLimit?.unified5hUtilization ?? null;
  const reset = state.rateLimit?.unified5hReset ?? null;
  if (state.tokenDb !== null && state.poolPolicy) {
    const c = countPoolTokens(state.tokenDb, state.poolPolicy);
    await log("throttled_rate_limit",
      `mode=pool pool=${c.available}/${c.total} selectable=${c.selectable} stale=${c.stale} 5h_utilization=${fmtPct(util)} threshold=95% reset=${reset ?? "unknown"} skipped_tasks=${allExecutable.length}`);
  } else {
    const intended = state.tokenDbInitFailed ? "(pool_intended=on pool_active=off reason=db_init_failed)" : "";
    await log("throttled_rate_limit",
      `mode=single ${intended} 5h_utilization=${fmtPct(util)} threshold=${THROTTLE_5H_THRESHOLD*100}% reset=${reset ?? "unknown"} skipped_tasks=${allExecutable.length}`);
  }
  return;
}
```

#### B. `proxy.ts:472-509` (`/rate-limit` ハンドラ)【Minor #9 対応で helper 集約 + Minor #8 対応】

**変更後**:

```ts
const db = tokenPoolEnabled ? getTokensDB() : null;
const policy = tokenPoolEnabled ? getCachedPoolPolicy() /* proxy 起動時に束縛 */ : undefined;
const throttled = isThrottled5h(db, rl, {
  running: !!state.running,
  bootReady: state.bootPhase === "ready",
  policy,
});
const poolInfo = (db !== null && policy)
  ? countPoolTokens(db, policy)
  : null;

return new Response(JSON.stringify({
  throttled,
  threshold: THROTTLE_5H_THRESHOLD, // pool 無効時の閾値表示用（既存契約維持）
  unified5hUtilization: rl?.unified5hUtilization ?? null,
  unified5hReset: toEpochSec(rawReset5h),
  unified7dUtilization: rl?.unified7dUtilization ?? null,
  unified7dReset: toEpochSec(rawReset7d),
  unifiedStatus: rl?.unifiedStatus ?? null,
  resetRemaining,
  pool: poolInfo, // §2.6 の 5 フィールド or null
}), { headers: jsonHeaders });
```

独立モード (`opts?.getState` 不在、`proxy.ts:473-485`) は `running=false` 相当で throttle 判定が false に倒れる。`pool` も null 固定。

#### C. `main.ts:2511-2544` (spawn-agent throttle ガード)【Minor #10 対応】

機能は B で自動追従。**ログメッセージのみ pool モード対応に拡張**:

```ts
const poolStr = rl.pool
  ? `mode=pool pool=${rl.pool.available}/${rl.pool.total}`
  : `mode=single`;
const utilStr = rl.unified5hUtilization != null ? `${(rl.unified5hUtilization*100).toFixed(1)}%` : "n/a";
await log("spawn_agent_throttled",
  `conductor=${conductorSurface} role=${role} task_id=${taskId ?? "-"} ${poolStr} util=${utilStr} unified5hReset=${rl.unified5hReset ?? "null"}`);
```

response 型 (`rl: { throttled, unified5hReset, unified5hUtilization, resetRemaining }`) に `pool?: { enabled, selectable, available, total, stale } | null` を追加。

#### D. `daemon.ts:3760-3772` (computeSidebarStatus)【Major #1, #5 対応】

**変更後**:

```ts
const throttled = isThrottled5h(state.tokenDb, state.rateLimit, {
  running: state.running,
  bootReady: state.bootPhase === "ready",
  policy: state.poolPolicy ?? undefined,
});
```

`computeSidebarStatus` の引数型に `tokenDb` / `running` / `bootPhase` / `poolPolicy` を追加（呼び出し元 `daemon.ts:3812` から渡す）。

既存挙動の `state.rateLimit?.unifiedStatus === "rate_limited"` の OR 条件は **pool 無効経路でのみ意味がある** ため、`isThrottled5h` の pool 無効分岐内に取り込む（§2.2 の擬似コードを修正して `unifiedStatus` も見るかを検討）:

```ts
// pool 無効経路: 従来 OR 条件を完全保持
return !isStale5h(rl) &&
  ((rl?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD ||
   rl?.unifiedStatus === "rate_limited");
```

ただし scanTasks 側 (3.2-A) は元から `unifiedStatus` を見ない (`daemon.ts:2730-2742`)。したがって `isThrottled5h` の pool 無効分岐に `unifiedStatus` を入れると scanTasks の挙動が変わる（より厳しく throttle する方向）。**呼び出し元ごとに分岐の意図が違う** ため、`isThrottled5h` には共通の最小判定（`unified5hUtilization >= THROTTLE_5H_THRESHOLD` のみ）を入れ、`computeSidebarStatus` 側で `unifiedStatus === "rate_limited"` の OR を上乗せする:

```ts
// daemon.ts: computeSidebarStatus
const baseThrottled = isThrottled5h(state.tokenDb, state.rateLimit, opts);
const throttled = baseThrottled
  || (state.tokenDb === null && !isStale5h(state.rateLimit) && state.rateLimit?.unifiedStatus === "rate_limited");
```

これで pool 有効時は `unifiedStatus` を見ず（pool が真実）、pool 無効時は既存挙動完全保持。

#### E. `dashboard.tsx:1449-1451` (isThrottled)【Major #1, Minor #6 対応】

**変更後**:

```ts
const isThrottled = !daemon.running || daemon.bootPhase !== "ready"
  ? false
  : daemon.tokenDb !== null && daemon.pool !== null
    ? !hasPoolHeadroomFromSummary(Array.from(daemon.pool.perHandle.values()))
    : !isStale5h(daemon.rateLimit) &&
      (daemon.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;
```

- boot ガードを最上位に移動（`headerSubtitle` の優先度ロジックと整合させる）。
- pool 有効時は純粋関数 `hasPoolHeadroomFromSummary` で判定（SQLite 触らない）。
- pool 有効だが `daemon.pool === null` (refreshPoolSnapshot 失敗 fallback) の場合は **rate-limit 経路にフォールバック**して silent failure を避ける。これは Major #1 の指摘に対する妥協で、daemon 側 (scanTasks / computeSidebarStatus) は `state.tokenDb` を直接見るため正確、dashboard は `pool` summary 経由なので近似値という構造。
- `dashboard-conductor.test.tsx` で `daemon.pool` の有無による分岐を明示テスト。

#### F. `pool-summary.ts:27-78` (`PerHandleSummary` 拡張)【Minor #7 対応】

```ts
export interface PerHandleSummary {
  util5h: number | null;
  util7d: number | null;
  capPct: number | null;
  selectable: boolean; // 新規
}
```

`buildPoolSummary` 内 `perHandle.set(t.handle, { ..., selectable: t.selectable })` を追加。

#### G. `daemon.ts: DaemonState` / `main.ts: 起動時警告`【Open Q6】

**`DaemonState` に追加**:

```ts
interface DaemonState {
  ...
  tokenDb: Database | null;
  tokenDbInitFailed: boolean;        // 新規。pool ON config だが initTokenDB が失敗
  tokenDbInitFailedLogged: boolean;  // 新規。1 度だけ diagnostic を出すための flag
  poolPolicy: SelectTokenPolicy | null; // 新規。pool 有効時のみ非 null
  ...
}
```

**`main.ts:686-703` の修正**:

```ts
const poolDecision = await isTokenPoolEnabled(PROJECT_ROOT);
await log(
  "token_pool_config",
  `enabled=${poolDecision.enabled ? "on" : "off"} source=${poolDecision.source}`,
);
if (poolDecision.enabled) {
  try {
    state.tokenDb = initTokenDB();
    state.poolPolicy = await resolveProjectTokenPool(PROJECT_ROOT);
  } catch (e: any) {
    state.tokenDb = null;
    state.tokenDbInitFailed = true;
    await log("error", `initTokenDB failed: ${e?.message ?? e}`);
    await log("warn",
      `[POOL_DISABLED] tokens.db init failed; pool ON config but running as pool OFF: ${e?.message ?? e}`);
  }
}
```

### 3.3 ガードレール遵守（rev1 から変更なし）

- **空 catch 禁止 / stderr ログ義務**: `pool-throttle.ts` / `token-store.ts: canSelectAnyToken` は I/O は SQLite クエリのみ。`token-store.ts` 既存 API がエラー時に投げるのを呼び元 (proxy / daemon) で `await log("error", ...)` する。新たな空 catch は導入しない
- **EventBus / task-state 直接書き込み禁止**: 本タスクは触らない
- **hook 分岐禁止**: 本タスクは触らない

## 4. テスト戦略

### 4.1 新規テストファイル `pool-throttle.test.ts`

`bun:sqlite` で in-memory DB を作って `tokens` / `usage_snapshots` / `leases` を仕込む単体テスト。

**Reviewer 補強案 B1-B5 を必ず含む**:

| ID | シナリオ | 期待値 |
|---|---|---|
| T1 | pool 有効 + selectable=2 件、両方 util_5h=0.5 | `isThrottled5h=false` |
| T2 | pool 有効 + selectable=2 件、片方 0.5 / 片方 0.96 | `isThrottled5h=false` (1 つでも < 0.95 で OK) |
| T3 | pool 有効 + selectable=2 件、両方 0.96 | `isThrottled5h=true` |
| T4 | pool 有効 + selectable=2 件、両方 stale (recorded_at が 1 時間前) | `isThrottled5h=true` |
| T5 | pool 有効 + selectable=1 件 (snapshot なし) | `isThrottled5h=false` (未使用 = admit) |
| **B1** | **pool 有効 + selectable=0 の唯一 token が `effectiveDefault` と一致 (project default 設定) + util=0.5** | **`isThrottled5h=false`**（default 昇格） |
| **B2** | **pool 有効 + 唯一の selectable token が `policy.exclude` で外れる + util=0.5** | **`isThrottled5h=true`**（false negative 回帰検出） |
| **B3** | **pool 有効 + 唯一の selectable token が lease 中 (leases テーブルに 120s lease)** | **`isThrottled5h=true`** |
| **B4** | **pool 有効 + 唯一の selectable token が util_5h=0.92** | **`isThrottled5h=false`**（90% は OK、95% で初めて NG。閾値整合の回帰検出） |
| **B5** | **pool 有効 + bootReady=false** | **`isThrottled5h=false`**（boot ガード） |
| **B5'** | **pool 有効 + running=false** | **`isThrottled5h=false`** |
| T8 | pool 無効 (`db=null`) + `state.rateLimit.unified5hUtilization=0.95` | `isThrottled5h=true` |
| T9 | pool 無効 + `unified5hUtilization=0.5` | `isThrottled5h=false` |
| T10 | pool 無効 + stale rateLimit (reset 時刻過ぎ) | `isThrottled5h=false` (既存 stale ガード保持) |
| T11 | pool 無効 + `rateLimit=null` | `isThrottled5h=false` |
| T12 | `countPoolTokens`: 3 件 (selectable=true: 0.5 / 0.96 / stale) | `{ enabled:true, selectable:3, available:1, total:3, stale:1 }` |
| T13 | `hasPoolHeadroomFromSummary`: perHandle で selectable=true && util5h=0.5 が 1 件 | `true` |
| T14 | `hasPoolHeadroomFromSummary`: 全件 selectable=false | `false` |

**rev1 の T6 / T7 の再評価**:

- **rev1 T6**「selectable=1 件 0.5 + selectable=0 件 0.5 (selectable=0 は無視) → true」: 方針 (a) 採用後は `canSelectAnyToken` が `effectiveDefault` を見るため、selectable=0 の token が default 一致なら admit される。シナリオを **T6'**「selectable=0 の token が default 一致 + selectable=1 件 0.5 → true（どちらかが admit）」と「T6''」「selectable=0 の token が default **不一致** + selectable=1 件 0.5 → true（selectable=1 で admit）」に分割。default 昇格の動作を明示するため B1 に集約してもよい。
- **rev1 T7**「selectable=0 のみ → false」: 方針 (a) 採用後は `effectiveDefault` の値で結果が変わる。`projectDefault` 不在 + `isOss=false` → false（admit ゼロ）。`projectDefault` 一致 → true（default 昇格 admit）。これらは B1 でカバー。**T7 は廃止**。

### 4.2 既存テストへの追加

- **`token-store.test.ts`**: `canSelectAnyToken` の単体テスト（admit ロジックの直接検証）。`selectToken` の既存テストが行レベルで通り続けることを確認（admitCandidates extract が refactoring であることの検証）。
- **`daemon.test.ts`**: scanTasks throttle ガードの pool ON/OFF 両モードを追加
  - 既存「idle Conductor 不在時は何も変更しない (throttled)」(daemon.test.ts:388 付近) は pool=null 経路として残す
  - 新規: pool 有効 + 全 token に余裕で assignTask が呼ばれる
  - 新規: pool 有効 + 全 token 0.96 で assignTask が **呼ばれない**
  - 新規: `tokenDbInitFailed=true` 時のログ format（`mode=single (pool_intended=on pool_active=off ...)`）
- **`proxy.test.ts`**: `/rate-limit` エンドポイントの pool-aware レスポンス
  - pool 無効 + rateLimit 0.95 → `{throttled: true, pool: null}`
  - pool 有効 + tokens.db に余裕 → `{throttled: false, pool: {enabled:true, selectable:1, available:1, total:1, stale:0}}`（rateLimit が 0.95 でも throttled=false）
  - pool 有効 + tokens.db 全枯渇 → `{throttled: true}`
  - 独立モード（`opts?.getState` 不在）→ `{throttled: false, pool: null}`
- **`dashboard-conductor.test.tsx`** / **`dashboard-pool.test.tsx`**: isThrottled の pool-aware 切り替え
  - `daemon.tokenDb=null` → 既存 rateLimit 判定
  - `daemon.tokenDb!=null && daemon.pool=null` (refreshPoolSnapshot 失敗 fallback) → rateLimit 経路
  - `daemon.pool.perHandle` selectable=true で util5h=0.5 が 1 件 → false
  - `daemon.pool.perHandle` 全部 selectable=true で util5h=0.96 → true
  - `running=false` → false（boot ガード）
  - `bootPhase='starting'` → false
  - **B6 (近似境界)**: `daemon.tokenDb!=null && daemon.pool.perHandle` が selectable=0 のみ + project default が SQLite に設定 → daemon 側は false (default 昇格 admit)、dashboard 側は true (近似で headroom なし)。この乖離を許容するテストとしてコメント明記
- **`pool-summary.test.ts`**: `perHandle.selectable` が listTokens の selectable と一致することを確認

### 4.3 mock 戦略

- `tokens.db`: `bun:sqlite` の `:memory:` で本物を作る。`token-store.ts:initTokenDB` は file path 不要のため簡易 fixture を test util にまとめる（既存 `pool-summary.test.ts` と同パターン）
- `state.rateLimit`: `RateLimitInfoSchema` (schema.ts:317) に従って手書き fixture
- `state.poolPolicy`: テスト fixture で `{ projectTags: ["any"], projectDefault: null, include: [], exclude: [], isOss: false, ossDefault: null }` をデフォルトとして使う util を test util に追加
- proxy: 既存 `proxy.test.ts:1191` の getTokensDB シングルトン破棄パターンを再利用

## 5. エッジケース

| ケース | 振る舞い |
|---|---|
| `tokens.db` 不在 (open 失敗) | §2.9 の経路。`state.tokenDb=null`, `tokenDbInitFailed=true` で運用される。`isThrottled5h` は pool 無効経路に落ちる。warning ログ + diagnostic 1 度きり |
| pool 設定不整合 (`enabled: true` だが tokens.db 空) | `canSelectAnyToken` が candidates ゼロ → throttled=true。これは仕様上正しい（spawn-agent も `selectToken=null` で失敗）。ログで `mode=pool pool=0/0 selectable=0` を残す |
| `usage_snapshots` 空 (起動直後で 1 度も API 呼んでない) | snapshot=null → admit ロジックは util_5h=0 として扱い admit（B5 で別途 boot ガード） |
| `usage_snapshots.util_5h=null` | admit で `?? 0` で fallback → admit |
| stale snapshot のみ | admit で除外 → throttled=true。fallback には**落とさない**（pool 有効時は pool が真実）。次の API 応答で usage_snapshots が更新されるまで待つ。selectToken と整合 |
| `state.tokenDb` の SQLite クエリ失敗 (corrupted DB) | `canSelectAnyToken` が throw。daemon 側は `scanTasks` の既存 try/catch で catch、proxy 側は `fetchHandler` の outer catch で 500。**`pool-throttle.ts` 自体は catch しない**（呼び元の責務） |
| dashboard と daemon で pool 状態が一瞬ズレる | 許容。`refreshPoolSnapshot` は毎 tick 実行され dashboard は次の repaint で同期する |
| dashboard `daemon.pool=null` 時の挙動（refreshPoolSnapshot 失敗） | rate-limit 経路にフォールバック（§3.2-E）。daemon 側 throttle 判定は SQLite 直接で正確 |
| pool ON だが project default が selectable=0 で snapshot 未取得 | `canSelectAnyToken` は default を runtime で候補化、snapshot 未取得は util=0 で admit → throttled=false（B1 派生） |

## 6. 段階分割（実装順序）

### Step 1: テスト先行

1. `pool-throttle.test.ts` を作成し、§4.1 の T1-T5 / B1-B6 / T8-T14 を **赤**で書く（実装前なので import 失敗 OK）

### Step 2: token-store の `canSelectAnyToken` 切り出し（refactor）

2. `token-store.ts` に `admitCandidates` (private) と `canSelectAnyToken` (public) を追加。`selectToken` を `admitCandidates` 経由に refactor
3. **既存 `selectToken` テストが緑のまま** であることを確認（refactoring 検証）。`token-store.test.ts` に `canSelectAnyToken` の単体テストを追加

### Step 3: `pool-summary` 拡張（被影響テスト含む）【Minor #7 対応】

4. **着手前 grep**:
   ```sh
   grep -rn "PerHandleSummary\|perHandle\.set\|perHandle:" skills/cmux-team/manager
   ```
5. `pool-summary.ts: PerHandleSummary` に `selectable: boolean` を追加。`buildPoolSummary` 内で埋める
6. §2.5 で列挙した被影響ファイルすべての fixture / 型 assertion を更新:
   - `pool-summary.test.ts`
   - `pool-header-display.ts` / `pool-header-display.test.ts`
   - `dashboard-conductor.test.tsx`
   - `dashboard-pool.test.tsx`
   - CLI 系 `cli-status-pool.test.ts`
   - `dashboard-metrics-pool-tokens.test.tsx` 系
7. 全部緑になることを確認

### Step 4: `pool-throttle.ts` 実装

8. `pool-throttle.ts` を新規作成。Step 1 のテストが緑になることを確認 (`bun test --timeout 30000 pool-throttle.test.ts`)

### Step 5: daemon の 2 箇所差し替え + DaemonState 拡張

9. `DaemonState` に `tokenDbInitFailed` / `tokenDbInitFailedLogged` / `poolPolicy` を追加（§3.2-G）
10. `main.ts:686-703` の起動シーケンスを §3.2-G に更新（warning ログ追加 + `poolPolicy` 初期化）
11. `daemon.ts: scanTasks` (§3.2-A) と `computeSidebarStatus` (§3.2-D) を `isThrottled5h` 経由に置換。`computeSidebarStatus` の引数型に `tokenDb` / `running` / `bootPhase` / `poolPolicy` を追加。`unifiedStatus === "rate_limited"` の OR は `computeSidebarStatus` 側で上乗せ（§3.2-D 末尾参照）
12. `daemon.test.ts` の throttle 系テスト追加

### Step 6: proxy の `/rate-limit` 拡張【Minor #9 で helper 集約後】

13. `proxy.ts: /rate-limit` (§3.2-B) を `isThrottled5h` 経由に変更し `pool` フィールドを追加。proxy 起動時に policy をクロージャ束縛
14. `proxy.test.ts` に pool-aware ケースと独立モードケースを追加

### Step 7: spawn-agent ログ拡張【Minor #10 対応】

15. `main.ts: cmdSpawnAgent` (§3.2-C) のログメッセージに `mode=pool pool=N/M` / `mode=single` を追加。response 型に `pool` を追加

### Step 8: dashboard.tsx【Minor #6 対応】

16. `dashboard.tsx: isThrottled` (§3.2-E) を pool-aware に切り替え。boot ガードを最上位に移動。`hasPoolHeadroomFromSummary` を import
17. `dashboard-conductor.test.tsx` / `dashboard-pool.test.tsx` でテスト追加

### Step 9: 結合テスト

18. CLAUDE.md ガイダンス（`bun test` 全体実行禁忌）に従い個別実行:
   ```sh
   cd skills/cmux-team/manager && for f in pool-throttle.test.ts token-store.test.ts pool-summary.test.ts pool-header-display.test.ts daemon.test.ts proxy.test.ts dashboard-pool.test.tsx dashboard-conductor.test.tsx; do bun test --timeout 30000 "$f"; done
   ```
19. 手動 e2e: pool 有効プロジェクト (`tokens.db` に 2 token) で 1 token を 96% に寄せて、scanTasks が assign を続けること、dashboard ヘッダーが ⏸ にならないこと、`spawn_agent_throttled` が `mode=pool pool=1/2` で残ることを確認

### Step 10: 仕様反映【Open Q4】

20. `docs/spec/09-token-pool.md` に pool-aware throttle の節を追加:
    - pool ON/OFF 別の判定ソース（`state.tokenDb`）
    - pool 有効時の判定が `canSelectAnyToken` を `selectToken` と共有することで構造的に整合性を保証している点
    - stale 扱い、`/rate-limit` の `pool` フィールド schema
    - `tokenDbInitFailed` 時の挙動（pool OFF 相当 + warning ログ）

## 7. 参考: 既存ファイル / 行番号サマリ

| 役割 | パス:行 |
|---|---|
| `THROTTLE_5H_THRESHOLD = 0.90` | `schema.ts:347` |
| `RateLimitInfo` Zod schema | `schema.ts:317-342` |
| `isStale5h` | `rate-limit-persistence.ts` |
| `state.tokenDb` 定義・初期化 | `daemon.ts:128`, `daemon.ts:387`, `main.ts:683-703` |
| `state.pool` / `refreshPoolSnapshot` | `daemon.ts:130-134`, `daemon.ts:406-417` |
| `buildPoolSummary` / `PerHandleSummary` | `pool-summary.ts:27-100` |
| `listTokens(db, {selectableOnly})` | `token-store.ts:338-347` |
| `getLatestUsageSnapshot` | `token-store.ts:488-498` |
| `selectToken` / admit ループ (`> 0.95` 閾値) | `token-store.ts:847-932`（admit 部 872-919）|
| `SelectTokenPolicy` | `token-store.ts:790-797` |
| `normalizePolicy` | `token-store.ts:799-822` |
| `acquireLease` / `expireLeases` | `token-store.ts:514-560` |
| `isTokenPoolEnabled` (3 階層解決) | `config.ts:477-485` |
| `resolveProjectTokenPool`（policy 取得想定） | `config.ts`（要確認、Step 5 着手時に実機特定） |
| scanTasks throttle ガード (A) | `daemon.ts:2730-2742` |
| `/rate-limit` ハンドラ (B) | `proxy.ts:472-509` |
| spawn-agent throttle ガード (C) | `main.ts:2511-2544` |
| computeSidebarStatus (D) | `daemon.ts:3740-3772` |
| dashboard isThrottled (E) | `dashboard.tsx:1449-1463` |
| `tokenPoolEnabled` クロージャ束縛 (proxy) | `proxy.ts:407-409` |
| `getTokensDB()` シングルトン | `proxy.ts:34-50` |
| `dashboard.tsx` で `daemon.tokenDb` を直接見る前例 | `dashboard.tsx:2082` |
