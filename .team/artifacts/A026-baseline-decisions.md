---
id: A026
type: decision
title: "T381 baseline snapshot 運用方針 + cohort 比較設計の確定"
created: 2026-04-30T17:29:17.289Z
updated: 2026-04-30T17:29:17.289Z
author: surface:510
task: 381
---

# T381 baseline snapshot + cohort 比較 — 運用方針確定

## 実装日

2026-05-01（金曜）

## baseline 開始日（spec で確定）

**2026-05-04（次の月曜、UTC）**

`docs/spec/11-metrics.md §2 baseline / evaluation 期間` に明記。

## 評価サイクル

- **baseline**: 2026-05-04 〜 2026-05-31（UTC、4 週）
- **evaluation**: CodeDNA 投入後 +4w → +8w → +12w でローリング

評価コマンド例:

```bash
cmux-team metrics compare \
  --baseline 2026-05-04..2026-05-31 \
  --comparison 2026-06-15..2026-07-12
```

## Decision Log（plan.md D1〜D17 の要約 + 実装で確定した判断）

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | snapshot 収集機構（cron / daemon / 専用 CLI + 外部 scheduler） | **専用 CLI `cmux-team metrics snapshot` + 外部 scheduler（launchd plist テンプレ提供）** | OS 依存を CLI から排除しつつ、daemon 落ち時の欠損を回避。CLAUDE.md「state を transformer の外側に持つ」「statefulness を排除」原理に整合 |
| D2 | 統計検定の選定 | **Welch's t-test を主、Mann-Whitney U（tied 補正あり）を補助、比率系は 2-proportion z-test** | 4 週 × 数十タスクの想定サイズで両方出すのが安全。Bun に統計ライブラリを足さず ~30〜100 行で自前実装（外部依存ゼロ） |
| D3 | snapshot 命名と保管場所 | **`.team/metrics/snapshots/YYYY-MM-DD.json`**（artifact ではない別ディレクトリ） | Axxx flat namespace を毎日消費する設計は破綻する。daily snapshot は raw fact、artifact は知見、性格が違う |
| D4 | 障害検知方法 | **`cmux-team metrics health` 専用サブコマンド + launchd `StandardErrorPath` で `.team/logs/snapshot.log` に流す** | compare 実行時に health チェックを混ぜると責務が広がる。独立 CLI なら CI / cron / 手動で呼べ exit code で alert 化できる |
| D5 | 警報閾値の SSOT | **コード SSOT**: `metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS` | TypeScript からマークダウンを参照する仕組みが無い。spec の閾値表は注釈で「コードを SSOT として参照」と明示し、docs-sync の運用対象とする |
| D6 | metrics サブコマンド追加方式 | **sub-subcommand パターン**（`cmux-team metrics snapshot/compare/health`） | `cmux-team token` / `pool` / `artifacts` と同型で構造的に揃う。flag 拡張は parser を歪める |
| D7 | snapshot ファイル形式 | **JSON 単一ファイル / 1 ファイル = 1 日** | DB は GC 対象で長期保管に向かない。JSON なら snapshot のスキーマを既存 aggregate 関数の戻り値そのままにできる |
| D8 | snapshot 既定 `--date`（昨日 UTC vs 当日 vs ローカル） | **昨日 UTC**（CLI 既定） | 当日を渡すと partial day を取りに行ってしまう。前日 UTC なら window が確定済みで再現性がある |
| D9 | compare 期間オーバーラップの扱い | 重なりは許容（CLI でブロックしない）、spec で運用注意 | 評価ポリシーは spec の責務、CLI は数値を出す責務に絞る |
| D10 | alarm 検出時の exit code | **exit 2**（compare CLI のみ） | exit 1 は引数エラー / IO エラーで使用済み。exit 2 で「正常実行 + alarm あり」を区別すると CI 連携が容易 |
| D11 | snapshot 形式に per_day を含めるか | **含めない**（per_task + period + metadata のみ）。per-day は compare 側で `derivePerDayFromSnapshots` 派生 | 1 日 window では per_day = 1 要素で period と重複。`aggregateMetricsByBucket` の二重 aggregation を排除 |
| D12 | snapshot atomic write | **temp file + `fs.rename`** で atomic 反映 | partial JSON ファイルが永続化されると `loadSnapshotsInRange` が永続的に skip し、その日のデータが永久欠損する |
| D13 | path traversal 対策 | **`path.resolve(projectRoot, ...)` 正規化 + projectRoot 配下チェック / 外部許可は明示フラグ `--allow-outside-project`** | `--out` / `--snapshot-dir` に絶対パス・`..` を渡されると project 外への副作用が発生する |
| D14 | snapshot dedup ルール | **2 段ルール**: (1) closed-state 優先、(2) 同 outcome 内では snapshot_date 昇順最後 | open task は後日 closed snapshot で完全になるため closed 優先。同 outcome 内では後発 snapshot ほど lifecycle が完全 |
| D15 | `runWithAbort` helper の影響範囲 | **新 metrics 系 cmd のみ**（snapshot / compare / health）。既存 cmdEvents / cmdMetrics には適用しない | 横断的 refactor は scope creep。既存テスト影響を 0 にし、本タスクは新規 cmd の追加と統合に集中 |
| D16 | schema_version migration policy | **increment-only / 過去 snapshot 再生成禁止 / v=2 移行時は両形式 loader 追加 / on-the-fly upgrade 禁止** | snapshot は fact として固定する設計。upgrade 入れると「再生成可能な形式」になり fact 性が崩れる |
| D17 | alarm direction map の location | **`metrics-thresholds.ts` の `AlarmThreshold.direction`** | spec 側は表として表示するが SSOT はコード。`evaluateAlarms` は direction を参照して比較演算子を切り替える |

## 実装で確定した追加判断

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| I1 | launchd template の配置場所 | **`skills/cmux-team/templates/launchd/`** 直下（plan の `templates/launchd/` ではなく） | 既存 templates 規約 `skills/cmux-team/templates/{en,ja}/...` と整合。spec の参照パスもこちらに合わせて修正 |
| I2 | path traversal の判定 | `path.resolve(root, value)` 後に `relative(root, abs)` が `..` で始まらないことで判定 | absolute path / `..` を含むパスを 1 つの正規化チェックでブロック可能 |
| I3 | `evaluateAlarms` の境界判定 | **strict greater (`>`) / strict less (`<`)** を使う | 浮動小数の自然な丸め誤差で「ぴったり閾値」のときに alarm 化しないため。`forced_close_rate` `+5pp` ぴったりは alarm にならない |

## 関連ファイル

- spec: `docs/spec/11-metrics.md`
- 用語: `docs/spec/glossary.md` §11
- 実装:
  - `skills/cmux-team/manager/metrics-stats.ts`
  - `skills/cmux-team/manager/metrics-snapshot.ts`
  - `skills/cmux-team/manager/metrics-compare.ts`
  - `skills/cmux-team/manager/metrics-health.ts`
  - `skills/cmux-team/manager/metrics-thresholds.ts`
- launchd template: `skills/cmux-team/templates/launchd/com.cmux-team.metrics-snapshot.plist.template`
- 最初の snapshot: `.team/metrics/snapshots/2026-04-30.json`（task=12、completion_rate=0.917）
- main.ts dispatch: `case "metrics":` → `cmdMetrics()` に sub-subcommand 分岐を追加（既存 aggregate にフォールバック）
- i18n: `help_metrics_snapshot` / `help_metrics_compare` / `help_metrics_health` を en + ja で追加
