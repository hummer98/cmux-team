# T352 Design Review

## Verdict
Approved

## Summary
設計判断 (A) `includeHandle` フラグ追加は妥当。Master/Conductor 行の互換は default 値で担保され、3 つの呼び出し箇所（dashboard.tsx:507/607/747）も grep 確認済みで破壊しない。テスト計画は概ね網羅的だが、 (1) `pool-surface-row.ts` 戻り値順序契約テストは「任意」ではなく **必須化**、(2) idle 行の dim 範囲縮小（roleIcon の dim 解除）が pool OFF 行にも波及する点の test/レビュー観点での明示、(3) (C) を不採用とした上で実装上は `slice(1)` を使う判断の整合性、を recommendations として整理。実装ブロックは不要。

## Findings

- **(severity: minor) (C) を不採用と宣言しつつ実装で `slice(1)` を採用する点の整合性**  
  Plan §2 で (C) は「配列順序前提で fragile」として却下しているが、Plan §4 Step 3-1 では `buildPoolSuffixForSurface(includeHandle:false)` の内部で `buildSurfaceRowSuffix(...).slice(1)` を採用する方針となる。これは (A) の枠内で post-process を helper の **責務境界の内側** に閉じ込めた変形であり、Plan 内でもその差分は注記されている。ただし「(C) は fragile / Step 3 の slice(1) は fragile でない」を分かつ唯一の構造的根拠は **順序契約テスト（§5 最後の「任意」項目）の存在** に依存するため、§5 の契約テストを optional のまま実装すると plan §2 の主張が成立しなくなる。→ Recommendations に「§5 順序契約テストを必須化」。

- **(severity: minor) idle 行 dim 範囲変更が pool OFF 経路にも波及する**  
  既存実装 dashboard.tsx:774 では idle 行の `${roleIcon} ${label}` をひとまとめに `{ dim: true }` で描画している。Plan §2 / Step 3 では roleIcon を plain、label のみ dim に切り替える。この再構成は `perHandle === null`（pool OFF）かつ `tokenHandle === undefined` のケースでも適用されるため、T352 spec が直接対象としていない pool OFF 全ユーザーの idle 行表示が変わる。task.md は「未バインド時は省略 → `└─ [201] ⚙ <taskTitle>`」とのみ記述し、dim 範囲には明示的に言及していない。Plan §2 で「安全側で roleIcon は dim 解除」と判断し PR で明示する旨記載済みなので追加対応は recommend のみ。

- **(severity: minor) `dashboard-pool.test.tsx` case 8 更新の意図保全**  
  Plan §5 は case 8 を「Agent 行 unbound で `(no token)` が出る」→「Agent 行 unbound で `(no token)` が **出ない**」に反転させる。ただし case 8 の本来の検証意図は `(no token)` テキストそのものよりも、**pool ON / agent unbound という組み合わせで surface ラベル `[200]` / `[100]` が 1 度ずつしか出ないこと**（重複禁止）にある（test 末尾の `countSurfaceLabel` assertion）。この不変条件は新仕様でも保持されるため、`(no token)` assertion を `not.toContain("(no token)")` に反転しつつ `countSurfaceLabel` 検証は残すべき。Plan は反転のみ言及しているため明示化が望ましい。

- **(severity: minor) T352-7 (pool OFF) の assertion 粒度**  
  Plan §5 は「T352-7: pool OFF で T351 の既存挙動維持」とあるが、上記 idle dim 範囲変更が pool OFF にも適用されるため、「既存挙動と完全一致」を strict に取ると test が落ちる懸念がある。test の意図を「pool ON 機能（@handle / util / cap / ⚠）が混入しないこと」に絞り込む形で記述するのが良い。同 Plan §5「buildConductorRow (3 引数) シム」は perHandle=null 経路の前後一致を担保するため、Plan §4 Step 3-2 の Agent 行リレイアウトで dim 構造が変わっても **両者の出力が同じ式で生成される**ため shim test 自体は保たれる（差分は対称的に発生する）。

- **(severity: minor) `(no token)` 抑止の分岐順序**  
  Plan §4 Step 3-1 で `includeHandle:false && tokenHandle == null → []` を明示的に分岐する記述になっているが、`buildSurfaceRowSuffix` の戻り値を取得してから `.slice(1)` する経路でも結果は `[]` になる（戻りは `[(no token)]` 1 要素）。実装では明示分岐の方が意図が読みやすいが、共通経路化（常に `slice(1)`）でも動作は同じ。どちらでも構わないが、明示分岐を選ぶならテスト T352-4〜T352-6 で「呼ばれた経路で空配列が返ること」を間接的に carve してほしい（`@`・`(no token)` の双方を含まないことを assert すればよい）。Plan §5 の T352-4〜6 が既にそれを満たすため追加対応不要だが、note として残す。

