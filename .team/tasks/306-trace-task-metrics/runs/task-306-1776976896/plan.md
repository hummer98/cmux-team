# T306 実装計画: `trace-task` にトークン消費集計を既定表示

- 対象タスク: T306
- Planner: surface 内 agent（task-306-1776976896 worktree）
- 前提タスク: T305（api_usage テーブル / insertApiUsage / getApiUsage が既に merge 済み。commit `e0c2d63`）
- 変更範囲: `skills/cmux-team/manager/trace-store.ts` + `skills/cmux-team/manager/main.ts` + `skills/cmux-team/manager/i18n.ts` + テスト追加
- 変更禁止範囲: proxy.ts / schema.ts / daemon.ts（集計は「記録済みデータの read-only 集計」のみで、書き込み経路は T305 の実装を温存）

---

## 1. 現状把握サマリー

### 1.1 api_usage テーブル（T305 で追加済み）

- 定義: `skills/cmux-team/manager/trace-store.ts` の `SCHEMA` 内（L141-170）と `ensureApiUsageColumns`（L226-278）
- PK: `id INTEGER AUTOINCREMENT`
- 集計で使うカラム:
  - `task_id TEXT NULL` — `x-cmux-task-id` ヘッダ or opts フォールバック。proxy 経由で付く。T305 以前のリクエストは当然 NULL
  - `role TEXT NULL` — `master` / `conductor` / `agent` / `unknown`（proxy L423 で `x-cmux-role` から。T304 以降）
  - `model TEXT NULL` — レスポンスの `message_start.model` から
  - `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` — すべて `INTEGER NULL`（非 prompt cache レスポンスは cache_* が NULL）
  - `duration_ms INTEGER NULL` — クライアントから見た 1 request 実時間
  - `status_code INTEGER NULL` — エラー応答も INSERT される（`http_<n>` / `rate_limit_error` / `stream_aborted` / `parse_failed`）
  - `error TEXT NULL` — 失敗事由（成功時は NULL）
- INDEX: `idx_api_usage_task_id` が張られているので `WHERE task_id = ?` は問題なく高速
- INSERT 地点: `proxy.ts` の非 streaming 終端 + SSE drain 終端で 1 回ずつ。1 リクエスト 1 行
- 既存 query 関数は `getApiUsage(db, opts)` のみで、これは単純な LIMIT 付き SELECT。**集計用クエリは未実装** → T306 で追加する

### 1.2 既存 `cmdTraceTask`（`main.ts` L4042-4140）

- 引数パース: `args[1]` に task-id（positional）、`hasFlag("name")` / `getArg("name")` でフラグを取る。`--summary` スタブが既に存在。`--no-metrics` はまだ無い
- ヘルプテキスト: `i18n.ts` L479-495（en）/ L1230-1246（ja）にある `help_trace_task`
- DB オープン/クローズ: `const db = initDB(PROJECT_ROOT); ... db.close();`（L4073-4075 で一度開閉）
- 現在の表示構成（行順）:
  1. `Task T{id}: {title}`
  2. `Run: {taskRunId}`
  3. `Worktree: {rel path}`（worktreePath があれば）
  4. `Base: {branch} @{sha} (source={source})` or `Base: -`
  5. `Deliverable: {formatted}` or `Deliverable: -`
  6. 空行
  7. `Sessions:` ヘッダ + 行: `  {role pad12} {sid slice8}  {surface pad12}  {lineCount pad10}  {jsonlPath}`
- 書式規則:
  - ラベルと値は `:` + 1 スペース区切り（"Task T", "Run:", "Base:" 等）
  - セクションは空行で区切る
  - カラムは `padEnd` で揃える、`role` 12、`surface` 12、`lineCount` 10 が前例
  - 数値はまだ出てこないので `toLocaleString("en-US")` 等のカンマ区切りは新規ポリシー

### 1.3 task_sessions から duration を取る既存クエリ

