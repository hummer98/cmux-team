# Design Review v2: T286 plan.md

## Verdict

**APPROVED**

判定根拠:
- Critical 2 項目（#1, #2）すべて Resolved
- Major 4 項目（#3, #4, #5, #6）すべて Resolved
- Minor 6 項目（#7〜#12）すべて Resolved
- v1 の正しい記述（§1 課題分析 / §2.1 の採用理由 / §2.4 代替案却下 / §3.1 ドキュメント書き換え表 / §6 既存型エラー / §7 Decision Log D1-D10）がそのまま保持されている
- 制御フローの pseudocode、エッジケース表、テストケース、Decision Log（D11-D17 追加）いずれも review-v1 Recommendations の文言と整合

よって Round 3 の Planner 改訂は不要、実装（Implementer / Inspector）フェーズへ進行可。

## A. Critical/Major 反映状況

### #1 applyDiscardOnly のログ契約と sequential 実行

**Status:** Resolved

**根拠:**
- plan.md §2.1「`applyDiscardOnly` 仕様（ログ出力契約 / sequential 実行保証）」(L117-142) で、ログ出力契約を bit-identical に保つ条件が明示されている。特に L124 で「`plan.discarded` のうち reason が `surface_missing_no_task` の行だけ `await log("conductor_discarded", ...)` を出力する。reason が `pid_dead_idle_cleanup` の行（C 経路由来）は既に `conductor_stale_surface_closed` で記録済みのためスキップ（= Critical #1 対応）」と書かれており、Recommendation #1 の文言がそのまま採用されている
- 同節 L128-138 に sequential 実行の疑似コードが載っており、外側 for ループで `await cmux.closeSurface(s)` → `await log(...)` を順次実行する形が明確
- L140 で「`Promise.all(plan.cleanup.map(closeSurface))` のような並列化は**禁止**（cmux 側で close 中に new pane 作成リクエストが入るレースを避けるため）」と仕様レベルで禁止
- S1 検証コマンド (L321-322) に `grep -A 3 'reason === "surface_missing_no_task"' skills/cmux-team/manager/daemon.ts | grep conductor_discarded` が bit-identical 検証用として追加され、`! grep -A 5 'function applyDiscardOnly' skills/cmux-team/manager/daemon.ts | grep 'Promise.all'` で並列化禁止の grep 検証も入っている
- Decision Log D12 (L542) / D13 (L543) に恒久記録されており、実装者・将来メンテナともに根拠が追える

### #2 layout_mismatch_on_resume の文言

**Status:** Resolved

**根拠:**
- plan.md §2.2「daemon.ts のログ文言修正（§2.1 Critical #2 対応 — 純観測ログに統一）」(L203-215) で、旧「existing panes will be kept; run 'cmux-team stop' then 'start --layout=...' to rebuild」を撤去し、`restored=${restoredLayout} current=${state.layout}` の純観測ログに統一する方針が明記
- L206 「T286 の fallback が発動するケース（KDG-SSO 再現条件）では既存 panes は全消失 → fallback で新 slot 作成（= requested layout で自動 rebuild）なので、『existing panes will be kept』は事実に反する」と、Review #2 の影響分析がそのまま受け止められている
- S2 (L324-340) の完了条件に「`grep -n "cmux-team stop" skills/cmux-team/manager/daemon.ts` で 0 件」「ログ文言から行動案内（`run 'cmux-team stop'` / `restart cmux session` 等）が完全削除されている」が明示
- M14 assertion 変更不要点（`restored=` / `current=` のみ見ている）も維持
- Decision Log D11 (L541) に Review 推奨案 (b) を採用した理由が恒久記録

### #3 M17 を 3 バリアント化

**Status:** Resolved

**根拠:**
- plan.md §4 S3 (L342-366) で M17a / M17b / M17c の 3 ケースが明示され、追加で任意 M17d（resumePlan 非空での分配検証）も用意されている
- M17a = E-only / M17b = C-only / M17c = C+E 混在、いずれも Review #3 の Recommendation と一致
- L358-361 で各ケースの verify 点が箇条書きされており、特に M17b/M17c で `cmux.closeSurface` の呼び出し順序を spy で検証する旨が明記（sequential 保証の可観測化）
- M17a/M17c では `conductor_discarded` log が E 経路 surface のみに出ること（reason フィルタの bit-identical 性）も verify 対象
- §5.2 エッジケース表 (L474-476) で (α)(β)(γ) の 3 パターンと対応する M17 番号がクロス参照されており、ドキュメント側の整合性も取れている
- Decision Log D9 (L539) に「M17b/M17c では `closeSurface` の呼び出し順序を spy で検証」が追記され、stub 範囲の方針も明記

