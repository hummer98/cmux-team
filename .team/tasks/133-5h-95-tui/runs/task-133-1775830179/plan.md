# 実装計画: 5hレート制限スロットリング + TUI表示

## 概要

5h unified utilization が 95% 以上に達した場合、新規タスクの Conductor 割り当てを一時停止し、TUI ヘッダーにスロットリング状態を表示する。実行中の Conductor は止めない。リセット時刻を過ぎたら自動復帰する。

## 変更対象ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `THROTTLE_5H_THRESHOLD` 定数を追加・export |
| `skills/cmux-team/manager/daemon.ts` | `scanTasks()` 冒頭にスロットリングガードを追加 |
| `skills/cmux-team/manager/dashboard.tsx` | ヘッダーの `headerParts` にスロットリング状態を表示 |

## 詳細設計

### 1. 閾値定数の定義（schema.ts）

**変更箇所**: `schema.ts` 末尾（`RateLimitInfo` interface の直後、158行付近）

```typescript
// --- スロットリング閾値 ---

/** 5h unified utilization がこの値以上なら新規タスク割り当てを停止 */
export const THROTTLE_5H_THRESHOLD = 0.95;
```

**理由**: schema.ts は型定義と定数の集約場所であり、daemon.ts と dashboard.tsx の両方から import される。新しいファイルは不要。

### 2. scanTasks のスロットリングガード（daemon.ts）

**変更箇所**: `scanTasks()` 関数（697行〜）、タスク割り当てループ（746行の `for (const task of allExecutable)` の直前）

**実装方針**:

```typescript
// === スロットリングガード ===
// allExecutable の算出後、割り当てループの前（745行付近）に挿入

const throttled5h = (state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;
if (throttled5h && allExecutable.length > 0) {
  const util = state.rateLimit!.unified5hUtilization!;
  const reset = state.rateLimit!.unified5hReset;
  await log("throttled_rate_limit",
    `5h_utilization=${(util * 100).toFixed(1)}% threshold=${THROTTLE_5H_THRESHOLD * 100}% reset=${reset ?? "unknown"} skipped_tasks=${allExecutable.length}`
  );
  return; // 割り当てループをスキップ（タスク一覧更新は完了済み）
}
```

**重要なポイント**:
- `state.pendingTasks` と `state.taskList` の更新（724〜744行）は**ガードより前**で完了している → TUI に正しい pending 数が表示される
- `return` で関数を抜けるだけなので、`tick()` 内の後続処理（`monitorConductors` 等）は正常に動作する
- `state.rateLimit` が `null` の場合（proxy 未起動時）はスロットリングしない（`?? 0` で安全にフォールバック）
- リセット時刻を過ぎれば proxy が次のレスポンスで低い utilization を返すため、自動的にスロットリング解除される

**import 追加**: daemon.ts の先頭で schema.ts から `THROTTLE_5H_THRESHOLD` を import する。

### 3. TUI ヘッダーのスロットリング表示（dashboard.tsx）

**変更箇所**: `buildViewWithApp()` 関数内の `headerParts` 生成（826〜829行）

**現在の実装**:
```typescript
const headerParts = [
  !daemon.running ? "STOPPED" : daemon.bootPhase !== "ready" ? "STARTING" : (state.version ? `v${state.version}` : ""),
].filter(Boolean);
const headerSubtitle = headerParts.join("  ");
```

**変更後の実装**:

```typescript
// スロットリング判定
const isThrottled = (daemon.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;

const headerParts = [
  !daemon.running ? "STOPPED"
    : daemon.bootPhase !== "ready" ? "STARTING"
    : isThrottled ? null  // スロットリング中はバージョンを省略（後で別途表示）
    : (state.version ? `v${state.version}` : ""),
].filter(Boolean);

// スロットリング表示テキスト（headerSubtitle に含める）
let throttleLabel = "";
if (isThrottled && daemon.running && daemon.bootPhase === "ready") {
  const util = daemon.rateLimit!.unified5hUtilization!;
  const pct = Math.round(util * 100);
  const remaining = formatResetRemaining(daemon.rateLimit!.unified5hReset);
  const resetPart = remaining ? ` → reset ${remaining}` : "";
  throttleLabel = `⏸ THROTTLED (5h: ${pct}%${resetPart})`;
}

const headerSubtitle = throttleLabel || headerParts.join("  ");
```

