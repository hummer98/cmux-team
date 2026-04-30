---
task: T318
reviewer: surface:89 (design-reviewer)
target: plan.md
created: 2026-04-25
---

# Design Review: T318 plan.md

## 総合判定

**APPROVED**

plan.md は A019 / A020 / task.md の要求を過不足なく実装計画に落とし込んでおり、かつ構造的正しさ原則に従って task.md より優れた atomic 設計（`UNIQUE(token_id) + INSERT OR IGNORE`）を採用している。A019 検証表との数値不整合も検出・Master 報告が予約されている。Implementer は plan.md に従って TDD で実装してよい。

## 観点別判定

| # | 観点 | 判定 | 一行コメント |
|---|------|------|-------------|
| 1 | スキーマ適合性 | OK | A019 DDL と完全一致。`UNIQUE(token_id)` 追加（usage_snapshots / leases）は UPSERT/atomic のための合理的上書き |
| 2 | CRUD API 完全性 | OK | task.md / A019 要求関数すべて網羅。命名は `storeToken` → `storeTokenInKeychain` へ明確化されており意味保存 |
| 3 | 既存パターンとの整合 | OK | `bun:sqlite`・WAL・`PRAGMA foreign_keys=ON`・`PRAGMA table_info` ベース migration すべて trace-store.ts / gh-cache-store.ts に一致 |
| 4 | 並行性・安全性 | OK | `INSERT OR IGNORE` で atomic、前置 DELETE の意図も明示。shell injection / token ログ漏れ対策も §7.3 で触れられている |
| 5 | pool_capacity 計算正確性 | OK | reference `20.0/168`・null/過去 reset ガード・clamp・plan_ratio null 除外すべて明示。A019 表不整合も検出済 |
| 6 | テスト計画 | OK | 0600 検証・6 ケース capacity・並行 race 再現・KEYCHAIN_TEST_MODE の in-memory fallback・env override いずれも網羅 |
| 7 | TDD 手順の妥当性 | OK | migration → CRUD → lease → keychain → capacity の依存順が論理的、各ステップが小さい |
| 8 | スコープ逸脱の有無 | OK | 新規 2 ファイルのみ、既存変更なし。CLI/proxy/spawn-agent は後続タスクに明確分離 |
| 9 | その他の懸念 | OK | 設計上の論点 11 件を付録で結論出し、後続タスクの named export も §11 に列挙 |

## 必須修正事項

なし（APPROVED）。

## 推奨改善事項（任意 — Implementer 判断でよい）

以下はいずれも plan.md の判断を覆すものではなく、実装時に軽く配慮すれば品質が上がる程度の提案。

### R1. `KEYCHAIN_TEST_MODE=1` 時の `isKeychainSupported()` の整合性

`§7.2` では `KEYCHAIN_TEST_MODE=1` のとき:
- `isKeychainSupported()` は `false` を返す
- 同時に `storeTokenInKeychain` / `retrieveTokenFromKeychain` / `deleteTokenFromKeychain` は in-memory Map で動作する

この二重状態は呼び出し側から見ると「keychain 機能は OFF（pool 全体 OFF）」と「keychain 関数は動く」が同時成立していて混乱を招く。

**候補案**:
- (a) `isKeychainSupported()` を test-mode でも `true` を返し、`useInMemory()` が別フラグで backing 層だけを切り替える（pool 機能の spawn-agent 側テストがしやすい）
- (b) 現状のまま「テストは keychain 関数の自己完結テストだけ行い、pool 統合は別 test double を後続タスクで用意」と割り切る

現 plan は (b) 相当。どちらでも実装可能なので Implementer 裁量で十分。

### R2. not-found 専用エラー型の追加

`retrieveTokenFromKeychain` は「handle が Keychain に存在しない」状態を `new Error("token not found for handle=...")` で投げる（§7.4）。KeychainCommandError とは別にこのケースを識別するため、呼び出し側は `err.message` を文字列マッチする必要がある。

