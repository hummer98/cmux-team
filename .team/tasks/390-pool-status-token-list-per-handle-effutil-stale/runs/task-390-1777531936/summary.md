# T390 完了サマリー

## タスク
pool status / token list の per-handle 表示を effUtil（stale 救済反映後）に揃える

## 結果
- 完了フェーズ: Plan → Design Review (Approved with comments) → Impl → Inspection (GO)
- 全テスト pass / tsc 新規エラー 0

## 完了したサブタスク

| Phase | 内容 | 結果 |
|---|---|---|
| 1 | Planner Agent で plan.md 作成 | 完了（cmux-team の planner が不調だったため、Claude のサブエージェントで代替） |
| 2 | Design Reviewer で plan.md レビュー | Approved (with comments) M1-M6 minor 指摘 |
| 3 | Implementer で TDD 実装 | 完了 — 262 pass / 5 skip / 0 fail |
| 4 | Inspector で検品 | GO 判定 |

## 変更ファイル一覧

### 実装 (src)
- `skills/cmux-team/manager/token-store.ts` — `STALE_THRESHOLD_MS` (export const) と pure 関数 `computeEffUtil` を新規追加。`admitCandidates` を `computeEffUtil` 呼び出しに置換
- `skills/cmux-team/manager/pool-throttle.ts` — file-local `STALE_THRESHOLD_MS` 削除し token-store から import。`countPoolTokens` の 2 ループを 1 ループに統合
- `skills/cmux-team/manager/token-format.ts` — `formatPerHandleUtilCell(snap, nowMs)` を新規 export
- `skills/cmux-team/manager/pool-cli.ts` — per-handle 行を `formatPerHandleUtilCell` に切替、行末に独立 `MARK` 列追加、フッタに条件付き凡例
- `skills/cmux-team/manager/token-cli.ts` — 同様の per-handle 行 / MARK 列 / 凡例追加

### テスト
- `skills/cmux-team/manager/token-store.test.ts` — `describe("computeEffUtil (T390)")` 10 ケース追加
- `skills/cmux-team/manager/token-format.test.ts` — `describe("formatPerHandleUtilCell (T390)")` 7 ケース追加
- `skills/cmux-team/manager/pool-cli.test.ts` — reset 通過済み stale token シナリオで 5H=0% / 行末 `*` / フッタ凡例の T390 ケース追加
- `skills/cmux-team/manager/token-cli.test.ts` — 同等の T390 ケース追加

### spec / docs
- `docs/spec/09-token-pool.md` — (a) `### cmux-team token list` に effUtil 表示の追記。(b) `#### stale 救済の挙動 (T373)` 表直下に CLI 表示の段落追加。(c) `## 7d Forecast ゲージ + next 候補` 配下に `### per-handle 行の effUtil 表示 (T390)` セクション新規追加。(d) 関連ファイル表に pool-cli.ts / pool-throttle.ts を追加、token-format.ts / token-store.ts 行に新 API を追記

### 不随的更新
- `package-lock.json` — 4.16.0 → 4.19.0（worktree 作成時の lockfile が古かったため、npm install で main の package.json と整合させる修復）

## 新規追加した関数 / 定数

```ts
// token-store.ts
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export function computeEffUtil(
  snap: UsageSnapshot | null,
  nowMs: number,
  staleThresholdMs: number = STALE_THRESHOLD_MS,
): {
  effUtil5h: number;
  effUtil7d: number;
  hasSnapshot: boolean;
  isStale: boolean;
  reset5hPassed: boolean;
  reset7dPassed: boolean;
};

// token-format.ts
export function formatPerHandleUtilCell(
  snap: UsageSnapshot | null,
  nowMs: number,
): { display5h: string; display7d: string; marker: string };
```

## テスト結果

| ファイル | pass | skip | fail |
|---|---|---|---|
| token-store.test.ts | 144 | 1 | 0 |
| token-format.test.ts | 20 | 0 | 0 |
| pool-throttle.test.ts | 31 | 0 | 0 |
| pool-summary.test.ts | 12 | 0 | 0 |
| pool-header-display.test.ts | 13 | 0 | 0 |
| pool-cli.test.ts | 4 | 0 | 0 |
| token-cli.test.ts | 38 | 4 | 0 |

合計 262 pass / 5 skip / 0 fail

T373 / T382 / B1-B6 系の admit / throttle 既存テストは全 pass、CLI test の per-handle 行 assertion (10%/20% 等) も effUtil 切替で破壊なし。

## TypeScript 型検査
`bunx tsc --noEmit` 新規エラー 0 件 / 既存エラー 0 件

## 設計上の判断

### マーカー位置の改善（M3 対応）
plan §4.1 では「マーカー `*` を 7D USE 列に append」だったが、5h 軸だけ reset 通過した @tayo ケース（5H reset 通過 / 7D 未到達）でも 7D 列に `*` が付き「7D が回復した」と誤読されるリスク。**実装では「行末に独立 MARK 列」に変更**し、両 CLI で凡例 `(* = reset 通過済みで実質クリア)` をフッタに表示。

### TS strict 互換性 (token-cli.ts)
既存コード `resetCandidates.length > 0 ? resetCandidates[0] : "--"` が `noUncheckedIndexedAccess` で `string | undefined` 推論される副作用エラーが、`.padEnd(14)` 追加時に表面化。`resetCandidates[0] ?? "--"` に書き換えて解消（意味的に等価）。

## マージコミット / PR URL
（後段で追記）
