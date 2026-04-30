# Plan: T363 — TUI ヘッダー右の 5h/7d を pool capacity に置換、専用ボックスは削除

## 1. 課題分析

### 現状の問題点

T351 で TUI dashboard ヘッダー周辺に **2 つの token pool 表示が並立**している:

1. **ヘッダー右** (`dashboard.tsx` L1426-1457): `5h: 32% ███ / 7d: 38% ████` — `buildRateLimitDisplay(daemon.rateLimit)` 由来
2. **ヘッダー直下のボックス** (`dashboard.tsx` L1469-1470 で `buildPoolHeader(daemon.pool)` 挿入): `┌─ token pool ─┐` で囲まれた `pool capacity: NN%` + `next reset: ...`

ユーザーフィードバック: pool capacity は「ヘッダー右の 5h/7d を **代替する位置**」に置きたい。専用ボックスは新設しない。

### 根本原因

T351 の Step 4-6 でヘッダー直下ボックスとして実装したが、要求は「右側スロットの内容を切り替える単一スロット化」だった。設計時に「rate limit と pool capacity は同じ概念領域 (使用容量) で互いに排他的に表示すべき」という判断を取り損ねた。

### 影響範囲

| 領域 | 影響 |
|------|------|
| TUI dashboard ヘッダー組み立て (`dashboard.tsx` L1426-1470) | 直接の修正対象 |
| `buildPoolHeader` 関数 (dashboard.tsx L460-489) | 呼び出し元削除で dead code 化（タスク指示で「当面残す」） |
| `buildPoolHeaderLines` (`pool-status-header.ts`) | 触らない。CLI (`main.ts` L1449) で引き続き使用 |
| `buildRateLimitDisplay` / `RateLimitPart` 型 (`rate-limit-display.ts`) | 触らない（型のみ再利用） |
| スロットリング判定 (`isThrottled` / `headerSubtitle` 赤 blink) | 内部状態として維持。左側 `cmux-team [headerSubtitle]` 部分の表示挙動は変更なし |
| `─ Rate Limit ─` 詳細セクション (下方) | 対象外。触らない |
| CLI (`cmux-team status`) のヘッダー直下ボックス | 本タスクでは触らない（後続タスク化を検討） |

## 2. 技術アプローチ

### 選択するアプローチ

**「ヘッダー右側を単一スロット化し、`daemon.pool` の有無で出力 parts を切り替える」**

- `daemon.pool != null` → 新規 helper `buildPoolHeaderDisplay(daemon.pool)` で pool capacity 用 `RateLimitPart[]` を生成
- `daemon.pool == null` → 既存 `buildRateLimitDisplay(daemon.rateLimit)` の parts をそのまま使用
- どちらも戻り値型は `{ parts: RateLimitPart[] }` で揃え、`dashboard.tsx` の描画ループ (`p.text` を `mapRateLimitColor(p.color)` で着色) を共通化

### 既存パターンとの整合性

- `RateLimitPart` 型 (`{ text, color: "green"|"yellow"|"red"|"gray", group?: boolean }`) を再利用
- 色マッピングは既存 `mapRateLimitColor` を経由（dashboard.tsx L232 / RGB 解決は dashboard 側に閉じる）
- 純粋関数として TUI 非依存に保つ（pool-status-header.ts と同じ流儀）

### 新規 helper の配置先と signature

**新規ファイル**: `skills/cmux-team/manager/pool-header-display.ts`

