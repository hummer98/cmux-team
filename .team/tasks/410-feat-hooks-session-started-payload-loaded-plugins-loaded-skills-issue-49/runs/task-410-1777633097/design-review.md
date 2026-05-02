# T410 Design Review

## Verdict: Approved

## Summary

`cmux-team send SESSION_STARTED --from-stdin` を hook として既存稼働させた構造を尊重しつつ、enrichment 取得を `cmdSend` 内部に閉じる設計（D1）は CLAUDE.md の「hook shell に分岐ロジックを持たせない」原則を厳守する妥当な構造的解決である。skills の `<source>:<name>` prefix 規則（D2）と null fallback（D3）は cohort 比較で「unknown / empty / loaded」を判別可能な意味論を与えており、§4 CodeDNA 評価判定基準の前提と整合する。subtask 分解（S1〜S10）は全変更対象を網羅し、`buildMessageFromHookInput` を sync 維持する判断（D6）も既存 7 箇所の呼び出しサイトへの破壊変更を回避する観点から正当化されている。Critical findings は無いが、実装着手前に以下の Recommendations を反映することで品質を底上げできる。

## Findings

### F1. [major] timeout 超過時の child process kill 機構が plan §S1 「メソッド制約」で明示されていない

- plan §5.2 / §S1 で「timeout は 3 秒」と書かれているが、`Bun.spawn` を timeout option で起動するのか、別途 `setTimeout` + `proc.kill()` で殺すのかが未定義。
- `cmdSend` は hook bash command (`2>/dev/null || true`) から呼ばれる短命 process なので、parent が exit しても claude CLI 子孫プロセスが orphan として残るリスクがある（POSIX 上、bash は子の SIGHUP propagation を保証しない）。
- 検証観点: 実装で `Bun.spawn({ timeout: 3000, killSignal: "SIGTERM" })` 等の標準 option を使い、stdout 破棄経路で reader がブロックしないことを確認する必要がある。
- review 観点 4「timeout 後の orphan process が滞留しないか」に直接対応。

### F2. [major] CRITICAL チェック項目「統合テスト/検証」: S8 e2e の `claudeAvailable()` skip ガードで CI green が常時担保される一方、cold start 含む実機 latency 検証が plan に組み込まれていない

- plan §5.3 で「概算 100〜500ms」と推定値があるが、実測値を記録する subtask が無い。
- claude CLI の cold start（plugin metadata cache miss 時）が 3s timeout に近づくと、null fallback が頻発する degradation を運用後まで気付けない。
- 検証観点: S8 の検証コマンドに「実機で 3 回連続実行し p95 latency を取得、3 秒以内に収まることを確認」を追加する。

### F3. [major] D5 の skill walk で `SKILL.md` 存在チェックを skip する判断の trade-off が plan §3.4 / §5.2 で根拠不足

- 主張「`claude plugins list --json` の `installPath` が enabled plugin に限定されているので skills/ 配下の dir はほぼ確実に有効」は確からしいが、plugin によっては `skills/_shared/` のような共通 helper dir を含むケースがある。
- noise skill 混入は cohort 比較で「skill X の存在」を見るときの偽陽性になり得る（特に cohort 比較対象 plugin が helper dir を持つ場合、skill cardinality が膨張する）。
- 一方で stat call はせいぜい (plugin 数 × skills/ 内 dir 数) 件で、現実的に 100 件以下なので latency 増分は数 ms。
- 検証観点: stat call の cost vs noise リスクを再評価し、plan で「将来 noise が観測されたら follow-up」と明記するか、最初から `existsSync(<dir>/SKILL.md)` を入れるかを決める。

### F4. [minor] `loaded_skills` の semantic が「実際に load された skill」と plan で列挙する「利用可能な skill 全部」で乖離している

- task.md §1 は「loaded_skills は session で実際に読み込まれた skill 全体を表す」と書く。
- plan の D5 / §3.4 の実装は「インストール済み・参照可能な skill dir 全部」（loaded ≠ activated）。
- Claude Code の skill activation は description に基づく動的判断なので「実際に loaded された」を session 単位で取得する API は存在しない。現実解として「利用可能な skill 全部」を取るのは妥当だが、命名が誤解を招く。
- 検証観点: plan §0 / §S9 の docs §3.5.2 に「loaded_skills semantic = "session で参照可能な skill (loaded ≠ activated)"」を明記すべき。

### F5. [minor] `JSON_EXTRACT` での `[]` 空配列と NULL の区別が plan §S9 §3.5.2 SQL 例で曖昧

- review 観点 7「空配列 vs unknown が SQL レベルで判別可能か」に対し、plan §S9 で `JSON_EXTRACT(loadedPlugins, '$') IS NULL` の例があるが、SQLite json1 の挙動として:
  - field absent → NULL
  - field が JSON null → NULL
  - field が `[]` → 文字列 `"[]"` あるいは JSON array
- 「unknown vs ロード 0 件」の判別には `JSON_TYPE(payload_json, '$.loadedPlugins')` が `'null'` か `'array'` か、または `JSON_ARRAY_LENGTH(...)` が 0 かを用いる必要がある。
- 検証観点: plan §S9 完了条件に「unknown と空配列を区別する SQL idiom (例: `JSON_TYPE = 'array' AND JSON_ARRAY_LENGTH = 0` を 'empty' と扱う) を spec に追記」を含めると consumer 実装時に迷わない。

### F6. [minor] `cmux-team` 自身が plugin として install されている self-detection ケースが plan に未記述

