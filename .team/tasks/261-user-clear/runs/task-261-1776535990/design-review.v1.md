# T261 Design Review

## Verdict

**Changes Requested**

## Summary

Planner の調査は総じて正確で、T253 race の根本分析（旧セッションの Stop hook → SESSION_IDLE が先行して assigning→running に倒し、直後の SESSION_CLEAR が user_clear 経路へ流れ込む）は実コードと合致している。task.md の期待（「classify-stop に state 追加」）に流されず、user_clear 判定は `classify-stop.ts` ではなく `daemon.ts:1704-1811` の SESSION_CLEAR ハンドラにあると正しく断定している点も評価できる。設計の骨格（`formatUserClearSnapshot` を既存 `formatConductorSnapshot` と分離し、assigning 窓の時刻を 4 フィールド追加して判定直前に 1 行吐く）は筋が良い。

ただし実装に着手すると確実にハマる 3 点の不整合があり、現状のまま Implementer に渡すと Step 4〜5 の期待ログが再現できない。具体的には、(a) Step 0 の rebase target が `origin/main` になっているが T260（`lastHookAt` / `formatConductorSnapshot` 導入）は local `main` にしか存在せず origin には未 push、(b) `source_guess` の算出位置が `daemon.ts:1604`（assigning→running 遷移の**後**）になるため、6.1 の期待値 `source_guess=clear_transient` が出ない、(c) 期待ログに含まれる `session_idle_at=` を埋めるフィールドが 2.1 の新規 4 フィールドに存在しない。いずれも 1〜2 行の修正で済むが blocker。

また `conductor.assignPromptFile` は 2.1 の表に載っておらず Step 5 で初出する、ステップ数が「5」と書きつつ Step 0〜6 で実質 7 ステップある、といった軽微な不整合もある。これらを解消すれば Approved。

## Findings

### [N] 観点 3 TDD ステップの実装可能性 / Step 0 の rebase target

- **Issue**: Step 0 は `git rebase origin/main` で T260 を取り込むと記載されているが、実際には T260（`0a1aaa8 Merge T260: ...`）は local `main` にのみ存在し、`origin/main` の tip は `ac269f6 chore: release v3.54.1` で T260 未到達。worktree base も同じ `ac269f6` 起点（plan 1.6 の記述と一致）。この状態で `git rebase origin/main` を実行すると T260 が取り込まれず、Step 2 の「`formatConductorSnapshot` / `lastHookAt` がそのまま使える」前提が成立しない。
- **Why it matters**: Step 2〜5 すべてが T260 の basis（`ConductorState.lastHookAt`, `formatConductorSnapshot`, `task_aborted reason=`）に依存する設計。rebase が空振りすると Implementer は T260 を再発明する羽目になるか、`lastHookAt` 未定義でコンパイルエラーに陥る。
- **Recommendation**: Step 0 を以下のいずれかに修正:
  1. `git rebase main`（local main）と明示し、rebase 前に `git log main..origin/main --oneline` で unpushed 分を確認する手順を追加
  2. もしくは Step 0 の前段に「`git push origin main` で T260 / T259 を origin に反映してから rebase」を追加し、`origin/main` 運用を維持
  さらに 1.6 節の「Implementer が `origin/main` から rebase すれば …」も同じ文言で修正すること。

### [N] 観点 2 設計の妥当性 / source_guess の算出順序

- **Issue**: 2.5 節の source_guess ルールは `conductor.status === "assigning" && clearSentAt 差 < 10s → clear_transient` と「遷移前の status」を前提にしている。しかし Step 4 の実装指示（「line 1604-1607 の `session_idle` detail に `source_guess` を付与」）では付加位置が 1594-1602 の assigning→running 遷移の**後**。この時点で `conductor.status` は既に `"running"` に書き換わっているため、T253 再現テストでは `turn_end` に評価され 6.1 節の期待ログ `source_guess=clear_transient` が出ない。
- **Why it matters**: T261 の核は「T253 bug の race を事後にログから特定する」こと。source_guess が誤って `turn_end` になると、T253 の race を発見する重要な手がかりが失われ、PR として完了条件 6.1 を満たせない。この齟齬は integration テスト（4.2 の `describe("T261: assigning_window_open/close ログ")` と `describe("T261: user_clear_decision スナップショット")`）でも再現するため、TDD サイクルが回らない。
- **Recommendation**: 以下いずれかで計算位置を明示:
  1. SESSION_IDLE ハンドラ冒頭（`conductor = findConductor(...)` 直後、1555 行付近）で `const prevStatus = conductor?.status` をキャプチャし、guessSessionIdleSource(prevStatus, ...) に引き回す
  2. もしくは `session_idle` ログを 1604 から 1594-1602 ブロックの**前**に移設し、さらに 1594-1602 の遷移 case に個別にログを足す
  推奨は (1)。Step 4 / Step 6 の REFACTOR 節と 2.5 節に `prevStatus` 引数を明記すること。

