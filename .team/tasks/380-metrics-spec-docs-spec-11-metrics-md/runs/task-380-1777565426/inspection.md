# T380 Inspection Report

## Verdict

**GO**

## Summary

`docs/spec/11-metrics.md`（377 行）は T379 実装と整合し、6 軸 taxonomy / 撤退判定 / 多重比較補正 / Caveats 3 点をすべて備えている。glossary §11（6 用語）と CLAUDE.md（最小 +2 行）も plan §D / §E どおり。F.1〜F.8 を inspector 側で再実行し、`metrics-aggregate.ts` / `metrics-cli.ts` / `trace-store.ts` / `i18n.ts` / `dashboard-metrics.ts` の各引用が正しいことを確認した。指摘は Minor 2 件のみで GO を妨げない。

## Done 判定（タスク本体）

| 判定項目 | 達成状況 | 根拠 |
|---|---|---|
| 1. 11-metrics.md が完成 | ✓ | 7 章（§1〜§7）+ taxonomy 6 サブセクション + Data sources 5 サブセクション + CodeDNA 4 サブセクション。377 行。`grep -nE '^##\|^###' docs/spec/11-metrics.md` で確認 |
| 2. glossary.md / CLAUDE.md が更新 | ✓ | glossary §11「Metrics 関連」表に 6 用語（metrics SSOT / cohort comparison / baseline period / evaluation period / header rot / agent message GC）。CLAUDE.md は `git diff --stat` で `+2 行のみ`（リポジトリ構造表 1 行 + 進捗情報の取得方法表 1 行） |
| 3. spec の各 metric が T379 実装と整合 | ✓ | F.1〜F.6 で `metrics-aggregate.ts` / `metrics-cli.ts` / `trace-store.ts` の symbol・SQL・interface・出力 schema を逐一突合（下記 F 表） |

## F.1〜F.8 自己再実行結果

| ID | 結果 | 備考 |
|---|---|---|
| F.1 | PASS | 9 metric 名の grep ヒット件数: spec 24 / aggregate 35 / cli 30。9 metric すべてが 3 ファイルに揃って出現 |
| F.2 | PASS | `session_to_task` CTE は `trace-store.ts` の 1179 / 1220 / 1258 の 3 関数（countToolCallsByTask / firstEditPerTask / failureRateByTask）に複製。spec §3.5 の脚注で 3 関数複製の事実を明記済み。SQL 全文の逐語コピーも spec §3.5 に転載確認 |
| F.3 | PASS | spec §3.1 の terminal 4 event（`task_completed` / `task_completed_state_mismatch` / `task_aborted` / `conductor_disconnect_timeout`）は `metrics-aggregate.ts:113-118` の `TERMINAL_EVENTS` set および `classifyOutcome`（120-133）と完全一致 |
| F.4 | PASS | `PerTaskMetrics` interface（`metrics-aggregate.ts:40-56`）の 10 field（task_id / assigned_ts / closed_ts / duration_ms / outcome / tool_calls / tool_call_total / tool_failure_rate / time_to_first_edit_ms / tokens）が spec §5.1 の jq keys と完全一致。`tokens` のサブ field（input/output/cache/requests）も §2.5 / §5.1 / §5.3 で整合 |
| F.5 | PASS | `i18n.ts` の `help_metrics` Notes 3 点（deny_rate は Bash deny 限定 / task_assigned 前 hook は集計外 / tool_response.content 1KB 切り詰め）が spec §6 に転載済み。意味内容はすべて等価 |
| F.6 | PASS（方式 B） | `bun run skills/cmux-team/manager/main.ts metrics --since 7d --format json | jq '.[0] | keys'` を inspector 側で実行 → spec §5.1 期待 keys と完全一致（10 key）。`--group-by day --since 14d --format csv` のヘッダーも `PER_BUCKET_HEADER`（`metrics-cli.ts:222-238`）と完全一致（15 列）。global 4.22.0 は metrics 未収録（次回 release 待ち）— 本件は plan §F.6 m-7 で許容 |
| F.7 | PASS | 6 用語が glossary §11（行 177-182）に揃う。各エントリは要約 1-2 行 + `11-metrics.md#...` 一次リンク + 関連列のみで、二次資料方針（DRY）を遵守 |
| F.8 | PASS | `git diff --stat CLAUDE.md` → `1 file changed, 2 insertions(+)`。差分は「リポジトリ構造」表 1 行 + 「進捗情報の取得方法」表 1 行のみで新 H2 増設なし |

