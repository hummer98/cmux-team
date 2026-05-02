# T381 implementation plan: baseline 定期 snapshot 自動収集 + cohort 比較ツール（Rev 2）

- task: T381 (depends_on: T379)
- planner: surface:510
- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-381-1777565435`
- 関連 issue: https://github.com/hummer98/cmux-team/issues/44

---

## 0. Revision Log

Design Reviewer から **Changes Requested**。Critical 4 件 / Major 4 件 / Minor 5 件を反映した改訂版。

主要変更点:

1. **e2e in-process テスト** を新サブタスク **S14** として明示（finding 1）
2. **alarm direction map** を §2.2 と S5 に明記。`{ completion_rate: "lower_is_worse", forced_close_rate / duration_ms_mean / tool_failure_rate: "higher_is_worse" }`（finding 2）
3. **snapshot 形式から `per_day` を削除**。per-task を 1 度だけ計算 → period を派生する純関数階層に変更。per-day は compare 側で `derivePerDayFromSnapshots` として派生（finding 3）
4. **atomic write**（temp file + `fs.rename`）を S3 に追加（finding 4）
5. snapshot_date は **UTC 基準** であることを spec に明記、launchd 推奨時刻は **UTC 00:05 = JST 09:05**（finding 5）
6. alarm 閾値の **SSOT はコード**（`metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS`）。spec は注釈で参照（finding 6）
7. `unionPerTask` の dedup を **2 段ルール**で明示: closed-state 優先 + snapshot_date 昇順最後（finding 7）
8. **path traversal 対策**を S3 / S6 / S7 に追加（finding 8）
9. §2.2 の per_task 説明を `readTaskLifecycle` の実態（open task も含む）に訂正（finding 9）
10. snapshot 形式の `metadata: { generated_at, events_jsonl_size_bytes }` sub-object 化（finding 10）
11. S1 完了条件に tied ranks 補正・df=0 等のエッジケースを明記（finding 11）
12. `runWithAbort` helper の影響範囲を **新 metrics 系 cmd のみ**に限定（finding 12）
13. spec に **schema_version は increment-only / 過去 snapshot 再生成禁止** を明記（finding 13）

---

## 1. 課題分析

### 1.1 現状

- **T379 完了済み**: `cmux-team metrics` が events.jsonl + traces.db を per-task / per-bucket で集計し、json / text / csv で出力できる（`runMetricsCli` in-process API + `aggregateMetricsByTask` / `aggregateMetricsByBucket` / `aggregatePeriod` 純粋関数）。
- **T380 spec は未着手**: `docs/spec/11-metrics.md` は存在しない。警報閾値・評価サイクルの基準が未定義。
- 現状の集計は **問い合わせ時に events.jsonl と traces.db を全スキャン** して計算する。長期間の trend 分析を毎回ゼロからやる構造は重く、また events.jsonl が rotate された場合や DB が GC された場合に過去値が **再現不能**。

### 1.2 根本原因（構造的観点）

過去計測値の再現性が input ファイル（events.jsonl, traces.db）に張り付いている。これは「state を transformer の外側に持つ」という CLAUDE.md の上位原理と矛盾する。trend を語る基盤としては:

1. **計測スナップショットを fact として外部化する**（再計算不能になっても snapshot 列が残る）
2. snapshot を時系列に並べるだけで cohort 比較が成立する（再集計と独立）

の 2 段階で state を凍結すべき。本タスクの本質はここ。

### 1.3 影響範囲

- 新サブコマンド追加: `cmux-team metrics snapshot` / `compare` / `health`（main.ts の `case "metrics":` 分岐を sub-subcommand 化）
- 新ディレクトリ: `.team/metrics/snapshots/` （`.team/artifacts/` には入れない、後述 D3）
- 新規ファイル: 統計検定 `metrics-stats.ts`、snapshot writer `metrics-snapshot.ts`、cohort compare `metrics-compare.ts`、health checker `metrics-health.ts`、閾値 SSOT `metrics-thresholds.ts`
- 既存ファイル: `metrics-cli.ts`（subcommand dispatch を追加）、`main.ts`（dispatch のみ）、`i18n.ts`（help 追加）
- spec: `docs/spec/11-metrics.md` を最小スコープで作成（baseline 開始日時 + 評価サイクル + 警報閾値表のみ）

---

## 2. 技術アプローチ

### 2.1 全体方針

「**snapshot は CLI で生成（OS 非依存）、スケジューラは外部に任せる（OS 依存を分離）**」というハイブリッド構成を採用する。

```
┌──────────────────────────────────────────────────────────┐
│ launchd / cron / GitHub Actions / 任意 scheduler         │
│   ↓ 1 日 1 回 起動（推奨: UTC 00:05 = JST 09:05）         │
│ cmux-team metrics snapshot --date YYYY-MM-DD            │ ← CLI は OS 非依存
│   ↓                                                      │
│ .team/metrics/snapshots/YYYY-MM-DD.json                 │ ← snapshot を fact として固定
│   ↓                                                      │
│ cmux-team metrics compare \                              │
│   --baseline 2026-05-04..2026-05-31 \                    │
│   --comparison 2026-06-15..2026-07-12                    │
│   ↓                                                      │
│ diff + 統計検定 + 閾値判定 → stdout (json / text)        │
│   alarm あれば exit 2                                    │
└──────────────────────────────────────────────────────────┘
```

### 2.2 選択した設計とその理由

#### サブコマンド構造（既存 metrics CLI への追加方針）

現状の `cmux-team metrics` は flat option（`--task-id` / `--since` / `--format` / `--group-by`）。ここに `--compare`、`--snapshot` を **flag として混ぜない**。理由:

1. `--compare baseline:<period> codedna:<period>` のような複数値 flag は parser を歪める。既存 `KNOWN_FLAGS` / `FLAGS_WITH_VALUE` の単純構造と合わない
2. snapshot 書き込みと aggregate stdout 出力は副作用と入出力が異なる（前者は `.team/metrics/snapshots/` への副作用、後者は read-only）
3. token / pool / artifacts と同型の **sub-subcommand パターン**で揃えると、help と dispatch の対称性が取れる

採用する dispatch:

```
cmux-team metrics                        # 既存: per-task aggregate（default）
cmux-team metrics --task-id ...          # 既存
cmux-team metrics --group-by day         # 既存
cmux-team metrics snapshot               # NEW
cmux-team metrics compare ...            # NEW
cmux-team metrics health                 # NEW
```

dispatch 場所は **main.ts レベル**（現 `case "metrics":` を `cmdMetrics()` 内で sub 判定）にする。`runMetricsCli` 自体に subcommand を入れると、既存 args parser を破壊し test も書き直しになるため、薄い分岐を main.ts に置き、それぞれ専用の `runMetricsSnapshotCli` / `runMetricsCompareCli` / `runMetricsHealthCli` を新規実装する。これは `case "token":` / `case "pool":` と同型で構造的に正しい。

#### snapshot ファイル形式（JSON、Rev 2 で per_day を削除・metadata sub-object 化）

```jsonc
{
  "schema_version": 1,
  "snapshot_date": "2026-05-01",          // YYYY-MM-DD（UTC 基準、ローカルではない）
  "window": {
    "from": "2026-04-30T00:00:00.000Z",  // [from, to)
    "to":   "2026-05-01T00:00:00.000Z"
  },
  "per_task":   [/* PerTaskMetrics[] = aggregateMetricsByTask 出力（後述 lifecycle 含む） */],
  "period":     {/* PeriodSummary = per_task から派生（aggregatePeriod を再呼び出ししない） */},
  "metadata": {
    "generated_at": "2026-05-01T00:05:00.000Z",
    "events_jsonl_size_bytes": 12345,
    "events_jsonl_path": ".team/events.jsonl",
    "traces_db_path": ".team/traces/traces.db"
  }
}
```

設計判断（Rev 2 反映済み）:

- **per_day を削除**（finding 3）。snapshot は 1 日 = 24h window なので per_day は要素 1 で period と情報が重複する。compare 側で per-day trend が必要な場合は snapshot 群から派生関数 `derivePerDayFromSnapshots` で生成する。これにより `aggregateMetricsByBucket` を snapshot 内で呼ぶ二重 aggregation を排除（`metrics-aggregate.ts:357` で内部的に `aggregateMetricsByTask` を呼ぶため、snapshot で両方呼ぶと完全に重複する）。
- **per_task の定義訂正**（finding 9）: `readTaskLifecycle(eventsFile, since)` は **terminal を持つ task は `terminal_ts >= since`、open task は `assigned_ts >= since`** で含める（`metrics-aggregate.ts:191-216` の実態）。したがって per_task は「**当該 window 内に terminal もしくは assigned があるタスク**」。outcome=open のタスクは含まれ、後日 closed snapshot が出現したら compare 側 dedup（後述）で closed 優先で上書きする。
- **fact / metadata 分離**（finding 10）: `generated_at` / `events_jsonl_size_bytes` 等の実行時情報は `metadata: { ... }` sub-object に隔離。snapshot 再生に寄与しない情報を fact レベルから切り離す。
- **period は per_task から派生**: S2 で `aggregateMetricsByTask` を 1 度だけ呼び、その結果（lifecycle map）から `aggregatePeriod(map)` で period を派生。snapshot 内 per_task と period は **同じ lifecycle map を起源** として整合する。
- **schema_version** は events.jsonl と同様 forward-compat 用。compare 側で `!== 1` の snapshot は warn + skip。spec で「schema_version は increment-only / 過去 snapshot は再生成禁止 / v=2 移行時は両形式を読める loader を追加」を明記（finding 13）。

#### 統計検定

- **Welch's t-test を主**（duration_ms_mean、tool_call_total / task などの連続値 metric に対し平均差 + p-value を返す）
- **Mann-Whitney U を補助**（小サンプル / 非正規分布の保険、tied ranks 補正含む）
- どちらも自前実装（Bun に統計ライブラリは不要、Student-t / 正規分布の CDF 近似はそれぞれ ~30 行）
- 比率系 metric（completion_rate / forced_close_rate / abort_rate / deny_rate）は **2-proportion z-test** で別ロジック

→ `metrics-stats.ts` に純粋関数として配置:

```typescript
export function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number };
export function mannWhitneyU(a: number[], b: number[]): { u: number; z: number; p: number };
export function twoProportionZTest(x1: number, n1: number, x2: number, n2: number): { z: number; p: number };

