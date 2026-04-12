# Inspection: Task 163

## 判定: GO

## 検品結果

- **テスト**: 83 pass / 0 fail（`bun test`、7 ファイル、195 expect）
  - 既存 validateSurface リトライテスト（4 件）pass を維持
  - 新規追加された send() / setStatus() の stderr 伝播テスト（2 件）pass
- **Recommendations 反映**: 全項目 反映済み
  1. ✅ 二重ラップ防止フラグ `__cmuxWrapped` — `cmux.ts:24, 30` で実装
  2. ✅ `formatExecError` / `sanitizeForLog` 共通化 — `exec-error.ts` 新設、`runCmux` も import 利用（重複なし）
  3. ✅ preflight.ts は `issue.context` に stderr を埋め込む方針で実装（`preflight.ts:34-35`）
  4. ✅ daemon.ts npm callback を `(err, stdout, stderr)` に変更し err.stderr/stdout を転写。`npm_self_update_completed` ログ追加で成功時記録も追加（design-review #4 の付随推奨対応）
  5. ✅ main.ts execFileSync catch — `cleanupAssignedTask`（abort-task）は空 catch を `formatExecError` 付きログに変更。`claude` spawn 系（892/962/1018）と daemon reload（294）は `stdio: "inherit"` で stderr が既にユーザ可視のため未変更（妥当）。`findLatestMainTs` の `npm prefix -g` 空 catch（70）はフォールバックチェーンの一部で意図的（OK）
  6. ✅ テスト箇所 — リトライ高速化のため `send()`（即時 throw 系）と `setStatus()`（catch+log 系）で検証
- **plan.md 完了条件**: 7 項目すべて満たす
  - cmux.ts 全 14 execFile が `runCmux` 経由 ✓
  - `runCmux` が stderr/stdout を message に含めて throw ✓
  - `formatExecError` 共通化＆4 ファイル（cmux/conductor/daemon/main/preflight）から呼出 ✓
  - daemon.ts npm callback で stderr ログ ✓
  - cmux.test.ts に stderr 伝播テスト追加 ✓
  - 既存テスト全 pass ✓
- **ログフォーマット**: `formatExecError` は `\s+` → スペース正規化 + 2KB 切り捨て + 空値省略を実装。1 行 1 イベント規約遵守
- **回帰**: validateSurface のリトライ動作・tree 成功時の即返し動作いずれも既存テストで保証されており影響なし

## Fix Required

なし。

## 勘所・懸念

- **手動 E2E 未実施**: `cmux tree` を意図的に失敗させる手動検証は実施していない。ただしユニットテストで `send()` 経由の Error.message に `stderr=<sentinel>` が含まれることを fake cmux で検証しており、`tree()` も同じ `runCmux` を通るためフォーマット出力は同一。理論上 `monitor_tree_failed last_error=...` ログにも `| stderr=...` が現れる
- **`error.cause` の利用**: `runCmux` は wrap 後 Error に `cause` を付与している。ログでは表示されないが debugger 等で原因辿れる。問題なし
- **`stdio: "inherit"` で execFileSync の stderr を取れない件**: claude spawn 系の `e.message` は依然 `Command failed` のみだが、stderr は子プロセスから直接ユーザコンソールへ流れているため失われていない。設計判断として妥当
- **proxy.ts の `e.message`（drainAndLog）**: plan.md で対象外と明記されており、execFile 由来ではないため検品観点でも問題なし
- **二重ラップ動作のテスト未追加**: `__cmuxWrapped` 分岐の単体テストはないが、ロジックは 3 行と単純で目視確認可能。余裕があれば将来追加推奨だが本タスクのブロッカーではない
