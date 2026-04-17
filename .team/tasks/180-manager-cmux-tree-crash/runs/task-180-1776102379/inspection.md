# Inspection: T180 — Manager の cmux tree タイムアウトを crash 判定から除外

## 判定: **GO**

plan / design-review / 受け入れ基準を満たしており、既存挙動の非破壊を実コードレベルで確認した。R1–R6 は妥当に反映済み。マージ可とする。

---

## 1. 検証結果サマリ

| 観点 | 結果 |
|------|------|
| `bun test` | ✅ **165 pass / 0 fail / 349 expect** — 既存テストに破壊なし、T180 向けに +20 tests |
| `bunx tsc --noEmit`（対象ファイル） | ✅ 新規エラーなし。`cmux.ts:22` の `NonSharedBuffer` 型不一致のみ検出、これは **main にも存在する既存エラー**で本タスクと無関係 |
| 変更量 | 5 ファイル / +262 / -20 行 |
| コード品質（plan §5 全箇所への `formatExecError` 適用） | ✅ `monitor_tree_failed` / `validate_surface_failed` / `getPaneForSurface failed` / `setStatus failed` すべて適用済み |
| 既存 crash 検出（`result === "missing"` → `kind=crashed`） | ✅ `daemon.ts` else 分岐で維持。surface 不在時の従来挙動は劣化なし |
| `treeImpl` 差し替えフック | ✅ production では `treeImpl = null` デフォルトで未注入時は実 cmux 呼び出し。副作用なし |
| `ConductorState` の後方互換 | ✅ `treeFailureCount` / `treeFailureFirstAt` は `optional()` で既存セッション読み込み可能 |
| ロギングポリシー準拠 | ✅ `formatExecError` 経由で stderr/stdout 付きエラーは自動的に detail に含まれる。高頻度ループ内のログは節目のみ（R5 反映） |
| 誤検出パターンの実装 | ✅ `isExecTimeout` は `killed && signal∈{SIGTERM,SIGKILL}` で判定、`cause` も辿る。混在時は `"missing"` 寄せ（真エラー 1 回でも返れば cmux daemon 応答中とみなす） |

---

## 2. 受け入れ基準チェック表（plan §7）

| # | 基準 | 結果 | 根拠 |
|---|------|------|------|
| 1 | cmux tree 一時タイムアウト（連続 <6 tick、累積 <120s）で Conductor 稼働中なら task aborted にならない | ◯ | `daemon.ts` の `unknown` 分岐で `count >= UNRESPONSIVE_MAX_TICKS && elapsed >= UNRESPONSIVE_MAX_SEC` の AND ゲート + `continue` でスキップ |
| 2 | `monitor_tree_failed` 等に stderr が含まれる | ◯ | `daemon.ts:1014` で `formatExecError(e)`。stderr が存在すれば自動付与（空なら省略仕様に沿う）|
| 3 | `validate_surface_failed` ログにも stderr 含む | ◯ | `cmux.ts:204` `formatExecError(e)` 適用 |
| 4 | `conductor_unresponsive*` / `conductor_responsive_recovered` ログ出力 | ◯ | 節目のみ: `_started` / `_threshold` / `_recovered` の 3 種類を実装（R5） |
| 5 | 本物 crash 検出（surface 不在）は従来通り `kind=crashed` | ◯ | `daemon.ts` `else` ブロックで `reason=validate_surface_failed kind=crashed` を維持 |
| 6 | `DISCONNECT_TIMEOUT_SEC=300` 維持、forced cleanup 機能継続 | ◯ | 定数・動作とも無変更 |
| 7 | CLAUDE.md「ロギングポリシー」準拠 | ◯ | `formatExecError` 統一 + 高頻度ログ抑制（節目のみ） |
| 8 | `isExecTimeout` / `validateSurfaceDetailed` のユニットテスト追加 | ◯ | `exec-error.test.ts` 8+3+3=14 ケース、`cmux.test.ts` に 6 ケース追加 |
| 9 | `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` / `_SEC` 環境変数で上書き可能 | ◯ | `daemon.ts:1012-1015` で `Number(process.env.XXX) \|\| default` |
| 10 | 既存セッション読み込みで `treeFailureCount` 未設定でも動作 | ◯ | `schema.ts` で `z.number().optional()` |

