# 実装計画: レート制限ヘッダー記録 + TUI トークン残量表示

## 変更対象ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `RateLimitInfo` インターフェース追加 |
| `skills/cmux-team/manager/daemon.ts` | `DaemonState` に `rateLimit` フィールド追加、初期値設定 |
| `skills/cmux-team/manager/proxy.ts` | レスポンスヘッダーから rateLimit を解析して DaemonState に書き込み |
| `skills/cmux-team/manager/dashboard.tsx` | ヘッダー行にトークン残量 % + プログレスバー表示 |

## 実装順序

1. schema.ts（型定義）
2. daemon.ts（状態フィールド追加）
3. proxy.ts（ヘッダー解析・書き込み）
4. dashboard.tsx（表示）

## 各ファイルの具体的な変更内容

### 1. schema.ts — `RateLimitInfo` インターフェース追加

120行末尾に追加:

```typescript
// --- レート制限情報 ---

export interface RateLimitInfo {
  /** tokens remaining（分単位ウィンドウ） */
  tokensRemaining: number;
  /** tokens limit（分単位ウィンドウ） */
  tokensLimit: number;
  /** tokens reset（ISO 8601） */
  tokensReset: string;
  /** input tokens remaining */
  inputTokensRemaining: number;
  /** output tokens remaining */
  outputTokensRemaining: number;
  /** 最終更新時刻 */
  updatedAt: string;
}
```

### 2. daemon.ts — `DaemonState` に `rateLimit` 追加

**2a. import に `RateLimitInfo` を追加**

19行の既存 import:
```typescript
import type { ConductorState, QueueMessage } from "./schema";
```
を以下に変更:
```typescript
import type { ConductorState, QueueMessage, RateLimitInfo } from "./schema";
```

**2b. `DaemonState` インターフェースにフィールド追加（51行付近、`wakeup` の前）**

```typescript
  /** API レート制限情報（proxy.ts が更新） */
  rateLimit: RateLimitInfo | null;
```

**2c. `createDaemon()` の返り値に初期値追加（84行付近、`wakeup: null` の前）**

```typescript
    rateLimit: null,
```

### 3. proxy.ts — レスポンスヘッダーからレート制限情報を解析・保存

**3a. import 追加**

12行の既存 import:
```typescript
import { QueueMessage } from "./schema";
```
を以下に変更:
```typescript
import { QueueMessage } from "./schema";
import type { RateLimitInfo } from "./schema";
```

**3b. ヘッダー解析ヘルパー関数を追加（`start()` 関数の前、35行付近）**

```typescript
/** Anthropic レスポンスヘッダーから RateLimitInfo を抽出 */
function extractRateLimit(headers: Headers): RateLimitInfo | null {
  const remaining = headers.get("anthropic-ratelimit-tokens-remaining");
  const limit = headers.get("anthropic-ratelimit-tokens-limit");
  if (remaining == null || limit == null) return null;

  return {
    tokensRemaining: parseInt(remaining, 10),
    tokensLimit: parseInt(limit, 10),
    tokensReset: headers.get("anthropic-ratelimit-tokens-reset") ?? "",
    inputTokensRemaining: parseInt(headers.get("anthropic-ratelimit-input-tokens-remaining") ?? "0", 10),
    outputTokensRemaining: parseInt(headers.get("anthropic-ratelimit-output-tokens-remaining") ?? "0", 10),
    updatedAt: new Date().toISOString(),
  };
}
```

**3c. streaming パス — `upstreamRes.headers` からヘッダー取得（205行付近、tee の前）**

`if (isStreaming && upstreamRes.body)` ブロック内、`const [clientStream, logStream] = upstreamRes.body.tee();` の**前**に追加:

```typescript
        // レート制限ヘッダーを DaemonState に反映
        if (opts?.getState) {
          const rl = extractRateLimit(upstreamRes.headers);
          if (rl) opts.getState().rateLimit = rl;
        }
```

**3d. 非 streaming パス — 同様に追加（234行付近）**

`const resBody = await upstreamRes.arrayBuffer();` の**後**、`const entry: TraceEntry = {` の**前**に追加:

