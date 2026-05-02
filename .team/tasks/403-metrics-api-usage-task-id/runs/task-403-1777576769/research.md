# T403 Research: api_usage.task_id 全件 NULL の根本原因

## 1. 概要

`api_usage.task_id` が全件 NULL になっている根本原因は、**`x-cmux-task-id` ヘッダを注入する仕組みが完全に未実装**である点にある。`proxy.ts:738` は `req.headers.get("x-cmux-task-id") || opts?.taskId` の 2 経路を期待するが、**どちらも main.ts 側で値が供給されていない**（ヘッダは inject されず、`startProxy` の opts にも `taskId` が渡されない）。`SKILL.md` および `runtime-backend.ts` のコメントには「`x-cmux-task-id` を inject する」と書かれているが、実装が伴っていない。実測では `api_usage` 13,885 行のうち task_id NULL = 13,885 件 / surface NULL = 11,129 件 / role NULL = 0 件であり、role / surface（master・conductor のみ）は inject 経路が機能している一方で task_id だけが完全欠落している状態と一致する。修正は agent 側でのヘッダ注入（spawn 時固定）+ proxy 側での conductor surface → taskId 逆引き（動的）のハイブリッドが妥当。

## 2. 調査結果

### 2.1 サブ質問 1: `x-cmux-task-id` ヘッダはどこで set されるべきか / 現在 set されているか

**結論: 仕様上は inject されるべきだが、現状はどこでも set されていない。**

`grep -rn "x-cmux-task-id" skills/cmux-team/` の結果（言及箇所のみで、set 箇所はゼロ）:

| 場所 | 内容 |
|------|------|
| `skills/cmux-team/SKILL.md:157` | ヘッダ仕様の表に `x-cmux-task-id \| タスクID` と記載（spec のみ） |
| `skills/cmux-team/manager/runtime-backend.ts:101` | コメント `リクエストメタデータ（x-cmux-task-id / x-cmux-role 等）` のみ。`SpawnOptions.metadata` 経由で渡す設計だが、`claude-code-backend.ts:110` の `setRequestMetadata` は **`no-op`** と明示されている |
| `skills/cmux-team/manager/proxy.ts:738` | 読み出し側のみ（`req.headers.get("x-cmux-task-id") || opts?.taskId`） |

実際に `ANTHROPIC_CUSTOM_HEADERS` に注入されているヘッダ（`main.ts` 内の generator 関数 3 種、いずれも `x-cmux-role` と `x-cmux-surface` のみで `x-cmux-task-id` は無し）:

```text
main.ts:2091  generateMasterSettings:      "x-cmux-role: master\nx-cmux-surface: ${surface}"
main.ts:2213  generateAgentSettings:       "x-cmux-role: agent"
main.ts:2317  generateConductorSettings:   "x-cmux-role: conductor\nx-cmux-surface: ${surface}"
```

`claude-code-backend.ts:107-111`:

> Claude Code backend では ANTHROPIC_CUSTOM_HEADERS 経由で注入するため no-op。
> `setRequestMetadata(_metadata: Record<string, string>): void { /* no-op */ }`

つまり `runtime-backend.ts` のメタデータ経路は claude-code-backend では機能しておらず、**唯一の inject 手段は `ANTHROPIC_CUSTOM_HEADERS` 文字列**だが、そこに `x-cmux-task-id` を埋める実装が無い。

### 2.2 サブ質問 2: `opts?.taskId` フォールバック経路

**結論: `cmdStart` の `startProxy` 呼び出しでは `taskId` は渡していない（渡せない）。**

`main.ts:759`:

```ts
proxyHandle = await startProxy(PROJECT_ROOT, {
  getState: () => state,
  onMessage: async (msg) => { ... },
  db: traceDb,
});
```

`opts.taskId` フィールドは型定義 (`proxy.ts:464`) に存在するが、daemon が proxy を起動する際は **複数タスクを並行サーブする** 性質上、起動時固定の単一 `taskId` は意味をなさない。実際にも未指定。

`startProxy` を呼ぶ他の箇所（`proxy-rate-limit-snapshot.test.ts:115/152/185/215`）はすべてテストで、本番経路は `cmdStart` のみ。`opts.taskId` 経路は事実上死んでいる。

### 2.3 サブ質問 3: surface → role → task_id の lookup chain は実装されているか

