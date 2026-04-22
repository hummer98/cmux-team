# T295 design review

**Reviewer**: design-reviewer
**Run**: task-295-1776828703
**Target**: `.team/tasks/295-close-task/runs/task-295-1776828703/plan.md`
**Base commit**: 4d484d2 (T294 完了)

## Verdict: Approved

## Summary

plan.md は「`close-task` に納品方式を構造化スロットとして持たせる」という本質課題を正しく捉えており、zod discriminated union + pure parser 分離 + SSOT（`formatDeliverable` 単一配置）という構造的に妥当な解決を採っている。既存 `QueueMessage` と同じパターン踏襲、旧 closed 行の後方互換、auto-close 経路（DL-02）と Conductor 自己書き換え（§9）の扱いまで踏み込んで設計されており、21 ファイルの変更範囲は S1〜S11 のサブタスクで網羅されている。CRITICAL チェック項目も全通過。

## CRITICAL チェック項目の検証

| # | 項目 | 結果 | 根拠 |
|---|------|------|------|
| 1 | サブタスクカバレッジ | ✓ | §3.1 の 21 ファイルは S1（schema）/ S2（task）/ S3（main.ts CLI + trace）/ S4（daemon auto-close）/ S5（i18n）/ S6（dashboard + TaskSummary）/ S7（trace-task）/ S8（テンプレ ja/en 各 3）/ S9（docs/spec + CLAUDE.md）/ S10（tests）/ S11（検証）に漏れなく対応 |
| 2 | 統合テスト/検証 | ✓ | S10 で `runCli` 経由の integration テスト（kind × 付随フラグの組合せ 7 ケース）、S11 で手動 dashboard / trace-task 動作確認が明記されている |
| 3 | 既存テストへの影響 | ✓ | `main.test.ts` L586 / L643 / L654 / L667 / L702、`daemon.test.ts` T274（実 L4532〜）、`task.test.ts` の更新が S10 に入っている（L4534 は 2 行ズレあり、下記 F5） |
| 4 | Conductor テンプレ自己書き換えの検証 | ✓ | §9 で「Step 8 rebase 検証と Step 9 の ff-only マージ検証を丁寧に行う」ことと、T274 の CHANGELOG L78 を前例として運用通知する点が明記されている |

## Findings

### F1. [minor] `--force` と新フラグの相互作用が明示されていない

`cmdCloseTask`（main.ts L3049）の assigned ガードは現状 `currentStatus === "assigned" && !journal && !force` で成立する。plan S3 は「既存の assigned ガードは保持」と書くが、T295 後は `--deliverable-kind` が必須化されるため、assigned タスクを kind 指定のみ（journal なし・force なし）で close しようとする呼び出しが以下 2 通りに分岐する。

1. assigned ガードを通過し、新パーサでの kind 検証を経て成功する
2. 旧ガード条件通り `--force` / `--journal` 無しで exit 1 になる

どちらを採るかは単なる判断で、本タスクの構造的正しさには影響しないが、plan レベルで「assigned + kind 指定のみ（journal なし）」の許容可否を 1 行明記し、テストケースを S10 に 1 本追加しておくと後工程で揺れない。

### F2. [minor] 旧 closed 行の読み取り互換テストが 1 箇所しか示されていない

S10 は `task.test.ts` で「旧 closed 行の後方互換 test」を追加する旨を含むが、plan のユーザー体験（dashboard / trace-task が旧行を壊さず表示）に直結する以下 2 観点のテストが subtask 内に列挙されていない。

- 旧 closed 行に対して `trace-task` が `Deliverable: -` を出す
- 旧 closed 行に対して dashboard の `buildTaskRow` が kind suffix を付けない

S10 のテスト列挙（9 項目目以降）に明示しておくと、S6 / S7 の実装時に「旧行 = 出さない」を漏らしにくい。

### F3. [minor] S7 の Deliverable 行位置に対する race 記述

S7 は「L3913 `console.log("Base: -")` の直後に Deliverable 行を追加」としているが、該当箇所は `assignedRow` 有無の if/else 2 経路に分岐しており（実 L3906〜3913）、Deliverable 行もこの if/else の外側で 1 回だけ出力する想定と読める。plan にはこれが明記されていない（「Base 行の直後」だけ）。実装者が if/else 内側に 2 箇所書き入れる誤読を避けるため、「Base 行 if/else の**後**で 1 回」と書くとより安全。

### F4. [minor] `help_trace_task` の更新が S9 に含まれていない

S7 で `trace-task` 出力に Deliverable 行が追加されるが、`i18n.ts` の `help_trace_task`（S7 セクションに言及なし）を更新するか否かが plan に明記されていない。出力仕様が増えるため help 文言の 1〜2 行更新が望ましいが、S5（`help_close_task` のみ）にも S9（docs 系）にも現れていない。小さな取りこぼし。