```ts
import type { PoolSummary } from "./pool-summary";
import type { RateLimitPart } from "./rate-limit-display";

export interface PoolHeaderDisplay {
  parts: RateLimitPart[];
}

/**
 * pool capacity を dashboard ヘッダー右側に表示するための parts を組み立てる純粋関数。
 *
 * - summary=null → 空 parts（呼び出し側で fallback 判定すること。本関数自体は parts:[] を返す）
 * - summary=有効 → `pool capacity: NN%` (色閾値あり) + `next reset: @handle Wd in Xh (+Y pts)` (gray) の 2 parts
 *
 * 色閾値（既存 buildPoolHeader と一致, docs/spec/09-token-pool.md 準拠）:
 *   - capacityPct >= 100 → green
 *   - 40 <= capacityPct < 100 → yellow
 *   - capacityPct < 40 → red
 */
export function buildPoolHeaderDisplay(
  summary: PoolSummary | null,
  now?: number,
): PoolHeaderDisplay;
```

**判断理由**: 既存 `pool-status-header.ts` は **`string[]` を返すボックス整形 API**（CLI 用、固定幅 60 文字）。新 helper は **`RateLimitPart[]` を返す構造データ API**（TUI 用）。責務と返り値型がはっきり違うため別ファイルにする。

## 3. 変更対象

### 修正するファイル

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/dashboard.tsx` | ヘッダー右 parts 組み立てを `daemon.pool != null ? buildPoolHeaderDisplay(daemon.pool) : buildRateLimitDisplay(daemon.rateLimit)` の分岐に変更 (L1430 / L1437 周辺の throttling 経路にも反映)。`...buildPoolHeader(daemon.pool)` (L1470) の挿入を削除。`import { buildPoolHeaderDisplay } from "./pool-header-display"` を追加 |

### 新規作成するファイル

| パス | 概要 |
|------|------|
| `skills/cmux-team/manager/pool-header-display.ts` | `buildPoolHeaderDisplay(summary)` 純粋関数 |
| `skills/cmux-team/manager/pool-header-display.test.ts` | 純粋関数 unit test (pool ON / OFF / 色閾値 / nextReset 有無) |

### 削除するファイル

なし。

### 「保留」（削除しない方針との整合）

- `dashboard.tsx::buildPoolHeader`（L460-489）は **export を維持**。タスク指示「当面残してよい」に従う。
  - 呼び出し元は dashboard.tsx L1470 のみで、本タスクで削除されるため **dead code 化** する。
  - JSDoc 冒頭に「T363 で dashboard 描画から外れた。CLI 側 (`main.ts::buildPoolHeaderLines`) と整合する別タスクで再評価する」コメントを追加。
- `pool-status-header.ts`（CLI 用 `buildPoolHeaderLines`）は触らない。`main.ts` L1449 で引き続き使う。

## 4. サブタスク分割（TDD 順序）

### Subtask 1: `pool-header-display.test.ts` を新規作成（test を先）

- **対象ファイル**: `skills/cmux-team/manager/pool-header-display.test.ts`（新規）
- **完了条件**: 以下のテストケースが定義されている（実装前なので **すべて失敗** する状態）
  - `case 1`: `summary=null` → `{ parts: [] }`
  - `case 2`: `capacityPct=173, nextReset=null` → parts[0].text に `pool capacity: 173%`, parts[0].color === `"green"`
  - `case 3`: `capacityPct=60` → parts[0].color === `"yellow"`
  - `case 4`: `capacityPct=30` → parts[0].color === `"red"`
  - `case 5`: `capacityPct=100` 境界 → `"green"`（>= 100%）
  - `case 6`: `capacityPct=40` 境界 → `"yellow"`（40-100%）
  - `case 7`: `capacityPct=39.9` → `"red"`（< 40%）
  - `case 8`: `nextReset` 有 → parts に `next reset: @kddi 5h in 30m  (+20 pts)` 相当の text を含む part が追加 (color: `"gray"`)
  - `case 9`: `nextReset.deltaPct < 0` → `(-5 pts)`、`deltaPct === 0` → `(+0 pts)`
  - `case 10`: `nextReset.remainingMs < 60_000` → `<1m`
  - `case 11`: `parts[0].group` が `true`（dashboard 側の間隔挿入が rate-limit と整合）
- **メソッド制約**: `RateLimitPart` 型を再利用（`color` リテラル）/ 色閾値定数を直書きせず、可能なら `pool-status-header.ts` の流儀に倣って関数内に閉じる
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test --timeout 30000 pool-header-display.test.ts
  ```
  → **すべて失敗** することを確認（モジュール未作成エラー OK）

