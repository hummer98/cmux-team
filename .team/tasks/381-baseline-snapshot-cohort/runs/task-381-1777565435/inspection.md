# T381 inspection

## Verdict: GO

## Summary

Critical findings: 0 件。Major findings: 2 件。Minor findings: 2 件。GO/NOGO 基準（Critical 0 AND Major ≤ 2）を満たすため **GO** と判定する。
118 個の関連テスト全 pass、`bunx tsc --noEmit` exit 0、計画 §3.1 列挙ファイルは全て存在し、CLI が実コマンドで動作。
Major 2 件は (1) `CohortDiff.rates` から `deny_rate` が欠落しており help（en/ja）と実装が不一致、(2) plan §3.1/§S12 で要求されていた `.team/artifacts/A026-baseline-snapshot-cohort.md` 未作成。いずれも Conductor 側で軽微に修正可能で、機能の本質（snapshot/compare/health の動作と統計検定）は問題なし。

## Findings

1. **[severity: major] CohortDiff.rates に `deny_rate` が欠落、help が嘘をついている**
   - 場所: `skills/cmux-team/manager/metrics-compare.ts:206-210` (CohortDiff 型 `rates` に `completion_rate / abort_rate / forced_close_rate` のみ、`deny_rate` 不在)
   - plan §4 S5 完了条件: 「rates: completion_rate / abort_rate / forced_close_rate / deny_rate ごとに { baseline, comparison, delta_pp, delta_pct, z_test }」
   - 実 CLI 出力でも rates の keys は `["abort_rate", "completion_rate", "forced_close_rate"]` のみ（`PROJECT_ROOT='' bun ... metrics compare ...` で確認）
   - 一方 `skills/cmux-team/manager/i18n.ts:1637` (ja) / `674` (en) の help_metrics_compare は「rates: completion_rate, abort_rate, forced_close_rate, deny_rate の差分（z-test）」と書いており **help が嘘をついている**
   - spec `docs/spec/11-metrics.md:95-99` は実装に追従して deny_rate を抜いており spec とコードは一致。Plan からの逸脱として impl-report に明記もされていない（「Issues Encountered」「Decision Log」のいずれにも触れられていない）
   - 影響: ユーザが help を見て deny_rate alarm を期待するが実際は出ないため運用混乱。`derivePerDayFromSnapshots` 側では `deny_rate: 0` をハードコード（`metrics-compare.ts:394`）しており、deny_rate は snapshot fact に含まれない以上 cohort 比較から落とした判断自体は構造的に妥当。修正は help を実装に合わせる方向が低コスト

2. **[severity: major] A026 artifact が未作成（plan §3.1 / S12 違反）**
   - plan §3.1 が要求するファイル: `.team/artifacts/A026-baseline-snapshot-cohort.md` (type: decision)
   - 実状: `.team/artifacts/` 配下に `A026-*` は無し（`ls .team/artifacts/ | grep A026` → 該当なし）
   - 代わりに Implementer は `runs/task-381-1777565435/baseline-decisions.md` に Decision Log D1〜D17 + I1〜I3 を書き出し、impl-report に「artifact 化は Conductor 側で実施」と明記
   - plan §4 S12 は「`cmux-team artifacts add` 経由でのみ artifact を登録」を完了条件としていたため Done 判定要件への明示的逸脱
   - 影響: artifact 索引に T381 の決定事項が登録されず、後続タスクからの参照性が落ちる。Conductor が `cmux-team artifacts add` で `baseline-decisions.md` を取り込めば回復可能

3. **[severity: minor] `buildPayload()` が型のためだけのダミー関数になっている**
   - 場所: `skills/cmux-team/manager/metrics-compare.ts:628-640`
   - `function buildPayload()` は `return {} as never` を返すだけで `formatTextCohort(p: ReturnType<typeof buildPayload>)` の型抽出にしか使われていない
   - 推奨: `type CohortPayload = { ... }` で interface/type 宣言にすると dead-ish 関数を削除でき、ランタイム artifact がゼロになる

4. **[severity: minor] `resolveUnderRoot` が 3 ファイルに重複**
   - 場所: `metrics-snapshot.ts:219-227` / `metrics-compare.ts:498-506` / `metrics-health.ts:133-141`
   - 同じ path traversal 検査ロジックが 3 箇所に複製されている（DRY 違反）
   - 推奨: `metrics-path.ts` 等の共通モジュールに集約し、3 ファイルから import する

