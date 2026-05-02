# T381 summary: baseline 定期 snapshot 自動収集 + cohort 比較ツール

## 概要

T379 で実装した `cmux-team metrics` を sub-subcommand 化し、`snapshot` / `compare` / `health` 3 サブコマンドと統計検定（Welch's t-test / Mann-Whitney U / 2-proportion z-test）、warning 閾値判定機構、launchd 用 plist テンプレート、運用 spec を新規追加。baseline period（2026-05-04〜2026-05-31）の連続計測を可能にする。

## 完了したサブタスク（plan §4 / S1〜S14）

| # | 内容 | 状態 |
|---|---|---|
| S1 | 統計関数 (Welch / Mann-Whitney / 2-prop z) | done |
| S2 | snapshot 純関数 `buildDailySnapshot`（二重 aggregation 排除） | done |
| S3 | snapshot CLI + atomic write + path traversal 対策 | done |
| S4 | snapshot ローダ + dedup 2 段ルール | done |
| S5 | `compareCohorts` + `evaluateAlarms` + direction map | done |
| S6 | compare CLI（exit code 2 = alarm あり） | done |
| S7 | health CLI（snapshot ギャップ検出） | done |
| S8 | main.ts dispatch + i18n + `runWithAbort` | done |
| S9 | spec `docs/spec/11-metrics.md` + glossary | done |
| S10 | launchd plist テンプレート（JST 09:05 = UTC 00:05） | done |
| S11 | 最初の 1 日分 snapshot 生成 | done |
| S12 | baseline 開始日確定（2026-05-04 UTC 月曜） | done |
| S13 | tsc + 全テスト pass | done |
| S14 | e2e in-process テスト | done |

加えて Inspector 指摘 (Major 1 + Minor 2) を fix フェーズで反映:
- help_metrics_compare の `deny_rate` 表記削除（en + ja）
- `buildPayload()` ダミー関数を `type CohortPayload` に置換
- `resolveUnderRoot` を `metrics-path.ts` に集約（DRY 違反解消）

## 変更ファイル

### 新規

- `skills/cmux-team/manager/metrics-stats.ts` — Welch / Mann-Whitney / 2-prop z / normalSF / studentTSF
- `skills/cmux-team/manager/metrics-stats.test.ts` — 31 tests
- `skills/cmux-team/manager/metrics-snapshot.ts` — `buildDailySnapshot` + `runMetricsSnapshotCli`
- `skills/cmux-team/manager/metrics-snapshot.test.ts` — 15 tests
- `skills/cmux-team/manager/metrics-compare.ts` — `loadSnapshotsInRange` / `unionPerTask` / `compareCohorts` / `evaluateAlarms` / `derivePerDayFromSnapshots` / `runMetricsCompareCli`
- `skills/cmux-team/manager/metrics-compare.test.ts` — 26 tests
- `skills/cmux-team/manager/metrics-health.ts` — `findSnapshotGaps` + `runMetricsHealthCli`
- `skills/cmux-team/manager/metrics-health.test.ts` — 10 tests
- `skills/cmux-team/manager/metrics-thresholds.ts` — `DEFAULT_ALARM_THRESHOLDS` SSOT
- `skills/cmux-team/manager/metrics-path.ts` — `resolveUnderRoot` 共通化
- `skills/cmux-team/manager/metrics-e2e.test.ts` — snapshot D1/D2 → compare → health 結合テスト 2 ケース
- `docs/spec/11-metrics.md` — snapshot schema / baseline / evaluation / 警報閾値 / 運用 / failure 検知
- `skills/cmux-team/templates/launchd/com.cmux-team.metrics-snapshot.plist.template`
- `.team/metrics/snapshots/2026-04-29.json` — 空 snapshot
- `.team/metrics/snapshots/2026-04-30.json` — 12 task の実 snapshot

### 変更