---

## 3. R1–R6 反映確認

| ID | 必須/推奨 | 判定 | 備考 |
|----|----------|------|------|
| R1 | 必須 | ✅ | SIGTERM kill 時の stderr 空問題は `formatExecError` の空値省略仕様で暗黙に対応。impl-notes §R1 に文言整理あり |
| R2 | 必須 | ✅ | `daemon.ts` `UNRESPONSIVE_MAX_TICKS` 宣言コメントに TODO として明記。本タスクスコープ外扱いは妥当（現行 120s + 300s = 7 分の 2 段ゲートで誤 abort リスクは十分低い）|
| R3 | 必須 | ✅ | `cmux.ts:30-33` で `wrapped.killed` / `wrapped.signal` / `wrapped.code` を転写。`exec-error.ts` の `isExecTimeout` も `cause` を辿るため二重に安全 |
| R4 | 任意 | ✅ | `__setTreeImpl` を export、`treeImpl` が null 時は実 cmux 呼び出し。production への副作用なし |
| R5 | 任意 | ✅ | 毎 tick ログをやめ、`_started` / `_threshold` / `_recovered` の状態変化節目のみ |
| R6 | 任意 | ✅ | `unknown` 時に `monitor_skip_agents` を 1 tick 1 回に絞って出力（複数 Conductor が同時 unresponsive でも 1 行に集約）|

---

## 4. コード確認（抜粋）

- `skills/cmux-team/manager/exec-error.ts:56-68` — `isExecTimeout` は `killed === true && signal ∈ {SIGTERM, SIGKILL}` + `cause` フォールバック。plan §2.1 通り
- `skills/cmux-team/manager/cmux.ts:187-215` — `validateSurfaceDetailed` は 3 試行で `allTimedOut` フラグ更新、終了時 `allTimedOut ? "unknown" : "missing"`。混在判定が plan §3.2 と一致
- `skills/cmux-team/manager/cmux.ts:221-224` — `validateSurface` は `validateSurfaceDetailed === "alive"` のラッパ。既存呼び出し元に対する後方互換維持
- `skills/cmux-team/manager/daemon.ts:1077-1144` — `alive` / `unknown` / `missing` の 3 分岐。`unknown` 時は threshold 未達なら `continue` で Agent チェックもスキップ（plan §3.3 通り）
- `skills/cmux-team/manager/daemon.ts:1150-1159` — Agent 生存チェックで `agentResult === "missing"` のみで削除。`"unknown"` 時の防御的扱いコメントあり（ただし `treeOutput !== null` 保証のため実際には `"unknown"` は返らない）

---

## 5. リスク・懸念

| リスク | 重要度 | 現状対応 |
|--------|--------|----------|
| `kind=cmux_unresponsive` で disconnected 化後 5 分で abort される | 中 | impl-notes §R2 TODO として明記。運用では 120s + 300s = 7 分の 2 段ゲートで実害低い |
| 真クラッシュの検出遅延（最大 60-120s） | 低 | `UNRESPONSIVE_MAX_SEC` 環境変数で短縮可。forceCloseDisconnectedConductor が最終的に回収 |
| `isExecTimeout` が cmux 側 SIGTERM を誤判定する可能性 | 低 | surface 消失は `tree()` 成功時の `includes()=false` で `"missing"` 判定され、crash 検出される |
| 手動検証（SIGSTOP/SIGCONT）は未実施 | 中 | ユニットテストで 3 値ロジックを網羅。事象ログからの閾値設計は根拠あり。将来 E2E 検証を行う場合は impl-notes §手動検証 の手順を使用 |
| `cmux.test.ts` で `__setTreeImpl` 注入を忘れる risk | 低 | `try/finally` ブロックで必ず `null` リセットしており並行テストでも汚染しない |

---

## 6. 結論

- 4 つの観点（受け入れ基準・R1-R6・非破壊・型/テスト）すべてパス
- 実装は plan / design-review の方針と完全に一致
- 本タスクスコープ外の R2（復帰パス）は impl-notes に TODO として適切にスコープアウト
- ただちにマージ可能

**判定: GO**