**結論: lookup chain は未実装。proxy.ts は state.conductors を参照していない。**

`schema.ts:391` の `ConductorState` には:

```ts
export const ConductorState = z.object({
  taskRunId: z.string().optional(),
  taskId: z.string().optional(),     // ← 存在する
  taskTitle: z.string().optional(),
  surface: z.string(),
  ...
});
```

があり、`state.conductors.get(surface)?.taskId` で取得可能。

しかし `proxy.ts` 内で `state.conductors` を参照しているのは `setRateLimit` 周辺の `tokenHandle` 反映 (`proxy.ts:212-220`) のみで、**task_id 解決には使われていない**。`proxy.ts:738` のロジックは headers / opts のみ参照する素朴な OR 連鎖になっている。

`team.json` には `conductors[].taskId` が含まれており、`task-state.json` にも task の状態が記録されているが、proxy はこれらを使った逆引きを行わない。

### 2.4 サブ質問 4: 本リポジトリ運用の特定設定差異

**結論: 本リポジトリ固有の設定が原因ではなく、コードの未実装バグ。**

実測データ（`/Users/yamamoto/git/cmux-team/.team/traces/traces.db` を直接 SELECT）:

```sql
-- スキーマ
CREATE TABLE api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT, role TEXT, surface TEXT, conductor_id TEXT, ...);

-- NULL 集計
SELECT COUNT(*), SUM(task_id IS NULL), SUM(surface IS NULL), SUM(role IS NULL)
FROM api_usage;
-- 13885 | 13885 | 11129 | 0

-- role 分布（抜粋）
agent     |8167
conductor |3542
master    | 998
master, x-cmux-surface: surface:N |多数  ← T354/T355 以前の汚染値（既に修正済み）

-- surface 分布（抜粋）
NULL          |11129   ← agent には surface が inject されないため
surface:139   |  554
surface:509   |  271
...

-- 直近 20 行（ROLE が agent のレコードは surface も NULL）
2026-04-30T19:23:01Z | task_id=NULL | surface=NULL | role=agent | ...
2026-04-30T19:22:01Z | task_id=NULL | surface=surface:509 | role=conductor | ...
```

事実関係:

- **role は全件埋まっている**: `x-cmux-role` 注入は機能している
- **surface は agent のみ NULL**: agent の `ANTHROPIC_CUSTOM_HEADERS` には `x-cmux-surface` が含まれていない（`main.ts:2213`）。master/conductor では埋まっている
- **task_id は全件 NULL**: 注入経路が一切無い

つまり「test fixture では task_id が渡されている」のは `proxy.test.ts` で `x-cmux-task-id` ヘッダを直接 set してテストしているからであり、本番経路（`cmdStart` → `startProxy` → Anthropic CLI が `ANTHROPIC_CUSTOM_HEADERS` を送信）には注入処理が無い。pool key モード等は一切無関係。

### 2.5 サブ質問 5: 修正方針

**結論: 修正可能。agent には spawn 時にヘッダ固定注入、conductor は proxy 側で surface → taskId 動的逆引き、master は task に紐付かないため NULL のまま許容、というハイブリッド方式が最小コストかつ正確。**

詳細は次節「修正方針」を参照。

## 3. 根本原因の特定

**`x-cmux-task-id` ヘッダを HTTP リクエストに乗せる実装が存在しない（未実装バグ）。**

T305 (`e0c2d63 feat(proxy): record api_usage + rate limit per request`) で proxy.ts に書き込みロジックが導入された際、`task_id` 列の供給経路は `req.headers.get("x-cmux-task-id") || opts?.taskId` という API 設計だけが先行整備された。しかし:

1. master/conductor/agent の settings.json (`generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings`) には `x-cmux-task-id` を埋めるコードが追加されなかった（master は性質上 task に紐付かないので妥当だが、conductor / agent は対応漏れ）
2. `cmdStart` の `startProxy(PROJECT_ROOT, opts)` でも `taskId` は渡されていない（daemon は複数タスク並走するため、ここで固定値を渡すのは設計上不可）
3. `runtime-backend.ts` の `metadata` 経路は `claude-code-backend.setRequestMetadata` が `no-op` と明示されているため死んでいる

結果として 100% の `api_usage` 行で `task_id` が NULL になる。

これは T305 の実装上の漏れであり、外部要因（Claude Code CLI が送らない等）ではない。

