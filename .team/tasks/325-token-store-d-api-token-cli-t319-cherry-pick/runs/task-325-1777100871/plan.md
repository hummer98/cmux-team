# T325 実装計画書 — token-store.ts D 系列 API + token-cli.test.ts cherry-pick (rev2)

## 0. ゴールと scope

T319 並行実装の abort worktree (`.worktrees/task-319-1777097734`) から、**main で不足している 2 点だけ** を取り込む:

1. `skills/cmux-team/manager/token-store.ts` に `deleteToken` / `updateTokenAuth` / `updateTokenPlan` の 3 関数を追加し、対応する unit test 11 ケースを `token-store.test.ts` に追記する
2. `skills/cmux-team/manager/token-cli.test.ts` を新規作成し、abort 版 56 テストのうち **main の token-cli.ts API 形状で実装可能なもの** を移植する

main の `token-cli.ts` / `proxy/*` (T320) / `spawn-agent` (T321) は一切変更しない（Option C）。`auth_hash` は main の 12 文字 prefix 仕様を維持する（abort 版の 64 hex に変更しない）。

非ゴール: T320 / T321 / TUI / Manager の token 統合・並列処理改修などは本タスクの範囲外。

### 検証基準の更新（rev2）

design-review §1 で指摘された通り、task.md の「token-cli.test.ts が **50 ケース以上 pass**」要件は Option C と物理的に矛盾する（移植可能 ~13–15 件、不能 ~36+ 件）。本 plan では新基準を以下に下方修正する:

- **最低 12 ケース pass**（必須）
- **推奨 15 ケース以上**（add 5 / list 2 / remove 2 / rotate 1 / set-plan 3 + 任意の補強分）
- **移植不能テストは全件 inline コメントで skip 理由を記録**（後段で reviewer が独立検算可能にする）

この差分は Conductor が summary.md / 完了レポートで Master へ明示エスカレーションする。plan 内では §3 検証計画にも新基準を直書きする。

---

## 1. Diff 解析

### 1.1 token-store.ts (D 系列 3 関数の追加分)

abort 版 `token-store.ts:343-379` に存在し、main 版にない関数:

| 関数 | シグネチャ | 役割 |
|------|-----------|------|
| `deleteToken(db, token_id)` | `(Database, number) => void` | tokens / usage_snapshots / leases から token_id 一致を **1 transaction で 3 テーブル削除**。冪等。Keychain は対象外（呼び出し側責務） |
| `updateTokenAuth(db, token_id, new_auth_hash)` | `(Database, number, string) => void` | `auth_hash` 列のみ更新。rotate の補償 tx 双方向で利用 |
| `updateTokenPlan(db, token_id, plan, plan_ratio)` | `(Database, number, TokenPlan, number\|null) => void` | `plan` / `plan_ratio` のみ更新。`selectable` / `tags` / `handle` / `organization_id` / `auth_hash` は維持 |

main 版は **既存 schema に CASCADE 制約なし** (token-store.ts:111-146 確認済み)。`leases.token_id` / `usage_snapshots.token_id` は `REFERENCES tokens(id)` だが `ON DELETE CASCADE` 句は付いていないため、`deleteToken` の transaction 内で 3 テーブルを明示削除する abort 版実装が必須。

abort 版 `deleteToken` は **削除順序** が `leases → usage_snapshots → tokens` で foreign_keys=ON 下でも安全（子から親）。これをそのまま採用する。

main 版にはすでに以下が **追加で存在** するが本タスクでは触れない:
- `getTokenByAuthHash` (line 325)
- `releaseLeaseByHolder` (line 457) ← T321
- `selectToken` (line 665) ← T321

### 1.2 abort 版 token-cli.test.ts のテストグループ列挙

