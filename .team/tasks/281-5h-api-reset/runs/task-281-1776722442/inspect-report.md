# T281 Inspector 検品レポート

## Verdict

**GO**

plan.md §6 の TDD 手順通りに `isStale` → `isStale5h` / `isStale7d` への軸別分離が完遂され、呼び出し元 6 箇所の置換も完全。受け入れ条件はすべて達成、単体・全体テストともに 100% 通過。plan.md からの逸脱・スコープ外変更も認められない（`package-lock.json` のバージョン更新を除く。下記「軽微な懸念」参照）。

---

## Acceptance Criteria Check

| # | 受け入れ条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | 5h reset 過去 / 7d reset 未来 → daemon の throttle ガードが解除される | ✓ | `daemon.ts:2515` の `throttled5h = !isStale5h(state.rateLimit) && ...`。`isStale5h` は 5h 軸のみ参照するため、5h 過去時に `isStale5h=true` → `!isStale5h=false` → `throttled5h=false` で assignment が継続する。`rate-limit-persistence.test.ts::isStale5h::T281 リグレッション: 5h 過去 / 7d 未来 → 5h は stale` で担保 |
| 2 | 対応するユニットテストが追加されている | ✓ | `isStale5h` describe 8 ケース / `isStale7d` describe 6 ケース / `rate-limit-display.test.ts` に T281 軸別 stale リグレッション 4 ケースを新規追加。計 18 ケース |
| 3 | dashboard の `⏸ throttled` 表示が 5h reset 通過時に外れる | ✓ | `dashboard.tsx:1092` の `isThrottled = !isStale5h(daemon.rateLimit) && ...`、`daemon.ts:3333` の sidebar `computeSidebarStatus` の `throttled` 判定が共に `isStale5h` を参照 |
| 4 | 既存のテストが通る | ✓ | `bun test`（全体）で 810 pass / 0 fail。本タスク変更範囲の flaky 観測なし。既存の `rate-limit-display.test.ts:70-90`（両軸 stale → 全 GRAY + `(stale)`、rate_limited × stale で赤にしない）も継続通過 |

---

## Test Results

### 該当テスト単独（Inspector 実行）

```
cd skills/cmux-team/manager && bun test rate-limit-persistence.test.ts rate-limit-display.test.ts
 34 pass
 0 fail
 54 expect() calls
```

### 全体テスト（Inspector 実行）

```
cd skills/cmux-team/manager && bun test
 810 pass
 0 fail
 1946 expect() calls
Ran 810 tests across 27 files. [36.96s]
```

impl-report 記載時点の 30 pass / 810 pass と比較し、対象ファイル単独で 4 件増（おそらく最終段階で境界条件ケースを追加した結果）。全体は同数 810 pass で整合。

---

## Findings

### Positive

1. **破壊的変更の完全性**: `grep -rn "\bisStale\b" skills/cmux-team/manager` で **0 件**。部分置換によるビルド破壊の中間状態が残っていない（plan.md §7.1 の方針を忠実に遵守）。
2. **軸の割り当て妥当性**: plan §2 の分類表通り、5h 専用として列挙された 4 箇所（daemon.ts L2515, daemon.ts L3333, proxy.ts L193, dashboard.tsx L1092）がすべて `isStale5h` を参照。`rate-limit-display.ts` はバー単位で軸別に `isStale5h` / `isStale7d` を使い分け、`main.ts:486` は両軸併記（`stale5h=<bool> stale7d=<bool>`）。plan §3.3 / §3.4 と完全一致。
3. **テスト品質（境界条件カバー）**:
   - 5h 過去 / 7d 未来 — persistence（T281 リグレッション）＋ display（2 件：通常 + rate_limited 併用）でカバー
   - 5h 未来 / 7d 過去 — display（2 件）でカバー、`isStale5h=false` / `isStale7d=true` の直交性も担保
   - 両方 null — `rl=null` / `rl=undefined` / `unified5hReset=null` / `unified7dReset=null` の 4 ケースで網羅
   - 両方 過去 — `unified5hReset 過去` + `unified7dReset 過去` の個別テストで独立にカバー。既存 display テスト `L70-77`（両軸 stale → 全 GRAY + `(stale)`）で結合動作も担保
   - 両方 未来 — `unified5hReset 未来（7d が過去でも影響しない）` / `unified7dReset 未来（5h が過去でも影響しない）` で個別にカバー
   - 解釈不能な reset 文字列 — 両軸でカバー
   - unifiedStatus 不干渉 — `isStale5h` 側で明示的にテスト
