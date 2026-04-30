# T393 Inspection Report

## 判定: GO

plan 2.1 の「`initTokenDB` 側で migration block を OFF/ON で囲む」案が忠実に実装されており、SQLite 12-step procedure の制約（PRAGMA はトランザクション外で発行）も守られている。テスト fixture の child row INSERT 追加は plan の意図（真の regression test 化）から見て正当な逸脱で、これがないと bug を再現できないため必要不可欠な補強。Critical / Major いずれも 0 件。

## 完了条件の充足

| 項目 | 状態 | 備考 |
|------|------|------|
| token-store.test.ts green | ✅ | 154 pass / 1 skip / 0 fail / 308 expect (1.62s) |
| fixture `REFERENCES tokens(id)` 追加 | ✅ | test L2656, L2661 に確認 |
| fixture child row INSERT 追加 | ✅ | test L2676-2679 (`usage_snapshots`/`leases` 各 1 件) |
| `PRAGMA foreign_key_check` 空配列 assert | ✅ | test L2708-2709 |
| `PRAGMA foreign_keys=1` assert | ✅ | test L2712-2713 |
| tsc 新規エラー 0 件 | ✅ | `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` exit=0 |
| 隣接テスト green 維持 | ✅ | pool-throttle (31 pass), daemon (177 pass) を独立確認。summary 記載の他 8 ファイルも green 報告 |

## 設計判断の妥当性

| 観点 | 判定 | 詳細 |
|------|------|------|
| plan 2.1 「`initTokenDB` 側で migration block を OFF/ON 区間で囲む」 | ✅ | token-store.ts:258-276 で実装。`needsT391=true` のときのみ OFF/ON 切替 |
| `PRAGMA foreign_keys=OFF` がトランザクション外（migration 関数の `BEGIN` より前）で発行 | ✅ | L260 で発行 → L264 `migrateTokensSchemaT391` 内で `BEGIN`。順序正しい |
| `PRAGMA foreign_key_check` がトランザクション外（migration 関数の `COMMIT` 後）で発行 | ✅ | L267 で発行。migration 関数の return 後 |
| `PRAGMA foreign_keys=ON` が `initTokenDB` 出口で発行されるか | ⚠ 部分的 | 正常 path では L276 で発行。**throw 経路では発行されない**（後述 Minor 参照） |
| 冪等条件の整合性（`needsTokensSchemaT391Migration` ⇔ migration 関数冒頭） | ✅ | 両者とも `notnull===0` の AND 条件で完全一致。docstring に「同じ条件であること」と明記 |

## plan からの逸脱判定

summary に記載の「fixture に child row INSERT を追加」は **正当な判断**。

- 理由: plan 3.A の注（「`@kept` row 単独でよい」と読める書きぶり）に従うと、child table が空のままでは FK enforcement 下でも `DROP TABLE tokens` が成功してしまい、本来再現すべき bug を test で再現できない。
- 結果: Step A 後の「赤テスト」が plan 期待通り `FOREIGN KEY constraint failed` で fail し、Step B 後 green に戻る完全な TDD サイクルが成立。
- スコープ拡大ではなく、TDD 精神に沿った plan 補完。コード本体の signature・ロジックは無改変で plan 2.2 を厳守。

## 副作用・破壊リスク

| 観点 | 判定 |
|------|------|
| `initTokenDB` 出口契約変更（FK が ON で返る） | ✅ 維持。既存 callers の前提を壊していない |
| 新 DB 起動 path で OFF 切替が走らないこと | ✅ `needsT391=false` で skip。新 DB は default OFF → 最終 ON への 1 回切替のみ |
| WAL モード切替との順序関係 | ✅ WAL は database-scope、FK は connection-scope で独立。`journal_mode=WAL` を最初に発行する順序は問題なし |
| 範囲外ファイル汚染 | ✅ `git diff HEAD --stat` で `token-store.ts` (+50/-3) / `token-store.test.ts` (+16/-3) のみ。assigned タスクファイル / artifact / prompt への波及なし |

## テストの真の regression test 化