- `cmdTraceTask` 冒頭で `getSessionsForTask(db, taskId)` を既に呼び、全 event（assigned / agent_spawned / closed / aborted）を ID 昇順で取得している
- つまり duration 専用クエリは不要で、既存の `sessions` 変数から `assigned`/`closed`/`aborted` 行を抜き出せば済む
- 実データ確認（`/Users/yamamoto/git/cmux-team/.team/traces/traces.db` の T303 行）:
  ```
  2026-04-23T02:15:39.388Z | assigned      | conductor | surface:628
  2026-04-23T03:36:21.294Z | closed        | conductor | surface:628
  ```
  → 差分が Duration（約 81 分）

### 1.4 既存テスト

- `skills/cmux-team/manager/trace-store.test.ts` に `describe("trace-store: api_usage (T305)", …)`（L655〜）が既にある
- `bun test` ＋ `bunx tsc --noEmit` が CI 基準（T305 のコミットメッセージから）
- 集計関数の test はここに `describe("trace-store: api_usage metrics (T306)", …)` を追加する形で自然に載る

---

## 2. 設計判断

### 2.1 `--no-metrics` フラグの受け方

- **決定**: `hasFlag("no-metrics")` で拾う。既存パーサが `--no-<name>` 形式を特別扱いしないので、`hasFlag("no-metrics") === true` = metrics 非表示 という素直な真理値で問題ない
- **採用理由**: `--summary` / `--json` 等と揃った記法で、`showHelp` の Options 追記だけで済む
- **拒否した代替案**: `getArg("metrics") === "false"` 形式 — タスク本文の仕様（`--no-metrics` 単独フラグ）と合わないので不採用

### 2.2 集計 SQL の分解方針

- **決定**: `trace-store.ts` に 3 つの read-only 関数を追加する
  1. `getTaskUsageTotal(db, taskId) → { requests, inputTokens, outputTokens, cacheCreation, cacheRead }`
  2. `getTaskUsageByRole(db, taskId) → Array<{ role, requests, inputTokens, outputTokens, cacheCreation, cacheRead }>`
  3. `getTaskUsageByModel(db, taskId) → Array<{ model, requests, inputTokens, outputTokens, cacheCreation, cacheRead }>`
- **1 クエリにまとめない理由**: total / by_role / by_model で `GROUP BY` 単位が違う。1 回 SELECT で 3 種のロールアップを作ろうとすると `GROUP BY ROLLUP` or UNION が要るが SQLite で可搬性が低く、3 回に分けるほうが**読みやすく**、idx_api_usage_task_id による filter は **WHERE で絞り込んだ後に GROUP BY** でコストもほぼ同じ
- **NULL の扱い**: `SUM()` は NULL を自動無視する（= 0 を足すのと同じ）ので `cache_creation_input_tokens` / `cache_read_input_tokens` の NULL 混在は SQL 側で透過的に処理される。アプリ側で `?? 0` を追加でかける必要はない
- `role = NULL` の行は by_role の `COALESCE(role, 'unknown')` で `unknown` 行に束ねる
- `model = NULL` の行は by_model で `COALESCE(model, '(unknown)')` に束ねる（エラー応答 = model 未取得の行が該当）
- **index**: `idx_api_usage_task_id` は既存。3 関数とも `WHERE task_id = ?` で引くので追加 index は不要

### 2.3 表示フォーマッタ

- **決定**: `main.ts` 内に `formatTokenCount(n: number): string`、`formatDuration(ms: number): string`、`formatCacheHitRate(read: number, input: number): string` の 3 ヘルパ関数を追加
  - `formatTokenCount`: `toLocaleString("en-US")` — `12,345` 形式
  - `formatDuration`: `ms` → `{h}h {m}m {s}s` / `{m}m {s}s` / `{s}s` / `<1s`（タスク本文例が `23m 14s` なので `h`=0 の時は省略）
  - `formatCacheHitRate`: 分母 = `input + cache_read`。両方 0 なら `n/a`、それ以外は `78.7%`（小数 1 桁）
- **ヘルパの置き場所**: main.ts ファイルが 5000 行超なので、既存の `buildHookDetail` 周辺（4155 前後、trace-hooks 用ヘルパの直下）に `// T306: metrics formatters` としてまとめる。別ファイル分離まではしない（「Three similar lines is better than a premature abstraction」）
- **例外**: `formatTokenCount` は単体テストしづらいほど小さいので main.ts 同居のまま。ただし 3 関数とも純関数として書く（I/O しない）

