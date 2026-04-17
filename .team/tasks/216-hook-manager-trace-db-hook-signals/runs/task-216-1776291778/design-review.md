# T216 design-review (rev2) — hook 全送信設計への統合

**Reviewer run**: task-216-1776291778 (rev2)
**Reviewed plan**: `.team/tasks/216-hook-manager-trace-db-hook-signals/runs/task-216-1776291778/plan.md` (rev2)
**日時**: 2026-04-16

---

## Verdict: Approved

---

## Summary

rev1 で指摘した 7 件（Critical 1 / Major 2 / Minor 4）は rev2 ですべて適切に解消されている。特に破綻リスクが高かった Critical #1（既存 T210 テスト更新漏れ）は §3 変更対象表 #9a・ST-9(a)・§9 受け入れ条件 #10 の 3 箇所で一貫して反映済み。ユニットテスト必須化（ST-10 を trace-store.test.ts、ST-11 を daemon.test.ts に分離）と `.find(h => h.matcher === ...)` パターンへの統一により、実装品質とテスト耐久性の両方が担保される計画になった。新たな critical/major 問題は検出されず、Implementer フェーズに進める状態と判定する。

---

## Resolution Check

| # | rev1 指摘 | 解消 | 反映箇所 |
|---|---------|:---:|---------|
| #1 [Critical] | ST-7 で `main.test.ts:939` の既存 T210 が破綻するが更新タスクが無い | ✅ | §3 変更対象表 #9a（種別: **更新**）/ ST-9(a) 既存 T210 の matcher 文字列と test 名の更新手順 / §9 受け入れ条件 #10「既存 T210 テストが新 matcher 文字列で pass」/ §5.1 リスク表 / D18 Decision Log |
| #2 [Major] | ST-9 のテスト仕様が index ベース (`hooks[1]`) — `.find` に統一すべき | ✅ | ST-9(b)(c) がすべて `.find(h => h.matcher === "logout\|prompt_input_exit\|other")` パターンで書き直されている。検証コマンドに `grep -c 'hooks\[1\]' main.test.ts # 新規 test では 0` を追加して index ベース禁止を機械的に担保。Agent 側 (`generateAgentSettings`) テストも ST-9(c) で追加。D19 Decision Log |
| #3 [Major] | `insertHookSignal` / `handleMessage` 統合テストが optional — 必須化すべき | ✅ | ST-10（trace-store.test.ts）が「必須」に格上げされ、3 本のテストが必須化: (1) SESSION_STARTED 挿入検証、(2) SESSION_ENDED reason=other と payload_json 復元検証、(3) 64KB truncate 検証。ST-11（daemon.test.ts）が新設され、`handleMessage(SESSION_ENDED reason=other)` で `conductor.status` 不遷移を必須検証。対比として reason=logout での disconnected 遷移 regression test も指示済み。D20 Decision Log |
| #4 [Minor] | ST-6 に import 追加手順が未記載 | ✅ | ST-6 作業 (1) に `SessionEndedMessage as SessionEndedMessageSchema` を main.ts L46 付近の既存 import 行に追加する具体的な形で明記。完了条件にも `grep -n "SessionEndedMessageSchema" main.ts` が import 行と parse 行の両方で hit することを追加 |
| #5 [Minor] | payload_json サイズ上限未定義 | ✅ | §2.2 に「payload_json のサイズガード（D17）」subsection を新設し、64KB (65536 bytes) 上限 + truncate + `console.warn("hook_signal_payload_truncated ...")` を明記。ST-2 作業手順にコード例付きで組み込み。ST-10 test 3 で truncate 動作を必須検証。§5.5 リスク表にも記載。D17 Decision Log |
| #6 [Minor] | GC 運用手順未記載 | ✅ | ST-1 の CLAUDE.md 追記本文に「運用上の注意（D14）」として `sqlite3 .team/traces/traces.db "DELETE FROM hook_signals WHERE timestamp < '2026-01-01'"` の具体的な手動 DELETE 手順を明記。§9 受け入れ条件 #2 に `grep "DELETE FROM hook_signals" CLAUDE.md` を追加して検証対象化 |
| #7 [Minor] | reason フィールドの実機確認指示なし | ✅ | ST-6 完了条件に「実機検証」節を追加。`cmux-team start` → Conductor spawn → `/clear` or `logout` → `sqlite3 .team/traces/traces.db "SELECT type, reason FROM hook_signals ORDER BY id DESC LIMIT 3"` で reason 列に `logout` / `other` / `prompt_input_exit` が入ることを確認する具体手順を明示。§9 受け入れ条件 #14 にも手動 E2E として登録 |