- **(severity: minor) `cmux-team start` 実機確認の position**  
  Plan §4 Step 4 と §7 完了条件で「実機目視確認（任意だが推奨）」とされている。dim / 色変更は JSON snapshot test では完全に検証しきれない（節点 `style.fg` 値の比較は脆い）ため、Implementer 段階で実機確認を **推奨ではなく必須** と扱うのが安全。Conductor 経路の Final Polish として位置付ける recommendation。

- **(severity: minor) Master 行の handle 表示は不変**  
  Plan §3 の表 / §6 リスク欄で Master 行を含めた `includeHandle` デフォルト維持を明示。dashboard.tsx:507（Master）, :607（Conductor）, :747（Agent）の 3 箇所を grep で確認済みで、Agent 行のみ第 4 引数 `false` を渡す方針は OK。

## Recommendations

1. **`pool-surface-row.ts` 戻り値順序契約テストを必須化**  
   Plan §5 末尾の「`buildSurfaceRowSuffix API 契約` describe に『bound 入力で先頭が必ず `@handle` の text node』assertion 追加」を「任意」から「必須」に格上げする。これが入って初めて Plan §2 の「(C) は fragile / Step 3 の slice(1) は fragile でない」という設計上の主張が tests でも担保される。Plan の構造的整合性のために必須化を推奨。

2. **case 8 更新の文面強化**  
   Plan §5 「case 8 を反転」を以下に書き換え:  
   > case 8 を「pool ON / agent unbound で `(no token)` を **含まない**」+「surface ラベル `[100]`/`[200]` が 1 度ずつ出現」の 2 条件に書き換える。`countSurfaceLabel` による重複禁止 assertion はそのまま残し、削除しない。

3. **idle dim 変更の波及範囲を test と PR description で明示**  
   - T352-7 (pool OFF) の assertion 文面を「`@` 文字を含まず、suffix 由来の util/cap 表記が混入しないこと」に絞り込む（既存の dim 構造との完全一致を assert しない）。
   - PR description に「idle 行の roleIcon は dim から plain に変更（taskTitle のみ dim を維持）。pool ON/OFF いずれの経路でも同じ」と明記。

4. **T352-8 (順序 assertion) の検出方法**  
   JSON 文字列上で `[201]` → spinner/icon → `@kddi` → taskTitle の出現順序を検証する際、`indexOf("[201]") < indexOf("▘") < indexOf("@kddi") < indexOf("foo")` のような単方向不等式で書く形式を推奨。`stringify` 出力中に複数箇所出現する文字列（`[201]` は `surface` ラベルと `[surface]` 表記で重複しない、`▘` は SPINNER_FRAMES 由来で 1 ヶ所のみ）に注意。

5. **`cmux-team start` 実機確認を完了条件として必須化**  
   §7 完了条件の「実機目視確認（任意だが推奨）」を「**実機確認を Implementer の必須ステップ**」に格上げ。色 (`fg: CYAN/YELLOW`) や dim 範囲の変更は JSON snapshot test では完全に保証できない。

## Notes

- Plan §6 の「`ui.row` の `null` 子要素サポート」は `dashboard.tsx:719` (`c.taskTitle ? buildTitleWithLinks(...) : null`) で利用実績あり。Agent 行の `(handle?)` も同パターン (`a.tokenHandle ? ui.text(...) : null`) で安全。
- Plan §3 の「`pool-surface-row.ts` は無変更（T351 の API 契約を維持）」は `formatSurfaceRow`（CLI 用文字列 API）にも影響しないことを意味し、`token status` などの CLI 表示は本タスクで一切変わらない。design boundary として明確。
- Plan §4 Step 4 のテスト loop（`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do ...; done`）は CLAUDE.md の `bun test` 全体実行禁忌方針と整合。Implementer は同 loop か、Plan で挙げた個別 test 4 ファイル（`dashboard-conductor.test.tsx` / `dashboard-pool.test.tsx` / `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx`）の最小集合を回せばよい。
- T352 の作業は単純な layout 調整に見えるが、(A) を採用したことで `buildPoolSuffixForSurface` のインターフェースが「surface row 整形」と「dashboard 表示都合 (handle 抑止)」の 2 責務に薄く広がる。将来 Master 行も含む広範な表示制御が必要になった場合、`buildPoolSuffixForSurface` を caller 種別 (`master`/`conductor`/`agent`) で param 化する案 ((B) の進化形) に再リファクタする判断ポイントになる。今回は YAGNI で OK。