### 2.4 カラム幅と整列

- タスク本文の例で by_role / by_model が `role 12 + requests pad + input=N output=N cache_read=N` の独自形
- **決定**: 既存の `role.padEnd(12)` 前例に合わせ、`role` / `model` は最長名の基準で右パディング。model は `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` を含むので **動的に最大長を求めてからパディング**。固定値だと将来新しいモデル名で崩れる
- 数値列も `String(n).padStart(maxDigit)` で右揃え。`requests`（3 桁程度）/ `input`（カンマ入りで 8 桁程度）/ `output` / `cache_read` それぞれの最大幅を取る
- **ヘッダなしの `key=value` ペア**は情報密度が低いため、タスク本文の例（`input=2,345 output=890 cache_read=12,345`）を踏襲しつつも、by_role / by_model は「列ごとに最大幅を取って spaces 区切り」で揃える
- 両方 0 な列は省略しない（説明性のため）

### 2.5 metrics が 0 件のタスク（T305 以前の closed）

- **決定**: `getTaskUsageTotal` の `requests === 0` で単一 `if` 分岐。出力は:
  ```
  Token Usage: (no usage data — task predates T305)
  ```
  の 1 行のみ。`By role:` / `By model:` は出さない
- 将来的に「task_id はあるが全 error 行」というケースも `requests > 0` になるのでこの分岐には落ちない（フォールバックは打たない）

---

## 3. データフロー

```
cmdTraceTask(taskId)
  ├─ 既存: loadTasks / taskState / getSessionsForTask (変更なし)
  ├─ 既存: Task / Run / Worktree / Base / Deliverable / Sessions 表示 (変更なし)
  └─ 【T306 追加ブロック】 if (!hasFlag("no-metrics"))
       ├─ db = initDB(PROJECT_ROOT)   // 既存 L4073 の db を close せずに再利用する案（下記「実装ステップ」参照）
       ├─ total   = getTaskUsageTotal(db, taskId)
       ├─ byRole  = getTaskUsageByRole(db, taskId)
       ├─ byModel = getTaskUsageByModel(db, taskId)
       ├─ duration = deriveDuration(sessions)  // 既に ID 昇順で取得済
       ├─ db.close()
       └─ renderMetrics(total, byRole, byModel, duration)
            ├─ if total.requests === 0 → 1 行フォールバック、return
            ├─ ヘッダ "Token Usage" + total ブロック
            ├─ "By role:" ブロック
            └─ "By model:" ブロック
```

### 3.1 擬似コード — getTaskUsageTotal

```sql
SELECT
  COUNT(*)                                AS requests,
  COALESCE(SUM(input_tokens), 0)          AS input_tokens,
  COALESCE(SUM(output_tokens), 0)         AS output_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
  COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read
FROM api_usage
WHERE task_id = $taskId
```
- `COALESCE(SUM(...), 0)`: 0 行ヒットでも NULL にならずに 0 を返すための保険（`COUNT(*)` だけは 0 を返すが SUM は空集合で NULL）
- エラー行（error NOT NULL）も合算する。タスク本文に「全リクエストの合計」とあるため、エラー再試行コストも含めて可視化するほうが意思決定に役立つ

### 3.2 擬似コード — getTaskUsageByRole

```sql
SELECT
  COALESCE(role, 'unknown')               AS role,
  COUNT(*)                                AS requests,
  COALESCE(SUM(input_tokens), 0)          AS input_tokens,
  COALESCE(SUM(output_tokens), 0)         AS output_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
  COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read
FROM api_usage
WHERE task_id = $taskId
GROUP BY COALESCE(role, 'unknown')
ORDER BY input_tokens + output_tokens DESC
```
- ORDER BY で重い順（input+output tokens 合計降順）→ Agent が先頭に来ることが多く視認性が良い

### 3.3 擬似コード — getTaskUsageByModel

```sql
SELECT
  COALESCE(model, '(unknown)')            AS model,
  COUNT(*)                                AS requests,
  ... (total と同じ列たち)
FROM api_usage
WHERE task_id = $taskId
GROUP BY COALESCE(model, '(unknown)')
ORDER BY requests DESC
```