// 内部ヘルパ（export してテストする）
export function studentTSF(t: number, df: number): number;        // Student-t survival function（両側 p）
export function normalSF(z: number): number;                       // 標準正規 SF（Mann-Whitney 大標本近似 / z-test）
```

p-value は両側を返す。閾値 α=0.05 は CLI 出力で flag を立てるだけで、計算側には埋めない。

#### Alarm direction map（Rev 2 で明示、finding 2）

各 metric が「増加 = 悪化」か「減少 = 悪化」かの方向は、code と spec の両方で同じ map を参照する。SSOT は `metrics-thresholds.ts`:

```typescript
// metrics-thresholds.ts
export type AlarmDirection = "higher_is_worse" | "lower_is_worse";

export interface AlarmThreshold {
  direction: AlarmDirection;
  delta: number;          // 比率系は pp（percentage point）、連続値系は pct（相対変化率）
  unit: "pp" | "pct";
}

export const DEFAULT_ALARM_THRESHOLDS: Record<string, AlarmThreshold> = {
  completion_rate:    { direction: "lower_is_worse",  delta: 0.10, unit: "pp" },   // -10pp 悪化
  forced_close_rate:  { direction: "higher_is_worse", delta: 0.05, unit: "pp" },   // +5pp 悪化
  duration_ms_mean:   { direction: "higher_is_worse", delta: 0.30, unit: "pct" },  // +30% 悪化
  tool_failure_rate:  { direction: "higher_is_worse", delta: 0.05, unit: "pp" },   // +5pp 悪化
};
```

`evaluateAlarms(diff, thresholds)` は metric ごとに direction を見て (a) higher_is_worse なら `delta > threshold.delta` で alarm、(b) lower_is_worse なら `delta < -threshold.delta` で alarm とする。spec の閾値表もこの形式（direction 列を持つ表）に揃える。

### 2.3 代替案と却下理由

| 案 | 却下理由 |
|---|---|
| **A: 純粋に launchd plist のみ提供** | macOS native 限定。cmux-team は `direnv-check` 等で他 OS も意識した設計。OS 非依存 CLI を介在させる方が portable |
| **B: daemon 内 scheduled writer** | daemon 落ち時に欠損。CLAUDE.md「state を外部化」原理と矛盾（snapshot 生成が daemon の生存に依存） |
| **C: 既存 `cmux-team metrics --compare` flag を実装** | parser 構造が崩れる。compare は複数 period 引数を取るためサブコマンドの方が自然 |
| **D: snapshot を `.team/artifacts/Axxx-metrics-YYYYMMDD.md` に書く** | Axxx flat namespace を 1 年で 360 連番消費。artifact は「知見」用、daily snapshot は「raw fact」で性格が違う（D3 で詳述） |
| **E: snapshot 形式を SQLite DB（traces.db に新テーブル）** | DB は GC 対象で長期保管に向かない。traces.db の Aggregate state を 1 日ごとに切り出して **JSON ファイル** に固定する方が再現性が高い |
| **F: snapshot に per_day も含める（Rev 1 案）** | finding 3 で却下。1 日 window では per_day = 1 要素で period と重複。aggregateMetricsByBucket の二重 aggregation を誘発 |
| **G: 閾値 SSOT を spec markdown** | spec から TS が値を読む仕組みが無い。コード SSOT + spec 注釈参照（finding 6 / D5） |

### 2.4 既存パターンとの整合性

- `metrics-cli.ts` / `events-cli.ts` の `runXxxCli({ args, projectRoot, stdout, stderr, abortSignal }): Promise<number>` を踏襲
- 集計ロジックは既存の `aggregateMetricsByTask` / `aggregatePeriod` を **再利用**（per-day は compare 側で snapshot 群から派生）
- in-process テストパターン: `metrics-cli.test.ts` の `captureStreams()` + `createDummyProject()` を新規 CLI でも使う
- help 文字列は `i18n.ts` 経由で `t("help_metrics_snapshot")` / `t("help_metrics_compare")` / `t("help_metrics_health")` を追加

### 2.5 構造的解決の検討（タスク仕様 §2 要請）

| 既存パターン | 採否 | 理由 |
|---|---|---|
| `events-cli.ts` の薄い dispatch（subcommand なし） | 不採用 | snapshot/compare/health は責務が異なる |
| `case "token":` の sub-subcommand 分岐 | **採用** | 同型で構造的に揃う。読み手の認知負荷が最小 |
| `case "artifacts":` の sub-subcommand + sort flag | 部分参考 | snapshot/compare/health の独立性は token に近い |

→ **case "metrics" を sub-subcommand 化**（subcommand なし = 既存 aggregate）。これが既存の token / pool / artifacts と完全に同型。

---

## 3. 変更対象

### 3.1 新規作成ファイル

| パス | 役割 |
|---|---|
| `skills/cmux-team/manager/metrics-snapshot.ts` | `runMetricsSnapshotCli` + snapshot ファイル書き出し純関数 + atomic write |
| `skills/cmux-team/manager/metrics-snapshot.test.ts` | snapshot CLI / 純関数 / atomic write のテスト |
| `skills/cmux-team/manager/metrics-compare.ts` | `runMetricsCompareCli` + snapshot 群読み込み + dedup + diff 算出 + `derivePerDayFromSnapshots` |
| `skills/cmux-team/manager/metrics-compare.test.ts` | compare CLI / dedup（2 段ルール）/ diff のテスト |
| `skills/cmux-team/manager/metrics-stats.ts` | 純粋統計関数（Welch / Mann-Whitney with tie correction / 2-prop z）+ CDF 近似 |
| `skills/cmux-team/manager/metrics-stats.test.ts` | 既知データセット（R / scipy 既知値）と一致確認、tied ranks / df=0 含む |
| `skills/cmux-team/manager/metrics-health.ts` | `runMetricsHealthCli` + snapshot ギャップ検出 |
| `skills/cmux-team/manager/metrics-health.test.ts` | gap 検出のテスト |
| `skills/cmux-team/manager/metrics-thresholds.ts` | `DEFAULT_ALARM_THRESHOLDS` SSOT + direction 型定義 |
| `skills/cmux-team/manager/metrics-e2e.test.ts` | snapshot → compare → health の e2e in-process テスト（**S14**） |
| `docs/spec/11-metrics.md` | baseline 開始日時 + 評価サイクル + 警報閾値表（最小） |
| `templates/launchd/com.cmux-team.metrics-snapshot.plist.template` | macOS 用 launchd テンプレ（任意提供） |
| `.team/artifacts/A026-baseline-snapshot-cohort.md` | T381 セッション要約（design decisions の最終記録） |

### 3.2 変更ファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/main.ts` | `cmdMetrics()` を sub-subcommand dispatch に変更（subcommand なし = 既存挙動を維持）+ `runWithAbort` helper（**新 metrics 系 cmd のみ**で使用） |
| `skills/cmux-team/manager/i18n.ts` | `help_metrics_snapshot` / `help_metrics_compare` / `help_metrics_health` を追加。既存 `help_metrics` に "Subcommands:" セクションを追記 |
| `skills/cmux-team/manager/metrics-cli.ts` | 変更なし（既存挙動を保つ）。dispatch は main.ts 側 |
| `docs/spec/glossary.md` | `baseline period` / `evaluation period` / `cohort comparison` / `daily snapshot` 用語を追加 |
| `README.md` / `README.ja.md` | 簡潔に `cmux-team metrics snapshot` の存在を追記（必要最小限） |