| 観点 | 判定 |
|------|------|
| Step A 後（fixture 修正のみ・コード未修正）に赤くなる構造か | ✅ child row INSERT が入ったので、`migrateTokensSchemaT391` が `foreign_keys=OFF` を立てない仮想状態では `DROP TABLE tokens` が `FOREIGN KEY constraint failed` で fail する。bug の再現性を担保 |
| `foreign_key_check` assertion の信頼性 | ✅ migration 後の `tokens` 再生成で id を保持できていれば child rows の FK は通る → 空配列。再生成順序や id renumber に regression が出れば必ず検知 |
| `foreign_keys=1` assertion | ✅ `initTokenDB` の出口契約を直接担保。FK ON の回し忘れを直接検知 |

## CLAUDE.md ガードレール準拠

| 観点 | 判定 |
|------|------|
| `bun test` 全体実行禁忌 | ✅ summary は単独ファイル指定で網羅。inspector も同様に単独実行 |
| 空 `catch {}` | ✅ 新規追加なし |
| `task-state` / `EventBus` 影響 | ✅ token-store のみ。範囲外 |
| `.team/artifacts/` 直接書込み | ✅ なし |
| main ブランチ直接操作 | ✅ worktree 内のみ |

## Findings

### Critical（NOGO 要因）
なし

### Major（GO 後の追加修正推奨）
なし

### Minor（任意改善）

1. **throw 経路で `PRAGMA foreign_keys=ON` が発行されない** — `migrateTokensSchemaT391` 内の例外、または `foreign_key_check` violation 検出時の throw が起きると、`initTokenDB` の最終 L276 `PRAGMA foreign_keys=ON;` に到達しない。ただし throw 時は caller (`createTokenStore`) が `db` を受け取らず close される設計のため、connection-scope の FK 状態は次回の `initTokenDB` 呼び出しに引き継がれない。**実害なし**。plan R6 でも「自動修復しない方針」として既知。`try/finally` で ON 復帰を保証する余地はあるが、本タスクスコープ外。

2. **`migrateClaudeCredentialsToSubscription` も FK OFF context 内で動く** — 現実装では `migrateTokensSchemaT391` と並びの位置で呼ばれるため `foreign_keys=OFF` 状態下で実行される。本関数は `UPDATE` のみで `DROP TABLE` は伴わないため OFF context 不要だが、害もない。plan 2.1 の「将来 migration が複数走った場合も同じ FK-OFF context で完走させたい」方針通り。観点上の問題なし。

3. **冪等条件の二重定義** — plan R1 で許容済み。`needsTokensSchemaT391Migration` と `migrateTokensSchemaT391` 冒頭で同じ式を 2 箇所に持っている。docstring で「同じ条件であること」を明記しており、緩和策も記述済み。NOGO 要因ではない。

## 検証ログ

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
[token-store] T391 migrated 1 row(s): claude-credentials → subscription
[token-store] T391 migration: relaxing NOT NULL on tokens.organization_id / auth_hash
 154 pass / 1 skip / 0 fail / 308 expect() calls (1.62s)

$ bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
exit=0  (新規エラー 0 件)

$ bun test --timeout 30000 pool-throttle.test.ts
 31 pass / 0 fail / 41 expect() calls (174ms)

$ bun test --timeout 30000 daemon.test.ts
 177 pass / 0 fail / 631 expect() calls (24.28s)
   ※ migration が実際に走るログ出力ありだが pass

$ git diff HEAD --stat
 skills/cmux-team/manager/token-store.test.ts | 19 +++++++++--
 skills/cmux-team/manager/token-store.ts      | 50 +++++++++++++++++++++++++++-
 2 files changed, 66 insertions(+), 3 deletions(-)
```

diff の概観:

- `token-store.ts`: `initTokenDB` の PRAGMA 順序再構成（FK ON を migration 後に移動 + needsT391 ガード付きで OFF/foreign_key_check を発行）。`needsTokensSchemaT391Migration` 新設。`migrateTokensSchemaT391` の docstring に呼出側責務を追記。
- `token-store.test.ts`: 旧 schema fixture に `REFERENCES tokens(id)` / 本番 index / child row INSERT を追加。assertion 2 件（`foreign_key_check` 空配列 / `foreign_keys=1`）追加。

plan の意図と実装の整合は完全。Critical 0 件・Major 0 件で **GO 判定**。
