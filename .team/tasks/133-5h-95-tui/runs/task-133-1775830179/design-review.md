# Design Review: 5hレート制限スロットリング + TUI表示

## 判定: Approved

## レビュー結果

### 正確性

全ての行番号・関数名・変数名が実際のコードと一致していることを確認した。

| plan.md の記述 | 実際のコード | 結果 |
|---|---|---|
| `scanTasks()` 697行〜 | daemon.ts:697 `export async function scanTasks` | OK |
| `allExecutable` ループ 746行 | daemon.ts:746 `for (const task of allExecutable)` | OK |
| `state.pendingTasks` 更新 724行 | daemon.ts:724 `state.pendingTasks = allExecutable.length;` | OK |
| `state.taskList` 更新 〜744行 | daemon.ts:733-744 `state.taskList = combined.map(...)` | OK |
| `headerParts` 826〜829行 | dashboard.tsx:826-829 | OK |
| ヘッダーレンダリング IIFE 855〜867行 | dashboard.tsx:855-868 | OK |
| `formatResetRemaining` 187行付近 | dashboard.tsx:188 | OK |
| `tick()` 内で `scanTasks` → `monitorConductors` | daemon.ts:417-418 | OK |
| `state.rateLimit` 型 `RateLimitInfo \| null` | daemon.ts:56 | OK |
| `unified5hUtilization` 型 `number \| null` | schema.ts:146 | OK |
| `RED` 定数 | dashboard.tsx:128 `const RED = rgb(180, 40, 40);` | OK |
| `RateLimitInfo` interface 末尾 158行付近 | schema.ts:134-157（interface は157行で終了） | OK |
| daemon.ts の schema import | daemon.ts:20 `import type { ConductorState, QueueMessage, RateLimitInfo }` | OK（`THROTTLE_5H_THRESHOLD` 追加が必要） |
| dashboard.tsx の schema import | dashboard.tsx:15-16 `import type { ConductorState, RateLimitInfo }` | OK（`THROTTLE_5H_THRESHOLD` 追加が必要） |

**注意**: `THROTTLE_5H_THRESHOLD` は `const` export のため、dashboard.tsx/daemon.ts の import に `type` でなく value import として追加する必要がある。現状の `import type { ... }` 行とは別の import 文にするか、`type` を外す必要がある。plan にはこの点の明示がないが、実装時に自明の対応で済む。

### 完全性

変更対象3ファイル（schema.ts, daemon.ts, dashboard.tsx）で必要な修正が全て網羅されている。

- **スロットリングガードの挿入位置**: `state.pendingTasks` / `state.taskList` 更新の後、割り当てループの前。TUI に正しい pending 数が表示される点が正しく考慮されている。
- **`tick()` の後続処理への影響**: `scanTasks()` 内の `return` は `tick()` を中断しない。`monitorConductors()` は daemon.ts:418 で別途呼ばれるため、Conductor 監視は継続される。plan の分析は正確。
- **他ファイルへの影響**: 変更は3ファイルに閉じており、他ファイルへの波及はない。

漏れは検出されなかった。

### 安全性

1. **null 安全性**: `state.rateLimit?.unified5hUtilization ?? 0` で `rateLimit` が null（proxy 未起動時）や `unified5hUtilization` が null（ヘッダー未受信時）のケースを正しくハンドリングしている。デフォルト 0 でスロットリングしない動作は安全。

2. **早期リターンの安全性**: `scanTasks()` の `return` は関数スコープの終了であり、`tick()` 内の `monitorConductors()` 呼び出しには影響しない。daemon.ts:415-418 の構造から確認済み。

3. **既存機能への影響**: 
   - タスク一覧表示: ガード前にタスク情報更新が完了しているため影響なし
   - Conductor 監視: ガードは割り当てループのみスキップ。実行中 Conductor は引き続き監視される
   - STOPPED/STARTING 表示: ヘッダーの条件分岐で優先されるため干渉なし

4. **自動復帰**: リセット時刻を過ぎれば proxy が次の API レスポンスで低い utilization を受信し、スロットリングが自動解除される。Conductor が動作中であれば API コールが発生するため、リセット情報は自然に更新される。正しい設計。

5. **Non-null assertion (`!`)**: `isThrottled` ガード内での `state.rateLimit!.unified5hUtilization!` は、直前の `isThrottled` 判定で `rateLimit` と `unified5hUtilization` の存在が保証されているため安全。ただし `?? 0` は `0` も `>= 0.95` を満たさないため、`unified5hUtilization` が `null` のとき `isThrottled` は必ず `false` になる。型システム上は `!` が正当。

### 実現可能性

1. **daemon.ts の擬似コード**: そのまま動作する。`THROTTLE_5H_THRESHOLD` の import 追加のみ注意。

2. **dashboard.tsx の擬似コード**: 基本的に動作する。以下の点に留意:
   - `formatResetRemaining` は既存関数で、`unified5hReset`（`string | null`）をそのまま渡せる型互換性がある
   - `isThrottled` は `buildViewWithApp()` のスコープに定義され、IIFE クロージャからアクセス可能
   - `RED` は dashboard.tsx:128 で定義済み
   - `ui.row`, `ui.text` は既存ヘッダーレンダリングと同じ API

3. **import の追加**: `THROTTLE_5H_THRESHOLD` は value export のため、既存の `import type { ... }` とは別行で import するか、`type` キーワードを外す必要がある。plan には明記されていないが実装時に自明。

4. **`formatResetRemaining` の引数フォーマット**: schema.ts のコメントでは `unified5hReset` を「unix timestamp 文字列」と記載しているが、`formatResetRemaining` は `new Date(resetIso)` でパースしている。Anthropic API の `anthropic-ratelimit-unified-5h-reset` ヘッダーが ISO 8601 形式であればそのまま動作する。既存の `buildUtilizationBar()` が同じ関数を使用して動作していることから、現状で問題なし（これは plan が導入する問題ではなく、既存のドキュメント不整合）。

## 将来拡張性

7d リミット追加は以下で対応可能:
- `THROTTLE_7D_THRESHOLD` を schema.ts に追加
- daemon.ts: `const throttled7d = ...` を追加し `if (throttled5h || throttled7d)` に変更
- dashboard.tsx: `isThrottled` の判定を `||` で拡張、`throttleLabel` にどちらの制限かを表示

パターンが同一のため、無理なく拡張できる設計になっている。

## 総評

設計は明確で、コード参照の正確性も高い。挿入位置・null 安全性・早期リターンの影響分析が適切に行われている。import の `type` / value 区別のみ実装時に注意が必要だが、plan の品質として問題はない。Approved とする。
