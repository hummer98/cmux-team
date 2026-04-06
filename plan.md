# T101 実装計画: ダッシュボードのTPM表示を5h/7d unified使用率表示に置換

## 概要

Claude Max 環境では `anthropic-ratelimit-tokens-*` ヘッダーが返されないため、TPM表示が常に `--` になる。代わりに `anthropic-ratelimit-unified-*` ヘッダーから5h/7d使用率を読み取り表示する。

## 変更順序

依存関係: schema.ts → proxy.ts → dashboard.tsx

### Step 1: schema.ts — RateLimitInfo に unified フィールドを追加

**ファイル**: `skills/cmux-team/manager/schema.ts` L133-146

**変更内容**: `RateLimitInfo` interface に unified 関連フィールドを追加

```typescript
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
  /** unified 5h 使用率（0.0-1.0、null = ヘッダーなし） */
  unified5hUtilization: number | null;
  /** unified 7d 使用率（0.0-1.0、null = ヘッダーなし） */
  unified7dUtilization: number | null;
  /** unified 5h リセット時刻（unix timestamp 文字列、null = ヘッダーなし） */
  unified5hReset: string | null;
  /** unified 7d リセット時刻（unix timestamp 文字列、null = ヘッダーなし） */
  unified7dReset: string | null;
  /** unified ステータス（allowed/rate_limited、null = ヘッダーなし） */
  unifiedStatus: string | null;
  /** 最終更新時刻 */
  updatedAt: string;
}
```

**理由**: 全フィールドを `| null` にすることで、従来の TPM のみヘッダーが返る環境との後方互換を維持。

---

### Step 2: proxy.ts — extractRateLimit() で unified ヘッダーを読み取る

**ファイル**: `skills/cmux-team/manager/proxy.ts` L38-55

**変更内容**: `extractRateLimit()` を拡張

```typescript
function extractRateLimit(headers: Headers): RateLimitInfo | null {
  // unified ヘッダーの読み取り
  const unified5hRaw = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const unified7dRaw = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const unified5h = unified5hRaw != null ? parseFloat(unified5hRaw) : null;
  const unified7d = unified7dRaw != null ? parseFloat(unified7dRaw) : null;
  const unified5hReset = headers.get("anthropic-ratelimit-unified-5h-reset") ?? null;
  const unified7dReset = headers.get("anthropic-ratelimit-unified-7d-reset") ?? null;
  const unifiedStatus = headers.get("anthropic-ratelimit-unified-status") ?? null;

  // 従来の TPM ヘッダーの読み取り
  const remaining = headers.get("anthropic-ratelimit-tokens-remaining");
  const limit = headers.get("anthropic-ratelimit-tokens-limit");

  // unified も TPM も両方ない場合は null
  if ((remaining == null || limit == null) && unified5h == null && unified7d == null) return null;

  const tokensRemaining = remaining != null ? parseInt(remaining, 10) : 0;
  const tokensLimit = limit != null ? parseInt(limit, 10) : 0;

  return {
    tokensRemaining: isNaN(tokensRemaining) ? 0 : tokensRemaining,
    tokensLimit: isNaN(tokensLimit) ? 0 : tokensLimit,
    tokensReset: headers.get("anthropic-ratelimit-tokens-reset") ?? "",
    inputTokensRemaining: parseInt(headers.get("anthropic-ratelimit-input-tokens-remaining") ?? "0", 10),
    outputTokensRemaining: parseInt(headers.get("anthropic-ratelimit-output-tokens-remaining") ?? "0", 10),
    unified5hUtilization: unified5h != null && !isNaN(unified5h) ? unified5h : null,
    unified7dUtilization: unified7d != null && !isNaN(unified7d) ? unified7d : null,
    unified5hReset,
    unified7dReset,
    unifiedStatus,
    updatedAt: new Date().toISOString(),
  };
}
```

**変更ポイント**:
- unified ヘッダーがある場合も `RateLimitInfo` を返すよう条件を緩和
- TPM ヘッダーがなくても unified があれば有効な情報として返す
- `representative-claim` ヘッダーは表示に使わないため読み取り不要

