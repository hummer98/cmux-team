# T281 実装計画 — `isStale` を軸別（5h/7d）判定に分離する

## 1. 背景・根本原因（再整理）

### 症状

5h スロットル発動中は全 Conductor が停止する → Proxy を流れる API コールが無くなる → `state.rateLimit` が `proxy.ts:384, 425` の upstream レスポンス抽出経路でしか更新されないため、スロットル中は古い値のまま凍結される。結果として **5h reset 時刻を過ぎても自動解除されない**。

### 根本原因

`rate-limit-persistence.ts:81-90` の `isStale()` が **5h と 7d の OR 判定**:

```typescript
return !(has5hFuture || has7dFuture);
```

- 5h reset 過去 / 7d reset 未来 → `isStale=false`
- `unified5hUtilization` は古い高値（例: 95%）のまま
- `daemon.ts:2514-2516` の `throttled5h` ガードが true のまま維持
- 新規 assignment ブロック → API コール発生せず → `state.rateLimit` 更新されず → 無限ループ

テスト `rate-limit-persistence.test.ts:139-142`（「5h reset 過去 / 7d reset 未来 → non-stale」）がこの挙動を固定化している。

### 修正の本体

「軸ごとに独立に stale 判定する」。5h スロットルに関わる判定は `unified5hReset` のみを見るため、7d reset が未来でも 5h stale なら throttle は解除される。

---

## 2. 影響範囲（`isStale` 呼び出し箇所一覧）

テストを除く呼び出しは 6 箇所。全てを「5h 専用 / 7d 専用 / 両軸」のどれに該当するかで分類した。

| # | ファイル:行 | 用途 | 意図すべき軸 | 置換方針 |
|---|---|---|---|---|
| 1 | `daemon.ts:2515` | 5h throttle assignment ガード | **5h 専用** | `isStale5h` |
| 2 | `daemon.ts:3333` | sidebar の `⏸ throttled` 判定（`unified5hUtilization` / `unifiedStatus=rate_limited` のみ参照） | **5h 専用** | `isStale5h` |
| 3 | `proxy.ts:193` | `/rate-limit` エンドポイントが dashboard UI に返す `throttled` flag | **5h 専用** | `isStale5h` |
| 4 | `dashboard.tsx:1092` | TUI ヘッダー `⏸ THROTTLED` 表示判定 | **5h 専用** | `isStale5h` |
| 5 | `rate-limit-display.ts:41` | 使用率バーの GRAY 化 / `(stale)` サフィックス | **軸ごと** | 5h バーは `isStale5h`、7d バーは `isStale7d` |
| 6 | `main.ts:486` | 起動時の情報ログ（`rate_limit_restored stale=...`） | 両軸併記 | `stale5h=... stale7d=...` |

### 7d throttle について（調査ポイント 3 への回答）

`THROTTLE_7D_THRESHOLD` は schema.ts / コード全域に **存在しない**。7d は観測（記録・表示）のみで、assignment / sidebar / proxy いずれも **throttle ガード対象外**。従って本タスクで「7d 専用の throttle 判定」を新規作成する必要はない。`isStale7d` は将来の拡張と dashboard 表示専用に定義する。

### 既存テストへの影響

- `rate-limit-persistence.test.ts:98-156`（`describe("isStale")`）: 旧 OR セマンティクスに依存。**削除または書き換え**。特に `L139-142`（過去/未来 → non-stale）は **意図と逆転する**（過去軸は stale 扱いしたいのが T281）
- `rate-limit-display.test.ts:70-90`（stale = 全 GRAY）: 両軸過去の前提なので **挙動変わらず**。5h/7d それぞれ過去の場合の分離テストを **追加**

---

## 3. 設計方針

### 3.1 公開 API（`rate-limit-persistence.ts`）

```typescript
/**
 * 5h 軸の stale 判定。
 * - `rl` が null / undefined → true
 * - `unified5hReset` が null / 過去 / 解釈不能 → true
 * - `unified5hReset` が未来 → false
 */
export function isStale5h(
  rl: RateLimitInfo | null | undefined,
  now: number = Date.now(),
): boolean;

/**
 * 7d 軸の stale 判定。
 * - `rl` が null / undefined → true
 * - `unified7dReset` が null / 過去 / 解釈不能 → true
 * - `unified7dReset` が未来 → false
 */
export function isStale7d(
  rl: RateLimitInfo | null | undefined,
  now: number = Date.now(),
): boolean;
```

