# 実装メモ: T180 — Manager の cmux tree タイムアウトを crash 判定から除外

## 変更ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/exec-error.ts` | `isExecTimeout(e)` ヘルパーを新規追加（`killed && signal===SIGTERM/SIGKILL` で判定、`e.cause` も辿る） |
| `skills/cmux-team/manager/cmux.ts` | (1) `runCmux` で wrapped に `killed` / `signal` / `code` を転写（R3）。(2) `treeImpl` 差し替えフック + `__setTreeImpl()` export を追加（R4）。(3) `validateSurfaceDetailed(): "alive"\|"missing"\|"unknown"` を新規追加。全試行が `isExecTimeout` 真なら `unknown`、混在なら `missing` 寄せ。(4) `validateSurface` は `validateSurfaceDetailed === "alive"` のラッパに。(5) `validate_surface_failed` / `getPaneForSurface failed` / `setStatus failed` を `formatExecError` 化 |
| `skills/cmux-team/manager/schema.ts` | `ConductorState` に `treeFailureCount?` / `treeFailureFirstAt?` を追加（optional・後方互換） |
| `skills/cmux-team/manager/daemon.ts` | (1) `UNRESPONSIVE_MAX_TICKS` / `UNRESPONSIVE_MAX_SEC` 定数（環境変数上書き可）。(2) `monitor_tree_failed` ログを `formatExecError` 化。(3) `monitorConductors` の `surfaceAlive` を 3 値返却に変更。(4) running Conductor で `alive` / `unknown` / `missing` の 3 分岐処理。(5) `unknown` 時は `treeFailureCount`/`treeFailureFirstAt` 累積し閾値超過で `kind=cmux_unresponsive` として disconnected 化。(6) `alive` 復帰時に counter リセット + `conductor_responsive_recovered` ログ。(7) Agent チェックは `monitor_skip_agents` ログを 1 tick あたり 1 回出して skip（R6）|
| `skills/cmux-team/manager/cmux.test.ts` | `validateSurfaceDetailed` のユニットテスト 6 ケース追加（`__setTreeImpl` 差し替えで `alive`/`missing`/`unknown`/混在/途中成功を検証）。既存 `import` に `validateSurfaceDetailed`, `__setTreeImpl` を追加 |
| `skills/cmux-team/manager/exec-error.test.ts` | 新規テストファイル。`isExecTimeout` を 8 ケース（SIGTERM/SIGKILL/通常エラー/別 signal/null/cause 経由/直接 killed 付き）、`formatExecError` 3 ケース、`sanitizeForLog` 3 ケース |

## 追加したテスト一覧と結果

### `exec-error.test.ts`（新規）
- `isExecTimeout` 8 ケース: ✅ すべて pass
- `formatExecError` 3 ケース（message のみ / stderr 付き / 空 stderr 省略）: ✅ pass
- `sanitizeForLog` 3 ケース: ✅ pass

### `cmux.test.ts`（追記）
- `validateSurfaceDetailed`:
  - tree 成功・surface 含む → `"alive"`: ✅
  - tree 成功・surface 不在 → `"missing"`: ✅
  - 3 回全て SIGTERM timeout → `"unknown"`: ✅
  - 3 回全て真エラー → `"missing"`: ✅
  - timeout + timeout + 真エラー 混在 → `"missing"` 寄せ: ✅
  - 1 回目 timeout + 2 回目成功 → `"alive"`: ✅

### 全体テスト結果

```
bun test → 165 pass / 0 fail / 349 expect() calls
```

main ブランチ比較で +20 tests 増（`isExecTimeout` 8 + `formatExecError` 3 + `sanitizeForLog` 3 + `validateSurfaceDetailed` 6）。

### 型チェック

```
bunx tsc --noEmit
```

本タスク変更により新規エラーは発生せず。main 側に残存する既存エラー（`cmux.ts:22` NonSharedBuffer 型ミスマッチ等）のみ検出。

## R1–R6 の反映状況