| describe ブロック | テスト数 | main API での移植可否 |
|------|----:|------|
| `validateAndNormalizeHandle` | 11 | ✗ pure function が main に **export されていない**。main は inline で sanitize する。→ 削除 |
| `rateLimitTierToPlan` | 4 | ✗ 同上。main は `PLAN_MAP` 定数で表引きするが export なし。→ 削除 |
| `parseCredentialFile` | 5 | ✗ 同上。main は `readClaudeCredentials` (private) で読む。→ 削除 |
| `hashAuthorization` | 2 | ✗ 同上。main は `computeAuthHash` (private、12 文字 prefix) を使う。仕様も異なる（full 64 hex vs 12 文字 prefix）。→ 削除 |
| `formatNextReset` | 6 | ✗ 同上。main は `formatReset` (private、近い方の 1 件を `5h@/7d@` 形式) を使う。→ 削除 |
| `formatTokenListRow` | 4 | ✗ 同上。main は `cmdTokenList` 内で直接 padEnd する。→ 削除 |
| `formatTokenListTable` | 1 | ✗ 同上。→ 削除 |
| `resolveTokenInput` | 4 | ✗ 同上。→ 削除 |
| `cmdTokenAdd` (integration) | 7 | △ 5 件移植可能、2 件 skip（tags=auto / Keychain 失敗補償 tx） |
| `cmdTokenList` | 2 | ○ 2 件移植可能 |
| `cmdTokenRemove` | 2 | ○ 2 件移植可能 |
| `cmdTokenRotate` | 3 | △ 1 件移植可能（credential 再取得で auth_hash 更新）。org_id 不一致 / Keychain 失敗 旧 hash 復元は skip |
| `cmdTokenSetPlan` | 3 | ○ 3 件移植可能 |
| `cmdToken` dispatcher | 2 | ✗ main に dispatcher 関数なし。→ 削除 |

**移植可能なテスト数の見積もり: 13 件（add: 5 / list: 2 / remove: 2 / rotate: 1 / set-plan: 3）。** abort 版 56 件、検証計画の「50 件以上 pass」目標は §0 の通り **12 件以上 + skip 理由 inline コメント** に下方修正済み。

### 1.3 main 版 token-cli.ts の公開関数シグネチャ → abort 版 test の書き換え方針

main 版 export (`token-cli.ts:117 / 237 / 308 / 351 / 404`):

```ts
export async function cmdTokenAdd(): Promise<void>;       // 引数なし、process.argv 直読み、readline 対話
export async function cmdTokenList(): Promise<void>;      // 引数なし
export async function cmdTokenRemove(): Promise<void>;    // process.argv[4] = handle
export async function cmdTokenRotate(): Promise<void>;    // process.argv[4] = handle
export async function cmdTokenSetPlan(): Promise<void>;   // process.argv[4] = handle, [5] = plan
```

abort 版 test の改造点:

| abort 版 | main API での書き換え |
|---|---|
| `cmdTokenAdd([...], { ask })` | `process.argv = ["bun", "cli", "token", "add"]` + `mock.module("readline", ...)` で `createInterface().question` を順次回答するモックに差し替え |
| `cmdTokenRemove(["remove", "@rm", "--yes"])` | `process.argv = [..., "remove", "@rm"]` + readline mock で `"y"` を回答（main は `--yes` フラグ非対応） |
| `cmdTokenRotate(["rotate", "@rot", "--source", "credentials", "--credentials-path", credPath, "--yes"])` | main の rotate は credentials-path 指定不可、`readClaudeCredentials()` が `~/.claude/.credentials.json` 固定。test は `process.env.HOME = tmpDir` 上書きで credentials.json を仕込む。`os.homedir()` は POSIX (macOS 含む) で `HOME` env が定義されていれば必ず尊重するため素直に動く（後述 §2-A 注記） |
| `cmdTokenSetPlan(["set-plan", "@sp", "max-x20"])` | `process.argv[4] = "@sp"`, `process.argv[5] = "max-x20"` |
| `__setKeychainTestFailureMode(true)` | main に該当フックなし → 該当テストは **skip + inline 理由コメント** |
| `cmdToken(["token", "what"])` (dispatcher) | main に dispatcher なし → **テスト削除**（switch は `main.ts` 側にあるため別途 main.ts のテストが必要だが本タスク範囲外） |
| organization_id 取得 | abort 版は credential ファイルの `organizationId` を読む。**main は API probe (`probeOrganizationId`)** で `https://api.anthropic.com/v1/models` を叩いて `anthropic-organization-id` ヘッダから取得する → test では `globalThis.fetch` を try/finally で関数毎に上書きし、ヘッダ付きレスポンスを返す |

