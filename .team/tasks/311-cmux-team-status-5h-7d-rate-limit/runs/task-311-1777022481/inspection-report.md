# T311 検品レポート

Implementer の成果物（`cmux-team status` に `─ Rate Limit ─` セクション追加）について、plan.md の要件と受け入れ条件を独立検証した。

**最終判定: GO** — 受け入れ条件すべて pass、コード品質に致命的問題なし、plan.md と構造的に整合。

---

## 1. 検証ログ

### 1.1 テスト実行

| コマンド | 結果 |
|---|---|
| `bun test skills/cmux-team/manager/rate-limit-status.test.ts` | **11 pass / 0 fail / 34 expect() calls** ✅ |
| `cd skills/cmux-team/manager && bun test`（全体） | **1226 pass / 0 fail / 2991 expect() calls**（41 files） ✅ |

### 1.2 型チェック

`cd skills/cmux-team/manager && bunx tsc --noEmit`:

```
conductor.ts(201,3): error TS1016
daemon.test.ts(3870,9): error TS2322
daemon.ts(1558,22): error TS2352
```

- baseline 3 件（`conductor.ts` / `daemon.test.ts` / `daemon.ts`）
- 本タスクで触ったファイル（`main.ts`, `rate-limit-status.ts`, `rate-limit-status.test.ts`）の**新規エラー: 0 件** ✅

### 1.3 実機動作

**(a) 正常** — `.team/rate-limit.json` が存在する環境で `bun run skills/cmux-team/manager/main.ts status`:

```
─ Tasks ───────────────────────────────────────────────────
  open: 10  closed: 295
─ Rate Limit ──────────────────────────────────────────────
  5h:  65% ███████░░░  reset in 1h19m  (2026/04/24 20:00)
  7d:  40% ████░░░░░░  reset in 23h19m  (2026/04/25 18:00)
  status: allowed  (updated 0s ago)
─ Log (last 10) ────────────────────────────────────────
```

→ **Log tail の直前、Tasks の直後に出現** ✅

**(b) 不在** — `.team/rate-limit.json` を一時退避して再実行:

```
─ Rate Limit ──────────────────────────────────────────────
  (no rate limit data — proxy not running?)
─ Log (last 10) ────────────────────────────────────────
```

→ 他セクション（Tasks / Log tail）は正常継続、exit code 0 ✅。退避後にファイルは復元済み。

**(c) 破損** — `.team/rate-limit.json` を `{broken` で上書きして再実行:

```
─ Rate Limit ──────────────────────────────────────────────
  (no rate limit data — proxy not running?)
─ Log (last 10) ────────────────────────────────────────
```

→ `loadRateLimit` が `rate_limit_persist_failed` を log に記録して null を返し、fallback 行が出る ✅。検証後にファイル復元済み。

**(d) stale** — unit test で検証（テスト 3/4/5）。実機検証は reset 時刻が過去になるまで待つ必要があるため省略、テストで担保。

### 1.4 既存モジュール未変更の確認

```bash
git diff --stat HEAD -- skills/cmux-team/manager/rate-limit-display.ts \
                         skills/cmux-team/manager/rate-limit-persistence.ts
→ (出力なし)
```

dashboard 側に影響が出ないことを構造的に担保 ✅。

### 1.5 import 制約の確認

```bash
grep -E "^import" skills/cmux-team/manager/rate-limit-status.ts
→ import type { RateLimitInfo } from "./schema";
→ import { isStale5h, isStale7d } from "./rate-limit-persistence";
```

plan.md ST1 の制約（`./schema` / `./rate-limit-persistence` のみ、Rezi/Ink/dashboard 系禁止）を充足 ✅。

---