**Critical/Major (#1〜#3) 解消判定: すべて OK。Approved 基準を満たす。**

---

## Findings

**なし**（新たな critical/major 問題は検出されず）。

以下は参考レベルの観察で、いずれも blocker ではなく修正不要:

- **ST-6 完了条件の文言**: 「`hook_signal_insert`（あるいは既存の `conductor_session_ended` 系）」という括弧付き表現はやや曖昧だが、最終的な検証対象は `sqlite3` クエリで reason 列の実値を確認する形になっており、実装者判断でログキー名のブレは吸収可能。blocker にはしない。
- **ST-11 の state fixture 構築**: `DaemonState` を inline 構築する際の `as any` 使用を許容と明記しており、実装優先度の判断として妥当。`createDaemon` を丸ごと呼ばない方針も handleMessage 単体を検証するユニットテストの粒度として適切。
- **ST-2 の `console.warn` vs `log()` 判断**: trace-store.ts が logger.ts を import しない方針（循環 import 回避）は明文化された設計判断として妥当。切替条件（「logger.ts への import が既に有れば `log` を使う」）も plan 内で明示されている。
- **D3 / D5 / §5.2 non-destructive migration / §2.6 代替案網羅**: Design Review rev1 で明示的に評価した判断のため rev2 で変更なし。これは意図通りで問題なし。

---

## Recommendations

（Approved のため特段の必須指示はなし）

Implementer 向けの参考メモ:

1. **ST-1 → ST-12 の順序を守ること**。特に ST-2 → ST-3 → ST-4 は trace-store の export → daemon の import → handleMessage での呼び出し、という依存関係が強い。
2. **ST-9(a) の既存 T210 更新を後回しにしない**。ST-7 を先に適用すると `bun test main.test.ts` が red になる時間帯が発生するため、ST-7 と ST-9(a) はできるだけ同じコミット（またはまとめて push 直前に揃える）に含めるのが望ましい。plan 上の順序（ST-7 → ST-8 → ST-9）でも技術的には問題ないが、CI 緑維持の観点で上記を推奨。
3. **ST-12 の手動検証（`sqlite3 ... SELECT reason FROM hook_signals`）は skip しないこと**。これが唯一「hook 経路が end-to-end で繋がっている」ことを保証する gate。ユニットテスト（ST-10 / ST-11）だけでは Claude Code の hook input JSON 仕様に対する答え合わせができない。

---

## 補足: rev2 で特に良かった点

- **Decision Log D17〜D20 の追加**: rev1 で指摘した 4 項目（Critical #1・Major #2・Major #3・Minor #5）に対して Decision Log に反映理由が明示的に追加されており、将来のメンテナンス時に「なぜこの test パターンなのか」「なぜ 64KB なのか」が追跡可能。
- **§3 変更対象表の再構成**: 「追加 / 更新 / 維持」の種別列を付けて既存 test 更新（#9a）と新規 test 追加（#9b）を分離している点は、Implementer が作業粒度を誤解しないための良い工夫。
- **ST-9 の検証コマンドの機械化**: `grep -c 'matcher === "logout|prompt_input_exit|other"' main.test.ts # 期待: 3 以上` と `grep -c 'hooks\[1\]' main.test.ts # 新規 test では 0` により、`.find` パターンへの統一が grep レベルで検証可能になっている。Inspector が手で読まずに済む。
- **Revision History の明記**: rev1 → rev2 の変更点が指摘番号と対応付けて列挙されており、再レビューの追跡性が高い。

---

**レビュー終わり**