### 3.2 既存 `isStale` の扱い（採用案: A）

**採用案 A: 既存 `isStale` を削除し、全呼び出し元を `isStale5h` / `isStale7d` に置換する。**

#### 案比較

| 案 | 内容 | 採否 |
|---|---|---|
| A | `isStale` を削除 | ✅ **採用** — 呼び出し元が 6 箇所しかなく、OR 判定を残すと誤用リスク。1 箇所ずつ「どの軸を使うか」を明示的に選ばせる |
| B | `isStale` を AND 判定（両軸 stale）に意味変更 | ❌ セマンティクスのサイレント変更は危険。新規に `isStaleAll` として作るなら可だが呼び出し元がない |
| C | 旧 `isStale` を `@deprecated` で残す | ❌ 内部 API のため deprecation 期間を設ける意義が薄い |

### 3.3 `rate-limit-display.ts` の修正方針

バー単位で軸別判定を適用する。`(stale)` サフィックスは「両軸 stale のときだけ」付ける（軸別 GRAY で stale 軸は視認可能なので重複回避）。

```typescript
const stale5h = isStale5h(rl, now);
const stale7d = isStale7d(rl, now);
const allStale = stale5h && stale7d;

// forceRed は unifiedStatus=rate_limited の警告表示。rate_limited は主に 5h 由来のため
// 5h non-stale のときだけ赤にする（7d stale でも 5h が生きていれば赤を出す）。
const forceRed = rl.unifiedStatus === "rate_limited" && !stale5h;

// 5h バーは stale5h で GRAY、7d バーは stale7d で GRAY
```

### 3.4 ログフォーマット（`main.ts:486`）

```
rate_limit_restored unified5h=<v> unified7d=<v> stale5h=<bool> stale7d=<bool>
```

旧 `stale=<bool>` 単一値の併記は削除（軸別のほうが情報量が多い）。

---

## 4. 変更対象ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/rate-limit-persistence.ts` | `isStale5h` / `isStale7d` 新規追加、`isStale` 削除、`isFuture` ヘルパは共用で残す |
| `skills/cmux-team/manager/rate-limit-persistence.test.ts` | 既存 `describe("isStale")` 削除、`describe("isStale5h")` / `describe("isStale7d")` 新規追加 |
| `skills/cmux-team/manager/rate-limit-display.ts` | `stale` 変数を軸別 `stale5h` / `stale7d` に分割、バー生成時に軸別適用、`(stale)` 付与は両軸 stale のときのみ |
| `skills/cmux-team/manager/rate-limit-display.test.ts` | 「5h 過去 / 7d 未来 → 5h バーのみ GRAY、7d バー色維持」テスト追加。「両方過去 → 全 GRAY + (stale)」は継続で通るはず |
| `skills/cmux-team/manager/daemon.ts` | L30 の import、L2515 / L3333 の呼び出しを `isStale5h` に置換 |
| `skills/cmux-team/manager/proxy.ts` | L15 の import、L193 の呼び出しを `isStale5h` に置換 |
| `skills/cmux-team/manager/dashboard.tsx` | L21 の import、L1092 の呼び出しを `isStale5h` に置換 |
| `skills/cmux-team/manager/main.ts` | L53 の import、L486 のログフォーマット更新 |

**コード変更合計**: ロジックは 1 モジュール（`rate-limit-persistence.ts`）、呼び出し元置換は 6 箇所。

---

## 5. テスト追加計画

### 5.1 `rate-limit-persistence.test.ts` — 新規

```typescript
describe("isStale5h", () => {
  const now = 1_700_000_000_000;
  const nowSec = Math.floor(now / 1000);
  const future = String(nowSec + 3600);
  const past = String(nowSec - 3600);

  test("rl=null → stale", () => expect(isStale5h(null, now)).toBe(true));
  test("unified5hReset=null → stale", () => {
    const rl = makeInfo({ unified5hReset: null, unified7dReset: future });
    expect(isStale5h(rl, now)).toBe(true);
  });
  test("unified5hReset が過去 → stale", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: future });
    expect(isStale5h(rl, now)).toBe(true);
  });
  test("unified5hReset が未来 → non-stale", () => {
    const rl = makeInfo({ unified5hReset: future, unified7dReset: past });
    expect(isStale5h(rl, now)).toBe(false);
  });
  test("T281 リグレッション: 5h 過去 / 7d 未来 → 5h は stale", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: future });
    expect(isStale5h(rl, now)).toBe(true);
  });
  test("解釈不能な reset 文字列 → stale", () => {
    const rl = makeInfo({ unified5hReset: "not-a-date" });
    expect(isStale5h(rl, now)).toBe(true);
  });
});

describe("isStale7d", () => {
  // 対称に 6 ケース
});
```