**ヘッダー行のレンダリング変更** (855〜867行):

スロットリング中はヘッダーの `left` 部分を赤色で表示する必要がある。現在は `dim: true` で統一されている。

```typescript
(() => {
  const rl = buildRateLimitDisplay(daemon.rateLimit);
  const portLabel = daemon.proxyPort ? ` :${daemon.proxyPort}` : "";
  const left = `─ cmux-team ${headerSubtitle}${portLabel}`;
  const rightText = rl.parts.map(p => p.text).join("  ");
  const fill = "─".repeat(Math.max(1, 80 - left.length - rightText.length));

  // スロットリング中: headerSubtitle 部分を赤色で表示
  if (isThrottled && throttleLabel) {
    const prefix = "─ cmux-team ";
    return ui.row({ gap: 0 }, [
      ui.text(prefix, { dim: true }),
      ui.text(`${throttleLabel}${portLabel}`, { style: { fg: RED } }),
      ui.text(` ${fill} `, { dim: true }),
      ...rl.parts.flatMap((p, i) => [
        ...(i > 0 ? [ui.text("  ", { dim: true })] : []),
        ui.text(p.text, { style: { fg: p.color } }),
      ]),
    ]);
  }

  return ui.row({ gap: 0 }, [
    ui.text(`${left} ${fill} `, { dim: true }),
    ...rl.parts.flatMap((p, i) => [
      ...(i > 0 ? [ui.text("  ", { dim: true })] : []),
      ui.text(p.text, { style: { fg: p.color } }),
    ]),
  ]);
})(),
```

**import 追加**: dashboard.tsx の先頭で schema.ts から `THROTTLE_5H_THRESHOLD` を import する。

**`formatResetRemaining` 関数**: dashboard.tsx の 187行付近に既存。`unified5hReset`（unix timestamp 文字列）を引数にとり `"2h34m"` 形式で残り時間を返す。そのまま利用可能。

**`isThrottled` のスコープ**: `buildViewWithApp()` 内で `headerParts` の直前に定義。同関数内のクロージャ（ヘッダーレンダリング IIFE）からも参照できる。

## テスト方針

### 手動テスト

1. **スロットリング発動の確認**
   - `cmux-team start` で daemon を起動
   - タスクを複数 ready にしておく
   - API を多用して 5h utilization を上げる（自然に上がるのを待つか、proxy の state を直接書き換え）
   - 95% 超過で `throttled_rate_limit` ログが出力されること
   - 新規タスクが割り当てられないこと
   - 実行中の Conductor は止まらないこと

2. **TUI 表示の確認**
   - ヘッダーに `⏸ THROTTLED (5h: 95% → reset 2h34m)` が赤色で表示されること
   - 通常のバージョン表示が消えてスロットリング情報に置き換わること
   - スロットリング解除後に通常のヘッダーに戻ること

3. **エッジケース**
   - `state.rateLimit` が `null`（proxy 未起動）のときスロットリングしないこと
   - `unified5hUtilization` が `null`（ヘッダーなし）のときスロットリングしないこと
   - daemon 起動直後（まだ API レスポンスを受けていない状態）で正常動作すること

## リスクと注意点

1. **リセット時刻の精度**: `unified5hReset` は API レスポンスのヘッダーから取得される unix timestamp。プロキシがレスポンスを受け取るたびに更新されるため、最後の API コール以降にリセット時刻が更新されない。ただしスロットリング中も Conductor は動作しているため、その API コールで自然に更新される。

2. **`return` による早期リターンの安全性**: `scanTasks()` は `tick()` から呼ばれ、その後に `monitorConductors()` が別途呼ばれる（daemon.ts:418行）。`scanTasks()` 内の `return` は `tick()` を中断しないため、Conductor 監視は継続される。

3. **7d リミットの将来拡張**: 今回は 5h のみ対象だが、同じパターンで `THROTTLE_7D_THRESHOLD` を追加するだけで対応できる。`isThrottled` の判定を `||` で拡張すればよい。

4. **STOPPED/STARTING 状態との優先順位**: スロットリング表示は `daemon.running && daemon.bootPhase === "ready"` の場合のみ表示。STOPPED や STARTING はそちらが優先される（当然の動作）。
