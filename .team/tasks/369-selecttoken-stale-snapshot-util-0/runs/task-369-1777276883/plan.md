# T369 Plan — `selectToken` stale snapshot の util リセット時刻反映

## 1. 背景・問題

### 現状実装

`skills/cmux-team/manager/token-store.ts:907-911` で、`selectToken` は snapshot
の `recorded_at` が 30 分以上前なら、トークンを丸ごと候補から除外している。

```ts
// 4) stale 除外（30 分以上未更新）
if (snap) {
  const recAt = new Date(snap.recorded_at).getTime();
  if (now - recAt > staleThresholdMs) continue;
}
```

`staleThresholdMs = 30 * 60 * 1000` は同関数内のローカル定数（他箇所では未利用）。

### 問題

スナップショットには `reset_5h_at` / `reset_7d_at`（次回 util リセット時刻）が記録
されている。**recorded_at が古くても、`reset_*_at` を過ぎていれば、その軸の
utilization はリセットされて 0 になっているはず**。にもかかわらず、現状は
recorded_at だけを見てトークンを除外する。

### 実例（@kami）

- recorded_at: 50 分前（stale 判定）
- 当時の util: util_5h = 1%, util_7d = 14%
- reset_5h_at: 既に過去
- 結果: 5h 軸は実質 0% にリセット済みで最も余裕があるはずなのに、候補から落ちる

長時間使われていないトークンほど stale になりやすく、しかも reset を跨いでいる
可能性が高い。本来は最優先で候補化されるべき token が選ばれないのは選択ロジック
の inversion になっている。

## 2. 設計方針

### 新ロジック（疑似コード）

`selectToken` の token ループ内、現状の `// 4) stale 除外` ブロックを以下に置換：

```ts
const snap = getLatestUsageSnapshot(db, tok.id);

// 4) stale 判定 + reset 反映による util 上書き
let effUtil5h = snap?.util_5h ?? 0;
let effUtil7d = snap?.util_7d ?? 0;

if (snap) {
  const recAt = new Date(snap.recorded_at).getTime();
  const isStale = now - recAt > staleThresholdMs;

  if (isStale) {
    const reset5hPast =
      snap.reset_5h_at != null && new Date(snap.reset_5h_at).getTime() <= now;
    const reset7dPast =
      snap.reset_7d_at != null && new Date(snap.reset_7d_at).getTime() <= now;

    // 両軸ともリセット時刻が未確定 (null or 未来) → util 値が信用できない → 除外
    if (!reset5hPast && !reset7dPast) continue;

    if (reset5hPast) effUtil5h = 0;
    if (reset7dPast) effUtil7d = 0;
  }
}

// 5) ブロッカー除外: 5h > 95%
if (effUtil5h > 0.95) continue;

// 6) admit 判定 (既存ロジック)
// ...

const score = 0.3 * effUtil5h + 0.7 * effUtil7d;
candidates.push({ token: tok, score });
```

### 設計上のポイント

| 項目 | 採用方針 | 理由 |
|------|---------|------|
| stale 判定の基準 | recorded_at + 30 分（既存閾値を維持） | 閾値変更は本タスクのスコープ外 |
| reset_*_at が null | 「未来扱い」と同じく信用不可 = 該当軸 reset 不確定 | snapshot にリセット時刻情報が無いケースは util の信頼度判断が不能。安全側に倒す |
| 片軸だけリセット済み | リセット済軸は 0、未リセット軸は snapshot 値そのまま | 未リセット軸の値は古いがリセットしていない以上「下限」として有用。除外より精度が高い |
| snapshot 自体が無い | stale 判定対象外で素通し（util=0 扱いの既存挙動を維持） | 新規 token / 未測定 token を機能的に阻害しない |
| ブロッカー判定 / score | **上書き後の effUtil5h / effUtil7d を使う** | 仕様変更の主目的そのもの。`util_5h>0.95` と `0.3*5h + 0.7*7d` の両方が effective 値を見る |

### 不変量（変更しないもの）

- 関数シグネチャ: `selectToken(db, holder, policy, nowIso)` は据え置き（呼び出し側 `main.ts:2692` 修正不要）
- exclude / default 昇格 / selectable / lease の判定順は既存通り
- `staleThresholdMs = 30 * 60 * 1000` 定数値
- `getLatestUsageSnapshot` の SQL / 戻り値型

## 3. 影響範囲

### コード

| 種別 | パス | 変更内容 |
|------|------|---------|
| 関数 | `skills/cmux-team/manager/token-store.ts` `selectToken` | stale 除外ブロックを util 上書きロジックに差し替え |

### 型・スキーマ

