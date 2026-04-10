# Inspection: 5hレート制限スロットリング + TUI表示

## 判定: GO

## 検品結果

### plan.md との整合性

3ファイル全て計画通りに実装されている。

| ファイル | 計画 | 実装 | 判定 |
|---------|------|------|------|
| schema.ts | `THROTTLE_5H_THRESHOLD = 0.95` を末尾に追加 | 162行目に追加、JSDoc コメント付き | OK |
| daemon.ts | `allExecutable` 算出後・割り当てループ前にガード挿入 | 747-756行、`state.taskList` 更新後・`for` ループ前に配置 | OK |
| dashboard.tsx | `headerParts` にスロットリング表示、赤色レンダリング | 827-846行でラベル生成、879-891行で赤色分岐 | OK |

- `scanTasks()` の `return` 位置が正しい（`state.pendingTasks`/`state.taskList` 更新後）
- `tick()` 内の `monitorConductors()` は `scanTasks()` の後に独立して呼ばれるため影響なし（daemon.ts:418-419行）
- STOPPED/STARTING 状態はスロットリング表示より優先される（plan の設計通り）
- `formatResetRemaining()` は既存関数（dashboard.tsx:189行）をそのまま利用

### コンパイルチェック

`npx tsc --noEmit` で 5 件のエラーが出力されたが、**全て既存エラー**（変更前のコードでも同一エラーが発生することを `git stash` で確認済み）。今回の変更で新たな型エラーは導入されていない。

### null 安全性

問題なし。

- `state.rateLimit?.unified5hUtilization ?? 0` — `rateLimit` が `null`（proxy 未起動）の場合は `0` にフォールバック。`0 >= 0.95` は `false` なのでスロットリングしない
- `throttled5h` が `true` の場合の `state.rateLimit!.unified5hUtilization!` — `?? 0` で `0` が返った場合は `0 >= 0.95` が `false` なので到達不可。non-null assertion は論理的に安全
- `state.rateLimit!.unified5hReset` — 同上、`rateLimit` は non-null 保証。`unified5hReset` は `string | null` だが、ログでは `reset ?? "unknown"` で安全に処理
- dashboard.tsx 側の `daemon.rateLimit!.unified5hUtilization!` も同じ論理で安全（`isThrottled && daemon.running && daemon.bootPhase === "ready"` ガード内）

### 既存機能への影響

問題なし。

- **タスク割り当て**: スロットリング非発動時は `throttled5h === false` で既存の `for` ループに到達。既存パスに変更なし
- **Conductor 監視**: `monitorConductors()` は `scanTasks()` とは独立して `tick()` 内で呼ばれる（daemon.ts:419行）。`return` で中断されない
- **ヘッダー表示**: スロットリング非発動時は `isThrottled === false`、`throttleLabel === ""`、`headerSubtitle = headerParts.join("  ")` で既存と同じ動作
- **fill 幅計算**: throttled 分岐と通常分岐で `left` 変数の構築が同一のため、レンダリング幅は一致

### import

正しい。

- daemon.ts:21行 `import { THROTTLE_5H_THRESHOLD } from "./schema";` — value import
- dashboard.tsx:17行 `import { THROTTLE_5H_THRESHOLD } from "./schema";` — value import
- 既存の `import type { ConductorState, ... }` とは別行で正しく分離されている

### ログ出力

適切。

- イベント名 `throttled_rate_limit` — ロギングポリシーの命名規則に準拠（判断分岐の記録）
- フォーマット: `5h_utilization=95.0% threshold=95% reset=unknown skipped_tasks=2` — `key=value` スペース区切り、1行1イベント
- スロットリング非発動時はログ出力なし（高頻度ログの禁止事項に準拠）
- `allExecutable.length > 0` ガードにより、実行可能タスクがない場合の不要なログを抑制
