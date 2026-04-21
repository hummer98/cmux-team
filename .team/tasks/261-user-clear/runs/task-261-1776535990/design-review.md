# T261 Design Review (rev2)

## Verdict

**Approved**

## Summary

v1 Review で blocker として挙げた 3 点（rebase target / source_guess 算出順序 / `session_idle_at` 相当フィールドの欠落）および suggestion の 2 点（`assignPromptFile` の宣言位置 / Step 数表記）は全て v2 で反映されている。特に blocker の核だった `guessSessionIdleSource` の `prevStatus` キャプチャは SESSION_IDLE / SESSION_CLEAR の両ハンドラ冒頭（`findConductor` 直後）で実施する指示が明文化され、さらに pure 関数として Step 2 GREEN に前倒し配置された点で、Step 4 の integration テストが `source_guess=clear_transient` を決定論的に検証可能になっている。

ConductorState の新規フィールドは 6 つ（`assigningSetAt` / `clearSentAt` / `promptSentAt` / `assignPromptFile` / `sessionStartedClearAt` / `sessionIdleAt`）に正しく拡張され、`sessionIdleAt` と `lastHookAt` の使い分け理由（SESSION_CLEAR ハンドラで `lastHookAt` が上書きされるため race signature が消える）も 1.3 / 5.7 節で明示的に正当化されている。`formatUserClearSnapshot` の出力例（2.2 節）と 6.1 節の期待ログも 1:1 対応しており、`session_idle_at=<SESSION_IDLE 時刻>` が SESSION_CLEAR 時刻と異なることを Step 5 テストで検証する指示も含まれている。

実コードとの整合も良好: base は `a1d51a2 Merge T259` で T260（`0a1aaa8`）が既に含まれており rebase 不要、SESSION_CLEAR ハンドラの範囲 L1936-2028・running 分岐 L1986・task_aborted L2001・SESSION_IDLE の assigning→running 遷移 L1824-1831・`session_idle` log L1834-1837 はいずれも worktree 実コードと完全一致。schema.ts L204-222 の ConductorState に `lastHookAt` が導入済みであることも確認済み。blocker なし、以下の Findings は全て suggestion レベル。

## v1 指摘の反映確認

| # | 指摘項目 | 反映状況 | コメント |
|---|---------|---------|---------|
| 1 | rebase target | 反映済 | v1 の「Step 0 で `git rebase origin/main`」は撤去。1.6 節で「本 worktree の base は `a1d51a2 Merge T259` で T260 は既に base に含まれている」と明記、Step 0 は `git log -1` による base 確認 + `bun test` に簡素化。実コード確認でも `a1d51a2` の ancestry に `0a1aaa8 Merge T260` が含まれる。|
| 2 | source_guess 順序 | 反映済 | 2.3 節で `guessSessionIdleSource(prevStatus, ...)` を pure 関数として定義（第 1 引数が `prevStatus`）。Step 4 の実装指示 L313-316 で「SESSION_IDLE ハンドラ L1786 の `findConductor` 直後で `const prevStatus = conductor?.status` をキャプチャ」と明示。2.5 節表 L208-209 にも `prevStatus` キャプチャ位置を明記。assigning→running 遷移後に status を参照しても `prevStatus` 引数経由で元の値が伝播するため `clear_transient` 評価が成立する。|
| 3 | sessionIdleAt + assignPromptFile | 反映済 | 2.1 節の表が 6 行に拡張され、Zod ブロックも 6 フィールド（L117-123）。`sessionIdleAt` の書き込みタイミングは「SESSION_IDLE ハンドラ（status 分岐後、`session_idle` log 直前）」と明記。Step 6 REFACTOR で resetConductor が 6 フィールド全てを undefined にクリア（L377-384）、6.2 チェックリストも 6 フィールドに更新。`lastHookAt` を流用しない根拠も 1.3 / 5.7 節で独立記述。|
| 4 | Step 数表記 | 反映済 | L219 で「Step 0（前準備） + Step 1〜5（RED→GREEN の 5 サイクル） + Step 6（REFACTOR）の計 7 段階」と正確化。頭の変更サマリ（L9）にも同じ表記が再掲されており整合している。|
| 5 | guess 関数前倒し | 反映済 | Step 2 GREEN で `formatUserClearSnapshot` と並べて `guessSessionIdleSource` を `export` で追加する指示に変更（L256 / L260）。Step 4 の SESSION_IDLE ハンドラ改変は pure 関数呼び出しに閉じられ、TDD サイクルが安定する。|

## Findings

### [S] 観点 2 設計の妥当性 / SESSION_CLEAR 側の `prevStatus` キャプチャ位置の活用範囲

- **Issue**: Step 5 で SESSION_CLEAR ハンドラ冒頭（L1942 `findConductor` 直後）に `const prevStatus = conductor?.status` をキャプチャする指示がある。一方、L1986 の running 分岐は `if (conductor && conductor.status === "running")` でガードされているため、この分岐内に到達した時点で `prevStatus === "running"` が保証される。Plan L367 のコード例でも `prevStatus ?? "running"` とフォールバックを置いており、実質 `"running"` 固定。
- **Why it matters**: 将来 SESSION_CLEAR ハンドラで status 遷移を伴う分岐が L1960-1969 以外にも追加された場合に備えて `prevStatus` をキャプチャすること自体は妥当だが、現状の running 分岐では意味的に冗長。
- **Recommendation**: Implementer が「なぜ `prevStatus ?? "running"` にフォールバックを置くのか」を迷わないよう、2.5 節 C1 の補足に「SESSION_CLEAR の running 分岐内なので prevStatus は常に `running`。`??` は防御的デフォルト」の 1 行コメントを足すと親切。blocker ではない。