### 3.3 削除ファイル

なし（既存実装と並列にせず純増。並列実装禁止ルールに反しない）。

---

## 4. サブタスク分割

### S1. 統計関数の実装（純粋関数 / 無依存）

- **対象**: `skills/cmux-team/manager/metrics-stats.ts`（新規）
- **完了条件**:
  - `welchTTest(a, b)` / `mannWhitneyU(a, b)` / `twoProportionZTest(x1, n1, x2, n2)` を export
  - 既知データセット（R / scipy.stats の出力値）と相対誤差 < 1e-3 で一致
  - **エッジケース**:
    - `welchTTest`: n=1 同士 / 全分散 0 / df<=0 で `{ t: NaN, df: 0, p: 1 }` 等の明示的な定義値を返す（NaN 伝播禁止）
    - `mannWhitneyU`: 全値同値で `{ u: n1*n2/2, z: 0, p: 1 }`、空配列で `{ u: 0, z: 0, p: 1 }`
    - `twoProportionZTest`: n1=0 / n2=0 で `{ z: 0, p: 1 }`、p1=p2=0 / p1=p2=1 で `{ z: 0, p: 1 }`
  - **Mann-Whitney は tied ranks 補正を実装**（rank-tie 補正項 `Σ(t³−t) / (n(n−1))` を分散から減じる小規模補正）
- **メソッド制約**:
  - `Math.erf` がないため、[Abramowitz & Stegun 26.2.17] または同等の有理関数近似で normalSF を構築
  - Student-t SF は incomplete beta 関数経由（Lentz の continued fraction）で実装
  - 外部依存禁止（Bun 標準ライブラリのみ）
- **テスト fixture**:
  - Welch's t-test: scipy.stats.ttest_ind(equal_var=False) の例題 5 ケース（n=2, 全分散 0, 同値配列含む）
  - Mann-Whitney U: scipy.stats.mannwhitneyu の例題 5 ケース（**tied ranks 多数のケース必須**）
  - normalSF: 標準正規 ([0, 0.5], [1.0, 0.1587], [1.96, 0.025], [3.0, 0.00135]) で誤差確認
  - Student-t SF: df=1, df=10, df=100 で scipy 値と一致
- **検証コマンド**: `bun test --timeout 30000 metrics-stats.test.ts`

### S2. snapshot 書き出し関数（純関数）の抽出