### #4 Fallback 制御フロー（resumePlan 透過）

**Status:** Resolved

**根拠:**
- plan.md §2.1「採用する制御フロー（resumePlan 透過を含む）」(L82-115) の疑似コードで、fallback 経路でも `resumePlan` をそのまま `initializeConductorSlots` に透過する形が明記。L108 に「resumePlan,   // <-- team.json 空経路と同じシグネチャ」のコメント付きで、Review #4 Recommendation と完全一致
- L84「`plan.unmatchedResumes.length > 0` のケース（team.json 非空 + 全 E + resumePlan に 2 件 unmatched が混在するシナリオ等）は fallback 発動条件から排除していない。fallback 経路でも `resumePlan` をそのまま透過して `initializeConductorSlots` に渡す（team.json 空経路と同一シグネチャ）」と明示
- §5.2 エッジケース表 (L477) に「`team.json` 3 entry 全 E + resumePlan 2 件（unmatched） → fallback 発動 + 新 slot 2 件に resume 分配（残 1 slot は通常 spawn）」行が新規追加
- S1 メソッド制約 (L314-315) に「`initializeConductorSlots` の引数（projectRoot / conductors / maxConductors / daemonSurface / resumePlan / layout / mainBranch）は team.json 空パスと完全に同じシグネチャで呼ぶ」
- 任意 M17d (L355) でテストレベルの追証も用意
- Decision Log D14 (L544) に恒久記録

### #5 applyDiscardOnly の sequential 実行（再強調）

**Status:** Resolved

**根拠:**
- plan.md §2.1 L126-142 で sequential 実行の保証を仕様レベル明記、L140 で `Promise.all` 並列化を「**禁止**」と強調
- S1 メソッド制約 (L317) に「**`Promise.all` での並列化は禁止**（cmux 側で close 中に new pane 作成リクエストが入るレースを避けるため）」が明示
- S1 検証コマンド (L322) に `! grep -A 5 'function applyDiscardOnly' skills/cmux-team/manager/daemon.ts | grep 'Promise.all'` が追加され、CI 外の手動確認でも grep で検知可能
- S1 完了条件 (L313) に「`applyDiscardOnly` のループが `for (const s of plan.cleanup) { await ... }` 形式 (sequential)」が明記
- Decision Log D13 (L543) に「cmux 側で close-surface 中に new pane 作成リクエストが入るレースを避けるため」「close-surface 完了後に `initializeConductorSlots` を呼ぶことで pane 数が一時的に過剰になる瞬間を避ける」が恒久記録

### #6 CHANGELOG

**Status:** Resolved

**根拠:**
- plan.md §4 S8 (L427-442) の冒頭ノート「`[Unreleased]` セクション以下に追記する。次回 release スキル実行時（別タスク）に release スキルが `[Unreleased]` を `[4.3.0] - <ISO date>` にリネームする前提で、本タスクではバージョン見出しを新設しない（= Major #6 対応）。現行 `[4.2.0] - 2026-04-21` エントリは触らない。」が Review #6 Recommendation と完全一致
- §3.1 変更ファイル表 L288 の CHANGELOG.md 行にも同じ方針が要約されている（「release スキル実行時に `[Unreleased]` → `[4.3.0]` に昇格する前提で、本タスクではバージョン見出しを新設しない」）
- S8 完了条件 (L442) に「`[Unreleased]` ヘッダ直下にエントリが追加されており、`[4.2.0]` エントリは触られていない」
- Decision Log D15 (L545) に release タスクとの同期ポイントが恒久記録

## B. Minor 反映状況

### #7 helper 関数命名

**Status:** Resolved

**根拠:** §2.1 L119「ここでの "discard" は『conductor entry を `state.conductors` に登録せずに流す』という広義の意味で使っており、C 経路の close-surface 副作用も含む（= Minor #7 対応で命名意図を明示。改名はしない）」＋ S1 step 6 (L309) に JSDoc 明示の指示 ＋ D16 (L546) に恒久記録。改名せずコメントで意図を示す方針は合理的（改名コストのほうが大きい）。

### #8 docs/spec/03-commands.md:7

**Status:** Resolved