### 5.2 `rate-limit-persistence.test.ts` — 旧 `describe("isStale")` 削除

`L98-156` を削除。代わりに上記 `isStale5h` / `isStale7d` describe に置き換え。

### 5.3 `rate-limit-display.test.ts` — 追加

```typescript
test("5h 過去 / 7d 未来 → 5h バーのみ GRAY、7d バーは元色", () => {
  const rl = makeInfo({
    unified5hReset: PAST_5H,
    unified7dReset: FUTURE_7D,
    unified5hUtilization: 0.95,
    unified7dUtilization: 0.17,
  });
  const { parts } = buildRateLimitDisplay(rl, NOW);
  const bar5h = parts.find((p) => p.text.includes("5h:"));
  const bar7d = parts.find((p) => p.text.includes("7d:"));
  expect(bar5h?.color).toBe("gray");
  expect(bar7d?.color).toBe("green");
  // 片軸 stale では (stale) サフィックス出さない
  expect(parts.some((p) => p.text.includes("(stale)"))).toBe(false);
});

test("5h 過去 / 7d 未来 / unifiedStatus=rate_limited → 7d も赤にしない（5h stale で forceRed 発動せず）", () => {
  const rl = makeInfo({
    unified5hReset: PAST_5H,
    unified7dReset: FUTURE_7D,
    unifiedStatus: "rate_limited",
    unified5hUtilization: 0.95,
  });
  const { parts } = buildRateLimitDisplay(rl, NOW);
  const bar7d = parts.find((p) => p.text.includes("7d:"));
  expect(bar7d?.color).not.toBe("red");
});
```

### 5.4 既存テストの修正

- `rate-limit-display.test.ts:70-77`（両方過去 → 全 GRAY + `(stale)`）は継続で通る（両軸 stale なので）
- `rate-limit-display.test.ts:79-90`（stale + rate_limited で赤にしない）は継続で通る（5h が stale → forceRed=false）
- ただし該当テストの事前条件に 7d も過去を含めるか確認。現行 `L82 unified7dReset: null` のため、これは両軸 stale のケース

---

## 6. TDD 手順

以下の順で 赤 → 緑 → リファクタを繰り返す。各ステップ後に `cd skills/cmux-team/manager && bun test` でリグレッション確認。

### Step 1: `isStale5h` / `isStale7d` の追加（赤 → 緑）

1. 🔴 `rate-limit-persistence.test.ts` に `describe("isStale5h")` の最小ケース 2 つ（null → stale、未来 → non-stale）を追加。テスト実行 → 関数未定義で fail
2. 🟢 `rate-limit-persistence.ts` に `isStale5h` / `isStale7d` を追加（既存 `isStale` はまだ残す）。`isFuture` を共有
3. 🟢 テスト通過を確認。5.1 の残り 4 ケース + `describe("isStale7d")` 6 ケースを追加しながら緑を維持

### Step 2: 呼び出し元を軸別に置換（赤 → 緑）

4. 🔴 `rate-limit-persistence.test.ts` の旧 `describe("isStale")` を削除。この時点では `isStale` を使っている 6 箇所のコードが残っているため型エラー・ランタイムエラーになる可能性あり。まずビルドで赤
5. 🟢 `daemon.ts` / `proxy.ts` / `dashboard.tsx` の `isStale` を `isStale5h` に置換（3 箇所の import 修正 + 4 箇所の呼び出し置換）
6. 🟢 `main.ts:486` のログを `stale5h=... stale7d=...` 形式に修正
7. 🟢 `rate-limit-display.ts` の `stale` 変数を `stale5h` / `stale7d` に分割し、バー単位で適用
8. 🟢 `rate-limit-persistence.ts` から `isStale` export を削除
9. 🟢 `bun test` 全体通過確認

### Step 3: `rate-limit-display.ts` の軸別 stale 対応（赤 → 緑）