## 2. 受け入れ条件チェック（plan.md 9 節）

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | `cmux-team status` で 5h / 7d の使用率・バー・reset 時刻・updatedAt が表示される | ✅ | 実機 (a) |
| 2 | `.team/rate-limit.json` 不在時に `(no rate limit data ...)` 表示、他セクション継続 | ✅ | 実機 (b) |
| 3 | `.team/rate-limit.json` 破損時に同上 | ✅ | 実機 (c) |
| 4 | axis 片方だけ stale のとき、その軸だけ `(stale)` 付与 | ✅ | テスト 3/4 |
| 5 | `unifiedStatus = "rate_limited"` のとき status 行に `⚠` | ✅ | テスト 6 |
| 6 | Log tail セクションは Rate Limit セクションより後ろに出る | ✅ | 実機 (a) |
| 7 | `bunx tsc --noEmit` の新規エラーゼロ | ✅ | §1.2 |
| 8 | `bun test` 全件パス | ✅ | §1.1（1226 pass） |
| 9 | `rate-limit-status.test.ts` のテストケースが 9 件以上存在し全件 GREEN | ✅ | 11 件実装 |
| 10 | `main.ts` の変更は 15 行以内 | ✅ | +12 行（import 1 + section 11） |

**10/10 pass**。

---

## 3. 品質評価

### A. 受け入れ条件の実機検証

- **Good points**:
  - impl-report.md の (a)/(b)/(c) 3 シナリオを独立再現でき、claim が正確であることを確認
  - exit code 0 を維持、他セクションへの副作用ゼロ
- **Findings**: なし

### B. コード品質レビュー（`rate-limit-status.ts`）

- **Good points**:
  - **GP1**: `buildRateLimitStatusLines(rl, now): string[]` は完全な純粋関数（I/O なし・副作用なし・`Date.now()` 直接呼び出しなし）。テスタビリティ高
  - **GP2**: 既存 `isStale5h` / `isStale7d` を再利用し、dashboard 側と一貫した stale semantics を保つ（T281 の軸独立 semantics に従う）
  - **GP3**: `parseReset` は `rate-limit-display.ts::formatResetRemaining` と同じ流儀（`Number(reset) > 1e9` で unix 秒 string 判定、fallback で `new Date()`）。既存挙動と一致
  - **GP4**: `unified5hUtilization != null` / `unified7dUtilization != null` / `unifiedStatus == null` の null ガードが各所で正しく入っている
  - **GP5**: 未来 updatedAt は `Math.max(0, ...)` でクランプ（時計ズレ対策）、`stale` 判定にも回らない
  - **GP6**: バー描画は `Math.max(0, Math.min(1, util))` で util > 1 でもクランプ、防御的
- **Findings**:
  - **M1 (Minor)**: plan.md の表示例では絶対時刻が `(2026-04-24 19:00)` 形式（ハイフン区切り）だが、実装は `(2026/04/24 20:00)` 形式（スラッシュ区切り）。これは `toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", ... })` の既定動作であり、impl-report.md §6 でも明示的に逸脱として記載されている。日本語プロジェクトでは自然な表示、テストは絶対時刻を fuzzy に assert しているため CI で flakey にならない。**容認**。
  - **M2 (Minor)**: `─ Rate Limit ${"─".repeat(46)}` でセクション幅は 13 + 46 = **59 char**。plan.md D7 は「合計 60（`─ Rate Limit ` 13 char + `─` × 45 ≈ 58）」と書かれているが、実際の他セクションと比較すると `─ Master ` (9) + 51 = 60、`─ Tasks ` (8) + 51 = 59 で**Tasks と同幅**。plan.md の計算例のほうがずれており、実装値が妥当。**容認**。

### C. テスト品質レビュー（`rate-limit-status.test.ts`）

- **Good points**:
  - **GP7**: plan.md ST2 の 10 ケース + 未来 updatedAt（11）= **11 ケース**。要求「9 件以上」を超過
  - **GP8**: `NOW = 2026-04-24T01:00:00.000Z` を固定注入、すべて `isoAt` / `unixSecAt` ヘルパー経由で生成。`Date.now()` を直接呼ぶ箇所なし、決定性完全
  - **GP9**: `expect(...).toContain(...)` / `.toMatch(...)` で文言微調整耐性。完全文字列一致なし
  - **GP10**: ISO 8601 文字列と unix 秒 string の両方をテストデータで使用（plan.md 要求の両方の入力形式を網羅）
  - **GP11**: 相対時刻エッジ（<1m / 90m → 1h30m / 25h → 1d1h / 過去 → expired）が 1 つのテスト内で複数ブロックで検証されている