## Findings

### Critical

なし。

### Major

なし。

### Minor

1. **`i18n.ts` の help_metrics 行参照が ja / en 逆転**
   - 場所: `docs/spec/11-metrics.md:339`
   - 記述: 「`help_metrics`（`i18n.ts` の ja: `i18n.ts:591-627` / en: `i18n.ts:1478-1514`）」
   - 実際: `i18n.ts:27` から `const en = {`、`i18n.ts:917` から `const ja: typeof en = {` で、line 591 は **EN**（"per-task / per-period aggregate of events.jsonl..."）、line 1478 は **JA**（"events.jsonl + hook_signals + api_usage を per-task / 期間で集計する"）。
   - 影響: 文書のメタ情報レベルの誤記。Caveats 3 点本文の正確性には無影響だが、SSOT として citation を辿った読者が逆の locale に飛ぶ。
   - 修正案: `ja: i18n.ts:1478-1514 / en: i18n.ts:591-627` に入れ替え。

2. **§3.5 脚注の CTE 行レンジが片方は CTE 単独・他方は `db.prepare(\``を含む混在表記**
   - 場所: `docs/spec/11-metrics.md:211`
   - 記述: 「`trace-store.ts:1179-1184` / `1219-1225` / `1257-1263`」
   - 実態: 1 つ目（countToolCallsByTask）は CTE 単体（1179-1184）。2 つ目・3 つ目（firstEditPerTask / failureRateByTask）は `const stmt = db.prepare(\``行（1219 / 1257）を含む。CTE 単体なら 1220-1225 / 1258-1263 が正確。
   - 影響: 軽度のオフバイワン。ジャンプして読めば該当 CTE は見つかるので実害は小さい。
   - 修正案: 揃えて `1179-1184 / 1220-1225 / 1258-1263`（CTE 単体）に統一する、もしくは揃えて prepare 行から含める。

## Fix Required

GO 判定のため修正必須項目はなし。Minor の 2 件はフォローアップで対応可。

## 申し送り（GO の場合）

- **Minor 2 件は次回コミットで一括修正推奨**: spec の citation 精度は spec の信用に直結するため、別タスクではなく本タスク close 直前 or 直後に同じブランチで修正できると望ましい。修正は `docs/spec/11-metrics.md` 339 行目と 211 行目の 2 箇所のみ。
- **next: baseline 計測タスクの起票**: §4.1 の N=14 day 暫定値、§2 の `[暫定]` 警報閾値（18 箇所）、§4.4 の Bonferroni α/N=0.0125 はすべて baseline 実測後に置換が必要。spec §7「未起票（後続）」に列挙済みなので、cmux-team の `baseline 取得 → 警報閾値 update` task を起票する流れが自然。
- **next: `session_to_task` CTE 共通化リファクタタスクの起票**: §3.5 脚注で 3 関数複製の事実を明記しているが、後続改善として共通化すべき。spec 側ではなくコード側のタスク。
- **glossary anchor の rendering 検証**: GitHub の auto-anchor は `4.1 baseline period / evaluation period の定義` を `#41-baseline-period--evaluation-period-の定義`（dash 2 重）に変換する慣例だが、cmux markdown ビューア / mo / GitHub Web で実際にリンクが飛ぶかはレンダラ依存。closed 後に GitHub PR 上で目視確認しておくと安心。
- **F.6 方式 A のフォローアップ**: 次回 cmux-team 公式リリース後に `cmux-team metrics --since 7d --format json | jq '.[0] | keys'` を global 版で再実行し、source ベースと出力一致することを `t379-verify.md` 末に追記する。差分があれば npm publish 漏れ or worktree rebase 漏れの signal。