- **対象**: `skills/cmux-team/manager/metrics-snapshot.ts`（新規、CLI まだ書かない）
- **完了条件**:
  - `buildDailySnapshot({ db, eventsFile, snapshotDate, generatedAt }): Promise<DailySnapshot>` を export
  - **二重 aggregation 排除**: 内部で `aggregateMetricsByTask` を **1 度だけ** 呼ぶ。period は同じ lifecycle map から `aggregatePeriod(map)` で派生させる（`aggregateMetricsByBucket` は呼ばない）
  - 戻り値は §2.2 snapshot ファイル形式（per_task + period + metadata、per_day なし）
  - per_task の含意: window 内に terminal もしくは assigned があるタスク（open task は outcome=open で含まれる）
- **メソッド制約**:
  - lifecycle 抽出は `readTaskLifecycle(eventsFile, since)` 経由のみ（重複ロジック禁止）
  - per-task と period は **同じ time window** を共有（since=snapshotDate 00:00 UTC, until=snapshotDate+1d 00:00 UTC）
  - `metadata` には `generated_at`, `events_jsonl_size_bytes`, `events_jsonl_path`, `traces_db_path` を含める
- **検証コマンド**: `bun test --timeout 30000 metrics-snapshot.test.ts`（純関数テストのみ、CLI は S3）

### S3. snapshot CLI の実装

- **対象**: `skills/cmux-team/manager/metrics-snapshot.ts` に `runMetricsSnapshotCli` を追加
- **完了条件**:
  - `cmux-team metrics snapshot [--date YYYY-MM-DD] [--out <path>] [--force]` で動く
  - 既定動作: `--date` 省略 = 「**昨日 UTC**」。`--out` 省略 = `.team/metrics/snapshots/YYYY-MM-DD.json`
  - 既存ファイルがあれば exit 1 + stderr 警告（`--force` で上書き）
  - `--help` で help 出力 / `--date` 不正値で exit 1
  - `runMetricsSnapshotCli({ args, projectRoot, stdout, stderr, abortSignal }): Promise<number>` 形式
  - **atomic write**（finding 4）: `<dir>/.tmp-<pid>-<random>.YYYY-MM-DD.json` に書き込み → `fs.rename(tmp, target)` で atomic 反映。例外時は tmp を unlink
  - **path traversal 対策**（finding 8）: `--out` を `path.resolve(projectRoot, value)` で正規化し、結果が `projectRoot` 配下にあることを検証。配下でない場合は `--allow-outside-project` 明示フラグが無ければ exit 1。absolute path / `..` を含むパスはこの正規化チェックでブロックされる
- **メソッド制約**:
  - 既存 `parseSince` / `parseISO` ロジックは流用しない（`--date` は YYYY-MM-DD 厳密形式のみ。曖昧化を避ける）
  - DB / events.jsonl 不在時の exit 1 メッセージは `metrics-cli.ts` と同じパターン
  - SIGINT/SIGTERM は abort 反映（CLI runner 側で AbortController を渡す）
- **検証コマンド**: `bun test --timeout 30000 metrics-snapshot.test.ts`（atomic write の partial-write 中断テスト含む）

### S4. snapshot ローダ + dedup 関数

- **対象**: `skills/cmux-team/manager/metrics-compare.ts`（新規、CLI まだ書かない）
- **完了条件**:
  - `loadSnapshotsInRange(snapshotDir, fromInclusive, toInclusive): Promise<{ snapshots: DailySnapshot[]; missing: string[]; skipped: string[] }>` を export
  - `from..to` の YYYY-MM-DD 範囲（両端含む）で snapshot ファイルを列挙し、欠損日は `missing` に列挙
  - JSON parse 失敗 / schema_version != 1 は `skipped` に列挙して warn
  - **`unionPerTask(snapshots): PerTaskMetrics[]`** … task_id 重複の dedup を **2 段ルール** で実装（finding 7）:
    1. **closed-state 優先**: outcome != "open" のレコードがあれば、そちらを採用
    2. **同じ outcome 内では snapshot_date 昇順の最後**を採用（後発の方が完全）
  - day boundary は UTC 基準（snapshot 書き出しと一貫）
- **メソッド制約**:
  - JSON parse 失敗は warn + skip（snapshot ファイル単位で堅牢化）
  - dedup は純関数として export し、テスト容易
- **テスト fixture**:
  - 3 日範囲 + 中間 1 日 missing で `missing: ["..."]` を assert
  - 同 task_id が「open レコード（snapshot_date=D1）」+「closed レコード（snapshot_date=D2）」で出現 → closed が採用される
  - 同 task_id が「closed レコード D1」+「closed レコード D2」→ D2 が採用される
  - 同 task_id が「open レコード D1」+「open レコード D2」→ D2 が採用される
- **検証コマンド**: `bun test --timeout 30000 metrics-compare.test.ts`

### S5. cohort 比較ロジック（純関数）

- **対象**: `skills/cmux-team/manager/metrics-compare.ts` に `compareCohorts` + `derivePerDayFromSnapshots` + `evaluateAlarms` を追加
- **完了条件**:
  - `compareCohorts(baseline: PerTaskMetrics[], comparison: PerTaskMetrics[], thresholds?: AlarmThresholds): CohortDiff` を export
  - `CohortDiff` は以下を含む:
    - `metrics`: 主要 metric ごとに `{ baseline_mean, comparison_mean, delta, delta_pct, t_test, mann_whitney }`
    - `rates`: completion_rate / abort_rate / forced_close_rate / deny_rate ごとに `{ baseline, comparison, delta_pp, delta_pct, z_test }`
    - `alarms`: 閾値超過の signal リスト（`metric`, `direction`, `delta`, `threshold_delta`, `threshold_unit`）
    - `samples`: `{ baseline_n, comparison_n }`
  - 主要 metric: `duration_ms`, `tool_call_total`, `tool_failure_rate`, `time_to_first_edit_ms`, `tokens_total`（input + output + cache 合算）
  - 閾値は `metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS` を import（spec はコメントで参照）
  - **`evaluateAlarms(diff, thresholds)` の direction map** は `metrics-thresholds.ts` の `direction` を信頼:
    - `higher_is_worse` (forced_close_rate / duration_ms_mean / tool_failure_rate): `delta > threshold.delta` で alarm
    - `lower_is_worse` (completion_rate): `delta < -threshold.delta` で alarm
  - **`derivePerDayFromSnapshots(snapshots): PerBucketMetrics[]`**: snapshot 群（順序保証なし）を snapshot_date 昇順で並べ、各 snapshot の period を per-day エントリに変換
- **メソッド制約**:
  - 統計検定は **必ず S1 の `metrics-stats.ts` 経由**（compare ファイルで erf を再実装しない）
  - `evaluateAlarms` は閾値 helper を独立関数化（テスト容易）
- **テスト fixture（alarm 判定マトリクス）**:
  - 4 metric × {超過 / 未超過 / 境界一致 / N/A } のテーブル駆動テスト
  - `lower_is_worse` の completion_rate で `-10pp` 超え / 未超 / 境界
  - `higher_is_worse` の duration_ms_mean で `+30%` 超え / 未超 / 境界
