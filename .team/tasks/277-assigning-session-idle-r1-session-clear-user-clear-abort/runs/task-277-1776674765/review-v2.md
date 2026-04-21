# T277 Design Review (round 2)

## 判定

**Approved**

## 根拠

前回 review (round 1) の Changes Requested 指摘 6 件（必須 2、推奨 2、任意 2）がすべて plan.md に反映されている。必須 2 件（既存 R1 test の処遇、SESSION_ACTIVE R1 の扱い明示）は完全にカバーされ、推奨 2 件（A014 Mermaid 図、conductor.ts:507-508 コメント）も具体的な修正内容付きで plan §4.5 / §4.3 に追記された。任意 2 件（`promptSentAt` による T276 忠実再現、`git grep -n "session_idle_at="` 最終確認）も採用されている。更新版 plan と実コード・既存 test を照合した結果、新たな矛盾・抜けは検出されなかった。Green 後に `bun test` 全 pass する見込みもある（後述「確認した事項」参照）。

## 前回指摘への対応状況

| # | 指摘 | 対応状況 | 備考 |
|---|------|---------|------|
| 1 | daemon.test.ts:2337-2358 既存 R1 test の処遇 | ✅ | §4.4 L83 で「L2337-2358 を削除し、新仕様 test に置き換える」を明記。置き換え先の test 本体は §5 Red に具体コードで提示。§9 完了条件 L257-258 にもチェック項目化 |
| 2 | SESSION_ACTIVE R1 扱いの明示 | ✅ | §2 L23-27 の「変更しない」に「SESSION_ACTIVE 側 R1 経路は現状維持」として明記。理由 1（hook 未設定）/理由 2（CLI 経由のみ）/結論（後日別タスク）の 3 点を論述。§4.1 表でも「変更なし」、§4.4 で L2360-2381 test 据置、§9 完了条件でも SESSION_ACTIVE R1 非変更を明示 |
| 3 | A014 Mermaid 図 (L266) の IDLE 削除 | ✅ | §4.5 L94 で「L266 から IDLE を外して `SESSION_STARTED(source=clear) / ACTIVE (taskRunId 有)` に修正」と明記。§9 完了条件 L263 で Mermaid L253-286 の更新をチェック項目化 |
| 4 | conductor.ts:507-508 コメント修正 | ✅ | §4.3 L76 で旧→新の具体コメント文面を提示。§9 完了条件 L254 にチェック項目化 |
| 5 | promptSentAt 設定で T276 忠実再現 | ✅ | §5 Red 2 つ目の regression test で `promptSentAt: clearSentAt + 200ms` を設定し、`expect(logContent).toMatch(/session_idle_source_guess=clear_transient/)` を assertion に追加。§6 検証観点表でも明記 |
| 6 | git grep 最終確認 | ✅ | §7 末尾「実装直前の最終確認チェックリスト」に `git grep -n "sessionIdleAtInAssigning"` / `git grep -n "session_idle_at="` / `git grep -n "assigning_window_close.*SESSION_IDLE"` / `git grep -n "conductor_running.*via=SESSION_IDLE"` の 4 コマンドを追加。§9 完了条件 L264 にチェック項目化 |

## 確認した事項

### 実コードと plan の整合

- **conductor.ts:507-508**: 現状コメント「保険経路として SESSION_IDLE / SESSION_ACTIVE でも assigning→running へ遷移させる」を確認。plan §4.3 の修正文面と矛盾なし
- **daemon.ts:1825-1833**: SESSION_ACTIVE R1 分岐を確認。`sessionIdleAtInAssigning` 相当フィールドは set していない。plan §2 の「変更しない」スコープと整合（SESSION_IDLE R1 と異なりフィールド書き込みがないため撤去コストが別論点）
- **daemon.ts:1937-1955**: SESSION_IDLE R1 本体確認。`sessionIdleAtInAssigning` 代入（L1943）/ `assigning_window_close via=SESSION_IDLE`（L1948-1950）/ `conductor_running via=SESSION_IDLE`（L1952-1955）の 3 要素。plan §4.1 の削除対象と一致
- **daemon.test.ts:2337-2358**: 既存 R1 SESSION_IDLE test を実コードで確認。`expect(conductor.status).toBe("running")`（L2356）が新仕様下で fail するため、plan §4.4 の「削除し新仕様 test に置換」は必須
- **daemon.test.ts:2360-2381**: SESSION_ACTIVE R1 test 確認。SESSION_ACTIVE R1 を残す plan と整合し、そのまま pass する
- **A014 L266**: 現 Mermaid の記述「SESSION_STARTED(source=clear) / ACTIVE / IDLE (taskRunId 有)」を確認。plan §4.5 の修正方針（IDLE 除去）と整合

### Green 後の test suite pass 見込み

- T232 メイン経路（L2306-2334、SESSION_STARTED source=clear）: 変更対象外で pass
- R1 SESSION_IDLE（L2337-2358）: 新仕様 test に置き換えで pass
- R1 SESSION_ACTIVE（L2360-2381）: SESSION_ACTIVE R1 は残すためそのまま pass
- T232 timeout（L2384-）: 影響なし
- T261 user_clear_decision_snapshot（L3757-3834）: regex が wildcard で `session_idle_at=` を吸収するため、列削除でも pass
- T232 `assigning_window_close via=SESSION_STARTED_clear`（L3871-3907）: 影響なし
- T261 timeout test（L3940-3962）: 影響なし
- §4.4 L4052-4102 の `sessionIdleAtInAssigning` assertion 削除: 他 3 フィールドの assertion は維持されるため問題なし
- 新規追加 regression test: ISO 8601 固定値 + `handleMessage` 直呼びで deterministic、flaky にならない

### §4 変更対象リストと §5 実装ステップの整合

- §4.1（daemon.ts）/ §4.2（schema.ts）/ §4.3（conductor.ts）/ §4.4（daemon.test.ts）/ §4.5（A014）の全カ所が §5 Red/Green/Refactor ステップでカバーされている
- §5 Red の 2 つ目 test（regression）が「clearSentAt + promptSentAt + idleAt + clearAt + startedAt」の 5 時点でタイムライン組立、T276 race（SESSION_IDLE 先着 → R1 発火せず assigning 維持 → SESSION_CLEAR 後着 → daemon_assign_clear で早期 break → SESSION_STARTED(source=clear) で正規遷移）を忠実再現
- §9 完了条件 14 項目が §4/§5/§7 の作業を漏れなくカバー

### 新たに検出した矛盾・抜け

- なし
- §4.4 の L3909-3938 test は「削除または新仕様 test に集約」と柔軟な表現だが、実装段階での判断として許容範囲内。完了条件 L259 にも明示されているため追跡は可能

### docs/CLAUDE.md への影響

- plan §4.6 の主張「CLAUDE.md / docs/spec/ に R1 / sessionIdleAtInAssigning / T232 / T261 の言及なし → 変更不要」は round 1 review で確認済み。round 2 でも変化なし
