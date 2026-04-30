# T393 実装計画書: tokens.db T391 schema migration の FK 違反修正 + テスト fixture の本番一致

## 1. 概要

### 目的

`skills/cmux-team/manager/token-store.ts` の `migrateTokensSchemaT391` (line 268-313) が
`PRAGMA foreign_keys=ON` 状態で `DROP TABLE tokens` を実行し、`usage_snapshots.token_id` /
`leases.token_id` の `REFERENCES tokens(id)` 制約に違反して **必ず例外で落ちる** 状態を解消する。
これにより `~/.cmux-team/tokens.db` の token pool 初期化が成功し、token pool config ON が
実体としても ON で動作するようになる。

副作用として、テスト fixture (`token-store.test.ts:2640-2672`) で旧 schema を作る箇所が
`REFERENCES tokens(id)` を欠いていたため CI が production と乖離し migration バグを
検出できていなかった問題を、本番 schema と完全一致させて regression test 化する。

### 影響範囲

| 種類 | 対象 |
|------|------|
| 修正コード | `skills/cmux-team/manager/token-store.ts` の `initTokenDB` / `migrateTokensSchemaT391` |
| 修正テスト | `skills/cmux-team/manager/token-store.test.ts` の T391 migration test |
| データ | ユーザー環境 `~/.cmux-team/tokens.db`（daemon 再起動で自動 migration 完走） |
| API/型 | 変更なし（migration 関数は private、外部 export は無し） |
| token pool 機能 | 4 アカウント分散・pool-throttle・proxy auto-rotate・@tayo の subscription 化 すべて復活 |

スコープ外: migration version table 導入 / rate-limit.json の rename ENOENT / token pool 設計見直し。

---

## 2. 設計判断

### 2.1 FK 切替の境界をどこに置くか

**結論: `initTokenDB` 側で「migration block 全体を `foreign_keys=OFF` で囲む」方式を採る。**
ただし migration が no-op（既に新 schema）の場合は OFF 切替自体を skip する。

理由:

- SQLite ドキュメントの 12-step procedure は `PRAGMA foreign_keys=OFF` を **トランザクション外で**
  発行することを明示。migration 関数の中で自前 BEGIN しても OFF 切替は effective にならない
  （現行コードはこれを把握していない）。
- 将来 migration が複数走った場合（`migrateTokensSchemaT391` → `migrateClaudeCredentialsToSubscription`、
  および将来追加分）も同じ FK-OFF context で完走させたい。
- 現状 `initTokenDB` 冒頭 (line 246) で `PRAGMA foreign_keys=ON` を立てているため、ここを
  「migration 完了後に ON する」順序に変更する。

新 init 順序:

```
mkdirSync → new Database
db.exec("PRAGMA journal_mode=WAL;")
db.exec(SCHEMA_V1)          // FK PRAGMA はまだ OFF（SQLite default）
ensureTokensColumns
ensureUsageSnapshotsColumns
ensureLeasesColumns
needsMigration = check()    // 旧 schema 検知
if (needsMigration) {
  // FK OFF context で migration を流す
  db.exec("PRAGMA foreign_keys=OFF;")
  migrateTokensSchemaT391(db)
  migrateClaudeCredentialsToSubscription(db)
  // foreign_key_check で violation 0 件を assertion
  const violations = db.prepare("PRAGMA foreign_key_check").all()
  if (violations.length > 0) throw new Error(...)
} else {
  // migration 不要パスでも 2 つの関数は冪等 no-op として走らせる（既存挙動維持）
  migrateTokensSchemaT391(db)
  migrateClaudeCredentialsToSubscription(db)
}
db.exec("PRAGMA foreign_keys=ON;")  // 最終的に必ず ON で返す
```

`needsMigration` は `migrateTokensSchemaT391` 冒頭の冪等条件（`organization_id.notnull===0 && auth_hash.notnull===0`）と同じ判定を切り出して再利用する。

**代替案と却下理由:**

- 案 B: migration 関数の中で `PRAGMA foreign_keys=OFF/ON` を呼ぶ
  → トランザクション外で発行すべき制約があるので、関数 signature が「呼出時に PRAGMA を切ってよい」
  という暗黙仕様を背負う。`initTokenDB` のように事前に ON を立てる callers を破る恐れ。
- 案 C: SCHEMA_V1 を流す前から FK=OFF で走らせ、最後だけ ON
  → 新 DB（migration 不要）でも常に OFF/ON 切替が走り無駄。ただしコードはシンプル。トレードオフ
  だが、現状のケースは旧 DB の migration 救済が主目的なので **必要なときだけ OFF にする** 案を採る。

### 2.2 migration 関数の signature 変更

**結論: signature 変更なし。** 引数は `db: Database` のまま、戻り値も `void` のまま。
FK 切替は呼出側（`initTokenDB`）の責任で行う。