### [N] 観点 2 設計の妥当性 / `session_idle_at` 相当フィールドの欠落

- **Issue**: 完了条件 6.1 の期待ログ（319 行目）には `session_idle_at=2026-04-18T21:10:44.100+09:00` が含まれているが、2.1 節に追加する新規フィールドは `assigningSetAt` / `clearSentAt` / `promptSentAt` / `sessionStartedClearAt` の 4 つだけで `sessionIdleAt` がない。既存の `conductor.lastHookAt`（T260 由来）を流用する案は、SESSION_CLEAR ハンドラ先頭の `conductor.lastHookAt = message.timestamp`（daemon.ts:1708 相当、local main）で SESSION_CLEAR 時刻に上書きされた**後**に `formatUserClearSnapshot` が呼ばれるため、SESSION_IDLE 時刻ではなく SESSION_CLEAR 時刻が snapshot に現れてしまう。
- **Why it matters**: T253 race の観測可能性の核は「clear 送信 → SESSION_IDLE → SESSION_CLEAR のタイムライン」をワンショットで読めること。`session_idle_at` が正しい値で埋まらない（あるいは SESSION_CLEAR と同時刻になる）と、「SESSION_IDLE が SESSION_CLEAR より 1.1s 先行していた」という race signature が消滅する。6.2 チェックリストの「`user_clear_decision` が emit」も不完全な snapshot で通過してしまうため blocker。
- **Recommendation**: 以下のいずれかを 2.1 / 2.2 節に反映:
  1. `ConductorState.sessionIdleAt?: string` を追加し、daemon.ts:1604（`session_idle` ログ直前、かつ assigning→running 遷移の後）で書き込む
  2. もしくは `formatUserClearSnapshot` 内でローカルに `Math.min(lastHookAt, clearSentAt のどれ)` から推定 — ただしこれは脆い。(1) 推奨
  (1) を採れば resetConductor でのクリア対象も「4 フィールド + assignPromptFile + sessionIdleAt」の 6 要素に更新が必要（Step 6 REFACTOR / 5.2 節も合わせて修正）。

### [S] 観点 6 出力フォーマット / `assignPromptFile` の宣言位置

- **Issue**: 2.1 節の新規フィールド表には 4 つしかないが、Step 5 の本文で「`prompt_file` を state に持たせる（`conductor.assignPromptFile`）」とさらっと追加されている。2.1 に載っていないため、Implementer が schema.ts 変更時に見落とす / 6.2 チェックリスト「ConductorState に 4 フィールド + `assignPromptFile` 追加済み」との食い違いで TDD テストが不安定化する可能性。
- **Why it matters**: 設計合意の粒度がばらつくと後から「仕様どっち？」の差し戻しが入る。
- **Recommendation**: 2.1 の表に 5 行目として `assignPromptFile` を追加し、Zod コードブロックにも `assignPromptFile: z.string().optional()` を追記。Step 3 の assignTask 本体実装にも「`conductor.assignPromptFile = promptFile`」を明記。

### [S] 観点 3 TDD ステップ / ステップ数の表記不整合

- **Issue**: 「ステップ数は **5 ステップ**」と冒頭に書きつつ、実体は Step 0（前準備）+ Step 1〜5 + Step 6（REFACTOR）の 7 ステップ。
- **Why it matters**: Implementer のチェックリスト管理で混乱の元。進捗報告時にも齟齬が出る。
- **Recommendation**: 「Step 0（前準備）+ Step 1〜5（RED→GREEN）+ Step 6（REFACTOR）の計 7 ステップ」と正確に書き直す。または Step 0 / Step 6 を「前準備 / 後処理」として RED-GREEN-REFACTOR カウントから除外し明示。

