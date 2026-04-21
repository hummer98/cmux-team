# T262 Design Review v2 (re-review)

## 判定

**Approved**

## 総評

Blocker 3 項（B1 / B2 / B3）と Major 5 項（M1〜M5）の全てに対して、plan.md v2 で **設計方針が明確に決定** され、対応する §章番号への加筆もある。特に B2 で「fail-stop 除外」を採用したことで `applyTransition` の責務境界が明快になり、§R1 の例外処理ロジックも現行挙動と整合する形で書き直された。M5 の検証階層化（destructive 厳密 / log 任意 / source 不要）は保守性面で妥当な譲歩で、Phase 2 refactor の阻害リスクが下がっている。Minor 6 項も全て plan に反映されており、実装着手の準備として十分。

唯一残課題は M2 の推奨修正 3 件のうち「`asking` + `CONDUCTOR_DONE`」のケースが §3 Step 2 #2 の到達可能セル列挙に明記されていない点だが、これは実装着手後の grep 確認で固定化可能で、Approved 判定の妨げにはしない（後述「新規指摘」参照）。

## 前回指摘の解消状況

### B1 (CONDUCTOR_CLEAR 欠落)

- 解消: **Yes**
- 根拠:
  - §2.1 L54: `FsmEvent` に `{ type: "CONDUCTOR_CLEAR"; reason?: string; surfaceMissing?: boolean; at: string }` 追加。
  - §2.4 L149-150: 「`broken` からの復帰は `CONDUCTOR_CLEAR` event のみ」と明記。Mermaid 図にも `broken --> idle: CONDUCTOR_CLEAR (surfaceMissing=false)` を含む。
  - §3 Step 5 #8: 置換ステップ 9 経路の中に CONDUCTOR_CLEAR を組み込み（B1）。
  - §5.4: 「broken + CONDUCTOR_CLEAR (surfaceMissing=false) → idle」「broken + CONDUCTOR_CLEAR (surfaceMissing=true) → broken 維持」両ケースを冪等性テストとして列挙。

### B2 (applyTransition rollback)

- 解消: **Yes**
- 選定案: **fail-stop 除外**（plan.md §3 Step 4 で 3 案比較表後に明示）
- 評価:
  - 比較表 L268-272 で effect-first / snapshot rollback / fail-stop 除外を「ログ順序」「rollback 複雑度」「現行統合テスト互換性」の 3 軸で評価。fail-stop 除外を選定した根拠も補足（plan.md §6 が `main.ts:798` / `resetConductor` を据え置きにしている方針との一貫性）。妥当な選定。
  - 新設計の `applyTransition` は (a) 非 destructive 即時実行 → (b) state commit → (c) destructive 返却 の 3 段階で、現行挙動と同順序のログ・state 整合を保てる。
  - §R1 で例外処理を全面書き直し: destructive は呼び出し側 try/catch、catch 側で `status="disconnected"` + `disconnectedAt=now` を明示代入する仕様に。`pid` 残留・`disconnectedAt` 未設定で disconnect_timeout 誤検出に至る前回指摘の懸念は解消。
  - §R1 末尾で「SESSION_CLEAR + running で destructive throw → 最終 status=disconnected, disconnectedAt=now, pid 残留なし」を assert する境界テストを追加すると明記。

### B3 (surface_missing 昇格)

- 解消: **Yes**
- 根拠:
  - §2.1 L48 / L54: `SESSION_CLEAR` / `CONDUCTOR_CLEAR` event に `surfaceMissing?: boolean` を追加。「surface 実在確認は呼び出し側で済ませ、結果を event に含める」と明記。
  - §2.2: guard 種別表に「surface 生存（v2 追加）」行を追加し、決定論的計算は呼び出し側で行う原則を再確認。
  - §3 Step 4 「B3 の surface_missing 責務分離」サブセクションで、`handleMessage` / `monitorConductors` で `cmux.getPaneForSurface` を先に呼ぶフローを明記。`next.status` と `targetStatus` の不変条件（呼び出し時点で `targetStatus` が `broken` になっているため FSM の決定と必ず一致）を保証。
  - §R5: T251 の `resetConductor` 内部昇格コードは Phase 1 では fail-safe として残す方針を明記し、Phase 2 で削除検討（§7 (f)）。性能面の懸念（高頻度 handler では呼ばない方針、SESSION_CLEAR / CONDUCTOR_CLEAR の低頻度 destructive 経路に限定）も追記。

### M1 (log effect detail)

