# T381 plan.md design review (round 2)

## Verdict: Approved

## Summary

Rev 2 改訂版は、前回 Changes Requested で指摘した Critical 4 件 / Major 4 件 / Minor 5 件すべてに **Resolved 判定**で対応している。snapshot 形式から `per_day` を削除して fact / 派生の階層を明示し、atomic write・dedup 2 段ルール・direction map・閾値 SSOT 一元化・path traversal 対策・e2e in-process テスト（S14）の追加により、partial state の入る余地を構造的に閉じる方向の補強が一貫している。新たに生じた critical / major 問題は無い。templates 配置に minor な指摘が 1 件あるが Approved に影響させない。

## Resolution Status

| # | finding | severity | status | notes |
|---|---------|----------|--------|-------|
| 1 | 統合テスト/検証のサブタスクが存在しない | critical | Resolved | S14 として `metrics-e2e.test.ts` を新規追加。snapshot D1 → snapshot D2 → compare → health（gap なし / gap あり）の 5 ステップ in-process シナリオが完了条件に明記。`createDummyProject()` 流用も指示済み。Done 判定 §1 / §2 / §4 と S14 の対応も §8 で更新済み |
| 2 | alarm の metric direction map 未定義 | critical | Resolved | §2.2 Alarm direction map セクションを新設し `metrics-thresholds.ts` の `AlarmThreshold.direction` に SSOT を確定。`{ completion_rate: "lower_is_worse", forced_close_rate / duration_ms_mean / tool_failure_rate: "higher_is_worse" }` を明示。S5 で `evaluateAlarms` が direction を信頼、D17 で location 確定。spec §警報閾値表も direction 列を持つ形に揃えると S9 完了条件 (4) で要求 |
| 3 | snapshot 形式の構造的冗長 + 二重 aggregation | critical | Resolved | snapshot 形式から `per_day` を削除（per_task + period + metadata のみ）。S2 完了条件で「`aggregateMetricsByTask` を 1 度だけ呼び、period は同じ lifecycle map から `aggregatePeriod(map)` で派生」を明記。per-day は compare 側 `derivePerDayFromSnapshots`（S5）で派生。`metrics-aggregate.ts:357` の二重スキャンが排除される構造になった。S11 検証コマンドに `jq 'has("per_day")' → false` の確認を入れて regression 防止 |
| 4 | atomic write 戦略が無い | critical | Resolved | S3 完了条件に「`<dir>/.tmp-<pid>-<random>.YYYY-MM-DD.json` 書き込み → `fs.rename(tmp, target)` で atomic 反映、例外時は tmp を unlink」を明記。検証コマンドに「partial-write 中断テスト」を含める。D12 で確定 |
| 5 | タイムゾーン × launchd 起動時刻不整合 | major | Resolved | snapshot_date は UTC 基準であることを §2.2 / S9 / S10 / D8 で一貫明記。launchd 推奨時刻は **UTC 00:05 = JST 09:05** に統一（S10 は `Hour=9, Minute=5` を採用しコメントで「これが UTC 00:05 に相当 / 前日 UTC のデータを取得するため」と記載）。spec § (6) にラベルが JST 翌日 09:00 までを含む documented behavior として明記 |
| 6 | alarm 閾値 SSOT の実態不在 | major | Resolved | コード SSOT（`metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS`）に確定。spec の閾値表は「コードの `DEFAULT_ALARM_THRESHOLDS` が SSOT。spec の数値はコードと同期する運用（docs-sync 対象）」と冒頭に注釈（S9 完了条件 (5)）。D5 / D17 / S5 / S9 で一貫 |
| 7 | snapshot dedup ルールが曖昧 | major | Resolved | S4 `unionPerTask` 完了条件に **2 段ルール**を明示: (1) closed-state 優先（outcome != "open"）、(2) 同 outcome 内では snapshot_date 昇順最後。テスト fixture も「open + closed」「closed + closed」「open + open」のテーブル駆動で具体的に列挙。D14 で確定 |
| 8 | path traversal 対策が無い | major | Resolved | S3（`--out`）/ S6（`--snapshot-dir`）/ S7（`--snapshot-dir`）すべてに `path.resolve(projectRoot, value)` 正規化と projectRoot 配下チェック、外部許可は `--allow-outside-project` フラグ要求を明記。D13 で確定 |
| 9 | `readTaskLifecycle` 説明と実態の乖離 | minor | Resolved | §2.2 で「`per_task` は当該 window 内に terminal もしくは assigned があるタスク（open task は outcome=open で含まれる）」に訂正。`metrics-aggregate.ts:191-216` の実装（closed_ts ?? assigned_ts で since 判定）と一致 |
| 10 | metadata sub-object 化 | minor | Resolved | §2.2 で `metadata: { generated_at, events_jsonl_size_bytes, events_jsonl_path, traces_db_path }` の sub-object に隔離。fact / metadata の階層が JSON で分離。S2 / S11 検証で `has("metadata") → true` も確認 |
| 11 | 統計関数のエッジケース完了条件不足 | minor | Resolved | S1 完了条件に Welch（n=1 / 全分散 0 / df<=0 で `{t: NaN, df: 0, p: 1}`）/ Mann-Whitney（全値同値 / 空配列 / **rank-tie 補正項 `Σ(t³−t) / (n(n−1))` を分散から減じる**）/ 2-prop z（n=0 / p1=p2=0 or 1）の挙動と、tied ranks 多数の fixture を明示的に紐付け |
| 12 | `runWithAbort` helper の影響範囲未確定 | minor | Resolved | S8 完了条件で「**新 metrics 系 cmd 3 つのみ**（snapshot / compare / health）。既存 `cmdEvents` / `cmdMetrics` への適用は本タスクでは行わない」と限定。D15 / §5.1 リスク表でも明文化。scope creep を構造的に防止 |
| 13 | schema_version migration 戦略 | minor | Resolved | §2.2 / S9 完了条件 (7) / D16 で「schema_version は increment-only / 過去 snapshot は再生成禁止 / v=2 移行時は両形式を読める loader を追加 / on-the-fly upgrade 禁止」を明記。fact 性を崩さない方針 |