4. **docstring の記述精度**: `rate-limit-persistence.ts` の `isStale5h` / `isStale7d` docstring に「軸独立 / T281」と「assignment ガードは 5h のみ、7d は観測のみ」を明記。plan.md §7.5 の仕様明示方針を実装に落とし込んでいる。
5. **`rate-limit-display.ts` のコメント品質**: T281 の意図（`forceRed` は 5h 由来 / `(stale)` は両軸 stale のみ）を 4 行コメントで明記し、将来の読み手が軸別設計の根拠を追える。
6. **ログフォーマット破壊的変更の合理性**: `main.ts:486` の `stale=<bool>` → `stale5h=<bool> stale7d=<bool>` は情報量増。impl-report §「plan.md からの逸脱」で `rg -n 'rate_limit_restored' README* docs/` 空を確認済み（plan.md §7.4 / review-v1 R2 準拠）。

### Negative

なし（致命的な問題は検出されず）。

---

## 軽微な懸念（NOGO 要因ではない）

### C1. `package-lock.json` の差分

`package-lock.json` に v4.0.0 → v4.1.0 のバージョン差分が含まれている。これは最新コミット `033c748 chore: release v4.1.0`（main ブランチ）に連動した副次的な差分であり、T281 の実装とは無関係。`npm install` 等が worktree 内で実行された結果とみられる。

- コミット時には含めるかどうかを Conductor が判断する（本筋と無関係なので別コミット or 除外が望ましいが、release 直後の worktree なので含めても害はない）
- 検品としては **無視可能**。影響範囲 0。

### C2. plan.md の「[x]」チェックマークが README 記載時点で既に付いている

`plan.md` §8 の受け入れ条件リストに既に `[x]` が入った状態で保存されているが、これは Planner が見込みでマークしたものか、Implementer が後から更新したものか不明。impl-report §「plan.md からの逸脱」には「なし」と明記されており、内容面の逸脱はない。ドキュメント運用の些細な点。

---

## Recommendations（任意）

実装への追加変更は不要。以降の運用で役立つ観点のみ。

### Rec1. E2E 手動検証（plan.md §8.4）

plan.md §8.4 の「`.team/rate-limit.json` に 5h 過去 / 7d 未来を仕込み、`cmux-team start` → dashboard で `⏸ THROTTLED` が消えることを目視確認」は、worktree 内でテストしていない（impl-report §「未検証」）。本番マージ後に一度だけ手動で仕込んで挙動確認すると安心。ユニットテストで担保されているため必須ではない。

### Rec2. `isStale7d` の将来利用

現状 `isStale7d` は `main.ts:486` の起動時ログと `rate-limit-display.ts` の 7d バーのみで使用。docstring に「7d throttle ガードは未実装」と明記されており、将来 7d assignment ガードを入れる際の拡張ポイントが準備されている。本タスクの責務外だが、後続タスクで 7d スロットリングを導入する場合は `isStale7d` を流用すればよい。

### Rec3. コミット戦略

impl-report §「コミット戦略」通り、**単一コミット**で完結させる（部分 push ではビルドが壊れる中間状態を作る）。コミットメッセージには破壊的変更（`isStale` export 削除、`rate_limit_restored` ログフォーマット変更）を明記することを推奨。

---

## 検証した観点サマリ

| 観点 | 結果 |
|---|---|
| plan.md 遵守（関数シグネチャ・命名・変更対象ファイル） | ✓ plan §9 パッチイメージと完全一致 |
| 受け入れ条件 4 項目 | ✓ 全達成 |
| 呼び出し箇所の網羅（破壊的変更の完全性） | ✓ `\bisStale\b` で 0 件 |
| 軸の割り当て妥当性（5h 専用 4 箇所） | ✓ daemon L2515/L3333, proxy L193, dashboard L1092 全て `isStale5h` |
| テスト品質（境界条件カバー） | ✓ 5h/7d × 過去/未来/null/解釈不能 を網羅 |
| 該当テスト単独実行 | ✓ 34 pass / 0 fail |
| 全体テスト（リグレッション） | ✓ 810 pass / 0 fail、flaky 観測なし |
| ログフォーマット変更の影響範囲評価 | ✓ 外部パーサー不在を grep 確認済み |
| スコープ遵守 | ✓ plan §10 のスコープ外項目に手を出していない |
| コード品質（重複・デッドコード） | ✓ `isFuture` 共用、デッドコードなし |