## Verification Log

### 1. ファイル存在 / git diff（plan §3.1 §3.2 整合）

```text
$ ls -la skills/cmux-team/manager/metrics-{stats,snapshot,compare,health,thresholds,e2e}*.ts
metrics-aggregate.ts (既存)
metrics-compare.test.ts / metrics-compare.ts          (新規)
metrics-e2e.test.ts                                   (新規, S14)
metrics-health.test.ts / metrics-health.ts            (新規)
metrics-snapshot.test.ts / metrics-snapshot.ts        (新規)
metrics-stats.test.ts / metrics-stats.ts              (新規)
metrics-thresholds.ts                                 (新規)

$ ls skills/cmux-team/templates/launchd/
com.cmux-team.metrics-snapshot.plist.template         (新規)

$ ls .team/metrics/snapshots/
2026-04-29.json   2026-04-30.json

$ git status --short  (変更 / 新規ファイル listing — 計画と整合)
 M docs/spec/glossary.md
 M skills/cmux-team/manager/i18n.ts
 M skills/cmux-team/manager/main.ts
?? .team/metrics/  .team/tasks/.../runs/
?? docs/spec/11-metrics.md
?? skills/cmux-team/manager/metrics-{compare,e2e,health,snapshot,stats,thresholds}*.ts(.test.ts)
?? skills/cmux-team/templates/launchd/
```

→ plan §3.1 / §3.2 で列挙されていたファイル群と一致。

### 2. テスト実走（個別ファイル単位）

```text
=== metrics-stats.test.ts ===     31 pass / 0 fail / 40 expect
=== metrics-snapshot.test.ts ===  15 pass / 0 fail / 44 expect
=== metrics-compare.test.ts ===   26 pass / 0 fail / 65 expect
=== metrics-health.test.ts ===    10 pass / 0 fail / 20 expect
=== metrics-e2e.test.ts ===        2 pass / 0 fail / 21 expect
=== metrics-cli.test.ts ===       16 pass / 0 fail / 33 expect (既存 — 破壊なし)
=== metrics-aggregate.test.ts === 18 pass / 0 fail / 53 expect (既存 — 破壊なし)
=== events-cli.test.ts ===        19 pass / 0 fail / 93 expect (既存 — 破壊なし)
total                            137 pass / 0 fail
```

### 3. tsc 型チェック

```text
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(no output) — exit 0
```

→ touched files / 既存とも型エラーゼロ。

### 4. 実 CLI 動作確認

```text
$ bun skills/cmux-team/manager/main.ts metrics --help     →  Subcommands: snapshot/compare/health 表示
$ bun ... metrics snapshot --help                          →  正常表示
$ bun ... metrics compare --help                           →  正常表示（finding 1: rates 説明に deny_rate が誤って含まれる）
$ bun ... metrics health --help                            →  正常表示

$ PROJECT_ROOT='' bun ... metrics compare \
    --baseline 2026-04-29..2026-04-29 --comparison 2026-04-30..2026-04-30 \
    | jq '.rates | keys'
[
  "abort_rate",
  "completion_rate",
  "forced_close_rate"
]                       ← deny_rate 欠落（finding 1）

$ PROJECT_ROOT='' bun ... metrics health --days 1
{ "missing": [], "count": 0, "days_checked": 1 }   exit 0
```

### 5. snapshot ファイル schema 検証

```text
$ jq 'keys' .team/metrics/snapshots/2026-04-30.json
["metadata", "per_task", "period", "schema_version", "snapshot_date", "window"]

$ jq '.schema_version, has("per_day"), has("metadata"), (.per_task | length), .period.completion_rate' \
    .team/metrics/snapshots/2026-04-30.json
1
false           ← per_day なし（finding 3 / D11 反映済み）
true            ← metadata sub-object 化（finding 10 反映済み）
12              ← per_task 12 件
0.9166666666666666

$ jq '.metadata' .team/metrics/snapshots/2026-04-30.json
{
  "generated_at": "2026-04-30T17:07:08.106Z",
  "events_jsonl_size_bytes": 13101,
  "events_jsonl_path": ".../.team/logs/events.jsonl",
  "traces_db_path":   ".../.team/traces/traces.db"
}
```