## 4. 修正方針（修正可能）

「3 層に応じて適切な経路で task_id を供給する」ハイブリッド方式を提案する。

### 4.1 agent: spawn 時に `x-cmux-task-id` をヘッダ固定注入（最小修正）

**根拠**: agent は 1 surface = 1 タスクで短命。spawn 時に taskId が確定しており（`cmdSpawnAgent` 内 `main.ts:2740` 付近で `team.json` から既に解決済み）、その値は agent 寿命中変化しない。固定注入で十分。

**変更ファイル**:

- `skills/cmux-team/manager/main.ts:2207` `generateAgentSettings(projectRoot, surface)` のシグネチャに `taskId?: string` 追加
- `skills/cmux-team/manager/main.ts:2213` ヘッダ生成を変更:

  ```ts
  // 現状
  ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: agent",
  
  // 変更後
  ANTHROPIC_CUSTOM_HEADERS: [
    "x-cmux-role: agent",
    `x-cmux-surface: ${surface}`,
    ...(taskId ? [`x-cmux-task-id: ${taskId}`] : []),
  ].join("\n"),
  ```

  - 同時に `x-cmux-surface` も注入する（agent の surface 列 NULL も解消できる二次効果）

- `skills/cmux-team/manager/main.ts:2874` の呼び出しを `generateAgentSettings(PROJECT_ROOT, surface, taskId)` に変更（taskId は既に同関数内 `cmdSpawnAgent` で解決済み）

### 4.2 conductor: proxy.ts で surface → taskId を動的逆引き（task 切り替えに追従）

**根拠**: conductor は同一 surface のまま task が動的に切り替わる。settings.json への固定埋め込みでは task 切り替えに追従できないため、リクエスト到着時の最新 state を参照すべき。`opts.getState` は既に proxy に渡されている (`main.ts:759`)。

**変更ファイル**: `skills/cmux-team/manager/proxy.ts:738`

```ts
// 現状
const taskId = req.headers.get("x-cmux-task-id") || opts?.taskId;
const conductorSurface =
  req.headers.get("x-cmux-surface")
  || req.headers.get("x-cmux-conductor-id")
  || opts?.conductorSurface;
const role = req.headers.get("x-cmux-role") || opts?.role;

// 変更後（surface 解決を先に行い、未指定 task_id を state から逆引き）
const conductorSurface =
  req.headers.get("x-cmux-surface")
  || req.headers.get("x-cmux-conductor-id")
  || opts?.conductorSurface;
const role = req.headers.get("x-cmux-role") || opts?.role;
let taskId = req.headers.get("x-cmux-task-id") || opts?.taskId;
if (!taskId && role === "conductor" && conductorSurface && opts?.getState) {
  try {
    const s = opts.getState();
    const c = s?.conductors?.get?.(conductorSurface);
    if (c?.taskId) taskId = c.taskId;
  } catch { /* state アクセス失敗時は taskId NULL のまま */ }
}
```

  - role を見て conductor のときのみ逆引きすることで、master ヘッダの surface (master は task に紐付かない) を誤って引き当てるのを避ける
  - state アクセスは pure read で副作用なし、existing tokenHandle 反映と同じパターン

### 4.3 master: 修正不要（task_id は NULL 許容）

**根拠**: master は複数タスクを起票・監督する役割で、API リクエスト 1 件に対して特定の task_id は紐付かない。NULL のまま運用するのが意味論的に正しい。

ただし将来的に「master が今操作している task」を識別したい場合は、UserPromptSubmit hook 等から最新 taskId を team.json に保存し、proxy が role==="master" の場合のみそれを引く、という拡張余地はある（本タスクのスコープ外）。

### 4.4 既存データの扱い

過去 13,885 行は task_id NULL のままで放置する（再構築不可）。新規行から正常化される。集計クエリ側で `WHERE task_id IS NOT NULL` を入れれば既存ロジックは破綻しない（既に in-memory fixture でロジック検証済みなので安全）。

## 5. テスト方針

### 5.1 ユニットテスト追加

