# T306 Implementer 実装サマリー

- 担当: Implementer agent（task-306-1776976896 worktree）
- plan.md: `.team/tasks/306-trace-task-metrics/runs/task-306-1776976896/plan.md` の「4. 実装ステップ」に一字一句沿って実装
- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-306-1776976896`
- branch: `task-306-1776976896/task`

## 変更ファイル

```
 M skills/cmux-team/manager/i18n.ts
 M skills/cmux-team/manager/main.ts
 M skills/cmux-team/manager/trace-store.test.ts
 M skills/cmux-team/manager/trace-store.ts
```

### 行数 (`git diff --stat`)

```
 skills/cmux-team/manager/i18n.ts             |   8 +
 skills/cmux-team/manager/main.ts             | 118 +++++++++++++-
 skills/cmux-team/manager/trace-store.test.ts | 222 +++++++++++++++++++++++++++
 skills/cmux-team/manager/trace-store.ts      | 129 ++++++++++++++++
 4 files changed, 475 insertions(+), 2 deletions(-)
```

plan.md 7 章の見積もり「合計 ~300 行」を少し上回ったが、これはテストの helper 相当部分をインライン展開した結果（同一ロジックを横断 assert するほうが可読性が高いと判断した）。実質的な生産コードは見積もり内。

## 実装の要点

### trace-store.ts（集計関数）

- `getApiUsage` の直下に 3 interface + 3 関数を追加（plan.md 4.1）
  - `TaskUsageTotal` / `TaskUsageByRole extends TaskUsageTotal { role }` / `TaskUsageByModel extends TaskUsageTotal { model }`
  - `getTaskUsageTotal(db, taskId) → TaskUsageTotal`
  - `getTaskUsageByRole(db, taskId) → TaskUsageByRole[]`
  - `getTaskUsageByModel(db, taskId) → TaskUsageByModel[]`
- SQL は plan.md 3.1-3.3 の擬似コードをほぼそのまま採用
  - `COALESCE(SUM(...), 0)` で 0 行ヒット時 NULL 回避
  - `COALESCE(role, 'unknown')` / `COALESCE(model, '(unknown)')` で NULL バケット集約
  - role 並びは `(SUM(input_tokens) + SUM(output_tokens)) DESC`
  - model 並びは `COUNT(*) DESC`
- 既存 index `idx_api_usage_task_id` を利用、追加 index なし

### main.ts（フォーマッタ + cmdTraceTask）

- imports: `getTaskUsageTotal / getTaskUsageByRole / getTaskUsageByModel / TaskSessionRecord / TaskUsageTotal / TaskUsageByRole / TaskUsageByModel` を追記
- helper 4 本を `cmdTraceTask` の直後（buildHookDetail の手前）に配置
  - `formatTokenCount(n)` — `toLocaleString("en-US")`
  - `formatDuration(ms)` — `<1s` / `Ns` / `Nm Ns` / `Nh Nm Ns`
  - `formatCacheHitRate(cacheRead, inputTokens)` — 分母 0 で `n/a`、それ以外は小数 1 桁
  - `deriveDuration(sessions)` — `assigned`（conductor）起点 + 終端（closed/aborted）差分、片方欠損は `null`
  - `renderTokenUsageSection(total, byRole, byModel, durationMs)` — console.log 直呼び、列幅は動的 `Math.max` + `padStart/padEnd`
- `cmdTraceTask` の変更:
  - `db.close()` を 2 箇所に分岐（No sessions ルート / 通常ルート）へ移動し、Metrics セクションを通常ルートの Sessions 出力直後に挿入
  - `--no-metrics` フラグで metrics ブロック全体をスキップ（既定 ON）
  - `--summary` スタブ位置は変更なし（Metrics の後に出る順序）

### i18n.ts（help）

- en / ja 両方の `help_trace_task` に Options `--no-metrics`、Examples 行、Output includes の Token Usage / By role / By model 説明を追記（plan.md 4.3）

### trace-store.test.ts（新規テスト）

plan.md 4.4 の 7 ケースを `describe("trace-store: api_usage metrics (T306)")` として末尾に追加:

1. 0 件タスクで requests=0 / 他列 0
2. cache 列 NULL 混在で NULL は SUM 無視、他列は合算
3. `role=NULL` → `"unknown"` 集約
4. `model=NULL` → `"(unknown)"` 集約
5. by_role が `(input + output) DESC`
6. by_model が `COUNT(*) DESC`
7. エラー行（`error NOT NULL`）も合算（total / by_role / by_model 全て）

`describe` と `beforeEach`/`afterEach` は既存 T305 ブロックと同じ `createDummyProject` + `initDB(tmpDir)` パターンを踏襲。

## 検証結果

### `bun test` (全 38 ファイル)

```
 1175 pass
 0 fail
 2887 expect() calls