- 解消: **Yes**
- 根拠:
  - §2.1 L66-67: `log` effect を `{ type: "log"; event: string; ctx?: LogCtx }` に変更。LogCtx の構造（elapsedSec, trigger, reason, taskRunId, sessionId, prevStatus, nextStatus, source, includeSnapshot）を L86-98 で定義。
  - §3 Step 4 「M1 の log effect 生成」サブセクションで `buildLogDetail` の責務（event 名 + ctx + conductor snapshot から detail 文字列を組み立てる）を明示。サンプルコードあり。
  - §5.1 で「log effect は event 名の存在のみ検証」とし、純粋関数の引数最小化と現行ログ不変の両立を担保。

### M2 (late_cleanup 経路)

- 解消: **Partial**
- 根拠:
  - §3 Step 2 #2 で「`disconnected` + `CONDUCTOR_DONE` taskRunId 一致 → `idle` + `resetConductor`（M2 の late_cleanup 経路）」を追加 ✓
  - 同 #2 で「`idle` + `CONDUCTOR_DONE` → no-op + `no_task` ログ」を追加 ✓
  - **未解消**: 推奨修正 3 つ目「`asking` + `CONDUCTOR_DONE` → 現行挙動を事前に grep で確認し、仕様として固定化」が plan に明記されていない（前回 review L57 の 3 項目のうち 2 項目のみ反映）。
  - 影響度の評価: `asking` 中に conductor が done マーカーを書くケースは到達確率が低く、実装着手後の grep で機械的に確認可能。Approve 判定の Blocker にはしないが、新規指摘として下記に記載。

### M3 (A014 外遷移)

- 解消: **Yes**
- 根拠:
  - §3 Step 2 #2 「現行 `handleMessage` の到達可能セル（A014 未記載）」セクションで前回指摘 4 件全てを明示的に列挙:
    - `asking` + `SESSION_ENDED` → `disconnected` ✓
    - `asking` + `SESSION_CLEAR` taskRunId 一致 → `asking` 維持 + skipDestructive ✓
    - `asking` + `SESSION_CLEAR` taskRunId 不在 → `idle` ✓
    - `starting` / `assigning` + `SESSION_ENDED` → `disconnected` ✓
    - `SESSION_ENDED` + surface mismatch → no-op + `session_ended_ignored` ログ ✓
  - case 総数概算 45〜55 と更新（前回 plan の 25 ケースから増加）。

### M4 (残置代入一覧)

- 解消: **Yes**
- 根拠:
  - §6 「据え置き（FSM 外残置代入）— v2 で付録化: M4」セクションに、2026-04-19 時点の `rg -n "conductor\.status\s*=\s*"` 全 13 件を表形式で列挙。
  - 各行に「恒久残置」「Phase 2 で検討」「対象外（master/agent）」「fail-safe として残置」のタグを付与。
  - Phase 1 で置換する Conductor status 代入の総数（19 箇所）を §3 Step 5 で明示し、§6 と整合。

### M5 (effect 検証階層化)

- 解消: **Yes**
- 根拠:
  - §5.1 で必須/任意/不要の 3 階層を明記:
    - 必須: destructive effect の型と相対順序を完全一致
    - 任意: log effect は event 名の存在のみ
    - 不要: log ctx 各フィールド値、notifyStateChanged の source、setXxx の細部
  - §R3 のテスト責務表に「effect 検証方針（M5）」列を追加し、3 ファイル（conductor-fsm.test.ts / daemon.test.ts / conductor.test.ts）の責務を一貫して定義。
  - 「T260 のような小刻みな調整でテーブルテストが red になる運用を避ける」と保守性の根拠を明示。

### m1〜m6 (Minor)