- **検証コマンド**: `bun test --timeout 30000 metrics-compare.test.ts`

### S6. compare CLI の実装

- **対象**: `skills/cmux-team/manager/metrics-compare.ts` に `runMetricsCompareCli` を追加
- **完了条件**:
  - `cmux-team metrics compare --baseline <from..to> --comparison <from..to> [--format json|text] [--snapshot-dir <path>]` で動く
  - period 形式: `YYYY-MM-DD..YYYY-MM-DD`（両端含む / 開始 ≤ 終了）。範囲の day 数 < 1 で exit 1
  - `--format json`（既定）/ `text`（人間向け要約）
  - 出力に `alarms[]` を含め、alarm がひとつでもあれば **exit code 2**（CI 連携用、引数エラー / IO エラーの exit 1 とは区別）
  - **path traversal 対策**（finding 8）: `--snapshot-dir` を `path.resolve(projectRoot, value)` で正規化し projectRoot 配下を検証。`--allow-outside-project` 無ければ exit 1
- **メソッド制約**:
  - 引数 parser は metrics-cli.ts の `KNOWN_FLAGS` パターンを踏襲（互換性のためではなく **構造の同型**を保つため）
  - `runMetricsCompareCli({ args, projectRoot, stdout, stderr, abortSignal }): Promise<number>`
- **検証コマンド**: `bun test --timeout 30000 metrics-compare.test.ts`

### S7. health CLI の実装

- **対象**: `skills/cmux-team/manager/metrics-health.ts`（新規）
- **完了条件**:
  - `cmux-team metrics health [--days <N>] [--snapshot-dir <path>] [--format json|text]` で動く
  - 「直近 N 日（既定 7、UTC 基準）に snapshot ファイルが揃っているか」をチェック。欠損日があれば exit 1 + json/text で `{ missing: [...], count: N, days_checked: N }` 出力
  - cron / launchd の `StandardErrorPath` で監視を組まなくても **コマンド一発で枯渇判定**できる位置付け
  - **path traversal 対策**（finding 8）: `--snapshot-dir` を `path.resolve(projectRoot, value)` で正規化し projectRoot 配下を検証
- **メソッド制約**:
  - 純関数 `findSnapshotGaps(dir, today, days): string[]` を export してテスト
  - `today` は引数で受けてテスト時に固定可能にする（`new Date()` を関数内で呼ばない）
- **検証コマンド**: `bun test --timeout 30000 metrics-health.test.ts`

### S8. main.ts dispatch + i18n 追加

- **対象**: `skills/cmux-team/manager/main.ts`、`skills/cmux-team/manager/i18n.ts`
- **完了条件**:
  - `case "metrics":` 内で `args.slice(1)[0]` を見て `snapshot` / `compare` / `health` に dispatch、それ以外は既存 `runMetricsCli` に流す
  - **`runWithAbort(fn): Promise<number>` helper を新設** し、新 metrics 系 cmd（snapshot / compare / health）でのみ使用（finding 12: scope creep 回避のため既存 cmdEvents / cmdMetrics は変更しない）
  - `help_metrics_snapshot` / `help_metrics_compare` / `help_metrics_health` 文字列を i18n.ts に追加（en/ja 両対応）
  - 既存 `help_metrics` の冒頭に `Subcommands: snapshot / compare / health` を追記
- **メソッド制約**:
  - 「dispatch を main.ts に置く」を貫き、`runMetricsCli` 自身に subcommand を入れない（テスト独立性のため）
  - i18n.ts に新キーを追加する場合、**en と ja を必ず両方入れる**（現状の構造を確認する）
  - `runWithAbort` の影響範囲は **新 metrics 系 cmd 3 つのみ**。既存 `cmdEvents` / `cmdMetrics` への適用は本タスクでは行わない（追跡 issue 化）
- **検証コマンド**:
  - `grep -n "case \"metrics\":" skills/cmux-team/manager/main.ts`
  - `grep -n "help_metrics_snapshot\|help_metrics_compare\|help_metrics_health" skills/cmux-team/manager/i18n.ts`
  - `bun test --timeout 30000 metrics-cli.test.ts`（既存テスト破壊なし確認）

### S9. spec 文書 + 用語集 + 運用ガイド

- **対象**: `docs/spec/11-metrics.md`（新規）、`docs/spec/glossary.md`（追記）
- **完了条件**:
  - `docs/spec/11-metrics.md` に以下を含む:
    1. **baseline 開始日時**: 本タスク完了後の最初の月曜（具体的日付は実装日に確定 / フォーマットは ISO 8601、UTC）
    2. **baseline 期間**: 4 週
    3. **evaluation 期間**: CodeDNA 投入後 +4w → +8w → +12w
    4. **警報閾値表**: completion_rate / forced_close_rate / duration_ms_mean / tool_failure_rate（**direction 列を明示**、S5 / `metrics-thresholds.ts` と一致）
    5. **閾値 SSOT 注釈**: 「コードの `metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS` が SSOT。spec の数値はコードと同期する運用（docs-sync 対象）」を冒頭に明記（finding 6）
    6. **タイムゾーン方針**（finding 5）: 「snapshot_date は **UTC 基準** であることを明示。JST 環境では snapshot_date が JST 翌日の 09:00 までのデータを含む点に注意。**launchd 推奨時刻は UTC 00:05 = JST 09:05**（前日 UTC が確定済みのタイミング）」
    7. **schema_version 方針**（finding 13）: 「schema_version は increment-only / 過去 snapshot は再生成しない（fact として固定） / v=2 移行時は両形式を読める loader を追加し、on-the-fly upgrade は禁止」
    8. **snapshot 自動収集の運用**: `cmux-team metrics snapshot` を 1 日 1 回起動する例（launchd plist 抜粋 + cron 抜粋 + GitHub Actions 抜粋）。各例で UTC ベース推奨時刻を明示
    9. **failure 検知**: `cmux-team metrics health` を別ジョブで日次実行する想定 / launchd の `StandardErrorPath` を `.team/logs/snapshot.log` に流す例
  - glossary.md: `baseline period` / `evaluation period` / `cohort comparison` / `daily snapshot` を追加
- **メソッド制約**:
  - 値（閾値）は `metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS` と **値で一致**（コード SSOT、spec は導出として参照）
- **検証コマンド**: `grep -n "completion_rate\|forced_close_rate" docs/spec/11-metrics.md skills/cmux-team/manager/metrics-thresholds.ts`

### S10. launchd plist テンプレート