`KeychainNotFoundError` を追加すれば `try { ... } catch (e) { if (e instanceof KeychainNotFoundError) ... }` で判別でき、spawn-agent 側の「未登録の token は auto-discover に回す」判断が書きやすくなる。

### R3. `KeychainCommandError` の stdout/stderr に token が混入しない保証

`§7.3 storeTokenInKeychain` で `-w` 無指定 + stdin 方式（試行 A）が動けば security コマンドの stdout/stderr に token は出ないが、試行 B（`-w <token>` args 渡し）にフォールバックした場合、security のエラー時 stderr が argv を echo する可能性がある（macOS の `security` ツールは通常 argv を stderr に出さないが未検証）。

実装時に次を入れると堅牢:
- `KeychainCommandError` に詰める前に `stderr.replace(token_string, "***")` 相当のマスクを適用
- そもそも `storeTokenInKeychain` 内の try/catch で捕まえたエラーに token を含めないガード

`§7.3 補足` で「log に出さない」とは書かれているが、Error オブジェクトに含めると呼び出し側の log フォーマッタが出してしまうため、型レベルでガードしておくと安心。

### R4. A019 検証表の数値不整合の扱い（既に plan 内で処理済、記録のため書く）

§8.3 で plan が検出した通り、A019 §pool_capacity 検証表のケース 1/3/4（672% / 336% / 112%）は `min(flow_5h, flow_7d)` 式で再計算すると一致しない（ケース 1 は 100% が正）。plan は「**実装は式を正**・テスト期待値を式で再計算・Implementer が実装後に Master 報告」と明示しており、これで十分。

Master への報告事項として plan.md の付録に書かれている通り、最終的に:
- **A** 式が正 → A019 表を修正（ケース 1: 100% / 3: ~50% / 4: ~50%）
- **B** 表が正 → 式を「5h 余裕あり時は min を取らない」等に変更

の二択を Master が決める。Implementer は **まず案 A（式を正）で実装** → テスト pass 後に Master に再確認。

### R5. `leases` の PK と UNIQUE の冗長性（plan 内でも認識済）

`PRIMARY KEY (token_id, holder)` + `UNIQUE(token_id)` は、UNIQUE のほうが強いため複合 PK が実質冗長。plan §6.3 末尾で「同じ holder が同じ token を何度も取らない意図の冗長な保険」と説明があり意図的。このままでも害はないが、**`PRIMARY KEY (token_id)` だけに簡略化**しても同じ atomic 性が得られる（構造的正しさの観点でさらにシンプル）。Implementer 裁量。

## Approved 確認

plan.md は実装に進める状態である。Implementer は plan.md に従って TDD で実装してよい。

特に評価すべき点:

1. **構造的正しさ原則の体現**: task.md が `BEGIN IMMEDIATE` と指定しているにもかかわらず、`UNIQUE(token_id) + INSERT OR IGNORE` で**スキーマ層にドメイン不変条件を表現**する選択をしており、CLAUDE.md の「必要な抽象化は積極的に導入し、構造でバグを絶つ」原則に合致している。

2. **既存パターンの確実な踏襲**: trace-store.ts / gh-cache-store.ts を読み込んだ上で、schema_version テーブル不採用・`PRAGMA table_info` ベース migration・`bun:sqlite` 固定・WAL+FK pragma をすべて一致させている。

3. **設計論点のプレコミット**: §付録で 11 件の論点すべてに結論が書かれており、Implementer が迷って戻ってくる箇所がほぼない。

4. **A019 との不整合を握りつぶさない**: 検証表の数値が式と合わないことを検出し、**plan 内で「実装は式を正として進める / Master に後で確認」と明示**している。これは CLAUDE.md の「判断に迷ったらユーザーに聞く」に合致する安全な判断の委譲。

5. **スコープの厳守**: 新規 2 ファイル（`token-store.ts` / `token-store.test.ts`）のみ、既存ファイル変更なし。後続タスク（CLI / proxy UPSERT / spawn-agent / TUI）が利用する named export を §11 で明示列挙しており、次のタスク作成時にブレない。