- **m1** (CONDUCTOR_REGISTERED の idempotent merge): 解消 ✓ — §3 Step 5 #1「新規 map 登録 + idempotent merge 分岐は handleMessage に残す（m1）」、§5.4「2 回目は no-op（transition() には既存 state を渡す想定。新規 map 登録は handleMessage 側の責務。m1）」と明記。
- **m2** (requestWakeup effect): 解消 ✓ — §2.1 L77 で `{ type: "requestWakeup"; reason: string }` effect 追加。§5.2 で「broken + CONDUCTOR_CLEAR (surfaceMissing=false) → ... + requestWakeup」の境界テスト追加。
- **m3** (broken_conductor_still_alive): 解消 ✓ — §3 Step 2 #2 で「`broken_conductor_still_alive` は **FSM 外**に残すため case には含めず handleMessage の責務として plan §6 で明記」と記載。§6 「m3 で明示: FSM 化しない条件付き副作用」セクションで該当ログ + `conductor_caller_alive` 系 + `insertHookSignal` を明記。
- **m4** (SESSION_ENDED reason=other): 解消 ✓ — §2.3 にデータフロー図（hook POST → insertHookSignal → classifyStopPayload → reason=other early return → applyTransition）を追加。§5.5 で「transition に到達した場合の防衛実装として `effects=[]` / `next=state` を返すケースを 1 件テスト」と明記。
- **m5** (Mermaid 差分図): 解消 ✓ — §2.4 「差分 Mermaid 図」セクションで `broken` + `CONDUCTOR_CLEAR (surfaceMissing)` を含む完全な遷移図を追加。
- **m6** (PID_DEAD stale ガード): 解消 ✓ — §5.6 「PID_DEAD の stale ガード（v2 追加: m6）」セクションで「stale 判定は transition() 内の guard として実装。`state.pid === event.pid` チェックを transition の冒頭に入れる」と方針確定。境界テスト 2 件追加。

## 新規指摘（あれば）

### 【Minor】N1. `asking` + `CONDUCTOR_DONE` の挙動が plan に固定化されていない

- 前回 review M2 の推奨修正 3 件のうち最後の項目（`asking` + `CONDUCTOR_DONE` の現行挙動 grep 確認）が §3 Step 2 #2 の到達可能セル列挙に含まれていない。
- 影響: 表駆動テストで「asking 中に done マーカーが書かれた場合」の振る舞いが固定化されず、実装者の判断に委ねられる。到達確率が低いため Blocker / Major には昇格しないが、Phase 2 で「asking」を sub-state 化する際に挙動の事後変更が起きうる。
- 推奨: 実装の Step 2 着手時点で `rg "handleConductorDone" skills/cmux-team/manager/daemon.ts` と `handleMessage` の `CONDUCTOR_DONE` case で asking 中の挙動（おそらく taskRunId 一致時に `idle` 復帰 + `resetConductor` で running と同じ）を確認し、conductor-fsm.test.ts に 1 ケース追加。

### 【Minor】N2. §3 Step 5 の `daemon.ts` 行番号と §6 の行番号が部分的に異なる

- §3 Step 5 L407 で「daemon.ts: 1352, 1359, 1634, 1711, 1714, 1719, 1800, 1811, 1818, 1822, 1827, 1885, 1962, 2195, 2207, 2221, 2258, 2457, 2472（19 箇所）」を列挙。
- §6 L548-557 の表は別の行番号（1326, 1433, 1605, 1683, 1770, 1855, 1914, 2032, 2383）で master/agent を含む全件を列挙。
- §3 と §6 の役割分担（§3 は Conductor 19 箇所、§6 は全件 + 据え置きタグ）は明快なので問題ないが、「§3 = §6 表の Conductor 行 + Phase 1 対象タグ」を明示する 1 文があるとレビューが楽。Minor。

## 総評（再掲・短縮）

Blocker 3 / Major 5 が解消され、Minor も全て反映されているため Approved。残課題は新規 N1 / N2 の 2 件のみで、いずれも実装着手中に低コストで対処可能。Phase 1 のスコープ・設計境界が明確化されたため、TDD で進めれば現行挙動の不変条件を保ったまま `transition()` 純粋化が完遂できる見込み。

## Approve 条件 / 追加修正事項

Approve 条件は満たされている。実装段階で以下を踏まえてほしい:

1. **N1 の対応**: Step 2 のテスト先行作成時、`asking + CONDUCTOR_DONE (taskRunId 一致 / 不在)` を 2 ケース追加し、grep で現行挙動を確認した結果を case 名コメントに残す。
2. **N2 の対応**: コミットメッセージか PR 説明で「§3 Step 5 の 19 箇所 = §6 表の Conductor 行（main.ts:798 / daemon.ts:916 / conductor.ts:605 を除く）」と明記すれば足りる。plan の書き換えは不要。
3. **境界テスト**: §R1 末尾の「SESSION_CLEAR + running で destructive throw → 最終 status=disconnected」テストは Step 4 の applyTransition 実装後すぐに走らせ、現行挙動との差異を最小限の commit で確認する。
4. **fail-safe 残置の追跡**: §6 で残置とした `conductor.ts:605`（resetConductor 内部の T251 昇格）は Phase 2 の削除候補として §7 (f) に記載済み。Phase 1 完了後の追跡用に follow-up タスクを起票しておくことを推奨（Approve 条件外、運用上の助言）。