---

## 2. 実装ステップ (TDD 順序)

### Step 0 — 検証基準の Master エスカレーション（着手前）

Conductor は本 plan 着手前に summary 雛形 / 開始ログで以下を Master 報告する:

> task.md §検証基準 「token-cli.test.ts が 50 ケース以上 pass」は Option C 制約（main の token-cli.ts 不変）と物理的に矛盾するため、**「最低 12 ケース pass + 移植不能分の skip 理由を全件 inline コメントで記録」** に下方修正する。詳細は plan §0 / §4 R1 参照。

合意後に Step 1 へ進む（合意プロセス自体は Conductor の進行管理ロジックで担保）。

### Step 1 — token-store.ts に D 系列 3 関数を追加

**1-A. RED**
- `token-store.test.ts` の末尾（`computePoolCapacity` の前または後）に **新 describe ブロック 3 つ** を追加:
  - `describe("deleteToken (T319)", ...)` — 4 ケース
  - `describe("updateTokenAuth (T319)", ...)` — 4 ケース
  - `describe("updateTokenPlan (T319)", ...)` — 3 ケース
- abort 版 test (token-store.test.ts:308-427) からそのまま copy してよいが、import 行の `deleteToken / updateTokenAuth / updateTokenPlan` を main の `import` 文に追記する。
- **数のカウント**: タスク要求は 11 ケース。abort 版 §"deleteToken (T319)" 3 + §"updateTokenAuth (T319)" 3 + §"updateTokenPlan (T319)" 3 = **9 ケース**。残り 2 ケースは以下を補強する（design-review §5 反映）:
  1. `deleteToken: leases / usage_snapshots の片方が空でも tokens 行は削除される` ← 部分状態の冪等性を担保
  2. `updateTokenAuth + getTokenByAuthHash の整合性` ← `updateTokenAuth` で書いた値が `getTokenByAuthHash` で正しく検索できる往復確認（main の `getTokenByAuthHash` は token-store.ts:325 で既存 export）
- `bun test skills/cmux-team/manager/token-store.test.ts` を実行 → 11 件すべて RED（関数未定義で `import` 失敗）。

**1-B. GREEN**
- `token-store.ts` の **`listTokens` 直後** (line 341 付近) に abort 版 (line 343-379) から **D 系列 3 関数をそのまま copy**。
  - JSDoc コメントもそのまま copy（CASCADE 未設定の根拠 / 冪等性 / Keychain 別系統など）。
  - `TokenPlan` 型は既存 export されているのでそのまま参照。
- `bun test skills/cmux-team/manager/token-store.test.ts` を再実行 → 全件 GREEN。
- `bunx tsc --noEmit` でエラーがないことを確認。

**1-C. REFACTOR**
- 不要。abort 版実装は trace-store / gh-cache-store と同形のため、main のスタイルに既に揃っている。

### Step 2 — token-cli.test.ts を新規作成

**2-A-Pre. mock hoisting 検証**（design-review §6 反映）

`bun:test` の `mock.module` は **ファイル top-level で実行された場合のみ後続 import に反映される**。describe 内で install すると、token-cli が import 済みの `createInterface` シンボルを掴んでいるため効かない可能性がある。残り全ケースを量産する前に、**1 ケースだけ書いて RED → GREEN を回し、readline mock が確かに効いていることを確認**する:

1. `cmdTokenList` の「0 件は案内文が出る」1 ケースだけ先に実装（readline は不要だが、`process.argv` / `process.exit` / `console` mock の素振りになる）
2. 続けて `cmdTokenAdd` の「manual 経路成功」1 ケースを実装し、readline mock の hoisting が効くことを確認
3. ここで失敗するなら DI 化（token-cli.ts に readline を引数で受け取る overload を追加）または HOME + tty 別経路へのフォールバックを検討（→ Option C 抵触の可能性があるため Master / Conductor へ判断要請）

**2-A. RED**
- `skills/cmux-team/manager/token-cli.test.ts` を新規作成。
- 構成（移植可能なものだけ）:

```ts
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test";
// 一時 DB / Keychain test mode / process.argv / process.exit / console / fetch / readline をすべて差し替える共通 setup

describe("cmdTokenAdd (integration)", () => {
  test("credentials 経路成功 → DB / Keychain に登録される (org_id は probe 結果)", ...);
  test("organization_id を probe できないと exit 1", ...);  // probeOrganizationId が null を返す mock
  test("organization_id 重複は exit 1 (rotate を使えと案内)", ...);
  test("handle 重複は exit 1", ...);
  test("manual 経路成功 (readline で token 貼り付け)", ...);
  test.skip("tags=auto 警告: main に該当ロジックなし", ...);
  test.skip("Keychain 失敗 → DB 巻き戻し: main に補償 tx 未実装 (R3)", ...);
});
describe("cmdTokenList (integration)", () => {
  test("3 件表示 (max-x20 健全 / max-x5 利用率高 / unknown plan snapshot 無し)", ...);
  test("0 件は案内文が出る", ...);
});
describe("cmdTokenRemove (integration)", () => {
  test("y 確認で DB と Keychain の両方から消える", ...);
  test("不存在 handle は exit 1", ...);
});
describe("cmdTokenRotate (integration)", () => {
  test("credential 再取得で auth_hash と Keychain が更新される (12 文字 prefix を維持)", ...);
  test.skip("organization_id 不一致は exit 1: main rotate に org_id check 未実装 (R2)", ...);
  test.skip("Keychain 失敗 → 旧 auth_hash 復元: main に補償 tx 未実装 (R3)", ...);
});
describe("cmdTokenSetPlan (integration)", () => {
  test("unknown plan を max-x20 に更新", ...);
  test("不正な plan 名は exit 1", ...);
  test("不存在 handle は exit 1", ...);
});
```

合計 **13 ケース active + 4 ケース skip（理由 inline 記載）**。新基準（最低 12 / 推奨 15 件）に対し active 13 ケースで最低基準を超え、推奨基準には未達。design-review §4 で言及された再見積もり結果に整合。