10. 🔴 `rate-limit-display.test.ts` に 5.3 の新規テストを追加。5h 過去 / 7d 未来で 5h バーが GRAY、7d バーが元色を期待。現行実装（Step 2 の時点で軸別化済み）で通るはずだが、Step 2 で partial しか触っていない場合は赤になる
11. 🟢 `buildRateLimitDisplay` を軸別 stale に完全対応させる
12. 🟢 テスト通過

### Step 4: リファクタ

13. `isFuture` ヘルパの重複除去・コメント整理
14. ログ・コメントの用語統一（「5h 軸」「7d 軸」の表現）
15. `cd skills/cmux-team/manager && bun test` 全体通過確認
16. `git diff` で差分レビュー → 不要な変更削除

---

## 7. リスク・留意事項

### 7.1 破壊的 API 変更

`isStale` export を削除するため、ツリー内の 6 箇所の import / 呼び出しを同時に置換する必要がある。**単一コミットで完結させる**ことを推奨。部分置換でビルドが通らない中間状態を作らない。

### 7.2 dashboard 表示の意図されたセマンティック変化

- 従来: `5h 未来 / 7d 過去` でも `isStale=false` だったため、7d バーは通常色で表示されていた
- 修正後: 7d バーは `isStale7d=true` で GRAY 化される

これは **表示の意図した変化**。7d reset が過去になっている = 7d のヘッダーが取得から時間が経過し信頼できない、という表示意図に合致する。許容する。

### 7.3 `persistRateLimit` / `loadRateLimit` との整合

`persistRateLimit` / `loadRateLimit` は値を丸ごと保存・復元するだけで stale 判定は行わない（`isStale` はあくまで呼び出し側の解釈）。従って軸別化に対する永続化層の変更は **不要**。既存 JSON フォーマットも変更しない（RateLimitInfo スキーマそのまま）。

### 7.4 `main.ts:486` のログ互換性

起動時ログ `rate_limit_restored stale=<bool>` → `stale5h=<bool> stale7d=<bool>`。外部ログパーサは存在しない想定（cmux-team 内部観察用）のため許容。ただし README / docs/spec で触れている場合は更新検討。grep で確認したが該当なし → docs 更新不要。

### 7.5 7d throttle の将来拡張

今回のスコープ外だが、`isStale7d` を追加したことで「将来 7d throttle ガードを作る際に `isStale7d` を使えば良い」という構造的な整合性が得られる。逆に今回その扱いを仕様として明記しておく:

> **7d は観測のみ。assignment ガードは 5h のみ。`unified7dUtilization` が高値でも throttle は発動しない。**

この方針を `rate-limit-persistence.ts` の関数 docstring に明記する。

### 7.6 テストの固定時刻依存

既存テストが `NOW = 1_700_000_000_000` を使用しており、新規テストも同値を使う。`now` 引数で injection するため日付跨ぎ問題は発生しない。

### 7.7 `isFuture` の仕様変更リスク

`isFuture` は内部関数で外部 export なし。`isStale5h` / `isStale7d` で共用する際に、現行の「null → false」「過去 → false」「未来 → true」セマンティクスをそのまま踏襲する。変更しない。

---

## 8. 受け入れ条件と検証手順

### 受け入れ条件（タスク記述より）

- [x] 5h reset 過去 / 7d reset 未来の状態で、`daemon.ts` の throttle ガードが解除される（assignment が再開する）
- [x] 対応するユニットテストを追加
- [x] dashboard の「⏸ throttled」表示が、5h reset 通過時に外れる
- [x] 既存のテストが通る

### 検証手順

#### 8.1 Unit テスト

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-281-1776722442/skills/cmux-team/manager
bun test rate-limit-persistence.test.ts
bun test rate-limit-display.test.ts
```

全ケース通過すること。

#### 8.2 全体テスト（リグレッション）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-281-1776722442/skills/cmux-team/manager
bun test
```

既存テスト全通過を確認。

