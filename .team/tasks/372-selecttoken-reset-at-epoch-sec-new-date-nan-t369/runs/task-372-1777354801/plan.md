# T372 実装計画 — `parseResetEpochMs` で stale snapshot 救済を回復させる

## 1. 概要

### 修正の意図

`token-store.ts: admitCandidates`（T369 で導入）の stale snapshot 救済ロジックは、Anthropic レスポンスヘッダー `anthropic-ratelimit-unified-5h-reset` / `anthropic-ratelimit-unified-7d-reset` を **epoch sec の文字列**（例 `"1777366200"`）として DB に保存しているため、`new Date("1777366200").getTime() === NaN` となり `<=` 比較が常に `false` を返す。結果、reset 時刻を過ぎたトークンも候補から除外され続け、T369 の救済が効いていない。

A 案（決定済み）に従い、module-private ヘルパー `parseResetEpochMs(v: string): number` を追加して epoch sec 文字列・ISO 8601 文字列・不正値を一元的に解釈する。NaN は `<=` で false になるので「不正値は reset 済みと判定しない」安全側動作を維持する。

### 影響範囲

- **コード変更**: `skills/cmux-team/manager/token-store.ts`（admit 判定 2 行 + ヘルパー 1 関数）
- **テスト追加**: `skills/cmux-team/manager/token-store.test.ts`（5 ケース、既存 describe ブロックに追加）
- **DB マイグレーション不要**: 既存 `usage_snapshots.reset_*_at` カラムのデータ形式（epoch sec 文字列）はそのまま読める
- **後方互換**: ISO 8601 文字列も引き続き解釈できる（proxy 側を将来変えても破壊しない）
- **API 変更なし**: `admitCandidates` / `selectToken` / `canSelectAnyToken` の signature は不変
- **`computePoolCapacity` への影響**: `hoursUntil`（`token-store.ts:758-759`）も同様に `new Date()` で reset_*_at をパースしているが、**今回の T372 スコープ外**（A 案で `admitCandidates` のみ修正と決定済み）。`hoursUntil` の修正は別タスクで扱う

## 2. 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/token-store.ts` | `parseResetEpochMs` ヘルパー追加（module-private）+ `admitCandidates` の reset5hPast / reset7dPast 判定 2 行を置換 |
| `skills/cmux-team/manager/token-store.test.ts` | `describe("selectToken (T369: stale snapshot の util リセット時刻反映)")` の末尾に T372 用テスト 5 件追加 |

## 3. 実装ステップ（TDD 順序）

### Step 1: 失敗テストを書く（RED）

`token-store.test.ts:1873`（既存 `describe` ブロック末尾、TC8 の直後）に T372 用テスト 5 件を追加する（詳細は §4）。
この時点では `parseResetEpochMs` が存在しないため、TC372-1 / TC372-2 / TC372-4（epoch sec 系）が失敗するはず。

検証:
```bash
cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
```

**期待**: TC372-1（過去 epoch sec で admit）が失敗、TC372-2（未来 epoch sec で除外）は偶然通る可能性あり（NaN <= now が false なので「除外」側は元実装でも観測上一致）、TC372-4（不正値）も同様に偶然通る。
**重要**: TC372-1 / TC372-3（epoch sec 過去 + 元 util_5h=0.99 でブロッカー回避）は明確に RED になる。少なくとも 1 件以上が RED であることを確認してから Step 2 へ進む。

### Step 2: ヘルパーと判定置換を実装（GREEN）

`token-store.ts` の admit 判定の直前（`admitCandidates` 関数定義の手前付近、または同ファイル内ヘルパー領域）に下記を追加:

```ts
/**
 * Anthropic ratelimit ヘッダー由来の reset 時刻を epoch ms に変換する。
 * - epoch sec の文字列（例 "1777366200"）→ * 1000 して epoch ms
 * - ISO 8601 文字列（例 "2026-04-25T10:00:00.000Z"）→ Date.parse 経由で epoch ms
 * - 不正値・空文字 → NaN（呼び出し側の `<=` 比較で安全側 false になる）
 */
function parseResetEpochMs(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}
```

