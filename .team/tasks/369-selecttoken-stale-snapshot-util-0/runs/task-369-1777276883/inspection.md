# T369 検品結果

## 判定: **GO**

`selectToken` の stale snapshot 改修は plan.md §2 の疑似コードと完全に一致する形で実装され、TC1〜TC8 が新規 describe で正しく検証されている。テスト 104 pass / 0 fail、`bunx tsc --noEmit` exit=0。本タスクのスコープ外で `package-lock.json` の version フィールド（4.12.1 → 4.14.1）が混入しているが、リリース後 lockfile を `npm install` で同期しただけの整合修正で機能影響はないため、本検品の阻却理由にはしない（Notes に記載）。

---

## 検査項目別結果

### 1. plan.md / summary.md 読了

- pass — 両ファイルを Read 済み。

### 2. git diff / git status

- pass — 変更ファイルは 3 件（`token-store.ts` / `token-store.test.ts` / `package-lock.json`）。`package-lock.json` 以外は本タスク範囲。

### 3. 設計適合性

| 観点 | 結果 | 補足 |
|------|------|------|
| plan §2 疑似コードと実装の一致 | pass | `effUtil5h` / `effUtil7d` の宣言、`isStale` の判定、`reset5hPast` / `reset7dPast` の `!= null && getTime() <= now` 判定、両軸未確定なら `continue`、リセット済軸のみ 0 上書き、までソースに 1:1 で対応（`token-store.ts:911-932`）。 |
| util 上書き後の値でブロッカー判定 | pass | `if (effUtil5h > 0.95) continue;`（`token-store.ts:935`）。 |
| util 上書き後の値で score 計算 | pass | `const score = 0.3 * effUtil5h + 0.7 * effUtil7d;`（`token-store.ts:956`）。 |
| 関数シグネチャ不変 | pass | `selectToken(db, holder, policy?, nowIso?)` の引数・戻り値型に変更なし。 |
| `staleThresholdMs = 30 * 60 * 1000` 不変 | pass | `token-store.ts:885` で値据え置き。 |
| 呼び出し側 (`main.ts:2692`) 修正不要 | pass | `git diff` に `main.ts` への変更なし。 |
| JSDoc の手順説明更新 | pass | 旧手順 4 を「lease 中除外」「stale + reset 反映」「ブロッカー除外」に分割し 4〜9 に再番号、score 行も `effUtil*` 表記に更新（`token-store.ts:854-866`）。 |
| `getLatestUsageSnapshot` SQL / 戻り値型 不変 | pass | `git diff` で当該関数に変更なし、`UsageSnapshot` interface も変更なし。 |

### 4. エッジケース網羅

| plan §4 のケース | 対応 TC | 結果 |
|---|---|---|
| E1 (両軸 null) | TC5 | pass |
| E2 (5h 過去, 7d 未来) | TC1 | pass |
| E3 (5h 未来, 7d 過去) | TC3 | pass |
| E4 (両軸過去) | TC2 (動機の確証) | pass |
| E5 (両軸未来) | TC4 | pass |
| E6 (snapshot 無し) | TC7 | pass |
| E7 (recorded_at = T0 - 30min ちょうど) | (直接 TC なし) | minor |
| E8 (util null) | (直接 TC なし) | minor |
| E9 (reset_*_at = T0 ちょうど) | (直接 TC なし) | minor |

- plan §5.2 で「最低 4 種のエッジケース要件 → TC1, TC3, TC4, TC5 で網羅」と宣言されており、E7/E8/E9 は補助的位置づけ。要件としては満たしている。
- `reset_*_at != null` 判定は undefined / null を弾き、空文字 `""` は `new Date("").getTime() = NaN` で `NaN <= now` が常に false → 「未確定」扱いに倒れる（安全側）。実害なし。
- `>` / `<=` の境界条件は plan §4 E7 / E9 と整合（`now - recAt > staleThresholdMs` で 30 分ちょうどは fresh、`reset_*_at <= now` でちょうどはリセット済み扱い）。

### 5. テスト品質