### 2.3 既存 callers への影響

`grep -rn "migrateTokensSchemaT391\|migrateClaudeCredentialsToSubscription"` で確認済み:

```
token-store.ts:254  migrateTokensSchemaT391(db);
token-store.ts:255  migrateClaudeCredentialsToSubscription(db);
token-store.ts:268  function migrateTokensSchemaT391(db: Database): void {
token-store.ts:326  function migrateClaudeCredentialsToSubscription(db: Database): void {
```

`initTokenDB` 以外に呼出元なし。両関数とも file-private。テストからも直接呼んでいない
（`initTokenDB` 経由でのみ起動）。よって `initTokenDB` 内のロジック変更で完結。

### 2.4 冪等条件の維持方法

`migrateTokensSchemaT391` の冒頭 (line 276-277) の判定はそのまま残す:

```typescript
if (!orgCol || !authCol) return;
if (orgCol.notnull === 0 && authCol.notnull === 0) return;
```

`initTokenDB` 側でも同じ判定を `needsMigration` として使う。これにより:

- 新 DB: `SCHEMA_V1` を流した直後は既に notnull=0、`needsMigration=false`、FK 切替なし
- 旧 DB: 1 回目で migration、2 回目以降は notnull=0 になっているので FK 切替なし
- 「壊れた DB（カラム無し）」: 関数冒頭で early return、FK 切替も skip（`needsMigration=false`）

既存テスト `既存に claude-credentials row が無い場合は no-op` 等の冪等系は無改変で
そのまま green を維持。

---

## 3. 実装ステップ（TDD 順序）

### Step A: テスト fixture を本番 schema と一致させる（赤くする）

**目的: 現状のバグをテストでも再現させ、修正後 green に戻ることで真の regression test を作る。**

`skills/cmux-team/manager/token-store.test.ts:2654-2667` を以下のように修正:

```typescript
// before（REFERENCES なし）
CREATE TABLE usage_snapshots (
  ...
  token_id INTEGER NOT NULL UNIQUE,
  ...
);
CREATE TABLE leases (
  token_id INTEGER NOT NULL UNIQUE,
  ...
);

// after（本番と一致）
CREATE TABLE usage_snapshots (
  ...
  token_id INTEGER NOT NULL UNIQUE REFERENCES tokens(id),
  ...
);
CREATE TABLE leases (
  token_id INTEGER NOT NULL UNIQUE REFERENCES tokens(id),
  ...
);
```

加えて、test 内で旧 schema fixture に **本番と同じ index** も並べる（`idx_usage_snapshots_token_time`,
`idx_leases_expires`）。これがあると本番 schema と完全に同等になり、index 周りで予期せぬ
差分が発生したときも検出できる。

**期待結果:** この時点で `bun test --timeout 30000 token-store.test.ts` を流すと、
T391 migration test が `FOREIGN KEY constraint failed` で **赤くなる** ことを確認。
これが本タスクの failing test。

> 注: 旧 schema fixture を修正するだけで、`@kept` row の INSERT 自体には影響しない
> （`organization_id`, `auth_hash` は NOT NULL の元値 `'org-kept-001'` / `'keep0000aaaa'` で揃っている）。

### Step B: production の migration ロジック修正

`skills/cmux-team/manager/token-store.ts` の `initTokenDB` を以下に書き換える。

#### B-1: 冪等条件を取り出して再利用可能にする

`migrateTokensSchemaT391` 冒頭の冪等判定と同等の関数を追加:

```typescript
function needsTokensSchemaT391Migration(db: Database): boolean {
  const cols = db.prepare("PRAGMA table_info(tokens)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const orgCol = cols.find((c) => c.name === "organization_id");
  const authCol = cols.find((c) => c.name === "auth_hash");
  if (!orgCol || !authCol) return false;
  return !(orgCol.notnull === 0 && authCol.notnull === 0);
}
```

`migrateTokensSchemaT391` の冪等判定は **そのまま残す**（関数単独で安全な API を維持。二重防御）。

#### B-2: `initTokenDB` 内の PRAGMA / migration 順序を再構成

before（line 245-256）:

```typescript
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=ON;");      // ← FK ON のまま下の DROP TABLE が走り爆発
db.exec(SCHEMA_V1);

ensureTokensColumns(db);
ensureUsageSnapshotsColumns(db);
ensureLeasesColumns(db);
migrateTokensSchemaT391(db);
migrateClaudeCredentialsToSubscription(db);
```

after:

```typescript
db.exec("PRAGMA journal_mode=WAL;");
// foreign_keys は SQLite default の OFF のまま、SCHEMA_V1 と migration を通す。
// SCHEMA_V1 は IF NOT EXISTS なので新 DB のみ実体作成。既存 DB では no-op。
db.exec(SCHEMA_V1);

ensureTokensColumns(db);
ensureUsageSnapshotsColumns(db);
ensureLeasesColumns(db);

const needsT391 = needsTokensSchemaT391Migration(db);
if (needsT391) {
  // SQLite 12-step procedure: FK は明示的に OFF（既に default OFF だが意図を明示）
  db.exec("PRAGMA foreign_keys=OFF;");
}
migrateTokensSchemaT391(db);
migrateClaudeCredentialsToSubscription(db);
if (needsT391) {
  // foreign_key_check で referential integrity を assertion
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `[token-store] T391 migration left ${violations.length} FK violation(s): ${JSON.stringify(violations)}`,
    );
  }
}
// 通常運用は FK ON で行う（INSERT/UPDATE 時の整合性担保のため）
db.exec("PRAGMA foreign_keys=ON;");
```

**ポイント:**

- `PRAGMA foreign_keys=OFF` はトランザクション外で発行 → migration 関数内の `BEGIN` より前
- `PRAGMA foreign_key_check` は `COMMIT` 後にトランザクション外で発行 → migration 関数の return 後
- 最後の `PRAGMA foreign_keys=ON` も migration 関数のトランザクション外なので effective
- migration 不要パス（新 DB / 2 回目以降）では FK は default の OFF → ON への 1 回切替のみ

> 注: 上の design は現行の `migrateTokensSchemaT391` の `BEGIN/COMMIT` をそのまま温存できる。
> 関数内の BEGIN ブロックは保ったまま、外側の PRAGMA だけを `initTokenDB` で操作する。

#### B-3: 関数コメント更新

`migrateTokensSchemaT391` の docstring に「呼出側で `foreign_keys=OFF` を立てておくこと」を追記。
内部で OFF を発行しない理由（PRAGMA はトランザクション外でしか effective でないこと）も併記。

### Step C: テストに `PRAGMA foreign_key_check` assertion 追加

`token-store.test.ts:2680-2701` の try ブロックに追加:

```typescript
try {
  // 既存 row が維持されていること（既存）
  const tok = getTokenByHandle(db2, "@kept");
  expect(tok).not.toBeNull();
  expect(tok?.credential_source).toBe("manual");

  // schema が NULL 許容になっていること（既存）
  const subTok = insertToken(db2, { ... });
  expect(subTok.organization_id).toBeNull();
  expect(subTok.auth_hash).toBeNull();

  // 追加: FK violation 0 件
  const violations = db2.prepare("PRAGMA foreign_key_check").all();
  expect(violations).toEqual([]);

  // 追加: foreign_keys が ON で返ってきていること（initTokenDB 出口の保証）
  const fk = db2.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(fk.foreign_keys).toBe(1);
} finally {
  db2.close();
}
```

### Step D: その他必要な変更

- なし。`bin/`, `proxy/`, `dashboard/` 等への波及はない。
- `docs/spec/09-token-pool.md` に schema migration の記述があるか確認し、必要なら 1 文追加
  （SQLite 12-step procedure に従う旨）。**ただしスコープが docs に広がるので、本タスクでは
  コードの実装と test の整合のみ取り、docs 同期は別タスク（`/docs-sync`）に委ねる。**
  → 本タスクでは触らない。

---

## 4. 検証手順

### 4.1 テスト

**`bun test` 全体実行は禁忌**（CLAUDE.md 既知の注意点。O(N²) 級劣化）。
token-store.test.ts 単独で流す:

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 token-store.test.ts
```

期待結果:

- Step A 直後（fixture 修正のみ・コード未修正）: T391 migration test が **赤** で 1 件 fail。
  fail メッセージに `FOREIGN KEY constraint failed` を含む。
- Step B 完了後: T391 migration test を含む全テストが **green**。
- Step C 完了後: 追加 assertion も green。violation 0 件、foreign_keys=1 で返ることを確認。

### 4.2 型チェック

```bash
cd skills/cmux-team/manager
bun run typecheck
# もしくは
bunx tsc --noEmit
```

新規エラー 0 件であること。型変更が無い前提なので tsc が赤くなったら設計判断ミスとみなしてやり直す。

### 4.3 隣接テストへの波及確認

token-store.ts を触るので、以下の関連テストも単独で実行:

```bash
cd skills/cmux-team/manager
for f in token-pool.test.ts pool-throttle.test.ts pool-disabled-fallback.test.ts; do
  [ -f "$f" ] && bun test --timeout 30000 "$f"