### Subtask 2: `pool-header-display.ts` を実装

- **対象ファイル**: `skills/cmux-team/manager/pool-header-display.ts`（新規）
- **完了条件**: Subtask 1 のテストが **すべて green**
- **メソッド制約**:
  - `PoolSummary` 型を `./pool-summary` から import
  - `RateLimitPart` / 戻り値型は `./rate-limit-display` から import
  - 色閾値は `>= 100 → "green" / >= 40 → "yellow" / else → "red"`（既存 `buildPoolHeader` (dashboard.tsx L477) と一致）
  - `next reset` の文字列整形は **既存ロジックを再利用しないで本ファイル内に書く**（`pool-status-header.ts::formatRelativeDuration` は private のため）— 仕様（`<1m` / `30m` / `2h30m` / `3d2h`）を踏襲し、テストで等価性を担保
  - parts 構造例:
    ```ts
    [
      { text: "pool capacity: 173%", color: "green", group: true },
      { text: "next reset: @kddi 5h in 30m  (+20 pts)", color: "gray" },
    ]
    ```
  - `summary.header.nextReset == null` のときは parts 1 個のみ
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test --timeout 30000 pool-header-display.test.ts
  ```
  → **すべて green**

### Subtask 3: `dashboard.tsx` のヘッダー右側を分岐に差し替え

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **完了条件**:
  1. L51 付近の `import { buildPoolHeaderLines } from "./pool-status-header";` の **下** に `import { buildPoolHeaderDisplay } from "./pool-header-display";` を追加
  2. L1430 付近、`const rl = buildRateLimitDisplay(daemon.rateLimit);` を以下に置換:
     ```ts
     const rl = daemon.pool != null
       ? buildPoolHeaderDisplay(daemon.pool)
       : buildRateLimitDisplay(daemon.rateLimit);
     ```
  3. L1437 throttling 経路 (`if (isThrottled && throttleLabel)`) は `rl.parts` を使うので **そのまま動く**（変更不要）。`isThrottled` 判定は `daemon.rateLimit` ベースのまま残す。
  4. L1470 の `...buildPoolHeader(daemon.pool),` を **削除**（行ごと、コメント `// T351:` も削除）
- **メソッド制約**: 既存の `mapRateLimitColor` / `RateLimitPart` 描画ループを変更しない
- **検証コマンド**:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-363-1777244120 && bunx tsc --noEmit 2>&1 | grep -E "dashboard\.tsx" || echo OK
  ```

### Subtask 4: 既存 `dashboard.tsx::buildPoolHeader` に保留コメントを追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx` L459-470 の JSDoc
- **完了条件**: JSDoc 冒頭に以下を追記:
  ```
  * NOTE (T363): dashboard 描画経路からは外した。export は CLI (main.ts) との
  *              整合再評価を待つために当面残す。新規利用は禁止。
  ```
- **メソッド制約**: 関数本体・signature は変更しない

### Subtask 5: `dashboard-pool.test.tsx` のスナップショット・assertion を新仕様で更新

- **対象ファイル**: `skills/cmux-team/manager/dashboard-pool.test.tsx`
- **完了条件**: `describe("buildPoolHeader", ...)` 配下の case 1-5 を以下のいずれかに整理:
  - **方針 A**（推奨）: case 1-5 を **そのまま残す**（`buildPoolHeader` 関数は export 維持なので機能テストは生きる）。新 describe `buildPoolHeaderDisplay (T363)` は **追加しない**（Subtask 1 の `pool-header-display.test.ts` でカバー済み）
  - **方針 B**: case 1-5 を `describe.skip` でマーク + 「Subtask 4 の保留コメント参照」コメント追加
  - **判断**: 方針 A を採用。`buildPoolHeader` の振る舞いは変えていないので既存テストは引き続き green、新仕様は新規テストファイルでカバー、という分担で構造的に正しい。
  - case 6-11 (`buildSurfaceRowSuffix` / `buildConductorRowWithPool`) は **触らない**