### [A] 観点 1 調査の正確性 — 参考事項

- **Issue（確認事項）**: 実コードで以下を verify 済み。
  - SESSION_CLEAR ハンドラ範囲 `daemon.ts:1704-1811`: 完全一致
  - user_clear 判定箇所 `daemon.ts:1764-1770`: running 分岐で journal + `task_aborted reason=user_clear` 発火、一致
  - SESSION_IDLE assigning→running 遷移 `daemon.ts:1594-1602`: 完全一致
  - SESSION_STARTED assigning→running 遷移 `daemon.ts:1134-1141`: 完全一致（Plan は 1134 と表記、実コードは 1134 で条件開始→1141 で log 終了）
  - `conductor.ts:assignTask` の行番号（405 assigning set / 408-410 /clear sendKey / 414-419 prompt sendKey）: 完全一致
  - `classifyStopPayload` は IDLE / ASK の 2 値を返すだけで user_clear に関知しない（classify-stop.ts:69 でシグネチャ確認、return 型）
- **Why it matters**: 参照行が正しいと Implementer がすぐ着手できる。Plan 1.1 の表は本レビューの verify と一致。
- **Recommendation**: 特になし。

### [A] 観点 5 リスク / hook_signals への影響

- **Issue（確認事項）**: Plan 5.3 は「`insertHookSignal` の呼び出し位置を変更しない」としており、T216 ポリシー（handleMessage 入口で全 hook 行を記録）に準拠。レビュー時点で新規ログが hook_signals の行に追加されない設計になっていることを確認済み。
- **Why it matters**: hook_signals テーブルは事後解析の基盤。余計な書き込みを入れない判断は正しい。
- **Recommendation**: 特になし。Step 5 / Step 6 実装時も `log()` 経由の追記のみで insertHookSignal を触らないことを implementer へ念押しすると万全。

## Recommendations

以下を反映した plan.md へ差し戻し:

1. **Step 0 / 1.6 節の rebase target を修正**:
   - 「`git rebase origin/main`」→「`git rebase main`（ローカルの main。origin/main は T260 未到達なので要確認）」に変更。または「Step 0 の前段で `git push origin main` を実行」を追加。
   - 1.6 節の「Implementer が `origin/main` から rebase …」も同文言に統一。

2. **2.5 節 source_guess の算出順序を明示**:
   - 付加位置を `daemon.ts:1604` から「SESSION_IDLE ハンドラ冒頭（`findConductor` 直後）で `prevStatus` をキャプチャし、guess 関数にそれを渡す」形に変更。
   - Step 4 の実装指示にも `const prevStatus = conductor?.status` を明示。
   - `guessSessionIdleSource(prevStatus, clearSentAtIso, taskRunId, messageTimestamp)` のような pure 関数として export / ユニットテスト可能にする（Step 6 REFACTOR で書いたとおりだが、純粋関数化を前倒しして Step 2 に含めると TDD サイクルが安定する）。

3. **2.1 節に `sessionIdleAt` と `assignPromptFile` を追加**:
   - 新規フィールドは 6 つ（`assigningSetAt` / `clearSentAt` / `promptSentAt` / `sessionStartedClearAt` / `sessionIdleAt` / `assignPromptFile`）に更新。
   - Zod コードブロックも更新。
   - Step 4 の実装指示に「assigning→running 遷移の後に `conductor.sessionIdleAt = message.timestamp` を設定してから `session_idle` を log」を追記。
   - Step 5 の snapshot テストに「`session_idle_at` が SESSION_IDLE 時刻で埋まり、SESSION_CLEAR 時刻と異なる」ケースを明示。
   - 5.2 節と 6.2 チェックリストの「4 フィールド」を「6 フィールド」に修正。

4. **Step 数の表記修正**:
   - 「**5 ステップ**」→「**Step 0〜Step 6 の計 7 段階（RED→GREEN は Step 1〜5 の 5 サイクル）**」など誤解のない表現へ。

5. **（任意）guessSessionIdleSource の独立関数化を Step 2 に前倒し**:
   - Step 6 REFACTOR に置かず Step 2 で作れば、Step 4 の daemon.ts 改変範囲が小さくなりテストが書きやすい。

上記を反映した後、再レビューで Approved 見込み。