- **モック戦略** (要点):
  - **DB**: `process.env.TOKEN_STORE_DB_PATH = join(mkdtempSync(...), "tokens.db")` で一時ファイル。`HOME` も同一 tmp に向けて固定する（後述 credentials.json 配置のため）。
  - **Keychain**: `process.env.KEYCHAIN_TEST_MODE = "1"` で in-memory モードを使う（`token-store.ts:485-497` の経路）。各テスト前に `__resetInMemoryKeychainForTest()` を呼ぶ。
  - **readline**: ファイル top-level で `mock.module("readline", () => ({ createInterface: () => ({ question: (q, cb) => cb(askAnswers.shift() ?? ""), close: () => {} }) }))` を install。`askAnswers` は module スコープの配列で、各テストの先頭で `askAnswers.length = 0; askAnswers.push(...)` と詰め替える。Step 2-A-Pre で hoisting が効くことを確認済みであることが前提。
  - **fetch (probeOrganizationId)**: **関数毎に try/finally で `globalThis.fetch` を退避・復元** する pattern を採用（design-review §8 反映）:
    ```ts
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { headers: { "anthropic-organization-id": "org-test-1" } });
    try { await cmdTokenAdd(); } finally { globalThis.fetch = orig; }
    ```
    `mock.module` は **使わない**（R5 hoisting 問題を増やすため）。null 経路は `headers: {}` で再現。
  - **process.exit**: `process.exit = ((code?: number) => { throw new Error("__test_exit_" + code); }) as never` で例外化（abort 版と同じパターン）。`afterEach` で原状復帰。
  - **process.argv**: **beforeAll で `originalArgv = process.argv.slice()` を保存し、afterEach で `process.argv = originalArgv.slice()` で完全置き換え**（design-review §7 反映）。要素を push/pop ではなく、毎回フルリセット。各テストの先頭で `process.argv = ["bun", "cmux-team", "token", <sub>, ...rest]` をセット。main の `getHandleArg()` は `process.argv[4]` を読む (`token-cli.ts:442-450`)。
  - **credentials.json (rotate 経路)**: main の `readClaudeCredentials()` は `~/.claude/.credentials.json` 固定 (`token-cli.ts:55`)。Node.js / Bun の `os.homedir()` は **POSIX (macOS 含む) 上で `HOME` env が定義されていれば必ず尊重する**（無定義時のみ `getpwuid_r` フォールバック）。よって `process.env.HOME = tmpDir` 上書き → `tmpDir/.claude/.credentials.json` を書き出す方式で素直に動く。`afterEach` で `process.env.HOME` を元に戻す。
    - **副作用回避を最優先する場合の代替経路**: rotate テストは手動入力経路（readline mock 一本で credential 全項目を回答）に統一し、credentials.json 配置自体を行わない選択肢も残す（実装時に Implementer が判断）。

**2-B. GREEN**
- 各 mock を `beforeEach` で setup, `afterEach` で原状復帰（`process.argv` / `process.exit` / `process.env` / `globalThis.fetch` / mocked module 内部状態をすべて復元）。
- `bun test skills/cmux-team/manager/token-cli.test.ts` を実行 → active 13 件 GREEN、skip 4 件は理由コメント付きで stable。
- regression 確認のため `bun test` 全体実行 → 既存 (token-store / proxy / spawn-agent / manager) が壊れていないこと。

**2-C. REFACTOR**
- 共通 helper (例: `setupTestEnv()` / `teardownTestEnv()` / `setReadlineAnswers(...)` / `withMockedFetch(orgId, fn)`) をテストファイル先頭にまとめる。
- 各テストの **why コメントは最小限**（同種の why は 1 箇所にまとめる）。skip 理由コメントだけは個別記載（reviewer の独立検算用）。

---

## 3. 検証計画

| 項目 | コマンド | 期待 |
|------|----------|------|
| D 系列テスト pass | `bun test skills/cmux-team/manager/token-store.test.ts -t "T319"` | 11 件 pass（既存 49 件含めて 60 件） |
| token-cli.test.ts pass | `bun test skills/cmux-team/manager/token-cli.test.ts` | **active 13 件 pass + skip 4 件 stable**（最低 12 件基準を満たす。skip 理由は §4 R1〜R3 を inline 引用） |
| 全テスト regression | `bun test` | 既存 pass 数 ≦ 新規 pass 数（既存が壊れていない） |
| 型チェック | `bunx tsc --noEmit` | エラー 0 件 |
| 機能検証 (手動 1): remove 後の orphan なし | `cmux-team token add @pers ...` → `upsertUsageSnapshot` で usage 行 + `acquireLease` で lease 行を作る → `cmux-team token remove @pers` 後に `sqlite3 ~/.cmux-team/tokens.db "SELECT COUNT(*) FROM usage_snapshots; SELECT COUNT(*) FROM leases"` | 両方 0 件（main の `cmdTokenRemove` は line 331-333 で手動 DELETE するため CASCADE 不要） |
| 機能検証 (手動 2): rotate で auth_hash 更新 | `cmux-team token rotate @pers` 後に `sqlite3 ~/.cmux-team/tokens.db "SELECT auth_hash FROM tokens WHERE handle='@pers'"` を rotate 前後で比較 | 値が変わっており、長さ 12 文字 hex prefix のまま |
| 機能検証 (手動 3): remove → 即 add 同 handle | Keychain test mode で `cmux-team token remove @pers` → `cmux-team token add @pers ...` を続けて実行 | 後続 add が **handle 衝突せず成功**（Keychain 残骸なし、design-review §残リスク反映） |