1. **`main.test.ts`** の `generateAgentSettings` テスト群 (`main.test.ts:2332`):
   - 既存テスト: `expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-cmux-role: agent");`
   - 追加テスト:
     - `generateAgentSettings(root, "surface:N", "T403")` の戻り値で `ANTHROPIC_CUSTOM_HEADERS` が `x-cmux-role: agent\nx-cmux-surface: surface:N\nx-cmux-task-id: T403` を含むこと（改行区切りであること、3 値全部入っていること、汚染値「カンマ区切り」が無いこと → T355 regression もガード）
     - `taskId` 未指定時は `x-cmux-task-id` 行が含まれないこと（壊れた値で書き込まないため）

2. **`proxy.test.ts`** に新ケース追加（既存の T323/T355 テスト群と同パターン）:

   ```ts
   test("T403: x-cmux-surface=conductor + x-cmux-task-id 未指定でも state.conductors から task_id を逆引きする", async () => {
     const fakeState = {
       conductors: new Map([
         ["surface:c1", { surface: "surface:c1", taskId: "T403", agents: [], status: "running", startedAt: new Date().toISOString() }],
       ]),
     };
     const proxy = await startProxy(projectRoot, { db, getState: () => fakeState });
     // /v1/messages を投げ、x-cmux-role: conductor + x-cmux-surface: surface:c1 のみ送る
     // expect: api_usage 行の task_id === "T403"
   });

   test("T403: ヘッダ x-cmux-task-id がある場合は state を引かずヘッダを優先", async () => { ... });
   test("T403: role=master の場合は state.conductors を引かない（誤マッチ防止）", async () => { ... });
   ```

3. **回帰確認**: 既存 1100 件強の test がすべて pass のままであること（`generateAgentSettings` のシグネチャを optional 引数で拡張するため互換性は保てる）。

### 5.2 統合確認（実機）

1. 修正後 daemon を再起動（`cmux-team start`）
2. 任意のタスクを assign（既存 conductor → agent 経路）
3. agent 起動 → ある程度 API call を発生させる
4. `sqlite3 .team/traces/traces.db "SELECT task_id, surface, role, COUNT(*) FROM api_usage WHERE timestamp > '<再起動以後>' GROUP BY task_id, surface, role"` で:
   - role=agent / conductor の行で `task_id` が埋まっていること
   - role=agent の行で `surface` も埋まっていること
   - role=master の行は `task_id NULL` のまま（仕様通り）

## 6. 参考: 関連ファイルパス・commit 一覧

### 関連 commit

| commit | 概要 |
|--------|------|
| `e0c2d63` | T305 — `feat(proxy): record api_usage + rate limit per request`（task_id 列を作ったが注入実装なし） |
| `0b99b7d` | T323 — `conductorId 廃止 + surface 統一` |
| `b7f83c7` | T354 — Metrics タブを Rate Limit Projection に作り直し（汚染 role 値の正規化） |
| `2590271` | T355 — `ANTHROPIC_CUSTOM_HEADERS` を改行区切りに是正 |

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team/manager/proxy.ts:738` | task_id / surface / role 解決ロジック（修正対象） |
| `skills/cmux-team/manager/proxy.ts:464-475` | `startProxy` opts 型定義（修正不要だが参照） |
| `skills/cmux-team/manager/main.ts:2082-2105` | `generateMasterSettings`（参考） |
| `skills/cmux-team/manager/main.ts:2207-2305` | `generateAgentSettings`（修正対象） |
| `skills/cmux-team/manager/main.ts:2306-2390` | `generateConductorSettings`（参考） |
| `skills/cmux-team/manager/main.ts:759` | `cmdStart` の `startProxy` 呼び出し（修正不要） |
| `skills/cmux-team/manager/main.ts:2874` | `cmdSpawnAgent` の `generateAgentSettings` 呼び出し（修正対象） |
| `skills/cmux-team/manager/main.ts:2734-2745` | `cmdSpawnAgent` 内の taskId 解決（既存・流用可能） |
| `skills/cmux-team/manager/runtime-backend.ts:101-105` | metadata 経路コメント（claude-code-backend では no-op、参考のみ） |
| `skills/cmux-team/manager/claude-code-backend.ts:107-111` | `setRequestMetadata` no-op（修正対象外） |
| `skills/cmux-team/manager/schema.ts:395-397` | `ConductorState.taskId` 型（既存・流用） |
| `skills/cmux-team/manager/trace-store.ts:587` | `insertApiUsage`（task_id 引数を受けるだけ、修正不要） |
| `skills/cmux-team/SKILL.md:155-160` | ヘッダ仕様の docs（実装に追従させる） |