その上で `token-store.ts:919-922` を置換:

```ts
// before
const reset5hPast =
  snap.reset_5h_at != null && new Date(snap.reset_5h_at).getTime() <= now;
const reset7dPast =
  snap.reset_7d_at != null && new Date(snap.reset_7d_at).getTime() <= now;

// after
const reset5hPast =
  snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now;
const reset7dPast =
  snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now;
```

### Step 3: 通過確認（GREEN）

```bash
cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
```

**期待**: 既存 TC1〜TC8（ISO 8601 ベース）+ T372 追加 5 件 + 他テストすべて pass。

### Step 4: 周辺テスト確認（回帰チェック）

`computePoolCapacity` などの reset_*_at を参照する他テスト群が壊れていないことを確認:

```bash
cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
```

（同じファイル内なので Step 3 と同コマンドで一括確認できる）

## 4. テストケース実装方針（5 件）

### 配置先

`token-store.test.ts` の `describe("selectToken (T369: stale snapshot の util リセット時刻反映)")` ブロック末尾（**TC8 の直後、行 1873 付近**）に追加する。`db` / `makeToken` / `insertToken` / `seedStaleSnapshot` / `seedFreshSnapshot` ヘルパーが既に整備されているため、それらを再利用する。

### 共通 helper の追加

epoch sec の過去・未来文字列を生成する小ヘルパーを describe 内（既存 `pastIso` / `futureIso` の直下）に追加する:

```ts
function pastEpochSec(minutesAgo: number): string {
  return String(Math.floor((Date.now() - minutesAgo * 60_000) / 1000));
}
function futureEpochSec(minutesAhead: number): string {
  return String(Math.floor((Date.now() + minutesAhead * 60_000) / 1000));
}
```

`upsertUsageSnapshot` は `reset_5h_at: string | null` を受けるので、epoch sec 文字列でもそのまま渡せる（DB スキーマも `TEXT`）。

### TC372-1: stale + reset_5h_at が epoch sec 文字列で過去 → admit、score=0 ベース

```ts
test("T372-1: stale + reset_5h_at = epoch sec(past) → 候補化、effUtil5h=0 で score 計算", () => {
  const t = insertToken(
    db,
    makeToken({ handle: "@kepoch1", organization_id: "org-kepoch1", tags: ["any"] }),
  );
  seedStaleSnapshot({
    tokenId: t.id,
    util5h: 0.9,
    util7d: 0.5,
    reset5hAt: pastEpochSec(5),
    reset7dAt: futureEpochSec(60),
    recordedMinutesAgo: 50,
  });
  const sel = selectToken(db, "h-372-1");
  expect(sel?.token.handle).toBe("@kepoch1");
});
```

**狙い**: 修正前は `new Date("17xxx").getTime() === NaN` → `reset5hPast=false` → stale 除外で `sel === null` になる。修正後は parseResetEpochMs で正しく過去判定 → admit。

### TC372-2: stale + reset_5h_at が epoch sec 文字列で未来 → 候補除外

```ts
test("T372-2: stale + reset_5h_at = epoch sec(future) + reset_7d_at = epoch sec(future) → 候補外", () => {
  const t = insertToken(
    db,
    makeToken({ handle: "@kepoch2", organization_id: "org-kepoch2", tags: ["any"] }),
  );
  seedStaleSnapshot({
    tokenId: t.id,
    util5h: 0.9,
    util7d: 0.5,
    reset5hAt: futureEpochSec(60),
    reset7dAt: futureEpochSec(120),
    recordedMinutesAgo: 50,
  });
  const sel = selectToken(db, "h-372-2");
  expect(sel).toBeNull();
});
```