- **対象**: `templates/launchd/com.cmux-team.metrics-snapshot.plist.template`（新規）
- **完了条件**:
  - 日次（**推奨: UTC 00:05 = JST 09:05**。launchd の StartCalendarInterval は local time 解釈なので、JST 環境では `Hour=9, Minute=5` を設定し、コメントで「これが UTC 00:05 に相当」と明記）
  - **テンプレート冒頭コメントに「snapshot_date は UTC 基準。前日 UTC のデータを取得するため、JST 環境では 09:05 起動が安全」を記載**（finding 5）
  - `StandardOutPath` / `StandardErrorPath` を `<project>/.team/logs/snapshot.log` に流す
  - `WorkingDirectory` を `{{PROJECT_ROOT}}` プレースホルダーで持たせる
  - README.md / docs/spec/11-metrics.md からの参照と一致
- **メソッド制約**:
  - cmux-team 既存テンプレート命名規約（`templates/` 直下の subdir + `.template` 拡張子）に揃える
  - 起動失敗時に launchd が無限再起動しないよう `KeepAlive=false`
- **検証コマンド**: プレースホルダーを置換した結果に対し `plutil -lint` で plist 構文チェック

### S11. 最初の 1 日分 snapshot 生成（Done 判定 §1 達成）

- **対象**: `.team/metrics/snapshots/<昨日 UTC>.json`
- **完了条件**:
  - `cmux-team metrics snapshot --date <昨日 UTC>` で 1 件生成
  - スキーマが S2 の DailySnapshot 形式と一致（per_task + period + metadata、per_day なし）
  - `cmux-team metrics health --days 1` が exit 0
- **メソッド制約**:
  - **CLI 経由でのみ生成**（手書き禁止）
  - 既存テスト fixture が空でも crash しないことを `metrics-snapshot.test.ts` で別途担保
- **検証コマンド**:
  - `cmux-team metrics snapshot --date <YYYY-MM-DD>`
  - `jq '.schema_version' .team/metrics/snapshots/<YYYY-MM-DD>.json` → `1`
  - `jq 'has("per_day")' .team/metrics/snapshots/<YYYY-MM-DD>.json` → `false`（per_day が無いことを確認）
  - `jq 'has("metadata")' .team/metrics/snapshots/<YYYY-MM-DD>.json` → `true`
  - `cmux-team metrics health --days 1`

### S12. baseline 開始日時を spec に確定 + artifact 化

- **対象**: `docs/spec/11-metrics.md`、`.team/artifacts/A026-baseline-snapshot-cohort.md`
- **完了条件**:
  - spec の `baseline 開始日時` を実装日基準で次の月曜日に確定（例: 2026-05-04 if 完了日が 2026-05-01 金曜、UTC で記載）
  - artifact A026 を `cmux-team artifacts add` で登録（タスク要約 + Decision Log + 実装日と baseline 開始日のマッピング + Rev 2 改訂理由）
- **メソッド制約**:
  - `cmux-team artifacts add` 経由でのみ artifact を登録（`addArtifact` の slug / id 採番ルールに従う）
  - artifact type は `decision`（運用方針の確定）

### S13. 全テストグリーン + tsc

- **対象**: 全 manager test + tsc
- **完了条件**:
  - `cd skills/cmux-team/manager && bunx tsc --noEmit` が exit 0
  - 個別ファイル単位で test pass:
    ```bash
    for f in metrics-stats.test.ts metrics-snapshot.test.ts metrics-compare.test.ts metrics-health.test.ts metrics-e2e.test.ts metrics-cli.test.ts metrics-aggregate.test.ts; do
      bun test --timeout 30000 "$f" || exit 1
    done
    ```
  - 既存テスト破壊なし（events-cli.test.ts / metrics-cli.test.ts 等が pass のまま）
- **メソッド制約**:
  - `bun test` 全体実行禁止（CLAUDE.md 注意点 §`bun test` 全体実行は禁忌）
- **検証コマンド**: 上記スクリプト

### S14. 統合 e2e in-process テスト（新規、Rev 2 finding 1）

- **対象**: `skills/cmux-team/manager/metrics-e2e.test.ts`（新規）
- **完了条件**:
  - `createDummyProject()` で fixture（events.jsonl + traces.db、2 日分の terminal イベントを持つタスクを複数）を構築
  - シナリオ:
    1. `runMetricsSnapshotCli({ args: ["snapshot", "--date", "D1"], ... })` を呼び `.team/metrics/snapshots/D1.json` を生成
    2. `runMetricsSnapshotCli({ args: ["snapshot", "--date", "D2"], ... })` を呼び `.team/metrics/snapshots/D2.json` を生成
    3. `runMetricsCompareCli({ args: ["compare", "--baseline", "D1..D1", "--comparison", "D2..D2", "--format", "json"], ... })` を呼び stdout に diff（metrics + rates + alarms + samples）が出ることを assert
    4. `runMetricsHealthCli({ args: ["health", "--days", "2", "--snapshot-dir", "<path>"], ... })` で gap がないこと（exit 0）を assert
    5. 中間日が欠損するような期間を渡したケースで health が exit 1 + missing を返すことも 1 ケース確認
  - `captureStreams()` で stdout/stderr を捕捉し JSON parse して構造を assert
  - 既存テスト fixture との独立性（projectRoot を tmp dir に隔離）
- **メソッド制約**:
  - **in-process のみ**（サブプロセス起動禁止、テスト時間 / flake 抑制）
  - fixture 構築は `createDummyProject()` のヘルパを再利用
- **検証コマンド**: `bun test --timeout 30000 metrics-e2e.test.ts`

### 並列実装禁止 / 削除タスク確認

- 既存 `runMetricsCli` は残す（responsibility が aggregation のみで、新 subcommand と並列ではない）。
- compare/snapshot/health は独立した責務のため新規追加であり「並列」には該当しない。
- 削除対象は**なし**。

---

## 5. リスク

### 5.1 既存機能との整合性

| リスク | 対策 |
|---|---|
| `cmux-team metrics` の既存 CLI 挙動が壊れる | dispatch は subcommand 名で peel off、subcommand 不一致なら **既存 `runMetricsCli` にそのまま渡す**。`metrics-cli.test.ts` 全 pass を S13 で担保 |
| `--task-id` が `snapshot` と誤解される | snapshot は positional subcommand として `args[0] === "snapshot"` でしか発火しない。`--snapshot` flag は導入しない |
| i18n.ts の en/ja 整合 | help 文字列追加時に両 locale を必ずペアで追加（既存パターンを grep で確認） |
| `runWithAbort` 導入で既存コマンドの SIGINT 挙動が変わる | 影響範囲を **新 metrics 系 cmd のみ** に限定（finding 12）。既存 cmdEvents / cmdMetrics には適用しない |

### 5.2 エッジケース

