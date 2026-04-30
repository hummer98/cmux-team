---
id: 393
title: tokens.db の T391 schema migration が FK 違反で失敗する根本修正（テスト fixture が本番 schema と乖離していた）
priority: high
created_by: surface:483
created_at: 2026-04-30T10:53:05.056Z
---

## タスク
## 背景

`token-store.ts:268-313` の `migrateTokensSchemaT391` が `PRAGMA foreign_keys=ON` 状態で `DROP TABLE tokens` を実行しており、`usage_snapshots.token_id REFERENCES tokens(id)` および `leases.token_id REFERENCES tokens(id)` の FK 制約に違反して必ず失敗する。

ユーザー環境（~/.cmux-team/tokens.db）では実際に以下のエラーが出続けている:

```
[2026-04-30T19:41:16] error initTokenDB failed: FOREIGN KEY constraint failed
[2026-04-30T19:41:16] warn [POOL_DISABLED] tokens.db init failed; pool ON config but running as pool OFF: FOREIGN KEY constraint failed
```

その結果、token pool が config ON のまま実体は OFF にフォールバックしており、4 アカウント分散 / pool-throttle / proxy auto-rotate / @tayo の `claude-credentials → subscription` データ migration がすべて停止している（catch で握りつぶされてクラッシュはしない）。

## なぜ CI を通ってしまったか（テスト戦略の bug）

`token-store.test.ts:2635-2702` の migration テストが、旧 schema fixture を手書きで再現する際に `REFERENCES tokens(id)` 句を落としていた:

**Production (`token-store.ts:200-219`)**:
```sql
CREATE TABLE IF NOT EXISTS usage_snapshots (
  ...
  token_id INTEGER NOT NULL UNIQUE REFERENCES tokens(id),  -- FK あり
  ...
);
CREATE TABLE IF NOT EXISTS leases (
  token_id INTEGER NOT NULL UNIQUE REFERENCES tokens(id),  -- FK あり
  ...
);
```

**Test fixture (`token-store.test.ts:2654-2667`)**:
```sql
CREATE TABLE usage_snapshots (
  ...
  token_id INTEGER NOT NULL UNIQUE,       -- REFERENCES なし
  ...
);
CREATE TABLE leases (
  token_id INTEGER NOT NULL UNIQUE,       -- REFERENCES なし
  ...
);
```

このため `DROP TABLE tokens` がテスト上では FK に当たらず素通りし、migration 成功と判定されていた。Production schema を読み込む実環境でのみ落ちる構造。

## 修正スコープ

### 1. Migration ロジックの再設計（SQLite 12-step procedure 準拠）

`migrateTokensSchemaT391` を SQLite 公式の table re-create プロトコルに合わせる:

1. `PRAGMA foreign_keys=OFF`（トランザクション外）
2. `BEGIN`
3. CREATE new → INSERT → DROP old → RENAME
4. `PRAGMA foreign_key_check` で違反 0 件を assertion
5. `COMMIT`
6. `PRAGMA foreign_keys=ON`（トランザクション外）

**注意点:**
- `PRAGMA foreign_keys` はトランザクション中に変更不可。`initTokenDB` 側で migration 前後の境界を制御する必要がある
- 現在 `initTokenDB` は冒頭で `PRAGMA foreign_keys=ON` を立てている。これを「migration 完了後に ON する」順序に変更
- migration が複数走る将来も想定し、`migrateTokensSchemaT391` だけでなく `migrateClaudeCredentialsToSubscription` も同じ context で完走させる

### 2. テスト fixture を本番 schema と一致させる

`token-store.test.ts:2640-2672` の旧 schema fixture に、本番と同じ `REFERENCES tokens(id)` を追加する。これにより現状の migration はテストでも赤くなり、修正後にテストが green に戻る = 真の regression test 化する。

加えて、テスト内でも `PRAGMA foreign_key_check` を実行して violation がない assertion を入れる。

### 3. 既存環境のデータ migration 完走確認

ユーザー環境の DB (`~/.cmux-team/tokens.db`) では:
- `tokens` table が旧 NOT NULL schema のまま（`organization_id NOT NULL` / `auth_hash NOT NULL`）
- @tayo row が `credential_source='claude-credentials'` のまま残存

修正後 daemon を再起動した際、両方が完走することを確認する（schema migration → データ migration の順）。@tayo は `subscription` に変換され `auth_hash=NULL` になる。

### 4. （オプション）migration version table の検討

現状は「毎回起動時に schema を見て条件分岐」する冪等性に依存している。長期的には `schema_migrations` table で applied 履歴を持つほうが堅牢だが、今回のスコープには含めず、retro で議論するに留める（タスク化はしない）。

## 完了条件

- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` が green
- [ ] テスト fixture に `REFERENCES tokens(id)` を追加した状態で migration が成功する（旧 schema → 新 schema 変換 + データ migration 両方）
- [ ] テスト内で `PRAGMA foreign_key_check` の結果が空配列であることを assert
- [ ] 修正後の daemon を起動して manager.log に `initTokenDB failed` / `[POOL_DISABLED]` が出ないことを確認
- [ ] 修正後の daemon 起動で @tayo row が `credential_source=subscription` / `auth_hash=NULL` に変換される
- [ ] `cmux-team token list` で 4 アカウント全てが正常表示される

## 関連

- T391: claude-credentials → subscription 移行（このタスクの migration を導入した親タスク）
- T384: proxy auto-rotate（tokens.db が機能していないと連動して停止）
- T367: pool-throttle（同上）

## やらないこと（スコープ外）

- migration version table の導入（retro 案件）
- rate-limit.json の rename ENOENT エラー（別タスクで切る）
- token pool の設計見直し全般