**狙い**: 未来 epoch sec が「未来」と正しく解釈され、stale 経路で候補外になることを保証する。修正前は NaN 比較で偶然通るが、回帰防止として残す（修正後の意図的な未来判定を保証）。

### TC372-3: stale + reset_5h_at が ISO 8601 で過去 → admit（後方互換）

```ts
test("T372-3: stale + reset_5h_at = ISO 8601(past) → 後方互換で admit（既存 TC1 と同等）", () => {
  const t = insertToken(
    db,
    makeToken({ handle: "@kiso", organization_id: "org-kiso", tags: ["any"] }),
  );
  seedStaleSnapshot({
    tokenId: t.id,
    util5h: 0.9,
    util7d: 0.5,
    reset5hAt: pastIso(5),         // ISO 8601
    reset7dAt: futureIso(60),
    recordedMinutesAgo: 50,
  });
  const sel = selectToken(db, "h-372-3");
  expect(sel?.token.handle).toBe("@kiso");
});
```

**狙い**: 既存 ISO 8601 ベースの動作（TC1 相当）が壊れていないことを明示する。命名で T372 専用 test だと分かるよう残す（重複ではなく後方互換の保証として価値あり）。

### TC372-4: stale + reset_5h_at が不正値（"abc"）→ NaN → 候補除外（安全側）

```ts
test("T372-4: stale + reset_5h_at = 不正値 → NaN 解釈 → 候補外（安全側）", () => {
  const t = insertToken(
    db,
    makeToken({ handle: "@kbad", organization_id: "org-kbad", tags: ["any"] }),
  );
  seedStaleSnapshot({
    tokenId: t.id,
    util5h: 0.9,
    util7d: 0.5,
    reset5hAt: "abc",
    reset7dAt: "not-a-date",
    recordedMinutesAgo: 50,
  });
  const sel = selectToken(db, "h-372-4");
  expect(sel).toBeNull();
});
```

**狙い**: 不正データ混入時に「reset 済み」と誤判定しない安全側動作を保証。`parseResetEpochMs("abc")` → `Number("abc") === NaN` → `new Date("abc").getTime() === NaN` → return NaN → `NaN <= now === false` → `reset5hPast=false`。

### TC372-5: fresh snapshot → reset 解釈ロジックを通らずそのまま score 計算

```ts
test("T372-5: fresh snapshot は reset_5h_at が epoch sec でも util 上書きされない（回帰）", () => {
  const tHigh = insertToken(
    db,
    makeToken({ handle: "@hifresh", organization_id: "org-hifresh", tags: ["any"] }),
  );
  // fresh + reset_*_at が epoch sec(過去) でも util は上書きされない
  upsertUsageSnapshot(db, {
    token_id: tHigh.id,
    util_5h: 0.9,
    util_7d: 0.5,
    reset_5h_at: pastEpochSec(5),
    reset_7d_at: pastEpochSec(5),
    unified_status: null,
  });
  const tComp = insertToken(
    db,
    makeToken({ handle: "@compfresh", organization_id: "org-compfresh", tags: ["any"] }),
  );
  seedFreshSnapshot(tComp.id, 0.5, 0.5); // score=0.5
  // 上書きされていれば @hifresh の score は 0 で勝つはず。されなければ 0.62 で @compfresh が勝つ
  const sel = selectToken(db, "h-372-5");
  expect(sel?.token.handle).toBe("@compfresh");
});
```

**狙い**: T369 の TC6（fresh snapshot は util 上書きされない）の epoch sec 版。reset 解釈ロジックは stale 分岐の中にあるので、fresh では分岐に入らないことを保証する。

## 5. 後方互換性の確認ポイント