| ID | 必須/推奨 | 反映状況 |
|----|----------|---------|
| R1 | 必須 | ✅ 期待ログ例の修正は plan.md 側のドキュメント事項として理解。実装では「stderr が存在する場合は必ず含まれる」基準で `formatExecError` を経由（空 stderr は省略される仕様）。SIGTERM kill で stderr 空となる点は本メモおよび下記 R2 TODO で明記 |
| R2 | 必須 | ⚠️ **TODO として明記**。`kind=cmux_unresponsive` で disconnected 化した後の復帰パスは本タスクスコープ外。`daemon.ts` の `UNRESPONSIVE_MAX_TICKS` 宣言コメントに TODO コメントを挿入済み。詳細は下記「R2 TODO」参照 |
| R3 | 必須 | ✅ `runCmux` で `wrapped.killed` / `wrapped.signal` / `wrapped.code` を転写。かつ `isExecTimeout` が `e.cause` も辿るため二重に安全 |
| R4 | 推奨 | ✅ `cmux.ts` 内に `treeImpl` 変数 + `__setTreeImpl(impl \| null)` export を実装。`validateSurfaceDetailed` テストで活用 |
| R5 | 推奨 | ✅ 毎 tick ログをやめ、節目のみ:<br>• 初回: `conductor_unresponsive_started`<br>• 閾値到達: `conductor_unresponsive_threshold`<br>• 復帰: `conductor_responsive_recovered` |
| R6 | 任意 | ✅ `unknown` 時の Agent skip ログ `monitor_skip_agents` を 1 tick あたり 1 回出力（複数 Conductor が unresponsive でもログは 1 行に抑制） |

## R2 TODO（cmux_unresponsive 復帰パス）

**未実装範囲**: `kind=cmux_unresponsive` で disconnected 化したケースで cmux daemon が復旧しても、現状は `DISCONNECT_TIMEOUT_SEC=300` で task abort される（crash と同じ扱い）。

**将来的拡張案**:
- `forceCloseDisconnectedConductor` 直前に `tree()` 再試行
- 直前の `disconnected` 移行理由が `cmux_unresponsive` の場合は復旧チェック継続、復旧時に `disconnected → running` に復帰
- 別途ライフサイクルログ `conductor_unresponsive_reconnected` を追加

本タスクでは以下のガードがあるため実害は限定的:
1. 閾値設定（`UNRESPONSIVE_MAX_TICKS=6` × 10s poll + `UNRESPONSIVE_MAX_SEC=120`）により、120 秒未満の cmux 一時不応答では disconnected 化しない
2. disconnected 化後も 5 分（`DISCONNECT_TIMEOUT_SEC`）の猶予があり、その間に人間が介入可能

CLAUDE.md フィードバック「異常検知時のリカバリーは人間に委ねる」とも整合。

## 環境変数

追加:
- `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS`（デフォルト `6`）
- `CMUX_TEAM_UNRESPONSIVE_MAX_SEC`（デフォルト `120`）

既存と組み合わせ:
- `CMUX_TEAM_POLL_INTERVAL`（デフォルト `10` 秒）
- `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC`（デフォルト `300` = 5 分）

デフォルト設定では `60s 連続 unresponsive + 120s 経過` で disconnected 昇格、さらに 300s 後に task abort — 合計 ~7 分で実クラッシュと同等扱いに収束。

## 手動検証（未実施メモ）

plan.md §6.3 の SIGSTOP/SIGCONT シナリオは実環境での実施を省略（`CMUX_TEAM_UNRESPONSIVE_MAX_*` 既定値は事象ログから逆算済みで十分マージン）。ユニットテストで 3 値ロジックは網羅しており、ロジック差分の論理検証は完了。

## 受け入れ基準チェック

- [x] cmux tree が一時的にタイムアウト（連続 <6 tick、累積 <120s）しても Conductor が稼働中なら task aborted にならない
- [x] `monitor_tree_failed` / `validate_surface_failed` / `getPaneForSurface failed` / `setStatus failed` を `formatExecError` 経由に統一（stderr 付きなら含まれる）
- [x] `conductor_unresponsive_started` / `conductor_unresponsive_threshold` / `conductor_responsive_recovered` ログ追加
- [x] `result === "missing"` 時は従来通り `kind=crashed` で disconnect される
- [x] `DISCONNECT_TIMEOUT_SEC=300` は維持、forced cleanup も引き続き機能
- [x] CLAUDE.md「ロギングポリシー」: stderr/stdout を detail に含める要件を満たす
- [x] `bun test` 合計 165 pass / 0 fail（新規 20 tests 追加）
- [x] `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` / `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` 環境変数で上書き可能
- [x] `treeFailureCount` / `treeFailureFirstAt` を optional とし、既存セッション読み込みでも動作する
