# T380 plan.md (rev2) Design Review

## Verdict

**Approved**

## Summary

rev1 で指摘した Major 3 件・Minor 8 件は **すべて plan.md rev2 に反映済み**。改訂履歴の主張と本文を突き合わせた結果、各指摘に対応する具体的な記述を §A〜§G の該当箇所に確認できた。整合性の二次確認（§C ↔ §B §2 / §B §4.4 ↔ §G.2 / §E ↔ §F.8 / §G.1）も問題なし。新規不整合は致命的なものなし（後述の Recommendations で 1 件文言指摘あり）。Implementer フェーズに進めてよい。

## Reflection check

| 指摘 ID | 内容 | 反映状況 | 引用箇所 |
|---|---|---|---|
| **M-1** | `tool_failure_rate` を「2.2 制約違反系」→「2.1 探索コスト系」へ移動、§2.2 は `deny_rate` のみ | ✓ | plan.md L161-163（§B §2.1 末尾注釈・§2.2 から除外を方針化）、L240（§C マトリクス 2.1 探索コスト系に `tool_failure_rate` を配置、「無駄な試行コスト」と注釈）、L241（§C §2.2 は `deny_rate` のみ） |
| **M-2** | §4.4 撤退判定に多重比較補正（BH / Bonferroni）を式レベルで明記、§G.2 にも反映 | ✓ | plan.md L186-190（§B §4.4 で「adjusted p<0.05」「α/N または BH 補正後 adjusted p<0.05」を明記、推奨 BH・代替 Bonferroni）、L403（§G.2 リスク表に「副作用系 N metric 同時検定で familywise α 膨張」行を追加、4 metric で ~18% の根拠も含む） |
| **M-3** | `dashboard-metrics.ts` との関係を §1 概要に 2-3 行で追記、SSOT は CLI 側と明示 | ✓ | plan.md L146-147（§B §1 概要の予告に「実装の SSOT は `metrics-aggregate.ts`（CLI 側）」「`dashboard-metrics.ts` は同じ `trace-store.ts` の SQL を呼ぶ別系統の UI ビルダーで、CLI と互換する数値を Manager dashboard の Metrics タブに表示する」を明記） |
| **m-1** | §A.1 PerTaskMetrics 列挙に `assigned_ts` / `closed_ts`、PerBucketMetrics に `bucket` を追加 | ✓ | plan.md L29（PerTaskMetrics: `task_id, outcome, assigned_ts, closed_ts, duration_ms, ...`）、L30（PerBucketMetrics: `bucket, tasks_assigned/completed/aborted, ...`） |
| **m-2** | §3.5 で `session_to_task` CTE が 3 関数に複製されている事実を脚注化（行番号併記） | ✓ | plan.md L172（§B §3.5 予告末尾に「`countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の 3 関数に複製されている（`trace-store.ts:1179-1184` / `1219-1225` / `1257-1263`）」） |
| **m-3** | CLAUDE.md は候補 2（最小変更）を採用、新 H2 増設しない | ✓ | plan.md L274-296（§E 全体で「採用方針: 候補 2（最小変更）」「やらないこと: 新 H2 セクションは作らない」を明記、理由として H2 が 20+ あり散漫化を回避）。波及確認: L100（§A.7 「編集対象は **2 箇所のみ**」）、L394（§G.1 「最小変更方針: ... 新 H2 は追加しない」）、L375-380（§F.8 「差分が 2 行のみであることを確認」） |
| **m-4** | §4.3 に正規性検定（n<30→Shapiro-Wilk / n≥30→CLT）と等分散性（Levene → 不等なら Welch）を事前確定 | ✓ | plan.md L182-184（§B §4.3 に 1 行ずつ事前確定として記載）、L410（§G.2 リスク表でも 3 条件を明示しフローチャート方針を強化） |
| **m-5** | §4.1 に N=14 day の根拠（cohort 内 task 数 30+ を確保する短期境界）と再評価方針を予告 | ✓ | plan.md L179（§B §4.1 「**N=14 day の根拠**: cohort 内 task 数 30+ を確保しやすい短期境界として暫定設定。後続タスクで実測値を見て再評価する旨を併記」）、L404（§G.2 リスク表に対応行追加） |
| **m-6** | §2.1 末尾 disclaimer「探索コスト系の variance / 平均は §2.6 俯瞰系に集約（軸の二重カウント回避）」 | ✓ | plan.md L162（§B §2.1 末尾 disclaimer の予告として明記、`tool_call_stddev` を §2.6 に置く判断の justify となる） |
| **m-7** | §F.6 のコマンド例に `bun run skills/cmux-team/manager/main.ts metrics ...` の source 直接実行を併記 | ✓ | plan.md L350-364（§F.6「方式 A: global インストール版」「方式 B: worktree 内 source 直接実行（検証時の優先手段）」を併記、両方式の出力一致確認も明記） |
| **m-8** | §5 text 例の予告に `tool_calls={"Read":12,...}` 形式の JSON-encoded value とパース方法を明示 | ✓ | plan.md L201-204（§B §5 text format 注記として「`tool_calls` は object 型のため JSON-encoded value として 1 行内に埋め込まれる」「`tool_calls=` の後の `{...}` を JSON.parse する」を明示） |

## New Findings

rev2 改訂で新規に出た問題は **致命的なものなし**。文言レベルの軽微な指摘 1 件のみ：

### n-1（軽微）§D 冒頭の「5 用語 → 実際は 6 用語」の説明が分かりにくい

- **箇所**: plan.md L253-255 / L268
- **内容**: 「タスク本体に書かれた 5 用語に加え `baseline period` と `evaluation period` は 1 行で並べて 1 セクション化する」と書かれているが、実際の表（L259-266）は 6 行（`metrics SSOT` / `cohort comparison` / `baseline period` / `evaluation period` / `header rot` / `agent message GC`）。L268 の補足で「5 + 2 = 6 用語、差分は 1 行のみで実害なし」と注記されているが、L255 の「5 用語に加え 2 用語」と本文表 6 行の差分が読み取りにくい。
- **影響**: glossary §11 として 6 行追加することは表で確定しているので、Implementer の作業に支障はない。
- **対処**: Phase 3 で Implementer が glossary を更新する際、表の 6 行をそのまま転記すればよく、plan.md の文言は変更不要。気になれば Implementer が glossary 更新ついでに plan.md L253-268 の表記を「6 用語（タスク本文の 5 用語 + `baseline period` / `evaluation period` を別エントリ化、ただし合計は 6）」のように整理してもよい。

## Recommendations

Approved のため Implementer（Phase 3）への申し送り事項のみ：

1. **§4.4 で同時検定する N metric を spec 段階で決め切るか検討**: 現時点の副作用系実装済み metric は `tokens.{input, output, cache, requests}` の 4 種。Bonferroni を例示するなら α/N=0.0125 を spec §4.4 に数値で書いておくと「将来 metric が増えると N が変わる」点と合わせて読者が混乱しにくい（オプション）。

2. **§F.6 の global vs source 出力一致確認**: 出力差分が出た場合、worktree の source が ahead で global が古いケースが想定される。差分検出時の対応（global 再インストール or source 優先）を `t379-verify.md` に書き残しておくと、後続タスクの再現性が上がる。

3. **§D の文言整理**（任意）: New Findings n-1 のとおり、glossary 表の 6 行を確定値として書き、L253-268 の前置きは Implementer が必要に応じて整理。

4. **§2.1 / §2.2 の各テーブル末尾注釈の漏れ防止**: M-1 / m-6 の注釈は §B の予告で複数箇所に散らばっている（L161-163）。spec 本体を書く際、§2.1 テーブル末尾に 2 行（`tool_failure_rate` の意味注釈 + 二重カウント回避 disclaimer）を確実に入れる。F.x チェックでは表本体の field 名しか grep していないので、注釈の漏れは目視確認が必要。

5. **§A.1 引用列挙と spec §5 出力例の整合**: m-1 で列挙が補強されたが、F.4 の grep は interface 定義側を検証するのみ。spec §5 の JSON 例で `assigned_ts` / `closed_ts` / `bucket` を例示し損なわないよう、spec を書く際に §A.1 の列挙を例の元ネタとして使うとよい。