#### 8.3 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-281-1776722442/skills/cmux-team/manager
bun run typecheck   # もし設定されていれば
# または
bun x tsc --noEmit
```

`isStale` 削除による import エラーが残っていないこと。

#### 8.4 E2E（手動・任意）

daemon を手動起動し `.team/rate-limit.json` に以下のテストデータを仕込む:

```json
{
  "tokensRemaining": 0, "tokensLimit": 1000, "tokensReset": "",
  "inputTokensRemaining": 0, "outputTokensRemaining": 0,
  "unified5hUtilization": 0.95,
  "unified7dUtilization": 0.4,
  "unified5hReset": "<過去の epoch 秒>",
  "unified7dReset": "<未来の epoch 秒>",
  "unifiedStatus": "rate_limited",
  "updatedAt": "2026-04-21T00:00:00Z"
}
```

`cmux-team start` → dashboard で **`⏸ THROTTLED` が表示されないこと**、ready タスクがあれば assignment が動き出すこと。

---

## 9. 参考: 置換箇所の具体パッチイメージ（参考、厳密な最終形は実装者判断）

### `rate-limit-persistence.ts`

```diff
-export function isStale(
-  rl: RateLimitInfo | null | undefined,
-  now: number = Date.now(),
-): boolean {
-  if (!rl) return true;
-  const nowSec = Math.floor(now / 1000);
-  const has5hFuture = isFuture(rl.unified5hReset, nowSec);
-  const has7dFuture = isFuture(rl.unified7dReset, nowSec);
-  return !(has5hFuture || has7dFuture);
-}
+/**
+ * 5h 軸の stale 判定。unified5hReset が null / 過去 / 解釈不能 → true。
+ * 7d 側の状態には影響されない（T281）。
+ */
+export function isStale5h(
+  rl: RateLimitInfo | null | undefined,
+  now: number = Date.now(),
+): boolean {
+  if (!rl) return true;
+  const nowSec = Math.floor(now / 1000);
+  return !isFuture(rl.unified5hReset, nowSec);
+}
+
+/** 7d 軸の stale 判定（観測表示用、throttle ガード対象外）。 */
+export function isStale7d(
+  rl: RateLimitInfo | null | undefined,
+  now: number = Date.now(),
+): boolean {
+  if (!rl) return true;
+  const nowSec = Math.floor(now / 1000);
+  return !isFuture(rl.unified7dReset, nowSec);
+}
```

### `daemon.ts:2514-2516`

```diff
   const throttled5h =
-    !isStale(state.rateLimit) &&
+    !isStale5h(state.rateLimit) &&
     (state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;
```

### `rate-limit-display.ts`

```diff
-  const stale = isStale(rl, now);
+  const stale5h = isStale5h(rl, now);
+  const stale7d = isStale7d(rl, now);
+  const allStale = stale5h && stale7d;

   if (rl.unified5hUtilization != null || rl.unified7dUtilization != null) {
     const parts: RateLimitPart[] = [];
-    const forceRed = rl.unifiedStatus === "rate_limited" && !stale;
+    const forceRed = rl.unifiedStatus === "rate_limited" && !stale5h;

     if (rl.unified5hUtilization != null) {
       const h5 = buildUtilizationBar("5h", rl.unified5hUtilization, rl.unified5hReset, now);
       parts.push(
         ...h5.parts.map((p) => ({
           ...p,
-          color: stale ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color,
+          color: stale5h ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color,
         } as RateLimitPart)),
       );
     }
     if (rl.unified7dUtilization != null) {
       const d7 = buildUtilizationBar("7d", rl.unified7dUtilization, rl.unified7dReset, now);
       parts.push(
         ...d7.parts.map((p) => ({
           ...p,
-          color: stale ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color,
+          color: stale7d ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color,
         } as RateLimitPart)),
       );
     }

-    if (stale && parts.length > 0) {
+    if (allStale && parts.length > 0) {
       parts.push({ text: "(stale)", color: "gray" });
     }
```

---

## 10. スコープ外（今回はやらないこと）

- 7d throttle ガードの新規追加（タスクの意図とズレる。必要なら別タスク化）
- `persistRateLimit` / `loadRateLimit` の永続化フォーマット変更
- dashboard の stale 表示 UI 大規模リニューアル（`(stale-5h)` / `(stale-7d)` 別表記など）
- `RateLimitInfo` スキーマへの stale フラグ追加

---

## 完了基準

- [ ] 上記すべての変更ファイルが適用され、TDD 手順の各ステップが完了
- [ ] `bun test` 全体通過
- [ ] `isStale` が `rate-limit-persistence.ts` から削除され、呼び出し元に残骸なし
- [ ] 新規ユニットテスト（`isStale5h` / `isStale7d` / 5h 過去+7d 未来の display）追加済み
- [ ] 8.4 の E2E 手順で dashboard 挙動確認（可能ならスクショ）