| 種別 | 変更 |
|------|------|
| `UsageSnapshot` interface | 変更なし（既に `reset_5h_at` / `reset_7d_at` / `recorded_at` を保持） |
| DB schema (`usage_snapshots` table) | 変更なし |

### テスト

| パス | 変更内容 |
|------|---------|
| `skills/cmux-team/manager/token-store.test.ts` | 新規 `describe("selectToken (T369: stale snapshot の util リセット時刻反映)")` を追加 |

### 呼び出し側

- `skills/cmux-team/manager/main.ts:2692` — 変更不要（API 互換）
- `skills/cmux-team/manager/daemon.ts` — `selectToken` 直接呼び出しなし
- `skills/cmux-team/manager/project-tags.ts` — コメント参照のみ

## 4. エッジケース

`now = T0` を基準に、各ケースの期待挙動を整理する（snapshot は stale = recorded_at < T0 - 30min 前提）。

| # | reset_5h_at | reset_7d_at | snapshot util | 新挙動 | 理由 |
|---|-------------|-------------|---------------|-------|------|
| E1 | null | null | (5h=0.9, 7d=0.5) | 候補外 | 両軸ともリセット時刻が記録されていない。util の信頼度が判定できないので除外 |
| E2 | 過去 | 未来 | (5h=0.9, 7d=0.5) | 候補化、util_5h=0, util_7d=0.5 | 5h はリセット済 → 0、7d はリセット未確定 → snapshot 値温存 |
| E3 | 未来 | 過去 | (5h=0.9, 7d=0.5) | 候補化、util_5h=0.9, util_7d=0 | 7d はリセット済 → 0、5h はリセット未確定 → snapshot 値温存 |
| E4 | 過去 | 過去 | (5h=0.9, 7d=0.5) | 候補化、util_5h=0, util_7d=0, score=0 | 両軸ともリセット済。@kami 系列で最優先候補になる |
| E5 | 未来 | 未来 | (5h=0.9, 7d=0.5) | 候補外 | 既存挙動の継続。util 値が古く未リセットで信用できない |
| E6 | (snapshot 自体が無い) | — | — | 候補化、util=0 扱い | 新規 token を阻害しない既存挙動を維持 |
| E7 | 過去 | 未来 | (5h=0.9, 7d=0.5)、recorded_at = T0 - 30min ちょうど | fresh 扱い | strictly greater 比較 (`> staleThresholdMs`) を維持 |
| E8 | 過去 | 未来 | (5h=null, 7d=null) | 候補化、util_5h=0, util_7d=0 | `snap?.util_5h ?? 0` で吸収。元実装と同じ |
| E9 | reset_5h_at = T0 ちょうど | T0 ちょうど | — | リセット済扱い (≤ で判定) | `<=` 比較で境界はリセット済側に倒す |

### ブロッカー判定との相互作用

- E2 のように util_5h を 0 に上書きした結果、`util_5h > 0.95` のブロッカー判定を **通る**ようになる。これは仕様意図の通り（リセット後に再候補化される）。
- 元 snapshot で util_5h=0.99 だが reset_5h_at が過去 → 上書き後 util_5h=0 でブロッカー回避、候補化される。

## 5. テスト計画

### 5.1 追加テストヘルパ

`token-store.test.ts` の `selectToken` セクション末尾に追加：

```ts
/** stale snapshot を seed する。recorded_at を強制的に巻き戻す */
function seedStaleSnapshot(args: {
  tokenId: number;
  util5h: number | null;
  util7d: number | null;
  reset5hAt: string | null;
  reset7dAt: string | null;
  recordedMinutesAgo: number; // 例: 50 → 50 分前
}) {
  upsertUsageSnapshot(db, {
    token_id: args.tokenId,
    util_5h: args.util5h,
    util_7d: args.util7d,
    reset_5h_at: args.reset5hAt,
    reset_7d_at: args.reset7dAt,
    unified_status: null,
  });
  const recordedAt = new Date(Date.now() - args.recordedMinutesAgo * 60_000).toISOString();
  db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
    .run(recordedAt, args.tokenId);
}
```

> 既存 `seedFreshSnapshot` パターンの拡張。`upsertUsageSnapshot` が `recorded_at` を `new Date()` で固定するため、UPDATE で巻き戻すのが必要。

### 5.2 追加テストケース

`describe("selectToken (T369: stale snapshot の util リセット時刻反映)")` 内：