```typescript
      // レート制限ヘッダーを DaemonState に反映
      if (opts?.getState) {
        const rl = extractRateLimit(upstreamRes.headers);
        if (rl) opts.getState().rateLimit = rl;
      }
```

### 4. dashboard.tsx — ヘッダー行にトークン残量表示

**4a. import に `RateLimitInfo` を追加**

14行の既存 import:
```typescript
import type { DaemonState, TaskSummary } from "./daemon";
```
の下に追加（schema.ts からの import は既に存在するため、そこに追加）:
```typescript
import type { RateLimitInfo } from "./schema";
```

**4b. レート制限表示ヘルパー関数を追加（`formatElapsed` 関数の後、165行付近）**

```typescript
/** レート制限のプログレスバーを生成 */
function buildRateLimitDisplay(rateLimit: RateLimitInfo | null): { label: string; color: typeof GREEN } {
  if (!rateLimit || rateLimit.tokensLimit === 0) {
    return { label: "TPM: --", color: GRAY };
  }
  const pct = Math.round((rateLimit.tokensRemaining / rateLimit.tokensLimit) * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color = pct >= 50 ? GREEN : pct >= 20 ? YELLOW : RED;
  return { label: `TPM: ${pct}% ${bar}`, color };
}
```

**4c. ヘッダー行にレート制限情報を追加（684行付近）**

現在のヘッダー行:
```typescript
        ui.text(`─ cmux-team ${headerSubtitle}${state.version ? ` v${state.version}` : ""} ${HR_FILL}`, { dim: true }),
```

これを以下に変更:
```typescript
        (() => {
          const rl = buildRateLimitDisplay(daemon.rateLimit);
          const left = `─ cmux-team ${headerSubtitle}${state.version ? ` v${state.version}` : ""}`;
          return ui.row({ gap: 0 }, [
            ui.text(`${left} `, { dim: true }),
            ui.text(rl.label, { style: { fg: rl.color } }),
          ]);
        })(),
```

**表示ラベルの選択**: `TPM`（Tokens Per Minute）を使用。分単位ウィンドウの残量であることを正確に伝え、月間残量との誤解を防ぐ。

## テスト方針

### TypeCheck

```bash
cd skills/cmux-team/manager && bun run tsc --noEmit
```

全ファイルで型エラーがないことを確認。

### 手動確認項目

1. **proxy.ts の動作確認**
   - daemon を起動し、API リクエストを送信
   - `http://localhost:<proxy-port>/state` エンドポイントで `rateLimit` フィールドが含まれていることを確認
   - 初回（API 未呼び出し時）は `rateLimit: null` であること

2. **dashboard 表示確認**
   - `cmux-team start` で daemon + dashboard を起動
   - ヘッダー行に `TPM: --` が表示されること（初期状態）
   - API リクエスト発生後、`TPM: XX% ██████░░░░` のように更新されること
   - 色が正しく変わること（50%以上=green, 20-50%=yellow, 20%未満=red）

3. **既存機能の非破壊確認**
   - Conductor タスク割り当て・完了が正常に動作すること
   - `/state` エンドポイントの既存フィールドが欠落していないこと

## 注意事項

1. **`extractRateLimit` のパース失敗**: `parseInt` が `NaN` を返す可能性がある。`remaining == null || limit == null` チェックでヘッダーが存在しない場合は `null` を返すが、値が数値でない異常ケースでも `NaN` が `tokensRemaining` に入る。ただし dashboard 側で `tokensLimit === 0` チェックがあるため、表示崩れは防止される。必要なら `isNaN` チェックを追加。

2. **スレッドセーフティ**: Bun はシングルスレッドなので、`opts.getState().rateLimit = rl` は安全。複数リクエストが並行しても最後の書き込みが勝つだけで、これは期待通りの動作（最新のレート制限情報が欲しい）。

3. **HR_FILL の除去**: 現在のヘッダー行は `HR_FILL`（罫線の埋め草）を使って横幅いっぱいに延ばしている。レート制限表示を右端に追加するため、`HR_FILL` は省略して `ui.row` で左右に分けるか、レート制限をヘッダーパーツに含める方式にする。実装時にレイアウトの見え方を確認して調整。

4. **新規ファイル不要**: 既存の4ファイルの修正のみ。新しいモジュールやファイルの作成は不要。