### 3.4 擬似コード — deriveDuration

```ts
function deriveDuration(sessions: TaskSessionRecord[]): number | null {
  const assigned = sessions.find(s => s.event === "assigned" && s.role === "conductor");
  const terminal = [...sessions].reverse().find(s => s.event === "closed" || s.event === "aborted");
  if (!assigned || !terminal) return null;
  const start = Date.parse(assigned.timestamp);
  const end   = Date.parse(terminal.timestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
```
- `assigned` が無い（アサイン失敗経路 / 古いタスク）→ null → Duration 行を出さない
- `closed` / `aborted` が無い（走行中タスクを trace した）→ null → Duration 行を出さない。**将来的には now() - start を running 表記で出す拡張が考えられるが T306 スコープ外**

---

## 4. 実装ステップ

### ステップ 1: `trace-store.ts` に集計関数を追加

- ファイル: `skills/cmux-team/manager/trace-store.ts`
- 追加位置: `getApiUsage` の直下（L606 以降）
- export する関数:
  - `export interface TaskUsageTotal { requests: number; inputTokens: number; outputTokens: number; cacheCreation: number; cacheRead: number; }`
  - `export interface TaskUsageByRole extends TaskUsageTotal { role: string; }`
  - `export interface TaskUsageByModel extends TaskUsageTotal { model: string; }`
  - `export function getTaskUsageTotal(db: Database, taskId: string): TaskUsageTotal`
  - `export function getTaskUsageByRole(db: Database, taskId: string): TaskUsageByRole[]`
  - `export function getTaskUsageByModel(db: Database, taskId: string): TaskUsageByModel[]`

### ステップ 2: `main.ts` のフォーマッタと Metrics セクション

- ファイル: `skills/cmux-team/manager/main.ts`
- 追加するヘルパ（`cmdTraceTask` より前、4040 行手前あたり）:
  - `function formatTokenCount(n: number): string`
  - `function formatDuration(ms: number): string`
  - `function formatCacheHitRate(cacheRead: number, inputTokens: number): string`
- `cmdTraceTask` 本体の改修:
  - `import { ..., getTaskUsageTotal, getTaskUsageByRole, getTaskUsageByModel, deriveDuration? } from "./trace-store";` に追記（deriveDuration は main.ts 内にローカル定義するので trace-store 側には置かない）
  - 既存 L4073 の `const db = initDB(PROJECT_ROOT)` から `db.close()` までの間に、`if (!hasFlag("no-metrics")) { … 集計 … }` ブロックを追加。現状 `db.close()` は `sessions` 取得直後に呼ばれているので、**close 位置を Metrics 出力後に移動**する（3 関数とも同 db ハンドルを使うのが自然）
  - Metrics 出力は Sessions の後、`--summary` スタブの前に挿入
- レンダリング関数（ローカル関数として main.ts 内に置く）:
  - `function renderTokenUsageSection(total, byRole, byModel, durationMs)` — console.log を直接叩く（既存 cmdTraceTask が console.log ベタ書き構成なので合わせる）

### ステップ 3: ヘルプテキスト更新

- ファイル: `skills/cmux-team/manager/i18n.ts`
- L479-495（en）/ L1230-1246（ja）の `help_trace_task` に Options の `--no-metrics` と Output includes の「Token usage totals / by role / by model / duration」を追記

### ステップ 4: テスト追加

- ファイル: `skills/cmux-team/manager/trace-store.test.ts`
- 追加 describe: `describe("trace-store: api_usage metrics (T306)", …)`
  - `getTaskUsageTotal: 0 件タスクで requests=0 / 他列 0 を返す`
  - `getTaskUsageTotal: cache 列 NULL 混在で NULL は合算されず他列は合算される`
  - `getTaskUsageByRole: role=NULL 行は "unknown" に集約される`
  - `getTaskUsageByModel: model=NULL 行は "(unknown)" に集約される`
  - `getTaskUsageByRole: 合計 tokens 降順で並ぶ`
  - `getTaskUsageByModel: requests 降順で並ぶ`
  - `エラー行（error NOT NULL）も集計に含まれる` — タスク本文には明記されていないが、コスト可視化の意図から含めるという設計判断の裏付け