### F5. [minor] 参照行番号の軽微なドリフト

- §2.4 で `QueueMessage` を L148 と記載（現状一致：L148）
- S2 で `loadTaskState` の既存 `catch` を L315 と記載（現状一致：L314〜317）
- §3.1 #7 で `daemon.ts:TaskSummary` を L36〜47 と記載（現状一致：L36〜47）
- `daemon.test.ts` T274 test を L4534 と記載（現状は L4532、describe は L4537）

最後の 1 つのみ 2 行ズレ。実装時は grep で正確に特定すべき旨を Implementer に伝えれば十分。

### F6. [minor] team-archive と summary.md への影響が plan 範囲外として明示されていない

`cmux-team team-archive` は closed タスクを `.team/archive/` に移すが、plan はそこでの deliverable フィールドの保持を明記していない（`.team/archive/` 配下の task-state 互換も task-state.json を読む想定）。実際には archive 側は task-state.json 全体を移さず closed 行を除外する既存実装だと思われるため影響は軽微だが、plan §5.1 の「既存機能への影響」表に「archive / summary.md は対象外」と 1 行足すと範囲が明確になる。

### F7. [minor] `--deliverable-kind none` + journal optional 判断の運用リスク

§5.2 と §7 の観点 1 が自己言及するとおり、`none` + journal 未指定は許容される（task.md 指示通り）。ただし実運用では「納品ゼロ + journal 未指定」は `auto_closed_by_daemon` 経路との区別がつかず、事後調査の情報量がほぼゼロになる。task.md が optional と明示しているため plan 側で覆すのは越権だが、Conductor テンプレ（S8）で「kind=none のときは運用上 journal を書くこと」を 1 行強めに書いておくと監査証跡が改善する。plan §7 の自己質問に対する答えがテンプレ本文には反映されていないため、Recommendations に含める。

## Recommendations

本レビューは Approved だが、Implementer が参照する際の指針として以下を推奨する。

1. **F1 対応**: S3 の完了条件に「assigned + kind 指定のみ（journal なし）でも、kind が valid なら close 可能（`--force` 不要）」または逆の意思決定を 1 行追加し、対応 unit テストを S10 に 1 本足す。既存 L3049 ガード仕様を動かさないなら後者、動かすなら前者。task.md の破壊的変更の趣旨に沿って「kind で意図が明示されたら assigned guard は通す」を採るのが素直。
2. **F2 対応**: S10 のテスト列挙に以下 2 項目を追加:
   - 旧 closed 行（`deliverable` フィールドなし）を読み込んだ状態で `trace-task` 出力に `Deliverable: -` が出る
   - 同状態で dashboard `buildTaskRow` が kind suffix を付けない
3. **F3 対応**: S7 の作業記述を「`assignedRow` 有無 if/else の**後**で 1 回出力」に書き換える。
4. **F4 対応**: S9 または S7 に `help_trace_task` の Deliverable 行追記（1 行でよい）を明記する。
5. **F5 対応**: Implementer に対し「plan 内の行番号は参考値。実装時は `grep -n` で特定する」旨を S11 検証手順の冒頭で一文伝える（既に §6 で 3 件の既存エラーの位置を grep で特定する運用が前提になっているため、同じ運用を close-task 側にも拡張）。
6. **F6 対応**: §5.1 の表に「`.team/archive/` / summary.md は本タスク対象外（archive は既存仕様通り task-state.json を参照しない）」を 1 行追加。
7. **F7 対応**: S8 の Conductor テンプレ書き換えで、`--deliverable-kind none` の例に「`--journal "<理由>"` を**強く推奨**（運用上は事実上必須）」のコメントを添える。task.md が optional を許している以上 CLI 検証は外すが、ドキュメント上の推奨明示で監査証跡を守る。
8. **DL-02 再確認（観点 7.3）**: auto-close 経路で `kind: "none"` を書く判断は妥当。理由は `auto_closed_by_daemon` journal が別途残るため `none` と手動 `none` を journal 本文で区別可能であること、および kind 列挙に `unknown` を足すと discriminated union の 4 variant が 5 に膨らみ Conductor プロンプトの分岐判断を増やす副作用があること。plan の判断で進めてよい。
9. **観点 7.4 確認**: T294 依存（`depends_on: [294]`）は現 main の HEAD `4d484d2 feat(auto-update): task モード廃止、notify のみ残す (T294)` が T294 完了コミットであり満足。追加対応不要。

## 判定根拠

- Critical findings: **0 件**
- CRITICAL チェック項目: **全 4 項目パス**
- Minor findings: 7 件（いずれも実装者が対処すれば解決、構造的変更は不要）

上記 Recommendations を反映すれば、本 plan は Implementer にそのまま引き渡せる品質。