> **検証基準の更新（rev2 / Conductor 判断）**: token-cli.test.ts の pass 件数は **最低 12 件、推奨 15 件以上 + 移植不能テストの skip 理由を全件 inline コメントで記録**。abort 版 56 件目標は Option C と物理的に矛盾するため下方修正済み（§0 / §4 R1）。本下方修正は Conductor が summary.md / 完了レポートで Master へ明示エスカレーションする。

> **D 系列 3 関数の production consumer**: main の `cmdTokenRemove` は `deleteToken()` を**呼ばず**直接 SQL を 3 連発で発行しているため、本タスクで `deleteToken` を追加しても CLI 経由の挙動は変わらない（CLI は変更禁止のため）。`deleteToken` 追加の意義は **将来の Manager / TUI / 補償 tx で再利用するための土台**であって、即座に CLI が consumer になるわけではない。配線は §5 完了条件に記載のフォローアップタスクで行う。

---

## 4. リスク・注意点

### R1. token-cli.test.ts の 50 件目標は到達不能（rev2 で確定下方修正済み）

abort 版 56 テストのうち約 **36 件は main に対応する export / フックがない pure function / dispatcher / Keychain failure injection のテスト** であり、**main の token-cli.ts を変更禁止**である以上 1 件も移植できない。実装可能なのは integration の **約 13 件** のみ（add: 5 / list: 2 / remove: 2 / rotate: 1 / set-plan: 3）。

選択肢の評価結果:
- **(A) 13 件で確定、§3 検証計画の "50 件以上" 目標は **「最低 12 件、推奨 15 件以上 + skip 理由全件記録」** に下方修正**（**採用**）
- **(B) main の token-cli.ts に pure function 追加 export を許可（CLI 動作不変）** → 不採用（タスク制約「main の token-cli.ts は変更禁止」を緩める必要があるため）
- **(C) Option C を撤回し abort 版の token-cli.ts ごと取り込む** → 不採用（T320 / T321 が main 版 API を前提に書かれており、現実的でない）

**Conductor は本下方修正を summary.md / 完了レポートで Master へ明示エスカレーションする**（plan §0 / Step 0 参照）。reviewer に対しては §R1〜R3 の skip 理由 inline コメントで独立検算可能にする。

### R2. main rotate の organization_id 不一致チェックは存在しない

abort 版 test "rotate: organization_id 不一致は exit 1" は移植不能。main の `cmdTokenRotate` (`token-cli.ts:351-398`) は credential を再取得して `auth_hash` を上書きするだけで、`organization_id` の整合性検証ロジックを持たない。**本タスクでは追加しない**（rotate の挙動を変える = main 変更禁止に抵触）。テスト側に `test.skip("...; main rotate に org_id check 未実装のため移植不能 (R2)")` で skip + 理由コメントを残す。

### R3. main rotate / add の Keychain 失敗時 補償 tx が存在しない

abort 版 test 2 件 (`add: Keychain 失敗 → DB 巻き戻し` / `rotate: Keychain 失敗 → 旧 auth_hash 復元`) は **main に補償 tx が実装されていない**ため移植不能。skip + 理由コメント残し（R3 引用）。

将来 Manager / spawn-agent の token 利用が広がれば「Keychain は更新成功 / DB は失敗（or 逆）」で auth_hash と Keychain の中身が乖離する事故が起こり得るため、フォローアップタスク `T319 補償 tx 追加` の起票を §5 で推奨する。

### R4. fetch mock の影響範囲