- **追加検証**: 「dashboard ヘッダーの組み立て結果に `pool capacity: NN%` が含まれ、`┌─ token pool ─┐` ボックス文字 (`┌` / `└`) が含まれない」という統合 assertion をどう書くかは要検討（`buildViewWithApp` は state 全体を要求するため簡単に呼べない）。**MVP では純粋関数 helper のテストでカバーし、統合テストは追加しない**（既存 dashboard 全体テストも `buildPoolHeader` 単体までしか網羅していない）。
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-pool.test.tsx
  ```

### Subtask 6: 関連テストの個別実行で regression 確認

- **完了条件**: 以下が全て green
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && for f in pool-header-display.test.ts pool-status-header.test.ts dashboard-pool.test.tsx rate-limit-display.test.ts; do
    bun test --timeout 30000 "$f" || break
  done
  ```
  ※ `bun test` 全体実行は CLAUDE.md の禁忌（O(N²) 級劣化）。個別実行のみ。

### Subtask 7: TypeScript 型チェック

- **検証コマンド**:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-363-1777244120 && bunx tsc --noEmit 2>&1 | grep -E "^(skills/cmux-team/manager/)" || echo "OK: no errors in target directory"
  ```

## 5. リスク

| リスク | 検証方法 / 対策 |
|--------|---------------|
| **pool OFF / 取得失敗 (`daemon.pool == null`) 時のフォールバック** が壊れる | Subtask 3 の三項演算子で明示的に `buildRateLimitDisplay(daemon.rateLimit)` に倒す。pool-header-display.test.ts case 1 で `null → []` を担保。さらに dashboard 統合テスト的には pool OFF 起動で 5h/7d バーが従来通り出ることを手動確認 |
| **スロットリング判定 (`5h ≥ 95%`) と headerSubtitle 赤 blink** が両立しない | `isThrottled` は `daemon.rateLimit` ベース（不変）。pool ON でも `daemon.rateLimit` が同時に存在する前提なので throttling 検出は機能する。throttling 中の右側 parts は **pool capacity 表示に置き換わる** 仕様（受け入れ条件は「headerSubtitle 部分」の挙動維持のみ要求）。L1437 経路で `rl.parts` を使うため throttling 中は forceRed 適用が pool 側にも効くか確認 → `buildPoolHeaderDisplay` は `forceRed` の概念を持たないので pool 側 parts はそのまま表示される。**この挙動でユーザー要求と整合する**（throttling 状態は left の `⏸ THROTTLED` blink で十分視認できる） |
| **`─ Rate Limit ─` 詳細セクション（下方）への影響** | 該当セクションは `buildRateLimitSection` 等で別途組み立てられている想定。本タスクは `buildPoolHeader` 削除と右パーツ分岐のみで、Rate Limit 詳細描画は無関係。`grep -n "Rate Limit" skills/cmux-team/manager/dashboard.tsx` で参照箇所が L1426-1470 の外であることを Implementer が確認 |
| **CLI (`cmux-team status`) との不整合** | 本タスクでは TUI のみ対応（タスク本文で明記）。CLI は引き続き `┌─ token pool ─┐` ボックスを出す。タスク完了後にユーザーへ「CLI 側も同様にエリア新設しないか？」を確認し、必要なら後続タスク `cmux-team status の pool capacity 表示位置` を起票 |
| **next reset 文字列の formatRelativeDuration 重複実装** | `pool-status-header.ts::formatRelativeDuration` は private。再利用すると export 増えるので、本ファイル内に等価実装を置き、test で出力一致を担保（cross-validate）。後続で共通化したくなったら別タスクで `format-duration.ts` を切り出す |

## 6. 既存型エラーの先読み

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-363-1777244120
bunx tsc --noEmit 2>&1 | grep -E "^(skills/cmux-team/manager/dashboard\.tsx|skills/cmux-team/manager/pool-status-header\.ts|skills/cmux-team/manager/rate-limit-display\.ts)" || true
```