| # | 名前 | seed | 期待 |
|---|------|------|-----|
| TC1 | "stale + reset_5h_at 過去 + reset_7d_at 未来 → 候補化、util_5h=0 で評価" | E2 相当 | `selectToken` が当該 token を返す。score = 0.7 * 0.5 = 0.35 |
| TC2 | "stale + 両軸 reset 過去 → 候補化、score=0 で他 token より優先される" | E4 相当（@kami の修正シナリオ）+ 競合 token (fresh, util_5h=0.05, util_7d=0.05, score=0.05) を seed | T369 token が選ばれる |
| TC3 | "stale + reset_5h_at 未来 + reset_7d_at 過去 → util_7d=0 上書き、util_5h は snapshot 値" | E3 相当 | 候補化される。score = 0.3 * 0.9 = 0.27 |
| TC4 | "stale + 両軸未来 → 既存挙動 (候補外)" | E5 相当 | `selectToken` が null を返す（他 token 無し） |
| TC5 | "stale + reset_5h_at=null + reset_7d_at=null → 候補外（リセット情報無し）" | E1 相当 | `selectToken` が null を返す |
| TC6 | "fresh snapshot は util 上書きされない（回帰）" | recorded_at = now の (5h=0.9, 7d=0.5) | score=0.62 で評価。util 値そのまま |
| TC7 | "snapshot 無し token は stale 判定の影響を受けない（回帰）" | snapshot なし | `selectToken` が当該 token を返す |
| TC8 | "stale + reset_5h_at 過去 で元 util_5h=0.99 → ブロッカー回避し候補化される" | recorded_at 50 分前, util_5h=0.99, util_7d=0.1, reset_5h_at 過去, reset_7d_at 未来 | 上書き後 util_5h=0、`> 0.95` 判定を通って候補化 |

最低 4 種のエッジケース要件 → TC1, TC3, TC4, TC5 で網羅。TC2 は @kami 系列の動機の確証。TC6 / TC7 は回帰。TC8 はブロッカー判定との相互作用。

### 5.3 既存テスト回帰確認

- `selectToken (tags フィルタ)` ブロック (~1181) の `seedFreshSnapshot` は recorded_at = now で構築 → stale 経路に入らない。既存挙動維持を確認。
- `selectToken (T335: project policy / OSS / default 昇格)` ブロック (~1275) も同上。
- `selectToken (T335: 受け入れ条件 Project A/C シナリオ)` ブロック (~1541) も fresh snapshot のみ → 影響なし。

## 6. 実装手順（TDD）

1. **テストヘルパ追加** — `token-store.test.ts` の `selectToken` 関連 describe の手前に `seedStaleSnapshot` ヘルパを配置。
2. **失敗するテスト追加** — 5.2 の TC1〜TC8 を新 describe ブロックとして追加。実装前に `bun test --timeout 30000 token-store.test.ts` で TC1〜TC8 が **fail することを確認**（TC4, TC5 は現状でも pass する可能性があるが、TC1/TC2/TC3/TC6/TC7/TC8 は明確に fail）。
3. **`selectToken` 改修** — `token-store.ts` の `// 4) stale 除外` ブロックを §2 の疑似コードに置換。`effUtil5h` / `effUtil7d` 変数をブロッカー判定 + score 計算で参照するよう修正。
4. **テスト全 pass 確認** — `bun test --timeout 30000 token-store.test.ts` で 100% green。
5. **リファクタ確認** — `effUtil5h` / `effUtil7d` の命名と JSDoc を見直し、`selectToken` 上部の選択ロジック説明コメント (§ 802〜867) を T369 の挙動に合わせて 1 行追記。
6. **既存挙動の暗黙の変化が無いか確認** — `selectToken (tags フィルタ)` / `selectToken (T335:...)` ブロックを単独実行し全 pass を再確認。

## 7. 検証

| 項目 | コマンド / 観点 |
|------|---------------|
| 単体テスト | `cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` で全 pass |
| 型チェック | `cd skills/cmux-team/manager && bunx tsc --noEmit` でエラーなし |
| 関連テスト | `bun test --timeout 30000 schema.test.ts` も走らせる（型変更なしのため影響は無いが念のため） |
| lint / format | プロジェクト規約に従い必要なら `bun run lint` |
| 全体 bun test 禁止 | CLAUDE.md 既知注意点 — `bun test` 全体実行は O(N²) 劣化のため**しない**。指定ファイル単独実行のみ |

### 受入確認 (manual)

- @kami のような stale + 両軸 reset 過去のトークンが、candidates に入って score=0 で最優先候補になることを TC2 で確認
- 既存の「stale で除外」挙動（reset_*_at が null/未来）が TC4 / TC5 で温存されていることを確認

## 8. 作業境界

- 本タスクのスコープは `selectToken` の stale 除外ロジック改修と単体テスト追加に限定する。
- `staleThresholdMs` 定数の値変更や外出しは行わない（必要なら別タスク）。
- snapshot 取得経路（proxy / `upsertUsageSnapshot` 呼び出し側）には触れない。
- `computePoolCapacity` は別関数で、本変更の対象外。