- review 観点 7「cmux-team 自身が plugin として install されているケース (self-detection) の handling」に対し、plan で言及無し。
- `claude plugins list --json` 出力に `cmux-team@hummer98-cmux-team` が含まれることが想定される（task.md fixture 例にも記載）。
- 実害は無い（recursive spawn になるパスは存在しない）が、plan §5.2 エッジケースに「self-detection: cmux-team plugin が enabled の場合、loadedPlugins に自身の id が含まれる。これは正常動作」を明記しておくと将来の混乱を避けられる。

### F7. [minor] plugin id と skill prefix で format が異質である点の spec 説明が不足

- plan §S9 の docs §3.5.2 で format を明記する予定だが、現状以下が混在:
  - plugin: `<id>@<source>` 形式（claude CLI 出力の `id` field をそのまま採用） — 例: `cmux-team@hummer98-cmux-team`
  - skill: `<source>:<name>` の 3 source prefix（plugin / user / project）
- cohort filter 用 SQL idiom が format ごとに異なる。spec で format BNF と SQL 例を併記しないと consumer がパース誤りを起こしやすい。
- 検証観点: §3.5.2 に format BNF + 各 format に対する `LIKE` SQL 例を含める。

### F8. [minor] hook 同時多発時の `claude plugins list --json` 並列 spawn の robustness 検証が plan で「実測で問題発覚したら follow-up」止まり

- plan §5.2 「hook の同時多発」で「CLI 自身が serialize する責任。実測で問題発覚したら follow-up」と認識はあるが、複数 Conductor が同時に Master spawn → 同時 SessionStart 時の競合（claude CLI の cache file lock 等）が未検証。
- 実害が出ても null fallback で本体送信は継続するので破滅的ではないが、「null fallback ばかり発生して cohort 解析の data 欠損」が起きると気付きにくい。
- 検証観点: 運用 telemetry として「session-enrichment 取得が null fallback になった件数」を `manager.log` に warn で記録するロジックを S6 に含めることで、運用後に気付ける形にする。

### F9. [minor] D5 の `readdirSync` を `withFileTypes: true` で呼ぶ判断は妥当だが、symlink 解決の方針が未明示

- plan §S1 メソッド制約で `readdirSync(<installPath>/skills, { withFileTypes: true })` で directory のみ抽出とあるが、`isDirectory()` は symlink を follow しない（`isSymbolicLink()` を別途判定する必要がある）。
- plugin が symlink で skill を提供する稀な構成では false negative。
- 検証観点: 実装ガイドとして「symlink は dirent.isDirectory() === false かつ isSymbolicLink() === true。lstat で再評価せず skip する（最初は単純実装）」を S1 に明記。

## Recommendations

Findings は全て Approved 範囲（Critical 0件）の改善提案だが、実装着手前に plan に反映することで手戻りを最小化できる:

1. **F1 対応**: S1 「メソッド制約」に「`Bun.spawn({ timeout: 3000, killSignal: 'SIGTERM' })` で起動し timeout 時の child / grandchild kill を runtime に委譲。stdout reader は `Bun.readableStreamToText` 等で blocking しない pattern を使う」を追記。
2. **F2 対応**: S8 「検証コマンド」に `time bun -e "import { collectSessionEnrichment } from './session-enrichment'; await collectSessionEnrichment()"` を 3 回連続実行し、p95 latency が 3s 以内に収まることを記録するステップを追加。
3. **F3 対応**: D5 を「初期実装は dir 名のみ、stat call 追加は noise 観測時の follow-up」と明記。または `existsSync(<dir>/SKILL.md)` を初期から導入し、cost を許容する判断のどちらかを明確化。
4. **F4 対応**: §S9 docs §3.5.2 の冒頭で「loaded_skills は session が参照可能な skill 集合（loaded ≠ activated）。activation は description-based の動的判断のため取得不可能」を明記。
5. **F5 対応**: §S9 docs §3.5.2 SQL 例に「unknown vs empty の判別 idiom (`CASE WHEN JSON_TYPE(payload_json, '$.loadedPlugins') = 'null' THEN 'unknown' WHEN JSON_ARRAY_LENGTH(payload_json, '$.loadedPlugins') = 0 THEN 'empty' ELSE 'loaded' END`)」を含める。
6. **F6 対応**: plan §5.2 エッジケース表に「self-detection: cmux-team plugin が enabled の場合、自身の plugin id が loadedPlugins に含まれる。これは正常」を 1 行追加。
7. **F7 対応**: §S9 docs §3.5.2 に format BNF（`plugin_id ::= <name>@<source_id>`, `skill_id ::= <source>:<name>` where `source ∈ {plugin, user, project}`）と各 format の `LIKE` SQL 例を併記。
8. **F8 対応**: S6 「完了条件」に「enrichment が null fallback になった場合は `manager.log` に `warn session_enrichment_null_fallback reason=<exception_class>` で記録」を追加。
9. **F9 対応**: S1 「メソッド制約」に「symlink dir は initial 実装では skip。`dirent.isDirectory() === true` のみを skill 候補とする」を追記。

将来 follow-up 検討事項（本タスク scope 外）:
- D1 で見送った `cmux-team session-enrichment --json` subcommand 化は debug 用途で価値がある。enrichment が null fallback になる頻度が運用観測で問題化したら新タスクで検討。
- §3.5.2 SQL idiom が dashboard / metrics compare CLI で頻繁に使われるようになったら view 化（`hook_signals_session_started_enriched`）を検討。