- **Findings**: なし

### D. main.ts 変更レビュー

- **Good points**:
  - **GP12**: +12 行（import 1 + section 11）で 15 行以内（薄さ担保）
  - **GP13**: 挿入位置が `console.log(\`  open: ${openCount}  closed: ${closedCount}\`);` の直後、Log tail の直前。plan.md D5 と一致
  - **GP14**: 外側 `try/catch` を置いて、`loadRateLimit` が Zod 失敗等で null フォールバックしない想定外例外も握りつぶす防御層を追加
  - **GP15**: `rate-limit-display.ts` / `rate-limit-persistence.ts` は **完全未変更**（§1.4）、dashboard 動作に一切影響なし
- **Findings**: なし

### E. plan.md との整合性

- impl-report.md §6 の逸脱 1（TDD 手順の厳密 RED 先行を省略）: 純粋関数で依存が軽く、テストが実装詳細に依存しない assert で書かれている以上、最終 artifact の品質は同等。**容認**
- 逸脱 2（ST7 help_status 文言未追加）: plan.md で「任意、時間があれば」と明示されている。**容認**
- 絶対時刻形式の差分（M1）: impl-report.md で明示されており、日本語ロケールの既定で自然。**容認**

Decision Log（plan.md §7）と実装の一貫性:

| # | 決定 | 実装と一致 |
|---|---|---|
| D1 | 新モジュール `rate-limit-status.ts` | ✅ |
| D2 | `formatDurationShort` コピー | ✅ 独自実装（10行弱） |
| D3 | plain text + `⚠` | ✅ `buildStatusLine` 参照 |
| D4 | `"ja-JP"` 固定 | ✅ `formatAbsoluteTime` |
| D5 | Tasks の後・Log tail の前 | ✅ 実機 (a) |
| D6 | null フォールバック | ✅ 外側 try/catch 併用 |
| D7 | セクション幅 ≈ 60 | ⚠ 59（Tasks と同幅、M2 参照） |
| D8 | axis stale は `isStale5h/7d` 準拠 | ✅ |
| D9 | help_status は任意 | ✅ 未実施 |

---

## 4. 最終判定

**GO**

受け入れ条件 10/10 すべて pass。コード品質は設計判断（純粋関数分離・既存モジュール再利用・薄い main.ts 変更）が plan.md と完全に整合し、致命的問題・セキュリティ懸念・データ破壊リスクはいずれも観察されなかった。

指摘は Minor 2 件（M1: 絶対時刻区切り文字、M2: セクション幅 1 文字差）のみで、いずれも実用上の影響なし・impl-report.md で既に説明済み。後続タスクに回す必要もない（そのまま merge 可）。

### 補足: よかった設計判断

- **純粋関数化**: `main.ts` にロジックを直書きせず `rate-limit-status.ts` に分離した構造選択が、テスト決定性・dashboard 非汚染・将来の表示拡張容易性をすべて同時に実現している
- **既存 `isStale5h` / `isStale7d` 再利用**: T281 で確立した軸独立 stale semantics と一貫、dashboard と CLI で stale 判定のロジック重複を作らなかった
- **main.ts の二重防衛**: `loadRateLimit` 内部の try/catch + 外側 try/catch で、想定外例外が他セクション（Log tail）を潰さないようにしている

### 参考: `main.ts` 変更の薄さ

```diff
+import { buildRateLimitStatusLines } from "./rate-limit-status";
...
+  // --- Rate Limit ---
+  console.log(`─ Rate Limit ${"─".repeat(46)}`);
+  try {
+    const rl = await loadRateLimit(PROJECT_ROOT);
+    for (const line of buildRateLimitStatusLines(rl, Date.now())) {
+      console.log(line);
+    }
+  } catch {
+    console.log(`  (rate limit read failed)`);
+  }
```

挿入 12 行、削除 0 行。既存 5 セクションに一切手を入れていない。