→ snapshot fact 形式は plan §2.2 と一致（per_day 不在 / metadata sub-object 化）。

### 6. 設計原則 / SSOT 検証

```text
$ grep aggregateMetricsByTask metrics-snapshot.ts | wc -l
2 (import + 1 invocation)            ← 二重 aggregation 排除（finding 3 反映済み）

$ grep -E "rename|atomicWrite" metrics-snapshot.ts
atomicWriteJson (定義) + writeFile(tmp) → rename(tmp, target)
                                       ← atomic write 実装（finding 4 反映済み）

$ grep resolveUnderRoot metrics-{snapshot,compare,health}.ts
all 3 ファイルに定義あり              ← path traversal 対策あり（finding 8 反映済み、ただし重複は finding 4 として記録）

# spec / コードの SSOT 一致
$ grep -E "0\.10|0\.05|0\.30" metrics-thresholds.ts docs/spec/11-metrics.md
metrics-thresholds.ts:
  completion_rate    delta=0.10 lower_is_worse  pp
  forced_close_rate  delta=0.05 higher_is_worse pp
  duration_ms_mean   delta=0.30 higher_is_worse pct
  tool_failure_rate  delta=0.05 higher_is_worse pp
docs/spec/11-metrics.md §4 警報閾値表 — 値完全一致 ✓
```

### 7. 統合 / 用語集

```text
$ grep -nE "case \"metrics\":" skills/cmux-team/manager/main.ts
5779:  case "metrics":
       → cmdMetrics() で sub-subcommand dispatch 確認

$ grep "help_metrics_(snapshot|compare|health)" skills/cmux-team/manager/i18n.ts
en: 591 / 634 / 658 / 686
ja: 1555 / 1598 / 1622 / 1649
→ en + ja 両方追加（D6 反映済み、ただし finding 1 で deny_rate 表記あり）

$ grep -nE "baseline period|evaluation period|cohort comparison|daily snapshot" docs/spec/glossary.md
177-180 行に 4 用語追加 ✓

$ sed "s#{{PROJECT_ROOT}}#/tmp#g" templates/launchd/...plist.template | plutil -lint -
<stdin>: OK ✓
```

### 8. T381 固有チェック

```text
$ grep -E "completion_rate|alarm" metrics-e2e.test.ts
e2e に "alarm 立つケース"（D1 100% → D2 20%）+ "立たないケース" 両方確認 ✓

$ ls /Users/yamamoto/git/cmux-team/.team/tasks/.../runs/task-381-1777565435/baseline-decisions.md
存在 (7127 bytes, 2026-05-04 確定 + Decision Log D1〜D17 + I1〜I3) ✓

$ ls /Users/yamamoto/git/cmux-team/.team/artifacts/ | grep A026
(no match)                            ← A026 未作成（finding 2）

$ grep "2026-05-04" docs/spec/11-metrics.md
56:- **2026-05-04 (UTC, 月曜)** ✓
60:- 4 週: **2026-05-04 〜 2026-05-31** (UTC, 両端含む) ✓
```

## 推奨修正（GO だが下記対応を推奨）

GO 判定だが Conductor で以下の修正を入れることを推奨。

1. (finding 1 — Major) `i18n.ts` の `help_metrics_compare` (en + ja) から「rates: ...deny_rate diffs (z-test)」「rates: ...deny_rate の差分（z-test）」表記を削除し実装と一致させる。あるいは plan 通り `CohortDiff.rates` に `deny_rate: RateDiff` を追加する（こちらは PeriodSummary / DailySnapshot に `period.deny_rate` を含める変更が必要で範囲広）。低コスト寄りは前者
2. (finding 2 — Major) `cmux-team artifacts add --type decision --title "T381 baseline snapshot 運用方針 + cohort 比較設計の確定" --slug baseline-snapshot-cohort --body-file .team/tasks/381-baseline-snapshot-cohort/runs/task-381-1777565435/baseline-decisions.md` 等で A026 を採番・登録
3. (finding 3 — Minor) `metrics-compare.ts:628` の `buildPayload()` ダミー関数を `type CohortPayload = { ... }` に置換
4. (finding 4 — Minor) `resolveUnderRoot` を `metrics-path.ts` 等に集約し 3 ファイルから import