## New Findings

### N1. [severity: minor] launchd plist テンプレートの配置パスが既存規約と異なる

§3.1 で `templates/launchd/com.cmux-team.metrics-snapshot.plist.template` を新規作成と書かれているが、現リポジトリには **トップレベル `templates/` ディレクトリは存在せず**、`skills/cmux-team/templates/` のみ存在する（中身は `en/` と `ja/`、agent role テンプレ用）。CLAUDE.md §「テンプレートの追加」も `skills/cmux-team/templates/<role-name>.md` を前提としている。

実装フェーズで以下のいずれかを選択する余地を残せばよい:

- (a) `skills/cmux-team/templates/launchd/...` に置く（既存 templates/ 直下に並べる）
- (b) `templates/launchd/...` をトップレベルに新設する（CLI からの参照パスを明確化したい場合）

どちらでも本タスクの構造原理には影響しない。S10 完了条件の「cmux-team 既存テンプレート命名規約に揃える」というガイダンスが配置場所に踏み込んでいないため、実装者が判断する形でよい。Approved には影響させない。

### N2. [severity: minor] S14 e2e テストでの統計検定 p-value が NaN / 1 になる可能性

S14 シナリオは「2 日分の terminal イベントを持つタスクを複数」程度の小サンプルを想定しているが、各日 1〜2 タスク程度だと Welch's t-test が `n=1 同士`に近い状態になり、S1 完了条件で定義した `{ t: NaN, df: 0, p: 1 }` が大量に出る。S14 の完了条件は「stdout に diff（metrics + rates + alarms + samples）が出ることを assert」とあり、p-value の値域までは検証していないため **テスト自体は通る**が、e2e の実効性として「実際に alarm が立つケース」も少なくとも 1 ケース含めると compare CLI の exit 2 経路が e2e で確認できる。

実装フェーズで「明らかに alarm を発火する fixture（completion_rate を D1 vs D2 で 100% → 50% にする等）」を 1 ケース足すだけで足りるので、S14 完了条件への小さな追記で十分。Approved には影響させない。

## Notes（参考情報）

- 改訂版 §0 Revision Log（13 項目）と §3 / §4 / §7 / §8 の対応は整合している。S14 の追加が §3.1（新規ファイル `metrics-e2e.test.ts`）/ §4（サブタスク S14）/ §8（Done 判定 §1 / §2 / §4 → S14）すべてに反映済み。
- snapshot ファイル形式から `per_day` を削除した影響（S2 完了条件、S11 検証コマンド、§5.2 エッジケース、D11、`derivePerDayFromSnapshots` の compare 側派生）は全箇所で一貫。残存箇所なし。
- `DEFAULT_ALARM_THRESHOLDS` の SSOT 配置は D5 / D17 / S5 / S9 で一貫。`metrics-thresholds.ts` を import する箇所（compare CLI / spec の参照注釈）も矛盾なし。
- e2e テスト S14 のスコープ（snapshot → compare → health）は 5 ステップで完結し、in-process / tmp dir 隔離 / `captureStreams()` 流用も明示。実装可能性は高い。
- §6「既存型エラーの先読み」で `bunx tsc --noEmit` exit 0 を確認済み（2026-05-01 時点）。新規ファイル追加で型エラーが出た場合は本タスク内で修正する基準を S13 と整合する形で維持している。

## 結論

Critical / Major findings がすべて Resolved、新規 critical / major なし、構造的整合性も保たれているため **Approved**。S11 / S12 / S14 を含む実装フェーズに進んで問題ない。N1 / N2 の minor は実装者判断で吸収可能。