| ケース | 想定動作 |
|---|---|
| snapshot 期間中にタスク 0 件の日 | snapshot は `per_task: []`, `period: { tasks_assigned: 0, ... }` で正常に書き出す（compare 側で `n=0` 配慮済み） |
| baseline と comparison 期間が一部重なる | 開始日 ≤ 終了日 のみ検査し、重なり自体は許容（評価ポリシー次第なので CLI で禁止しない）。spec で「重ねないこと」と運用注意を残す |
| タイムゾーン: snapshot を朝に走らせると「昨日 UTC」が地域によってズレる | 既定 `--date` を **「昨日 UTC」** に固定し、ローカルタイムゾーン依存を排除。違和感ある運用なら `--date` を明示する設計。spec で UTC 基準を明示 |
| events.jsonl が rotate されて古い記録が消える | snapshot に書き出した時点で fact が固定。rotate 後に再生成を試みる用途は想定外として spec に明記 |
| 既に同日 snapshot がある状態での再実行 | exit 1 + 警告。`--force` で上書き（運用ミス保護） |
| snapshot 書き込み中にプロセスが落ちる（partial write） | atomic write（temp file + rename）で **partial JSON ファイルが永続化されない**。temp は次回起動時に手動掃除（`.team/metrics/snapshots/.tmp-*` を見れば検知可能） |
| t-test で n=1 同士 / 全分散 0 | `welchTTest` は明示的な定義値 `{ t: NaN, df: 0, p: 1 }` を返す。compare 側で `p` の表示を抑制 |
| Mann-Whitney で全値同値 / tied ranks | U=n1·n2/2、z=0、p=1。**tied ranks の rank-tie 補正を実装**（同値多数で分散補正） |
| schema_version 不一致 snapshot | warn + `skipped[]` に列挙。compare 出力に `skipped_files: [...]` を含める。spec で「過去 snapshot 再生成禁止 / 両形式 loader 追加で対応」と明記 |
| `--out` / `--snapshot-dir` に絶対パス・traversal | path.resolve 後 projectRoot 配下を検証、外れていたら `--allow-outside-project` 必須で exit 1 |

### 5.3 テスト戦略

- **in-process pattern**: `metrics-cli.test.ts` の `captureStreams()` + `createDummyProject()` を流用。サブプロセス起動は不要（テスト時間の悪化と flake を避ける）
- **統計検定の数値精度**: scipy / R の既知データを fixture（配列リテラル + 期待値）として埋め込み、相対誤差 < 1e-3 で assert。具体的には:
  - Welch's t-test: scipy.stats.ttest_ind(equal_var=False) の例題 5 ケース（含む n=2, 全分散 0, 同値ケース）
  - Mann-Whitney U: scipy.stats.mannwhitneyu の例題 5 ケース（**tied ranks 多数のケース必須**）
  - normalSF: 標準正規 ([0, 0.5], [1.0, 0.1587], [1.96, 0.025], [3.0, 0.00135]) で誤差確認
- **snapshot ローダの欠損日処理**: 3 日範囲 + 中間 1 日 missing で `missing: ["2026-..."]` を assert
- **snapshot dedup の 2 段ルール**: open + closed / closed + closed / open + open のテーブル駆動
- **compare の alarm 判定**: 4 metric × {超過 / 未超過 / 境界一致 / N/A } のマトリクス × direction（lower/higher_is_worse）でテーブル駆動
- **e2e（S14）**: snapshot CLI を 2 日分実行 → 同じ snapshot dir を compare CLI に渡す → health で gap 検証 を 1 ケースで通す