`globalThis.fetch` を直接上書きすると、同一 worker で並走する他 test (token-store / proxy / spawn-agent) に副作用が出る恐れ。bun-test は describe 単位で worker isolation するため通常は問題ないが、念のため **関数毎に `try/finally` で `const orig = globalThis.fetch; ... finally globalThis.fetch = orig` を必ず入れる**（design-review §8 反映）。`mock.module` での fetch 差し替えは hoisting 問題（R5）を増やすため使わない。

### R5. readline モックの module キャッシュと hoisting

`bun:test` の `mock.module` は **ファイル先頭（top-level）で実行された場合のみ、後続の `import { cmdTokenAdd } from "./token-cli"` がモック版 readline を見られる**。describe 内で install すると、token-cli が import 済みの `createInterface` シンボルを掴んでいるため効かないケースがある。

対策:
1. `mock.module("readline", ...)` は **必ずファイル top-level で 1 回だけ install**
2. closure で `askAnswers: string[]` を mock 内から参照させ、各テストで配列を詰め替える:

```ts
const askAnswers: string[] = [];
mock.module("readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(askAnswers.shift() ?? ""),
    close: () => {},
  }),
}));
beforeEach(() => { askAnswers.length = 0; });
```

3. Step 2-A-Pre で 1 ケース RED → GREEN を素早く回し、hoisting が効くことを実機確認してから残りを量産する（design-review §6）。

### R6. helper / fixture の存在確認

abort 版テストで使われているヘルパは:
- `mkdtempSync` / `rmSync` / `writeFileSync` / `tmpdir` / `join` ← 標準ライブラリ。main 側にも問題なく存在
- `__resetInMemoryKeychainForTest` ← main の `token-store.ts:733` に export 済み
- `__setKeychainTestFailureMode` ← **main の token-cli.ts に存在しない**。R3 と同じく該当テストは skip

### R7. auth_hash の差異

main の `computeAuthHash` (`token-cli.ts:34-36`) は `sha256("Bearer " + token).slice(0, 12)` で **12 文字 prefix**。abort 版 test は `expect(auth_hash).toMatch(/^[a-f0-9]{64}$/)` を期待するため、移植時は **`/^[a-f0-9]{12}$/` に書き換え**る。これは「auth_hash 形式は main 仕様維持」の制約に整合。

### R8. process.argv 復旧漏れ

各 test は `process.argv` を直接書き換えるため、**`beforeAll` で `originalArgv = process.argv.slice()` を保存し、`afterEach` で `process.argv = originalArgv.slice()` の完全置き換え**（要素入れ替えではなく fresh copy 代入）を統一スタイルにする（design-review §7）。失念すると後続テストが意図しない handle / plan を読む。

### R9. (新規 rev2) credential_source 列の整合

main の `cmdTokenAdd` は `credential_source` 列に `"claude-credentials" | "manual"` を保存（`token-cli.ts:222`）。abort 版 test の expectation は `"credentials"` 等の別名を期待する箇所がある可能性が高い。Implementer は **abort 版 test を移植する際、`credential_source` の文字列を main 仕様に合わせて書き換える**（R7 の auth_hash 同様の対症処理）。具体的には:

- credentials.json 経路: `expect(...).toBe("claude-credentials")`
- manual 経路: `expect(...).toBe("manual")`

### R10. (新規 rev2) cmdTokenRemove の Keychain 削除タイミング

main の `cmdTokenRemove` は DB 削除 **後** に `deleteTokenFromKeychain(handle)` を呼ぶ（`token-cli.ts:333 → 337`）。途中失敗時の挙動（DB は削除済み / Keychain は残存 → 次回 add で同 handle が衝突するリスク）は test では網羅しない（補償 tx 不在 = R3）が、**§3 手動検証 #3 に「Keychain test mode で remove → 即 add 同 handle が成功する」を 1 ケース追加**して、最低限の整合性確認を行う。

### R11. (新規 rev2) D 系列関数の production consumer 不在