| 観点 | 確認内容 |
|---|---|
| 既存 DB データ | `usage_snapshots.reset_*_at` の TEXT カラムには epoch sec 文字列が保存されている。再書き込み・マイグレーション不要。`parseResetEpochMs` は既存値をそのまま読める |
| ISO 8601 互換 | proxy 側を将来変えても壊れないよう、ISO 8601 文字列も `new Date(v).getTime()` 経由で解釈できる（TC372-3 で保証） |
| `null` 値 | `snap.reset_5h_at != null` の null チェックは admit 判定側で先に行う（修正後も維持）。`parseResetEpochMs` は `string` のみ受け取る前提 |
| 不正値 | `Number.isFinite` で NaN を弾き、`Date.parse` も NaN なら NaN を返す。`<=` で false になるので「reset 済みと誤判定しない」安全側動作（TC372-4 で保証） |
| API signature | `admitCandidates` / `selectToken` / `canSelectAnyToken` / `upsertUsageSnapshot` の引数・戻り値は変更なし |
| 他コンシューマ | `hoursUntil`（`token-store.ts:758-759`）も `new Date()` で reset_*_at を解釈しているが、本タスクのスコープ外（A 案決定通り）。別タスクで扱う旨を §1 に明記済み |

## 6. 検証コマンド

```bash
cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
```

**注意**: CLAUDE.md 規約により `bun test` 全体実行は禁止（O(N²) 級劣化で 13 分以上ハング）。**必ずファイル単位で実行する。**

期待される結果:
- 既存テスト全件 pass（TC1〜TC8 含む）
- T372 追加 5 件 pass

## 7. リスクと回避策

| リスク | 影響 | 回避策 |
|---|---|---|
| `parseResetEpochMs` の epoch sec / ms の取り違え | 巨大値が ms と誤判定され、reset が常に未来扱いになる | epoch sec の妥当範囲（10 桁、~2286 年まで）を考慮しても `Number.isFinite` で十分。`* 1000` で ms に統一する仕様を JSDoc に明記 |
| ISO 8601 文字列の数字部分が `Number()` で finite になる誤判定 | `Number("2026-04-25T10:00:00.000Z")` は `NaN` なので問題なし。ただし `"2026"` のような短縮形が来ると `Number("2026") === 2026` が finite で `2026 * 1000 = 2026 ms`（1970 年）と誤判定される可能性 | proxy 側の出力は `epoch sec の数字列` か `ISO 8601 完全文字列` の二択しかないので実害なし。ただし JSDoc で「proxy が出す 2 形式に対応」と明記し、想定外形式は将来扱わないことを示す |
| 既存 TC1〜TC8 の ISO 8601 ベーステストが壊れる | TC1 等が落ちると T369 の動作保証が失われる | TC372-3 で ISO 8601 後方互換を明示テスト。さらに Step 3 で全 token-store.test.ts を実行して既存全件の pass を確認する |
| `hoursUntil`（`computePoolCapacity` 内）も同じ NaN 問題を持つ | pool capacity の計算が epoch sec 文字列で誤動作している可能性 | **T372 のスコープ外**（A 案決定通り）。本 plan には含めず、別タスクで起票する旨を §1 に明記済み。レビュー時にユーザーに別タスク起票を打診する |
| 修正後も「stale + reset 過去」シナリオで util_5h > 0.95 の元値が残ると `effUtil5h = 0` 上書きで救済されるが、ブロッカー判定 `effUtil5h > 0.95` は **上書き後の値**で行うため安全 | 既存 TC8 と整合 | TC372-1 で `util5h: 0.9` のシナリオで admit を保証。ブロッカー回避シナリオは TC8（既存）でカバー済み |

## 8. 完了条件

- [ ] `parseResetEpochMs` が `token-store.ts` に追加され、`admitCandidates` から呼ばれている
- [ ] `token-store.test.ts` に T372-1〜T372-5 の 5 件が追加されている
- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` が全件 pass
- [ ] 既存 TC1〜TC8 が引き続き pass（後方互換確認）
- [ ] DB マイグレーション不要（既存 epoch sec 文字列をそのまま解釈できる）