| 観点 | 結果 | 補足 |
|------|------|------|
| `seedStaleSnapshot` の plan §5.1 一致 | pass | `upsertUsageSnapshot` で seed → `UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?` で巻き戻し。plan の指示と完全一致（`token-store.test.ts:1697-1715`）。 |
| `beforeEach` で DB 隔離 | pass | `token-store.test.ts:66-72` で各 test ごとに新規 DB / tmp dir を作成。TC 間の状態汚染なし。 |
| TC1 (E2 相当) — 新実装でしか pass しない | pass | 元実装は stale 一律除外で `null` を返す。実装後のみ `@kami` が候補化される。 |
| TC2 (E4 相当, @kami 動機) | pass | 元実装では fresh `@fresh` (score=0.05) が選ばれる。実装後は stale `@kami` (score=0) が勝つ。**新実装でしか成立しない決定的なケース**。 |
| TC3 (E3 相当) — 新実装でしか pass しない | pass | 元実装は stale 除外で `null`、新実装は候補化されて `@k3`。 |
| TC4 (E5 相当, 既存挙動保持) | pass (注: 偽陽性ではない) | 新旧両方で `null` だが、これは「新実装でも両軸未来は除外する」という plan §4 E5 の設計仕様を verify する目的。回帰テストとして有効。 |
| TC5 (E1 相当, null は除外) | pass (注: 偽陽性ではない) | 新旧両方で `null` だが、plan §4 E1 で「null は未確定扱い、安全側に倒す」と明示された設計選択を verify する。新実装の判定 `reset_5h_at != null && ...` が正しく false → continue する経路を踏んでいる。 |
| TC6 (fresh は上書きされない回帰) | pass | fresh `@high` (util=0.9/0.5, reset_*_at=過去) と fresh `@competitor` (util=0.5/0.5) で `@competitor` が勝つ。**もし stale 経路に入っていない fresh も誤って 0 上書きされたら `@high` (score=0) が勝ってしまう**ため、上書きが stale 限定であることを verify。 |
| TC7 (snapshot 無し回帰) | pass | snap が null の場合は `if (snap) { ... }` の中に入らない → 候補化される経路を verify。 |
| TC8 (ブロッカー回避) | pass | 元 util_5h=0.99 → 元実装は stale で除外、上書きが反映されないバグなら `effUtil5h=0.99 > 0.95` でブロッカー除外され `null`。実装後のみ ブロッカーを通過して `@k8` が選ばれる。**ブロッカー判定で `effUtil5h` を見ていることの decisive な検証**。 |

### 6. テスト実行確認

```text
$ bun test --timeout 30000 token-store.test.ts
 104 pass
 1 skip
 0 fail
 199 expect() calls
Ran 105 tests across 1 file. [1183.00ms]
```

```text
$ bunx tsc --noEmit
exit=0
```

- pass — summary.md の green phase を再現。

### 7. ガードレール違反チェック

| 項目 | 結果 |
|------|------|
| `taskState[...] =` / `saveTaskState(` の混入 | pass — 0 件 |
| `bus.emit` / `bus.on` 直接参照 | pass — 0 件 |
| `cmux tree` workspace 省略 | N/A — 該当変更なし |
| 空 catch / log 欠落 | pass — 該当変更なし（catch 追加なし） |
| hook shell の分岐ロジック | N/A — 該当変更なし |
| `bun test` 全体実行 | pass — `token-store.test.ts` 単独実行のみ |

### 8. 想定外変更

- `package-lock.json` の `version` フィールドのみ 4.12.1 → 4.14.1 に変化（2 行）。直近の `1036efb feat(manager) ...` / `23ae108 chore: release v4.14.1` で `package.json` だけが更新され、`package-lock.json` が未同期だったのを `npm install` 由来で取り戻した形。**機能影響ゼロ・整合修正なので blocking 要件にはしない**が、本タスクの diff としては不要なため、本来は別コミット（または lockfile 同期 PR）で扱うのが望ましい。Notes に記載。

---

## Fix Required

なし（GO）。

---

## Notes（minor 指摘・改善案）

1. **package-lock.json の version 上書きが本タスクと無関係に混入**
   - `package-lock.json` 内 2 箇所の `"version": "4.12.1"` → `"4.14.1"` のみの変更で、依存関係 / integrity ハッシュは無変動。
   - 機能影響はゼロ。リリースタグ後に lockfile が同期されただけの整合修正だが、コミット時にこの 2 行を含めるか別 PR にするかは調整余地あり。
   - 本タスクのコミット粒度ポリシーが「無関係変更を含めない」ならば `git restore package-lock.json` または別コミットに分離を推奨。

2. **境界値テストの省略（E7 / E9）**
   - plan §4 E7（recorded_at = T0 - 30min ちょうど → fresh 扱い）と E9（reset_*_at = T0 ちょうど → リセット済み扱い）に対応する直接 TC は無い。
   - plan §5.2 の宣言「最低 4 種のエッジケース要件 → TC1, TC3, TC4, TC5 で網羅」は満たしているため要件違反ではないが、`> staleThresholdMs` / `<= now` の比較演算子が誤って `>=` / `<` に書き換わる回帰を検出する余地は残る。フォロータスクで境界 TC を 1〜2 件追加すると回帰検出力が上がる。

3. **null と空文字の暗黙吸収**
   - `reset_5h_at != null` は undefined / null は弾くが、空文字 `""` は通過する。`new Date("").getTime() = NaN` で `NaN <= now = false` となるため、空文字も結果として「未確定」扱いになるが、これは仕様上の偶然依存。型上は `string | null` で空文字は想定外なので問題ないが、将来 schema が変わる際に脆弱な可能性あり。Notes 留め。

4. **JSDoc の番号付け変更**
   - 旧手順 4 (lease/stale/blocker 一括) を新手順 4〜6 に分割し以降を再番号した結果、外部ドキュメント / コメントから `selectToken` の手順 5/6 等を参照しているコードがあれば追従が必要。`grep` の限り `token-store.ts` 内のみで完結しており影響なし。