- `skills/cmux-team/manager/main.ts` — `cmdMetrics()` を sub-subcommand 化、`runWithAbort` helper 追加
- `skills/cmux-team/manager/i18n.ts` — en + ja の help_metrics_{snapshot,compare,health} 追加
- `docs/spec/glossary.md` — §11 に baseline period / evaluation period / cohort comparison / daily snapshot を追加

## テスト結果

```
metrics-stats.test.ts       31 pass / 0 fail (40 expect)
metrics-snapshot.test.ts    15 pass / 0 fail (44 expect)
metrics-compare.test.ts     26 pass / 0 fail (65 expect)
metrics-health.test.ts      10 pass / 0 fail (20 expect)
metrics-e2e.test.ts          2 pass / 0 fail (21 expect)
metrics-cli.test.ts         16 pass / 0 fail (33 expect)  # 既存
metrics-aggregate.test.ts   18 pass / 0 fail (53 expect)  # 既存
events-cli.test.ts          19 pass / 0 fail (93 expect)  # 既存
total                      137 pass / 0 fail
```

`bunx tsc --noEmit` (in `skills/cmux-team/manager/`): exit 0、touched files の型エラーゼロ。

## Done 判定対応（task §Done との対応）

| 仕様 | 対応 |
|---|---|
| 日次 snapshot が連続収集を開始 | S11 で `.team/metrics/snapshots/2026-04-30.json` を生成（schema_version=1, per_task=12, completion_rate=0.917） |
| cohort 比較ツールが動作 | S6 `cmux-team metrics compare --baseline ... --comparison ...` で diff + 統計検定 + alarm 出力（alarm あれば exit 2） |
| baseline 開始日時が docs に記録 | `docs/spec/11-metrics.md §2` に **2026-05-04 (UTC, 月曜)** を確定 |
| 自動収集が落ちた場合の検知方法 | `cmux-team metrics health --days N` で gap 検出、launchd `StandardErrorPath` を `.team/logs/snapshot.log` に流す例を spec に記載 |

## Decision Log（D1〜D17 / I1〜I3）

詳細は `baseline-decisions.md` 参照（Conductor が `cmux-team artifacts add` で artifact 化）。

主要決定:
- **D1**: snapshot 機構は **専用 CLI + 外部 scheduler** ハイブリッド（OS 非依存 / daemon 落ち欠損なし）
- **D2**: 統計検定は Welch（連続値）+ Mann-Whitney（補助）+ 2-prop z（比率）の 3 種
- **D3**: snapshot 保管は `.team/metrics/snapshots/` に分離（`.team/artifacts/` の Axxx flat namespace を消費しない）
- **D5/D6/D17**: alarm 閾値は `metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS` がコード SSOT、spec は同期
- **D7**: snapshot 形式は JSON 1 ファイル/日（DB は GC 対象で長期保管に向かない）
- **D8**: 既定 `--date` は **昨日 UTC**（partial day を踏まない / TZ 依存排除）
- **D11**: snapshot から `per_day` を削除（per_task + period のみ、二重 aggregation 排除）
- **D12**: atomic write（temp file + fs.rename / 例外時 unlink）
- **D13**: path traversal は `path.resolve(root, value)` + `relative` で `..` チェック、外部許可は `--allow-outside-project`
- **D14**: dedup は (1) closed-state 優先, (2) snapshot_date 昇順最後の 2 段
- **D15**: `runWithAbort` helper は新 metrics 系 cmd のみに適用（scope creep 防止）
- **D16**: schema_version は increment-only / 過去 snapshot 再生成禁止（fact 性確保）
- **I1**: launchd template は `skills/cmux-team/templates/launchd/` 配下に配置（既存規約整合）

## 残課題（cleanup 候補）

- `runWithAbort` helper の既存 `cmdEvents` / `cmdMetrics` への展開（D15 でスコープ外と確定）
- `derivePerDayFromSnapshots` を CLI から露出（per-day cohort trend 出力）

これらは本タスクのスコープ外。後続タスクとして検討可能。

## マージ情報

- branch: `task-381-1777565435/task`
- マージ方法: ローカル ff-only マージ（main へ）
- マージコミット SHA: 後段で記録