---

### Step 3: dashboard.tsx — buildRateLimitDisplay() を unified 対応に書き換え

**ファイル**: `skills/cmux-team/manager/dashboard.tsx` L174-185

**変更内容**: unified データの有無で表示を切り替え

```typescript
/** 使用率のプログレスバーを1つ生成 */
function buildUtilizationBar(label: string, utilization: number): { text: string; color: typeof GREEN } {
  const pct = Math.round(utilization * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color = pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
  return { text: `${label}: ${pct}% ${bar}`, color };
}

/** レート制限の表示文字列を生成 */
function buildRateLimitDisplay(rateLimit: RateLimitInfo | null): { label: string; color: typeof GREEN } {
  if (!rateLimit) {
    return { label: "Rate: --", color: GRAY };
  }

  // unified データがある場合: 5h/7d 使用率を表示
  if (rateLimit.unified5hUtilization != null || rateLimit.unified7dUtilization != null) {
    const parts: string[] = [];
    let worstColor: typeof GREEN = GREEN;

    if (rateLimit.unified5hUtilization != null) {
      const h5 = buildUtilizationBar("5h", rateLimit.unified5hUtilization);
      parts.push(h5.text);
      if (h5.color === RED || (h5.color === YELLOW && worstColor === GREEN)) worstColor = h5.color;
    }
    if (rateLimit.unified7dUtilization != null) {
      const d7 = buildUtilizationBar("7d", rateLimit.unified7dUtilization);
      parts.push(d7.text);
      if (d7.color === RED || (d7.color === YELLOW && worstColor === GREEN)) worstColor = d7.color;
    }

    // rate_limited の場合は赤に強制
    if (rateLimit.unifiedStatus === "rate_limited") worstColor = RED;

    return { label: parts.join("  "), color: worstColor };
  }

  // フォールバック: 従来の TPM 表示
  if (rateLimit.tokensLimit === 0) {
    return { label: "Rate: --", color: GRAY };
  }
  const pct = Math.round((rateLimit.tokensRemaining / rateLimit.tokensLimit) * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color = pct >= 50 ? GREEN : pct >= 20 ? YELLOW : RED;
  return { label: `TPM: ${pct}% ${bar}`, color };
}
```

**表示例**:
- unified あり: `5h: 18% ████████░░  7d: 74% ███████░░░`（緑/黄）
- unified なし + TPM あり: `TPM: 85% ████████░░`（従来と同じ）
- どちらもなし: `Rate: --`（グレー）

**色の閾値**（unified の場合、utilization は「使用量」なので高い方が危険）:
- < 70%: 緑（余裕あり）
- 70-89%: 黄色（注意）
- >= 90%: 赤（危険）
- `unifiedStatus === "rate_limited"`: 赤（強制）

**呼び出し箇所（L776）は変更不要** — `buildRateLimitDisplay` の戻り値の型は同じ。

---

## ビルド確認手順

```bash
cd skills/cmux-team/manager
bun build ./main.ts --target=bun --outdir=./dist --external bun:sqlite
```

型エラーがなければ OK。自動テストはないため、ビルド通過が確認基準。

## フォールバック戦略

| シナリオ | 動作 |
|---------|------|
| unified ヘッダーあり + TPM ヘッダーなし | unified 表示（5h/7d バー） |
| unified ヘッダーなし + TPM ヘッダーあり | 従来の TPM 表示 |
| 両方あり | unified を優先表示 |
| 両方なし | `Rate: --` をグレー表示 |
| unified 片方だけ（5h のみ等） | 存在する方だけ表示 |
| parseFloat 失敗 | null 扱い → フォールバック |

## リスク

- **低**: schema.ts の interface 変更は型レベルのみで、Zod スキーマや JSON シリアライズには影響なし
- **低**: `buildRateLimitDisplay` の戻り値の型（`{ label: string; color: typeof GREEN }`）は変わらないため、呼び出し側の変更不要
- **なし**: ヘッダーが返されない環境では従来通り `Rate: --` 表示になるだけ