- cmdTraceTask 自体には test を追加しない（既存の trace-task にも単体 test は無く、E2E 確認ベース）

### ステップ 5: 手動検証

- worktree 内で実装 → main 起動中の daemon を使って実 DB 相手に確認:
  1. `cmux-team trace-task 305` — T305 作業中に記録された api_usage 行を集計（実データあり想定。無ければフォールバック表示の確認になる）
  2. `cmux-team trace-task 303 --no-metrics` — 従来出力と diff で一致することを確認
  3. `cmux-team trace-task 200 | grep "Token Usage"` — T305 以前の古いタスクでフォールバック行が出ること
  4. `cmux-team trace-task 306` — 自分自身のタスクに対して実行し、Planner Agent の消費量が見えること（dog-fooding）

### ステップ 6: CI 基準

- `cd skills/cmux-team/manager && bun test` — 新規エラー 0 件、既存 1168 pass 維持（T305 時点の基準）
- `cd skills/cmux-team/manager && bunx tsc --noEmit` — 新規 TS エラー 0 件（既存 3 件は T305 で申告済みの別タスク）

---

## 5. テスト観点

### 5.1 正常系

- **実データ総量**: T303 / T304 / T305 のような新しい closed タスクで `Total requests` が 1 以上になり、input / output が非零で表示される
- **role 別内訳**: conductor + agent + （master / unknown）の行が出る。不要な role 行（0 件）は自動的に出ない（`WHERE task_id + GROUP BY` なので空 role バケットは出現しない）
- **model 別内訳**: opus / sonnet / haiku が混在するタスクで 2 行以上出る
- **cache hit rate**: `cache_read / (input + cache_read)`。T303 は cache 利用あり想定なので 50% 前後出ることを目視確認
- **duration**: `23m 14s` 形式で 1 時間以上なら `1h 23m 14s`、1 分未満なら `14s`、1 秒未満なら `<1s`

### 5.2 フォールバック・縮退系

- **api_usage 0 件**: T200 等の古いタスクで 1 行フォールバック
- **`--no-metrics`**: 既存出力と diff で完全一致（ByteCompare 可能なレベル）
- **走行中タスク**: assigned だけで closed/aborted が無い場合、Duration 行は出ない / または `Duration: (in progress)` の二択。**スコープ決定**: 「出さない」を採用（T306 は closed 前提の集計というタスク本文意図に沿う）
- **assigned も存在しない（レガシー）**: Duration 行を出さない

### 5.3 regression

- `cmdTraceTask` 既存表示（Task / Run / Worktree / Base / Deliverable / Sessions）の各行が metrics の有無にかかわらず同一であること
- `--no-metrics` で差分 0、metrics ON で末尾に追加される構造であること

### 5.4 unit test（trace-store）

- 上記「実装ステップ 4」で列挙した describe / it

---

## 6. リスク・境界

### 6.1 設計上のリスク

| リスク | 対応 |
|---|---|
| cache hit rate の分母が 0（input=0 & cache_read=0） | `formatCacheHitRate` が `n/a` を返し、Cache read 行に `(cache hit rate: n/a)` と併記 |
| input_tokens が 0 だが cache_read > 0 | hit rate 100%（`0 + cache_read` なので全部 cache）という数学的に正しい値が出る。表示自体に問題なし |
| エラー応答行（`status_code >= 400 or error IS NOT NULL`）の合算 | タスク本文は明示していないが「全リクエストの集計」という表現から合算する。テストで明示的に assert する |
| 大量リクエスト（数千行）の集計パフォーマンス | SQLite + `idx_api_usage_task_id` があるので **実測で数 ms**。パフォーマンス懸念なし。負荷試験までは不要 |
| `model` 文字列が `claude-opus-4-7` と `claude-opus-4-7-20260xxx` で乱立 | T306 ではそのまま GROUP BY する（正規化しない）。将来的に base model name へ折りたたむのは別タスク |
| API レスポンス model != request model のケース | proxy は `message_start.model` を採用しており、それを UI でそのまま表示するだけなのでここでは判断しない |
| T305 デプロイ直後タスク（一部だけ api_usage がある） | requests > 0 分岐に入るが、**total と by_role / by_model の一貫性が崩れる可能性**は無い（全部同じ WHERE で引くので）。部分的欠損の注意書き等は出さない（false alarm のノイズを増やすだけ） |
| 走行中タスク（status=assigned）でユーザが実行 | Duration 無し + Total など途中集計が出る。誤解を招く可能性があるが、**意思決定の参考にはなる**ので抑制しない方針 |