### [S] 観点 3 TDD ステップ / `assigning_window_close` ログの二重発火ケースの明示

- **Issue**: 5.1 節で「`conductor_running` と `assigning_window_close` がペアで 2 行出るのを許容」とあり、SESSION_STARTED(clear) と SESSION_IDLE(assigning+taskRunId) の**どちらが先に来ても** window close ログが 1 回だけ出ることが想定されている。しかし Step 4 の integration テスト列挙（L294-296）では「両方来た場合の順序依存」が 4.2 節の describe "assigning_window_close ログ" L416 にのみ触れられており、Step 4 本体のテストリストからはやや読み取りづらい。
- **Why it matters**: T253 事例は「SESSION_IDLE が先、SESSION_STARTED が来ない（または遅延）」パターン。逆パターン（SESSION_STARTED が先で SESSION_IDLE は running 経由で来る）のテストも assigning_window_close が 2 重で出ないことを検証する意味で有用。
- **Recommendation**: Step 4 のテストリストに「SESSION_STARTED(clear) → running 遷移後、続く SESSION_IDLE では `assigning_window_close` が出ない（`conductor.status === "running"` でガードされるため）」という否定系ケースを 1 つ足すと、実装時の分岐漏れ（遷移後に close ログを誤発火する）を防げる。

### [S] 観点 6 出力フォーマット / `elapsed_since_clear_sent` の単位表記

- **Issue**: 2.2 節の出力例 L145 で `elapsed_since_clear_sent=2300ms`、`-` 時は `elapsed_since_clear_sent=-` と定義。Step 1 の formatUserClearSnapshot テスト L235 は「`nowISO` 引数で決定論的に計算」で網羅しているが、`clearSentAt` が set でも `nowISO` が未指定（`new Date().toISOString()` fallback）の場合のテストが明示されていない。
- **Why it matters**: Step 5 の integration テスト（T253 再現）では `nowISO` 引数を渡さず実時刻で動かすため、`elapsed_since_clear_sent` の shape は `\d+ms` であることを正規表現でアサートする必要がある。plan 4.4 節で range 検証（`toBeGreaterThan(0)` / `toBeLessThan(5000)`）を掲げているが、snapshot 文字列の regex も追記しておくと、実装の「`${elapsed}ms` フォーマット崩れ」を早期検出できる。
- **Recommendation**: 4.2 節 user_clear_decision describe に「snapshot 文字列の `elapsed_since_clear_sent=` が `\d+ms` 形式」の正規表現マッチを 1 つ足すと堅牢性が増す。blocker ではない。

### [A] 観点 1 調査の正確性 — 実コード照合結果

- 以下を worktree 実コードで verify 済み（一致）:
  - base: `a1d51a2 Merge T259`（`0a1aaa8 Merge T260` を含む）→ rebase 不要
  - SESSION_CLEAR ハンドラ範囲 daemon.ts:1936-2028: 一致（assigning 早期 return L1953、running 分岐 L1986、task_aborted L2001）
  - SESSION_IDLE ハンドラの `findConductor` L1786、assigning→running 遷移 L1824-1831、`session_idle` log L1834-1837: 一致
  - SESSION_STARTED assigning→running 遷移 L1357 付近: 一致（plan は L1358-1363）
  - ConductorState schema.ts:204-222 に `lastHookAt` 導入済み（T260 由来）
  - `classifyStopPayload` は IDLE / ASK の 2 値のみで user_clear に関知しない（plan 1.1 節記述通り）
- **Why it matters**: Implementer がすぐ着手できる精度。
- **Recommendation**: 特になし。

### [A] 観点 5 リスク / `formatConductorSnapshot` との役割分離

- 実コードで `formatConductorSnapshot`（T260 導入）を確認した。disconnect 観点のフィールドセット（`lastHookAt` / `disconnectedAt` / `pid` 等）を出力するヘルパーで、assign 窓観点（`assigningSetAt` / `clearSentAt` 等）は含まない。T261 で `formatUserClearSnapshot` を別関数化する方針（1.6 / 2.2 節）は妥当で、既存 `formatConductorSnapshot` の呼び出し箇所（conductor_disconnected / conductor_broken ログ）に影響を与えない。
- **Recommendation**: 特になし。Step 6 REFACTOR で「daemon.ts のローカル util セクションに 2 関数を並べて配置」とあるが、`formatConductorSnapshot` も同セクションに既に存在することを Implementer が確認できるよう、Step 6 の箇所に「既存 formatConductorSnapshot のすぐ下に新規 2 関数を配置」と追記すると可読性が上がる。これも blocker ではない。

## Recommendations

本 plan は v1 の 5 項目を全て反映しており Approved。上記 Findings は全て suggestion レベルで、実装着手を止める理由にはならない。Implementer は以下の順序で進めて問題ない:

1. Step 0: base 確認 + `bun test` green 確認
2. Step 1-2: schema 6 フィールド + `formatUserClearSnapshot` / `guessSessionIdleSource` pure 関数を RED→GREEN
3. Step 3: assignTask 側の state 書き込み + 3 ログ
4. Step 4: SESSION_STARTED / SESSION_IDLE の遷移ログ + `prevStatus` キャプチャ + `sessionIdleAt` 上書き
5. Step 5: SESSION_CLEAR の `user_clear_decision` スナップショット（T253 再現テスト含む）
6. Step 6: REFACTOR — resetConductor で 6 フィールドクリア、CLAUDE.md ロギングポリシー最終確認

上記 [S] の 3 点は実装中に余力があれば反映する程度で、リリース時に blocker にはならない。