done
```

これらが green を維持していること。赤くなった場合は migration 順序変更の副作用を疑う。

### 4.4 ユーザー環境への適用（実装側の手順 documenting のみ）

Conductor は worktree 内で動作し本番 DB (`~/.cmux-team/tokens.db`) を直接触らない。
本タスクの完了条件には含まないが、実装後にユーザーが daemon を再起動した際、以下が完走する想定:

1. `migrateTokensSchemaT391`: `tokens` table を新 schema (NOT NULL 緩和) で再作成
2. `migrateClaudeCredentialsToSubscription`: @tayo row が `subscription` / `auth_hash=NULL` に変換
3. manager.log に `[POOL_DISABLED]` ではなく通常の起動ログが出る
4. `cmux-team token list` で 4 アカウントすべて表示・selectable

ユーザー側でこれを観測できれば真の解決。daemon 再起動はユーザーの操作なので Agent 側からは触らない。

---

## 5. 想定リスク

### R1: 冪等性の破壊

migration 関数のロジック自体は無改変、外側の PRAGMA を切り替えるだけ。`needsTokensSchemaT391Migration`
が migration 関数冒頭の冪等条件と同じ式なので、二重に判定しても結果は一致する。

破壊シナリオ:

- もし将来 `migrateTokensSchemaT391` の冪等条件を変更したのに `needsTokensSchemaT391Migration` を
  更新し忘れる → FK 切替の skip 判定が migration 関数の skip 判定とずれる
- 緩和策: `needsTokensSchemaT391Migration` を migration 関数の冒頭で内部的にも呼ぶように
  リファクタしてもよいが、本タスクのスコープを狭めるため **現状は二重定義のまま**、
  コメントで「両者は同じ条件である」旨を明記する

### R2: 新 DB 初期化時の無駄な FK 切替

`needsT391=false` の path では FK 切替を skip する設計にした。新 DB 起動時の OFF/ON 切替は
1 回（最後の ON のみ。default OFF からの遷移）。実害なし。

（仮にすべての path で OFF→ON するとしても SQLite の PRAGMA は O(1) なので perf 的に懸念なし。
スコープ最小化の観点で skip にするだけ。）

### R3: テスト並列実行時の DB ファイル衝突

旧 schema fixture test は `testDir` 内に `old-schema.db` を作る（既存実装どおり）。
他の test は `tokens.db` を使うので path が異なり衝突しない。`describe` の `beforeEach` で
testDir を分けている既存パターンを踏襲。

### R4: WAL モードと PRAGMA foreign_keys の相互作用

`PRAGMA journal_mode=WAL` は connection-scope ではなく database-scope（永続）。
`PRAGMA foreign_keys` は connection-scope。両者は独立して操作できるので相互影響なし。
SQLite ドキュメントでも "foreign keys are disabled per-connection" と明示。

### R5: トランザクション内で PRAGMA foreign_keys 変更が no-op になる罠

これがまさに現行コードのバグの核心。design 上、`PRAGMA foreign_keys=OFF` は
**migration 関数の `BEGIN` より前** で発行する。`initTokenDB` 内で順序を厳守すること。
コードレビュー時に `BEGIN` と PRAGMA の順序を最重点でチェック。

### R6: foreign_key_check が migration 関数の中で見えない

`PRAGMA foreign_key_check` はトランザクション内でも発行可能だが、`COMMIT` 直前に check して
violation があれば ROLLBACK する設計が望ましい。本 plan では migration 関数の `COMMIT` 後・
`initTokenDB` 内で check しているので、failed violations の場合 DB 自体は新 schema になった後で
throw する。これは「DB は新 schema、initTokenDB は throw」という中途半端な状態を残すリスクがある。

緩和策: violation 検出時の throw を厳格にするため、

- `initTokenDB` から throw された場合の caller（`createTokenStore` 等）の挙動を git grep で
  確認 → 既存の `initTokenDB failed` ログ経路（manager.log の `[POOL_DISABLED]`）に乗ることを
  確認した上でそのまま throw
- 通常 path では `usage_snapshots` / `leases` には旧 row が無い（新 DB / 旧 DB 両方とも
  migration 時点では空 or tokens の id を参照済み）ので violation は発生しない想定
- 万一 violation が発生したら user-env で再現性のある異常 → 自動修復しない方針
  （CLAUDE.md feedback 「異常検知時のリカバリーは人間に委ねる」）

これは現実的に許容可能。本 plan のスコープでは **violation 検出 → throw + ログ** で固定。

### R7: 既存の他 test (pool-throttle 等) で initTokenDB を呼ぶときの挙動変化

`initTokenDB` の出口で `PRAGMA foreign_keys=ON` を保証する点は変わらないので、
INSERT/UPDATE 系の既存テストには影響しない。Step 4.3 の隣接テスト確認で担保する。

---

## 完了条件チェック

- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` が green
- [ ] テスト fixture に `REFERENCES tokens(id)` を追加した状態で migration が成功する
- [ ] テスト内で `PRAGMA foreign_key_check` の結果が空配列であることを assert
- [ ] tsc 新規エラー 0 件
- [ ] 隣接テスト (token-pool / pool-throttle / pool-disabled-fallback) が green