`grep deleteToken/updateTokenAuth/updateTokenPlan skills/cmux-team/{manager,proxy}/*.ts` で確認した結果、main の `manager/` および `proxy/` 配下に呼び出し箇所は 0 件。今回追加する 11 件のテストは関数の単体動作を保証するが、実運用で呼ばれない関数は将来の規約変更で削除されやすい。**フォローアップタスク `T319 D系列を cmdTokenRemove に配線` を §5 完了条件で起票する**ことで dead code 化リスクを管理する（Option C 制約のため本タスクでは配線しない）。

---

## 5. 最終成果物

- `skills/cmux-team/manager/token-store.ts`: `deleteToken` / `updateTokenAuth` / `updateTokenPlan` の 3 関数追加（約 +40 行）
- `skills/cmux-team/manager/token-store.test.ts`: 11 ケース追記（約 +120 行）
- `skills/cmux-team/manager/token-cli.test.ts`: 新規作成、**active 13 ケース + skip 4 ケース**（理由 inline 記載）（約 +400–600 行）
- main の `token-cli.ts` / `proxy/*` / `spawn-agent` への変更: **0 件**

完了条件:
1. `bun test skills/cmux-team/manager/token-store.test.ts` で全件 pass（既存 + 新規 11）
2. `bun test skills/cmux-team/manager/token-cli.test.ts` で **active 13 件 pass + skip 4 件 stable**（最低 12 件基準を満たす。件数は §4 R1 の新基準で確定、Conductor が summary.md で Master へエスカレーション済み）
3. `bun test` 全体で regression 0 件
4. `bunx tsc --noEmit` でエラー 0 件
5. 手動検証 §3 の orphan / auth_hash 更新 / remove → 即 add の 3 ケースが確認済み
6. **フォローアップタスク `T319 D系列を cmdTokenRemove に配線する` を本タスク完了後に起票する**（dead code 化対策、design-review §2 反映）。本タスクの finish/abort いずれの場合でも、Conductor が summary.md に follow-up 起票指示を含めて Master へ報告する。
7. **（推奨）フォローアップタスク `T319 補償 tx 追加` を起票**（add / rotate の Keychain 失敗時 DB 巻き戻し / 旧 hash 復元、R3 反映）。本タスクの範囲外だが Manager / spawn-agent の token 利用拡大を見据えて推奨。

---

## 6. 実装上のヒント (Implementer 向けメモ)

- abort 版 D 系列 3 関数は **そのまま copy で動く**（main schema が同じ、CASCADE なしも同じ、TokenPlan 型も同じ）。**変更不要**。
- abort 版 test 11 ケースのうち 9 ケースは abort 版から copy。残り 2 ケース（補強分）は §1.1 候補 1（`deleteToken` 部分状態冪等性）と候補 2（`updateTokenAuth + getTokenByAuthHash` 整合性）を採用。
- token-cli.test.ts の最低限のテンプレートは abort 版 test の `describe("cmdToken* (integration)", ...)` ブロック (`token-cli.test.ts:481-1101`) を出発点とし、API 形状を main に合わせて書き換える。pure function 系の describe ブロック (上の §1.2 で × の行) は **丸ごと削除**して構わない。
- mock 戦略は §2-A の「モック戦略」を厳守。とくに **fetch / readline / process.exit / process.argv / process.env の 5 軸復旧** は test 安定性の要。
- **Step 2-A-Pre の hoisting 検証は省略禁止**（design-review §6）。全 13 ケース実装後に「実は readline mock が効いてなかった」と発覚すると後戻りが大きい。
- skip ケース 4 件は `test.skip(name, fn)` で残し、**name に R2 / R3 など §4 のリスク番号を引用**する（reviewer が独立検算しやすくする）。
- `credential_source` の文字列（R9）と `auth_hash` の長さ regex（R7）は abort 版 test 移植時の **二大書き換えポイント**。Implementer は移植開始前に grep で全箇所を洗い出すこと。