---

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` を `skills/cmux-team/manager/` で実行 → **exit 0、エラーゼロ**（2026-05-01 時点）。

### 6.1 本タスクで触る既存 TS エラー（修正対象）

なし。

### 6.2 本タスクで触らない既存 TS エラー（保留）

なし。

→ 新規ファイル追加で型エラーが発生した場合は **本タスク内で修正**する（既存 0 件を維持する基準）。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| **D1** | snapshot 収集機構（A: cron/launchd / B: daemon / C: 専用 CLI + 外部 scheduler） | **C: 専用 CLI `cmux-team metrics snapshot` + 外部 scheduler（launchd plist テンプレ提供）** | OS 依存を CLI から排除しつつ、daemon 落ち時の欠損を回避。CLAUDE.md「state を transformer の外側に持つ」「statefulness を排除」原理に整合。launchd 不在環境（Linux / CI）でも cron / GitHub Actions で同じ CLI を呼べる |
| **D2** | 統計検定の選定 | **Welch's t-test を主、Mann-Whitney U（tie 補正あり）を補助、比率系は 2-proportion z-test** | 4 週 × 数十タスクの想定サイズで両方出すのが安全。連続値・比率値で異なる検定を使い分けるのが構造的に正しい。Bun に統計ライブラリを足さず、erf/Student-t/incomplete beta を ~30〜100 行で自前実装（外部依存ゼロ） |
| **D3** | snapshot 命名と保管場所 | **`.team/metrics/snapshots/YYYY-MM-DD.json`（artifact ではない別ディレクトリ）** | Axxx flat namespace を毎日消費する設計は破綻する（1 年で 360 連番）。daily snapshot は「raw fact」で artifact（「知見」）と性格が違う。既存 `addArtifact` の責務を歪めない。`.team/metrics/` 直下に置くことで GC 対象（`.team/traces/`）と長期保管対象を分離 |
| **D4** | 障害検知方法 | **`cmux-team metrics health` 専用サブコマンド + launchd `StandardErrorPath` で `.team/logs/snapshot.log` に流す** | compare 実行時に health チェックを混ぜると責務が広がる。独立 CLI なら CI / cron / 手動どこからでも呼べ、exit code で alert 化できる。manager.log と分離することで snapshot 生成失敗の原因特定が早い |
| **D5** | 警報閾値の SSOT 物理的所在（コード vs spec markdown vs `.team/metrics/thresholds.json`） | **コード SSOT**: `metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS`（finding 6） | TypeScript からマークダウンを参照する仕組みが無い。コード SSOT なら型安全で test も書ける。spec の閾値表は注釈で「コードの `DEFAULT_ALARM_THRESHOLDS` を参照」と書き、**docs-sync の運用対象** とする。外部 JSON 化（オプション b）は将来拡張余地として残すが本タスクでは採らない |
| **D6** | metrics サブコマンド追加方式（flag 拡張 vs sub-subcommand） | **sub-subcommand パターン**（`cmux-team metrics snapshot/compare/health`） | `cmux-team token` / `pool` / `artifacts` と同型で構造的に揃う。flag 拡張は parser を歪める。dispatch は main.ts に薄く置き、各 CLI は独立した `runXxxCli` で in-process テスト容易 |
| **D7** | snapshot ファイル形式（JSON vs SQLite vs Markdown） | **JSON 単一ファイル / 1 ファイル = 1 日** | DB は GC 対象で長期保管に向かない。Markdown はパースが緩く比較困難。JSON なら snapshot のスキーマを既存 aggregate 関数の戻り値そのままにできる（再実装ゼロ） |
| **D8** | snapshot 既定 `--date`（昨日 UTC vs 当日 UTC vs ローカル） | **昨日 UTC**（CLI 既定）／`--date` で override | 当日を渡すと「partial day」を取りに行ってしまう。前日 UTC なら window が確定済みで再現性がある。タイムゾーン依存は CLI 側で排除しユーザの schedule 設定に任せる。spec で UTC 基準と launchd 推奨時刻（UTC 00:05 = JST 09:05）を明記（finding 5） |
| **D9** | compare 期間オーバーラップの扱い | 重なりは許容（CLI でブロックしない）、spec で運用注意 | 評価ポリシーは spec の責務。CLI は数値を出す責務に絞る。alarm threshold をどう適用するかは運用判断のため CLI で禁止しない |
| **D10** | alarm 検出時の exit code | **exit 2**（compare CLI のみ） | exit 1 は引数エラー / IO エラーで使用済み。exit 2 で「正常実行 + alarm あり」を区別すると CI 連携が容易（GitHub Actions の `continue-on-error: false` 等で flag が立つ） |
| **D11**（Rev 2） | snapshot 形式に per_day を含めるか | **含めない**（per_task + period + metadata のみ）。per-day は compare 側で `derivePerDayFromSnapshots` 派生関数 | snapshot は 1 日 window なので per_day は要素 1 で period と重複。`aggregateMetricsByBucket` が内部で `aggregateMetricsByTask` を呼ぶ二重 aggregation を排除（finding 3）。fact / 派生の階層が綺麗になる |
| **D12**（Rev 2） | snapshot atomic write | **temp file + `fs.rename`** で atomic 反映 | partial JSON ファイルが永続化されると `loadSnapshotsInRange` が永続的に skip し、その日のデータが永久欠損する（finding 4）。POSIX rename は同 fs 上で atomic |
| **D13**（Rev 2） | path traversal 対策 | **`path.resolve(projectRoot, ...)` 正規化 + projectRoot 配下チェック / 外部許可は明示フラグ `--allow-outside-project`** | `--out` / `--snapshot-dir` に絶対パス・`..` を渡されると project 外への副作用が発生（finding 8）。CLI 側で正規化して projectRoot 配下を強制し、外したい場合のみ明示 opt-in にする |
| **D14**（Rev 2） | snapshot dedup ルール | **2 段ルール**: (1) closed-state 優先、(2) 同 outcome 内では snapshot_date 昇順最後 | open task は後日 closed snapshot で完全になるため closed 優先（finding 7）。同 outcome 内では後発 snapshot ほど lifecycle が完全（時間経過で metric が確定する） |
| **D15**（Rev 2） | `runWithAbort` helper の影響範囲 | **新 metrics 系 cmd のみ**（snapshot / compare / health）。既存 cmdEvents / cmdMetrics には適用しない | 横断的 refactor は scope creep（finding 12）。既存テストへの影響を 0 にし、本タスクは新規 cmd の追加と統合に集中 |
| **D16**（Rev 2） | schema_version migration policy | **increment-only / 過去 snapshot 再生成禁止 / v=2 移行時は両形式 loader 追加 / on-the-fly upgrade 禁止** | snapshot は fact として固定する設計（finding 13）。upgrade 入れると「再生成可能な形式」になり fact 性が崩れる。両形式 loader にすれば過去 snapshot を読み続けられる |
| **D17**（Rev 2） | alarm direction map の location | **`metrics-thresholds.ts` の `AlarmThreshold.direction`** | finding 2: spec 側は表として表示するが SSOT はコード。`evaluateAlarms` は direction を参照して比較演算子を切り替える。spec 表は direction 列を持ち、コードと値が一致する |

---

## 8. Done 判定（タスク仕様 §Done との対応）

| タスク仕様 | 対応するサブタスク |
|---|---|
| 日次 snapshot が連続収集を開始 | S2 + S3 + S10 + S11（最初の 1 日分が `.team/metrics/snapshots/` に出る + launchd plist が用意される） |
| cohort 比較ツールが動作し diff + 統計検定を出力 | S4 + S5 + S6 + **S14**（`cmux-team metrics compare` で diff / t-test / Mann-Whitney / 比率検定 / alarm 出力、e2e で結合確認） |
| baseline 開始日時が docs に記録 | S9 + S12（`docs/spec/11-metrics.md` に baseline 開始日時を確定） |
| 自動収集が落ちた場合の検知方法が決まっている | S7 + S9 + **S14**（`cmux-team metrics health` + launchd `StandardErrorPath` を spec に明記、e2e で gap 検出を確認） |

---

## 9. 実装順序の根拠

S1（統計）→ S2（snapshot 純関数）→ S3（snapshot CLI + atomic write）→ S4 + S5（compare 純関数 + alarm + per-day 派生）→ S6（compare CLI）→ S7（health CLI）→ S8（dispatch + i18n + runWithAbort）→ S9 + S10（spec + plist）→ S11（最初の snapshot 生成）→ S12（baseline 開始日確定 + artifact）→ S13（全テスト + tsc）→ **S14（e2e in-process テスト）**

理由:

1. **依存方向**: S5/S6 は S1（統計）と S2/S4（snapshot 形式）の両方に依存
2. **テスト容易性**: 純粋関数（S1, S2, S4, S5）→ CLI（S3, S6, S7）→ 結合（S8）→ e2e（S14）の順で in-process test を積み上げる
3. **Done 判定の最終確認**（S11）は CLI 実装完了後にしかできない
4. **spec 確定**（S12）は Done 直前まで遅延（baseline 開始日時 = 完了日基準で計算）
5. **e2e テスト（S14）は最後**: 全 CLI が揃ってからしか組めない。S13 の個別テスト pass を前提に結合検証

---

## 10. 補遺: 想定する実装サイズ

| ファイル | 想定 LOC（テスト除く） |
|---|---:|
| `metrics-stats.ts` | ~150 |
| `metrics-thresholds.ts` | ~30 |
| `metrics-snapshot.ts` | ~140（atomic write + path 正規化込み） |
| `metrics-compare.ts` | ~280（dedup 2 段ルール + derivePerDay + alarm direction） |
| `metrics-health.ts` | ~90 |
| `main.ts` の差分 | ~40（runWithAbort 含む） |
| `i18n.ts` の差分 | ~120（en + ja の help × 3 つ） |
| `docs/spec/11-metrics.md` | ~180 行（Markdown、UTC + SSOT 注釈 + schema migration 含む） |
| `templates/launchd/...plist.template` | ~60（UTC コメント込み） |
| **合計**（コード）| **~1090 LOC** |
| テスト（個別 + e2e）| ~750 LOC |

「変更が大きい」を理由に妥協せず、**snapshot を fact として外部化する**という構造的解決を貫くこと。Rev 2 の主眼は「fact / metadata / 派生の階層を明示する」ことと「partial state の入る余地を構造的に閉じる」（atomic write・dedup 2 段ルール・direction map・SSOT 一元化）にある。