### 6.2 T307（次タスク）との境界

- **T306 がやること**: CLI 1 タスク分の静的集計のみ
- **T306 がやらないこと**:
  - Dashboard（TUI）への metrics 埋め込み — T307
  - 時系列グラフ / burn rate / ETA 予測 — T307
  - `--since` / `--until` 等の時間窓フィルタ — 現時点で要件なし
  - cost（USD）換算 — price カラムが api_usage に無く、別タスク
  - タスク横断（全体集計）— 別タスク
- dashboard.tsx / task-state.json は **読み書きしない**。T307 で ink コンポーネントに `getTaskUsageTotal` を呼ばせる前提で、関数は main.ts 依存にしない（trace-store.ts に置く）のは T307 への投資

### 6.3 下位互換

- `--no-metrics` で従来の trace-task 出力が維持される → スクリプトから trace-task 出力を grep しているユーザには移行パスがある
- 既定 ON 化により **パイプ先のスクリプト**が壊れる可能性。CHANGELOG に「trace-task の出力に Token Usage セクションが既定で追加された。従来動作は `--no-metrics` で維持」と記載する

### 6.4 観測性

- 集計関数は純粋 read（SELECT のみ）なので `log()` 呼び出しは入れない（ロギングポリシー「高頻度ループ内の過剰ログは不要」に一致）
- DB open/close 失敗時のみ既存の catch 経路で拾われる（`cmdTraceTask` 全体が外側で try/catch されている想定。なければこの PR でも付け足さない — 既存パターンに従う）

---

## 7. 変更ファイル一覧（まとめ）

| ファイル | 変更内容 | 行数見積 |
|---|---|---|
| `skills/cmux-team/manager/trace-store.ts` | 3 interfaces + 3 集計関数を L606 以降に追加 | +60 |
| `skills/cmux-team/manager/main.ts` | 3 フォーマッタ + `deriveDuration` + Metrics セクション挿入 + import 追加 | +100 |
| `skills/cmux-team/manager/i18n.ts` | `help_trace_task` en/ja に `--no-metrics` と output 説明を追加 | +8 |
| `skills/cmux-team/manager/trace-store.test.ts` | `describe("api_usage metrics (T306)")` に 7 テスト追加 | +120 |
| `CHANGELOG.md`（Implementer が最後に書く想定） | T306 エントリ | +5 |

合計 ~300 行変更。既存コードの破壊的変更はゼロ（`cmdTraceTask` 出力末尾に追加するだけ、かつ `--no-metrics` で抑止可能）。

---

## 8. Implementer へのヒント

1. **最初に書くもの**: `getTaskUsageTotal` + その単体テスト。ここが成立すれば残りは GROUP BY 変えるだけ
2. **テストデータ構築**: T305 の既存 test（L713 以降）を参考に `insertApiUsage` で task_id=X の行を複数入れる helper を書くと Query 3 種のテストで使い回せる
3. **db ハンドル共有**: 既存 `cmdTraceTask` は `sessions` 取得直後に `db.close()` しているが、Metrics で再度 open すると起動コストがかかる。**close を Metrics 出力後に移す**のが推奨パス
4. **padEnd の動的計算**: by_role / by_model のテーブル表示で、まず `Math.max(...rows.map(r => r.role.length))` で横幅を決めてから `padEnd` する。T306 はレンダリングの一貫性が大事
5. **手動検証の優先順位**: まず `--no-metrics` で diff 0 を取り、次に metrics ありを別タスクで走らせる。regression を先に潰すほうが精神衛生に良い