Ran 1175 tests across 38 files. [51.57s]
```

T305 時点の基準 `1168 pass` から `+7`（新規テスト 7 本分）で fail 0 件、regression なし。

### `bunx tsc --noEmit`

```
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1558,22): error TS2352: Conversion of type 'string | undefined' to type ... may be a mistake ...
```

既存 3 件（T305 時点で申告済みの別タスク由来）のみ。T306 追加分の TS エラーは 0 件。

### 手動検証

tmp ディレクトリ `/tmp/cmux-t306-test` に main の trace DB をコピー → 合成 api_usage 行 7 件を INSERT し、`PROJECT_ROOT=/tmp/cmux-t306-test bun .../main.ts trace-task <id>` で確認。

#### 1. metrics ON（T303 に合成データあり）

```
Task T303: P2: task-state 全 mutation を pure reducer 経由に置換し SSOT を確立する
Run: -
Base: main @9cc7628 (source=config-local-ahead)
Deliverable: merged into main @ 06a074a

Sessions:
  conductor    409d6891  surface:628   -           -
  planner      --------  surface:725   -           -
  reviewer     --------  surface:726   -           -
  planner      --------  surface:727   -           -
  reviewer     --------  surface:728   -           -
  impl         --------  surface:729   -           -
  inspector    --------  surface:730   -           -
  inspector    --------  surface:731   -           -
  conductor    409d6891  surface:628   -           -

Token Usage:
  Requests:     7
  Input:        11,000 tokens
  Output:       5,250 tokens
  Cache create: 1,100 tokens
  Cache read:   97,000 tokens (cache hit rate: 89.8%)
  Duration:     1h 20m 41s

By role:
  agent      requests=5  input=9,000  output=4,500  cache_read=62,000
  conductor  requests=2  input=2,000  output=  750  cache_read=35,000

By model:
  claude-opus-4-7            requests=4  input=9,700  output=4,650  cache_read=90,000
  claude-sonnet-4-6          requests=1  input=  800  output=  400  cache_read= 5,000
  claude-haiku-4-5-20251001  requests=1  input=  500  output=  200  cache_read= 2,000
  (unknown)                  requests=1  input=    0  output=    0  cache_read=     0
```

Sessions セクションの後、`--summary` スタブより前に Metrics が挿入される。列幅は `Math.max` で自動調整（`(unknown)` 行を含めて model 列 25 文字）。エラー行 1 件が `(unknown)` model に集約されている。

#### 2. `--no-metrics` で main ブランチと diff 0

```
$ diff /tmp/t306-with-data-old.txt /tmp/t306-with-data-nometrics.txt && echo "DIFF: 0 (identical)"
DIFF: 0 (identical)
```

`--no-metrics` 指定時は従来の trace-task 出力と**バイト単位で一致**することを確認。スクリプト互換性の移行パスが担保されている。

#### 3. 古いタスク（T250 / api_usage 行なし）でフォールバック行

```
Task T250: Conductor に broken 状態を導入し、エラーステートを idle に戻さない
Run: -
Base: origin/main @dedba23 (source=config-origin)
Deliverable: -

Sessions:
  conductor    b09bfe81  surface:128   -           -
  ...
  conductor    b09bfe81  surface:128   -           -

Token Usage: (no usage data — task predates T305)
```

T305 以前の closed タスクは 1 行フォールバック、By role / By model は出さない（plan.md 2.5）。

#### 4. ヘルプテキスト（ja）

```
cmux-team trace-task -- タスクのセッション履歴を表示

Usage:
  cmux-team trace-task <task-id> [options]

Options:
  --no-metrics           Token Usage / By role / By model セクションを非表示にする
  --summary              要約モード（将来拡張用スタブ）

Examples:
  cmux-team trace-task 141
  cmux-team trace-task 141 --no-metrics
  cmux-team trace-task 141 --summary

Output includes:
  - Base 行: base branch / SHA / source（記録がある場合）
  - Deliverable 行: close-task 時に記録された納品方式（kind + 詳細）。旧行は "-"
  - Token Usage: 全体集計（requests / input / output / cache create / cache read / cache hit rate / duration）
  - By role / By model: role 別・model 別の内訳（T305 以前のタスクはフォールバック行 1 行のみ）
```

en / ja 両方で `--no-metrics` / Examples / Output includes が揃っていることを確認。

## plan.md 設計判断の遵守

- [x] `--no-metrics` は `hasFlag("no-metrics")` で真理値として受ける
- [x] SQL は 3 関数分離（1 クエリ統合せず）
- [x] エラー行も合算（テスト 7 番で明示 assert）
- [x] model / role の NULL は `COALESCE` で `unknown` / `(unknown)` に寄せる
- [x] cache hit rate 分母 0 は `n/a`
- [x] Duration 行は assigned または終端欠損時は出さない
- [x] `.team/artifacts/` には書き込んでいない
- [x] プロジェクト直下の `artifacts/` には触れていない

## 後続工程（Conductor に委ねる）

commit / `bunx tsc --noEmit` 新規 error 0 件確認 / rebase main / merge / `close-task` はこの Implementer agent では実行していない。Conductor が最後にまとめて行う想定（プロンプトの指示に従う）。