**結果**: 該当ファイルに既存型エラーなし。

| ファイル | 既存エラー | 区分 |
|----------|-----------|------|
| `dashboard.tsx` | なし | — |
| `pool-status-header.ts` | なし | — |
| `rate-limit-display.ts` | なし | — |

→ **本タスクで解消すべき既存型エラーはない**。新規 `pool-header-display.ts` と `dashboard.tsx` の編集箇所が新たに型エラーを出さないことのみ確認すればよい（Subtask 7）。

## 7. Decision Log

### D1: 新 helper の配置 — `pool-header-display.ts` 新規作成 (採用)

| 候補 | 選定理由 / 棄却理由 |
|------|-----|
| **A: `pool-status-header.ts` に `buildPoolHeaderDisplay` を追加** | 棄却。既存関数は **`string[]` を返すボックス整形 API**、新関数は **`RateLimitPart[]` を返す構造データ API**。返り値型も用途も違うのに同居させると、ファイル名の意味（"status header" = CLI status コマンドのヘッダー）から外れる。1 ファイル 1 責務を守る |
| **B: `pool-header-display.ts` を新規作成** ✅ | 採用。TUI 用 parts API として独立。命名は `rate-limit-display.ts` (TUI 用 parts API) と対称 |
| C: `dashboard.tsx` 内に inline で書く | 棄却。テストしにくい。タスク要件「テスト可能にする」と矛盾 |

### D2: `dashboard.tsx::buildPoolHeader` の扱い — 残す (採用)

タスク本文「`buildPoolHeader` 関数本体は当面残してよい」に従い **export 維持**。dead code になるが、後続タスク（CLI 側 `buildPoolHeaderLines` の整合再評価）まで方針が決まらないため判断を遅延させる。Subtask 4 で JSDoc に保留コメントを追加し、新規利用を禁止する記述を残す。

### D3: throttling 中の右側 parts — pool capacity を出す (採用)

throttle (5h ≥ 95%) と pool capacity は独立した情報軸。タスク本文「daemon.pool != null → pool capacity 表示用の parts」「pool 情報が無いとき (pool OFF / 失敗) は従来通りの 5h/7d 表示にフォールバック」が条件分岐の唯一の判定軸であり、throttle 状態は分岐に絡まない。throttle 視認性は左側 `⏸ THROTTLED` の赤 blink で確保される。

### D4: 既存 `dashboard-pool.test.tsx` の `buildPoolHeader` 既存テスト — 残す (採用)

`buildPoolHeader` 関数は本タスクで削除しない（D2）ため、関数の振る舞いを検証する既存テストはそのまま有効。新仕様は新規 `pool-header-display.test.ts` でカバーする分担にする。テストの責務分割（既存関数 vs 新関数）が明確になり、構造的に正しい。

### D5: `formatRelativeDuration` 共通化 — 本タスクでは行わない (採用)

`pool-status-header.ts` の private 関数を export 化して再利用すると影響範囲が広がる。新ファイルに等価実装を置き、test で `<1m / 30m / 2h30m / 3d2h` の出力一致を担保。後で共通化したくなったら `format-duration.ts` 切り出しタスクを別途立てる（YAGNI）。

### D6: 統合テスト追加 — 本タスクでは行わない (採用)

`buildViewWithApp` レベルの「ヘッダー文字列に `pool capacity` が含まれ `┌─ token pool ─┐` が含まれない」統合テストは既存資産が薄く、新規構築コストが高い。純粋関数 helper の単体テストと、Implementer による手動 TUI 起動確認（pool ON / OFF）でカバーする。
