# T369 実装サマリー

`selectToken` の stale snapshot 除外ロジックを、`reset_5h_at` / `reset_7d_at` を反映した util 上書きロジックに変更した。

## 変更ファイル

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/token-store.ts` | `selectToken` の stale 除外ブロックを util 上書きロジックに置換。ブロッカー判定 / score 計算を `effUtil5h` / `effUtil7d` 参照に変更。JSDoc の選択ロジック説明（手順 4〜9）を新挙動に合わせて更新 |
| `skills/cmux-team/manager/token-store.test.ts` | 新規 describe `selectToken (T369: stale snapshot の util リセット時刻反映)` を追加。`seedStaleSnapshot` ヘルパ + TC1〜TC8 の単体テスト |

差分: 2 files changed, +217 -11 行（うち test は +188 行、token-store.ts は +29 -11 行）。

## 実装ロジック（plan §2 と一致）

```ts
// 4) stale 判定 + reset 反映による util 上書き（T369）
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

    if (!reset5hPast && !reset7dPast) continue;
    if (reset5hPast) effUtil5h = 0;
    if (reset7dPast) effUtil7d = 0;
  }
}

if (effUtil5h > 0.95) continue;     // ブロッカー判定 (上書き後)
// ...admit 判定...
const score = 0.3 * effUtil5h + 0.7 * effUtil7d; // score 計算 (上書き後)
```

## 追加テスト一覧 (8 件)

| # | 名前 | 期待挙動 |
|---|-----|---------|
| TC1 | stale + reset_5h_at 過去 + reset_7d_at 未来 → 候補化、util_5h=0 で評価 | `@kami` が選ばれる |
| TC2 | stale + 両軸 reset 過去 → 候補化、score=0 で fresh 競合より優先される | stale @kami (score=0) が fresh @fresh (score=0.05) を抜いて選ばれる |
| TC3 | stale + reset_5h_at 未来 + reset_7d_at 過去 → util_7d=0 上書き、util_5h は snapshot 値 | `@k3` が候補化される |
| TC4 | stale + 両軸未来 → 既存挙動 (候補外) | `null` |
| TC5 | stale + reset_5h_at=null + reset_7d_at=null → 候補外（リセット情報無し） | `null` |
| TC6 | fresh snapshot は util 上書きされない（回帰） | reset_*_at が過去でも fresh の `@high` (util=0.9/0.5) は score=0.62 のまま、競合 `@competitor` (score=0.5) が勝つ |
| TC7 | snapshot 無し token は stale 判定の影響を受けない（回帰） | `@k7` が選ばれる |
| TC8 | stale + reset_5h_at 過去 で元 util_5h=0.99 → ブロッカー回避し候補化される | `@k8` が選ばれる |

## テスト結果

### TDD red phase（実装前）

```
 100 pass
 1 skip
 4 fail
```

fail 内訳: TC1 / TC2 / TC3 / TC8（既存実装は stale を一律除外するため）。
TC4 / TC5 / TC6 / TC7 は既存挙動と一致するため pass（plan §6 の想定どおり）。

### TDD green phase（実装後）

```
cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
 104 pass
 1 skip
 0 fail
 199 expect() calls
```

### 型チェック

```
cd skills/cmux-team/manager && bunx tsc --noEmit
exit=0
```

### Invariant

- `taskState[...]=` / `saveTaskState(` の grep 0 件を維持
- `bus.(emit|on)` の eventBus.ts 外参照 0 件を維持

## 判断点

| 論点 | 採用方針 | 理由 |
|------|---------|------|
| `staleThresholdMs` 定数値 | 30 分のまま据え置き | 閾値変更は本タスクのスコープ外（plan §8） |
| `reset_*_at` が null | 「未来扱い」と同じ未確定として扱う | snapshot にリセット時刻情報が無いケースは util 信頼度判断不能。安全側に倒す |
| 片軸だけリセット済み | リセット済軸だけ 0 上書き、未リセット軸は snapshot 値温存 | 未リセット軸は古い値だが「下限」として有用 → 候補化のほうが精度高い |
| snapshot 自体が無い | stale 判定対象外で素通し（既存挙動維持） | 新規 token / 未測定 token を阻害しない |
| ブロッカー判定 / score | 上書き後の `effUtil5h` / `effUtil7d` を使う | 仕様変更の主目的そのもの。`util_5h>0.95` ブロッカー回避が TC8 で確認 |
| JSDoc 番号付け | 手順 4 を「lease 中除外」と「stale + reset 反映」に分割し 4〜9 に再番号 | 新たな処理層を文書化、既存読者にも明示 |
| 既存テスト | `selectToken (tags フィルタ)` / `selectToken (T335:...)` は fresh snapshot のみ使用 → 影響なし、追加修正不要 | plan §5.3 の通り |

## 完了条件チェック

- [x] `selectToken` が plan.md §2 の疑似コード通りに変更されている
- [x] TC1〜TC8 がすべて pass
- [x] `bunx tsc --noEmit` がエラー 0
- [x] 既存テストが壊れていない（100 → 104 pass、追加 4 件のみ増加）
- [x] summary.md を出力ディレクトリに書き出し

## スコープ外（plan §8 の境界）

- `staleThresholdMs` の値変更・外出しは未実施
- snapshot 取得経路（proxy / `upsertUsageSnapshot` 呼び出し側）は触れていない
- `computePoolCapacity` は対象外
- `bun test` 全体実行は禁忌のため未実行（CLAUDE.md 既知注意点）。`token-store.test.ts` 単独実行のみ