**根拠:** §3.1 表 L283「**注記追加** (Minor #8): 『起動・ステータスは CLI サブコマンド（`cmux-team start`, `cmux-team status`）に移行した（停止は当初 `cmux-team stop` として実装されたが T286 で廃止）』のような履歴注記にする。そのまま `stop` 単語を削るだけだと日本語として『停止』が抜けて文意が崩れるため」＋ S7 L417 / 完了条件 L422「L7 は単なる単語削除ではなく日本語として意味が通る注記になっている」＋ D17 に恒久記録。

### #9 README.ja.md:182

**Status:** Resolved

**根拠:** §3.1 表 L280「L178-183 コードブロックの整合を目視確認」、§2.2 表 L224「同ブロック内 4 行 → 3 行になる。他コマンドのコメント粒度と整合するか目視確認 — Minor #9」、S7 完了条件 L421「**`README.ja.md` L178-183 のコードブロック目視確認**」で 3 箇所に冗長に明記されており、実装時に見落としにくい。

### #10 pidfile.test.ts は本タスクで変更なし

**Status:** Resolved

**根拠:** §2.2 L188「`pidfile.test.ts:127-128` は `toContain("54321")` と `toContain(testDir)` のみを検証しているため assertion 修正は不要（= Minor #10 対応）」＋ S6 完了条件 L404-405「**`pidfile.test.ts` の assertion 修正は不要**（= Minor #10 対応）」＋ §5.1 L466 にも「既確認: `toContain("54321")` / `toContain(testDir)` のみなので assertion 修正不要（= Minor #10）」の 3 箇所で明示。

### #11 JSDoc の改行位置・spacing

**Status:** Resolved

**根拠:** S4 完了条件 L378-379「**冒頭 JSDoc コメントブロックの空行整形確認**（= Minor #11 対応）: stop 行だけ抜けて `* ./main.ts send ...` / `* ./main.ts send SHUTDOWN` 等の周辺行と不自然な空行が生じないか目視確認」で、チェックポイントとして完了条件に織り込まれている。

### #12 D5 を artifact 化する候補にする

**Status:** Resolved

**根拠:** §2.3 L257「後続タスク候補として Decision Log D5 に記録、§4 S9 の完了後に artifact 起票を推奨 — Minor #12 対応」＋ S9「S9 完了後の任意推奨作業」L455「Decision D5『`initializeLayout` の state-machine 化（`LayoutRestoreReducer` + `LayoutRestoreEffects` への再分割）』の内容を artifact (type=decision) として起票し、後続運用で追跡可能にしておく。`/artifact decision "T286 後続: initializeLayout state-machine 化"` 相当。強制ではない」＋ D5 (L535) 本文にも同文が追記されており、運用ルート含めて明示。

## C. 全体評価

- **課題分析の整合性 (§1)**: §1.1 の manager.log ダンプ・§1.2 の A〜E マトリクス・§1.3 影響範囲・§1.4 stop 問題はいずれも v1 から踏襲され、記述の正確性は保たれている。v2 改訂は §1 を touch していない（正しい挙動）
- **修正方針 pseudocode (§2)**: §2.1 の制御フロー疑似コードは Review #4 Recommendation の字面と完全一致。L86-115 で fallback 条件（3 カテゴリ len===0）と `applyDiscardOnly` → `initializeConductorSlots` の順序・シグネチャが明記されている。L117-142 の `applyDiscardOnly` 仕様も bit-identical 契約 + sequential 保証で網羅的
- **テスト戦略 M17 (§4 S3 / §5)**: M17a/b/c の 3 バリアント + 任意 M17d に分割。各テストで verify する項目（`layout_restore_empty_fallback` ログ、slot 作成数、`cmux.closeSurface` の sequential 呼び出し順序、`conductor_discarded` の reason フィルタ）が明示されており、Review #3 の懸念が解消されている
- **Decision Log 新規項目 (§7)**: D11-D17（7 件）が追加された。各 ID は対応する Review 指摘（D11=Critical #2 / D12=Critical #1 / D13=Major #5 / D14=Major #4 / D15=Major #6 / D16=Minor #7 / D17=Minor #8）に対応しており、追跡性が高い。D1-D10 も全て保持されている
- **v1 の正しい記述が誤削除されていないか**: §1 課題分析・§2.3 構造的解決の検討・§2.4 代替案と却下理由・§3.1 ドキュメント書き換え表・§6 既存型エラー・既存 Decision D1-D10 のいずれも保持されている。deletion は発見されず

## D. 新規発見事項

以下はいずれも APPROVED 判定を覆すほどではない観察点（参考まで）:

- **S1 検証 grep「applyDiscardOnly 3 件以上」の緩さ**: L320 の「`grep -n "applyDiscardOnly" skills/cmux-team/manager/daemon.ts` で 3 件以上」は、定義 1 + `initializeLayout` 呼び出し 1 + `applyRestorePlan` 呼び出し 1 = 3 件を想定している。ただし将来 applyRestorePlan 内部でさらに分岐して複数箇所から呼び出すケースもあり得るため「3 件以上」の緩い表現は合理的。厳密に検証したければ Inspector 側で「定義 1 + 呼び出し 2 以上」の形で追検可能
- **D14 と maxConductors < resumePlan.length のケース**: fallback 発動条件が `plan.unmatchedResumes.length > 0` を排除していないため、理論的には `maxConductors=3 + resumePlan=5 件` のような過剰 resume が来た場合の挙動が plan で明示されていない。ただしこれは既存 `initializeConductorSlots` の panes と 1:1 分配仕様（T255 で確立）に委ねる設計で、T286 スコープ外の既存挙動。現行仕様上も maxConductors を超える resume は再現性が低く、今回対応しなくても実害は低い
- **M17d の判定方針**: 任意扱いだが、Major #4 の回帰防止価値は高い（silently ready 戻しの事故防止）。Implementer が余力あれば入れる運用でよい
- **「pane 数が一時的に 6 になる瞬間を避ける」記述の補足**: L141 の「pane 数が一時的に 6 になる瞬間を避ける」は wide (3 slot) + 新規 3 slot = 6 の意味。16x9 (2 slot) の場合は 4 slot になる過渡状態を避ける意味に一般化される。厳密には「pane 数が `2 * maxConductors` になる瞬間を避ける」と読み替える必要があるが、実装上は sequential 保証で全レイアウトをカバーするので文言修正は不要

## E. Recommendations（CHANGES REQUESTED の場合）

該当なし（APPROVED のため）

## F. 補足コメント（APPROVED の場合）

実装時に注意すべき点を短く列挙:

- **S1 の `applyDiscardOnly` 抽出時**: `applyRestorePlan` 現行 L1010-1027 の C/E ブロックと行単位で diff を取り、reason フィルタ条件・ログ key 名・sequential 順序が bit-identical か grep + 目視の両輪で確認。Inspector フェーズで `git show HEAD:skills/cmux-team/manager/daemon.ts` と抽出後の `applyDiscardOnly` を並べて比較推奨
- **S2 のログ文言変更と M14 assertion**: M14 は `restored=wide current=16x9` の prefix しか見ていないので変更不要だが、他の箇所（integration test / snapshot test / grep-based log assertion）で「existing panes will be kept」等の文字列を比較していないか `grep -rn "existing panes will be kept" skills/cmux-team/` で念のため確認
- **S3 の M17b spy 検証**: `cmux.closeSurface` の呼び出し順序を spy で検証する際、test が mock Conductor の PID 死亡 + surface 実在 + idle を並列に 3 件セットアップするため、setup 順と expected 順が一致するよう Array ordering に注意（M12 の setup を流用するのが安全）
- **S4 の JSDoc 整形**: `main.ts` 冒頭 JSDoc コメントブロックで `stop` 行だけ削除すると、前後の `send` / `send-key` / `send SHUTDOWN` との間に不自然な 2 連続空行が残る場合がある。削除後にブロック全体を目視で見て「コマンド一覧として違和感がないか」を確認
- **S7 の grep 網羅性**: `grep -rn "cmux-team stop"` だけでなく `grep -rn "stop コマンド"` / `grep -rn "'stop'"` も 1 回通すと取りこぼし防止になる（日本語説明文中の「stop コマンド」表現が残っていないか確認）
- **S9 検証時の「新規エラー 0 件」判定**: §6.2 の既存 2 件 (`daemon.test.ts:3720` / `daemon.ts:1538`) を除外する必要があるため、`bunx tsc --noEmit 2>&1 | grep -v "daemon.test.ts:3720" | grep -v "daemon.ts:1538"` のような差分取りで自動確認できる
- **S9 完了後の artifact 起票（Minor #12 / D5）**: 強制ではないが、後続タスクの起票漏れを防ぐため Conductor 完了処理内で `/artifact decision "T286 後続: initializeLayout state-machine 化"` 相当を実行しておくと、将来の refactor 候補を追跡しやすい
