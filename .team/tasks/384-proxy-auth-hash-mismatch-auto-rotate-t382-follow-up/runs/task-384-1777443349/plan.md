---
task_id: 384
title: proxy: auth_hash mismatch 時の auto rotate（T382 follow-up）
run_id: task-384-1777443349
plan_author: surface:139 (Planner)
plan_created_at: 2026-04-29
---

## 1. 目的とゴール

### 解決すべき問題

Dear T318 の事故シナリオで判明した「`@tayo` の `usage_snapshots` が `recorded_at=2026-04-26T15:01:48Z` 以降固まり util_7d=0.91 に張り付いた」根本原因は、**proxy が観測する Authorization ヘッダーの `auth_hash` と DB に登録された `tokens.auth_hash` が乖離した**こと。乖離は OAuth refresh（macOS Keychain 側で Claude Code 本体が token を rotate するイベント）で発生し、proxy は新 `auth_hash` を「未知 token」として扱うため `usage_snapshots` の UPSERT 経路に流れず**永久に止まる**。

T382 一次対応は selectToken に 7d ブロッカー（util_7d > 0.95 で除外）を追加して落札を止めただけで、**snapshot が 0.95 を超えなければ admit ループには漏れる**。Dear の事故は実 monthly limit が 100% に達しても snapshot が 0.91 で止まっていたため、T382 だけでは止まらない。

### ゴール

- proxy の `updateTokensDB` が `auth_hash` で見つからなかった token を、**`organization_id` でヒットすれば既存レコードの `auth_hash` を UPDATE して通常 UPSERT 経路に流す**。
- これにより OAuth refresh で発生する `auth_hash` 乖離を proxy が**自動的に修復**し、`usage_snapshots` の更新が止まらなくなる。
- 既存の auto-discover 経路（`tokenPoolEnabled` ガード付きの新規 token INSERT）と、既存の `auth_hash` ヒット経路は**そのまま維持**する。

### 非ゴール（本タスクで触らないもの）

- Keychain 側の token 同期（spawn-agent が新 token を retrieve する経路）。これは別タスク。
- `cmux-team token rotate` 手動 CLI（既存）。今回は proxy 側の自動補正のみ。
- `tokens.organization_id` UNIQUE 制約の変更。既存スキーマを前提に動く。

---

## 2. 現状コードの分析

### 2.1 既存関数の存在確認（必ず確認すべき事項 #1）

`skills/cmux-team/manager/token-store.ts` に**全て実装済み**。新規追加は不要。

| 関数 | 行 | シグネチャ |
|---|---|---|
| `getTokenByAuthHash` | token-store.ts:347 | `(db, authHash) => Token \| null` |
| `getTokenByOrganizationId` | token-store.ts:330 | `(db, organization_id) => Token \| null` |
| `updateTokenAuth` | token-store.ts:382 | `(db, token_id, new_auth_hash) => void`（auth_hash 列のみ UPDATE） |
| `insertToken` | token-store.ts:298 | `(db, input) => Token` |

`updateTokenAuth` は既に `cmux-team token rotate` の補償トランザクション用として export 済みなので、proxy.ts から import して再利用するだけ。

### 2.2 `updateTokensDB` の現状（必ず確認すべき事項 #2）

`skills/cmux-team/manager/proxy.ts:98-176` に実装。書き換え対象は **L114-L172**。

```
L114:    const tok = getTokenByAuthHash(db, authHash);
L116-152: if (tok) { ... 既存 UPSERT + maybeApplyTokenHandle ... }
L153-172: else if (organizationId) {
            if (!tokenPoolEnabled) return;       ← pool OFF gate
            const handle = genAutoDiscoverHandle(...);
            insertToken(...);                    ← UNIQUE constraint failed の発生源
            log("token_auto_discovered", ...);
          }
L173-175: } catch (e: any) { log("token_db_update_failed", ...); }
```

**今回の改造**: L114 で `tok` が null だったら L153 の `else if (organizationId)` に入る前に `getTokenByOrganizationId` で再検索し、ヒットしたら `updateTokenAuth` で `auth_hash` を UPDATE してから L116 の UPSERT 経路に合流させる。

`getTokenByOrganizationId` ヒット時に `insertToken` を呼ぶと `tokens.organization_id` UNIQUE 制約違反で throw（必ず確認すべき事項 #5 参照）。今回の auto-rotate 経路では UPDATE のみなので UNIQUE 制約には抵触しない。

### 2.3 organizationId の入手経路（必ず確認すべき事項 #3）

`upstreamRes.headers.get("anthropic-organization-id")` を呼び出し側で取得。

| 呼び出し位置 | 行 |
|---|---|
| streaming path | proxy.ts:726 |
| 非 streaming path | proxy.ts:799 |

両方とも `updateTokensDB(authHash, rl, organizationId, ...)` の第 3 引数として既に渡されている。**proxy.ts の引数経路は変更不要**。

ヘッダーが返ってこない場合は `null` が渡る。null のときは auto-rotate も auto-discover も skip（既存挙動と同じ）。

### 2.4 既存の auth_hash masking 規約（必ず確認すべき事項 #4）

| ログ | masking | 場所 |
|---|---|---|
| `computeProxyAuthHash` 自体 | sha256 hex の **prefix 12 文字** | proxy.ts:66 |
| `token_db_update_failed` | `auth_hash=${authHash}`（12 文字フル） | proxy.ts:174 |
| `token_auto_discovered` | auth_hash はログに出さず `org=${organizationId.slice(0, 8)}` のみ | proxy.ts:171 |

**設計判断**: 今回の `token_auto_rotated` は **old/new の auth_hash を両方ログに出す**ため情報量が増える。既に sha256 hex の 12 文字 prefix だが、念のため**さらに 6 文字（24bit）に丸めてログ出力**する。理由：
- 6 文字でも実運用ログ全体での衝突確率は十分低く、識別性は保たれる
- 将来 `auth_hash` のフル長を 12 → 16 文字等に伸ばしてもログのフォーマットは固定される
- `org=${organizationId.slice(0, 8)}` の masking 流儀と整合

DB 内の auth_hash 値は従来通り 12 文字フル（`computeProxyAuthHash` の戻り値）を保存する。masking は**ログ出力時のみ**。

### 2.5 UNIQUE constraint failed の発生条件（必ず確認すべき事項 #5）

`tokens` テーブルのスキーマ（token-store.ts:132-144）：

```sql
CREATE TABLE IF NOT EXISTS tokens (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  handle            TEXT    NOT NULL UNIQUE,
  organization_id   TEXT    NOT NULL UNIQUE,   ← これ
  auth_hash         TEXT    NOT NULL,
  ...
);
```

`organization_id` UNIQUE 制約により、`insertToken` で同一 `organization_id` の行を 2 回作ろうとすると `SQLITE_CONSTRAINT_UNIQUE` で throw。

**今回の修正は INSERT の手前で UPDATE 経路に分岐**するため、UNIQUE 制約には抵触しない。`updateTokenAuth` は `auth_hash` 列のみを書き換えるので `organization_id` UNIQUE / `handle` UNIQUE のどちらにも影響しない。

別途、テストで「`getTokenByOrganizationId` ヒット時には `insertToken` が呼ばれないこと」を検証する（fallthrough 検証）。

### 2.6 proxy.test.ts のテストパターン（必ず確認すべき事項 #6）

既存テスト `describe("proxy: auto-discover gate (T341)", ...)` (proxy.test.ts:1387-1734) のパターンをそのまま踏襲する：

1. **DB 隔離**: `process.env.TOKEN_STORE_DB_PATH` をテスト毎にユニーク化、`__resetTokensDbForTest()` を beforeEach/afterEach で呼ぶ
2. **Keychain in-memory**: `process.env.KEYCHAIN_TEST_MODE = "1"`
3. **upstream モック**: `startUpstreamWithOrgHeader(orgId)` ヘルパー（テスト 1421-1444 行）を流用。`anthropic-organization-id` と unified utilization ヘッダーを返す
4. **fire-and-forget 完了待ち**: `await new Promise((r) => setTimeout(r, 50))`
5. **DB 検証**: `initTokenDB() + listTokens / getLatestUsageSnapshot / getTokenByOrganizationId` で結果を assert
6. **環境変数 restore**: afterEach で `originalTokenDb / originalKeychain / originalApi / originalPool` を復元

テストファイル末尾に `describe("proxy: auth_hash auto-rotate (T384)", ...)` を新設し、上記パターンを使う。

---

## 3. 設計

### 3.1 改訂後の `updateTokensDB` 構造（擬似コード）

```ts
function updateTokensDB(
  authHash: string | null,
  rl: RateLimitInfo | null,
  organizationId: string | null,
  surface: string | null,
  role: string | null,
  opts: { tokenPoolEnabled: boolean; getState?: () => any },
): void {
  if (!authHash) return;
  const db = getTokensDB();
  if (!db) return;
  if (!rl) return;

  const { tokenPoolEnabled, getState } = opts;

  try {
    // ── Phase 1: auth_hash で検索 ──
    let tok = getTokenByAuthHash(db, authHash);

    // ── Phase 2: auto-rotate（auth_hash mismatch だが organization_id 一致） ──
    let rotatedFromOldAuth: string | null = null;
    if (!tok && organizationId) {
      const byOrg = getTokenByOrganizationId(db, organizationId);
      if (byOrg) {
        rotatedFromOldAuth = byOrg.auth_hash;
        updateTokenAuth(db, byOrg.id, authHash);
        // 後続 UPSERT で参照する byOrg を新 auth_hash で更新したオブジェクトに差し替え
        tok = { ...byOrg, auth_hash: authHash };
        log(
          "token_auto_rotated",
          `handle=${tok.handle} old_auth=${rotatedFromOldAuth.slice(0, 6)} ` +
          `new_auth=${authHash.slice(0, 6)} org=${organizationId.slice(0, 8)}`,
        ).catch(() => {});
      }
    }

    // ── Phase 3: tok があれば UPSERT 経路（既存ロジックそのまま） ──
    if (tok) {
      const prev = getLatestUsageSnapshot(db, tok.id);
      const u5h = rl.unified5hUtilization;
      const u7d = rl.unified7dUtilization;
      const changed =
        prev == null ||
        (u5h != null && prev.util_5h != null && Math.abs(u5h - prev.util_5h) >= 0.01) ||
        (u7d != null && prev.util_7d != null && Math.abs(u7d - prev.util_7d) >= 0.01) ||
        (u5h != null && prev.util_5h == null) ||
        (u7d != null && prev.util_7d == null) ||
        rl.unified5hReset !== prev.reset_5h_at ||
        rl.unified7dReset !== prev.reset_7d_at ||
        (rl.unifiedStatus ?? null) !== prev.unified_status;

      if (changed) {
        upsertUsageSnapshot(db, {
          token_id: tok.id,
          util_5h: u5h,
          util_7d: u7d,
          reset_5h_at: rl.unified5hReset,
          reset_7d_at: rl.unified7dReset,
          unified_status: rl.unifiedStatus ?? null,
        });
      }

      if (surface && role && getState) {
        try {
          maybeApplyTokenHandle(getState(), surface, role, tok.handle);
        } catch (e: any) {
          log("token_handle_apply_failed",
              `surface=${surface} role=${role} err=${e?.message ?? e}`).catch(() => {});
        }
      }
    } else if (organizationId) {
      // ── Phase 4: 真の新規 token（auth_hash も organization_id も未知） ──
      if (!tokenPoolEnabled) return;
      const handle = genAutoDiscoverHandle(db, organizationId);
      insertToken(db, {
        handle,
        organization_id: organizationId,
        auth_hash: authHash,
        plan: "unknown",
        plan_ratio: null,
        tags: ["auto"],
        credential_source: "auto-discover",
        selectable: false,
      });
      log("token_auto_discovered",
          `handle=${handle} org=${organizationId.slice(0, 8)}`).catch(() => {});
    }
  } catch (e: any) {
    log("token_db_update_failed",
        `auth_hash=${authHash} err=${e?.message ?? e}`).catch(() => {});
  }
}
```

### 3.2 設計判断ポイントの根拠

| 判断 | 採用 | 根拠 |
|---|---|---|
| auto-rotate を `tokenPoolEnabled` で gate するか | **gate しない**（pool OFF でも実行） | Dear の事故は `@tayo`（`selectable=1`、手動 add した正規 token）で起きた。pool OFF の手動運用派こそ rotate が止まらないと困る。`tokenPoolEnabled` ガードは**新規 INSERT（auto-discover）のみ**に維持する |
| ログの auth_hash masking | **prefix 6 文字** | 衝突確率十分低く、`org=...slice(0, 8)` と並んで見やすい。DB 内は 12 文字フル維持 |
| `tok` 変数の差し替え方 | `tok = { ...byOrg, auth_hash: authHash }` | 後続 UPSERT 経路で `tok.id`/`tok.handle` を参照するだけなので spread で安全。`getTokenByAuthHash` を再呼び出しすると DB ラウンドトリップが増える |
| `maybeApplyTokenHandle` を auto-rotate 経路でも呼ぶか | **呼ぶ** | rotate 後は新 auth_hash でヒットした token と同じ扱いにする。surface ↔ tokenHandle 反映ロジックは現実の handle (`@tayo` 等) を貼り直すべき |
| transaction 化 | **しない**（fire-and-forget の単一 UPDATE） | `updateTokenAuth` は単一 UPDATE。後続 `upsertUsageSnapshot` も別 UPSERT。失敗してもエラーは catch で吸収。tokens.db は WAL モードで多重 writer 安全 |

### 3.3 import 追加

`proxy.ts:22-28` の token-store import に `getTokenByOrganizationId` と `updateTokenAuth` を追加：

```ts
import {
  initTokenDB,
  getTokenByAuthHash,
  getTokenByOrganizationId,   // ← 追加
  updateTokenAuth,             // ← 追加
  insertToken,
  getLatestUsageSnapshot,
  upsertUsageSnapshot,
} from "./token-store";
```

### 3.4 関数 docstring 更新

`updateTokensDB` の jsdoc（proxy.ts:86-97）を更新：

```text
* Anthropic レスポンス 1 件につき tokens.db を更新する（T320 / T384）。
* - auth_hash が既知 (`getTokenByAuthHash`): utilization 変化時のみ UPSERT
* - auth_hash 未知 + organization_id 既知 (`getTokenByOrganizationId`):
*     auto-rotate（既存 token の auth_hash を UPDATE してから UPSERT 経路に合流）。
*     OAuth refresh で auth_hash が乖離した token の usage_snapshots 更新を再開させる（T384）。
*     `tokenPoolEnabled` には依存しない（手動 add の正規 token も rotate 対象）。
* - auth_hash も organization_id も未知 + tokenPoolEnabled=true:
*     auto-discover INSERT（selectable=0）
* - tokenPoolEnabled=false かつ未知 token: skip
```

---

## 4. テスト戦略

### 4.1 追加するテストケース（proxy.test.ts 末尾に新設）

`describe("proxy: auth_hash auto-rotate (T384)", ...)` ブロックに以下の 8 ケース。fixture は既存の `startUpstreamWithOrgHeader(orgId)` を流用し、beforeEach/afterEach は `proxy: auto-discover gate (T341)` のパターンを丸ごとコピー（DB path 隔離 + Keychain in-memory + 環境変数 restore）。

| # | テスト名 | 検証内容 |
|---|---|---|
| 1 | `T384-P1: auth_hash mismatch + org 一致 → 既存 token の auth_hash が UPDATE され usage_snapshots が UPSERT される` | `insertToken({ handle: "@known", org: "org-X", auth_hash: "OLD" })` した状態で `auth_hash="NEW"` & `org="org-X"` の HTTP リクエスト → DB の auth_hash が `NEW`（sha256 後の 12 文字 prefix）に更新、`getLatestUsageSnapshot` で 5h/7d util が反映される |
| 2 | `T384-P2: auto-rotate 後の連続リクエストは getTokenByAuthHash 経路で UPSERT が継続する` | P1 直後に同じ auth_hash で 2 回目のリクエストを送り、`util_5h` を変化させて UPSERT が更新されることを確認（rotate が一度きりの操作であって永続効果を持つこと） |
| 3 | `T384-P3: org が返ってこない場合は auto-rotate も auto-discover も skip` | upstream が `anthropic-organization-id` を返さない fixture → DB は変化しない |
| 4 | `T384-P4: pool OFF でも auto-rotate は実行される（手動 add token の OAuth refresh ケース）` | `CMUX_TEAM_TOKEN_POOL=0` で T384-P1 と同じシナリオ → auth_hash UPDATE と usage_snapshots UPSERT が成立する（tokenPoolEnabled は INSERT のみ gate する設計の検証） |
| 5 | `T384-P5: org も未登録 + pool ON → 従来通り auto-discover INSERT（rotate ではなく新規）` | DB を空にした上で `auth_hash=NEW`, `org=org-fresh` で HTTP リクエスト → `selectable=0` で新規 INSERT。`token_auto_rotated` ログは出ない |
| 6 | `T384-P6: org も未登録 + pool OFF → 何もしない` | 既存 T341-P1 と同じ。新コードでも regress していないことを保証 |
| 7 | `T384-P7: ログフォーマット検証` | `manager.log` を tail し `token_auto_rotated handle=@known old_auth=XXXXXX new_auth=YYYYYY org=ORGORG12` 形式（6/6/8 桁マスキング）で 1 行記録されることを正規表現で検証 |
| 8 | `T384-P8: auth_hash 既ヒット時は updateTokenAuth が呼ばれない（regression guard）` | `insertToken({ handle: "@known", org: "org-X", auth_hash: "AAAAAA..." })` した上で同じ auth_hash で HTTP リクエスト → `getTokenByOrganizationId` 経路には入らない。spy する代わりに `auth_hash` 列が変化していないことを assert |

### 4.2 失敗系（タスク本文「auto-rotate 失敗ケースの fixture」）

| # | テスト名 | 検証内容 |
|---|---|---|
| F1 | `T384-F1: updateTokenAuth が throw しても呼び出し側に例外が漏れない` | DB を `db.exec("DROP TABLE tokens")` などで壊した上で fetch → レスポンスは 200 で返る、`token_db_update_failed` ログのみ記録。proxy が落ちないこと |

### 4.3 既存テストへの regression 検証

以下の既存テストが通ることを確認する：

- `proxy: tokenHandle apply (T323)` — 既知 token + master/conductor の tokenHandle 反映
- `proxy: auto-discover gate (T341)` 全 4 件（P1-P4）
- `T367: /rate-limit pool 有効 + 余裕あり / 全 token util=0.96` — pool throttle 経路

### 4.4 実行コマンド

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 proxy.test.ts
```

`bun test` 全体実行は CLAUDE.md の禁忌（O(N²) 級劣化）。**`proxy.test.ts` 単体実行**のみ行う。

---

## 5. 実装手順

**TDD（test-first）で進める。** 各ステップは独立して commit 単位にする。

### ステップ 1: テストフレーム追加（fail 確認）
1. `proxy.test.ts` の末尾に `describe("proxy: auth_hash auto-rotate (T384)", () => { ... })` を新設
2. `beforeEach` / `afterEach` を T341 パターンからコピー（環境変数 backup・`__resetTokensDbForTest()` 呼び出し）
3. `startUpstreamWithOrgHeader(orgId)` ヘルパーを再利用（既存のものを使う。重複定義しない）
4. **テスト T384-P1 だけを書いて `bun test --timeout 30000 proxy.test.ts` を実行**
5. 期待値: P1 が **fail**（auth_hash が UPDATE されない & `getLatestUsageSnapshot` が null）

### ステップ 2: import 追加
1. `proxy.ts:22-28` の token-store import block に `getTokenByOrganizationId, updateTokenAuth` を追加
2. `bun tsc --noEmit` 等の型検査で import エラーが消えることを確認

### ステップ 3: `updateTokensDB` 改造（コア実装）
1. `proxy.ts:98-176` を §3.1 の擬似コード通りに書き換え
2. jsdoc を §3.4 通りに更新
3. テスト T384-P1 を再実行 → **pass** することを確認

### ステップ 4: 残りのテスト追加と pass 確認
1. T384-P2 〜 P8、F1 を追加
2. `bun test --timeout 30000 proxy.test.ts` 全 pass を確認

### ステップ 5: regression 確認
1. 既存の T323 / T341-P1〜P4 / T367 系テストが全て pass することを確認（同じ test ファイルなので step 4 で検証済み）

### ステップ 6: 型検査と build
1. `bun tsc --noEmit -p skills/cmux-team/manager/tsconfig.json`（実プロジェクトの type check コマンドに準拠）

### ステップ 7: 実機での観測（任意・PR レビュー前推奨）
1. `cmux-team start` で daemon を立ち上げ、`@tayo` の token を手動 rotate（`cmux-team token rotate @tayo` で Keychain 側を新値に差し替え）
2. agent を 1 個 spawn して proxy 経由でリクエスト送信
3. `.team/logs/manager.log` に `token_auto_rotated handle=@tayo old_auth=... new_auth=... org=...` が記録されること
4. `cmux-team token list` で `@tayo` の最新 utilization が更新されていることを確認

---

## 6. 影響・リスク

### 6.1 既存テストへの影響

- 既存 `updateTokensDB` の **動作分岐（auth_hash ヒット / 未ヒット & pool OFF / 未ヒット & pool ON）はすべて維持**。新規分岐（auth_hash 未ヒット & org ヒット）が間に追加されるだけ。
- T341-P3（pool OFF + 既知 token UPSERT）は無影響（auth_hash で直ヒットするので Phase 1 で完結）
- T323 系（master/conductor tokenHandle 反映）は無影響（同じ Phase 3 で `maybeApplyTokenHandle` が呼ばれる。auto-rotate 経路でも呼ばれるが既存挙動と同じ）

### 6.2 ログ仕様

| ログラベル | 出力タイミング | フォーマット |
|---|---|---|
| `token_auto_rotated`（**新規**） | auth_hash 未ヒット & org ヒット時 | `handle=@xxx old_auth=AAAAAA new_auth=BBBBBB org=ORGORG12` |
| `token_auto_discovered`（既存） | auth_hash 未ヒット & org も未ヒット & pool ON | `handle=@orgo org=ORGORG12` |
| `token_db_update_failed`（既存） | catch ブロック | `auth_hash=<12 hex> err=<message>` |
| `token_handle_apply_failed`（既存） | maybeApplyTokenHandle が throw | `surface=... role=... err=...` |

masking 規約: ログでは `auth_hash.slice(0, 6)`、`organization_id.slice(0, 8)`。DB 内では 12 文字フル維持。

### 6.3 セキュリティ・プライバシー

- auth_hash は元々 sha256 hex の 12 文字 prefix なので**復元不可能**（48bit）。さらに 6 文字に丸めても 24bit でログから token を逆引きする攻撃は非現実的
- auth_hash は ANTHROPIC_API_KEY や OAuth token そのものではない（Authorization ヘッダー全体の sha256）。masking ポリシーの 6 文字化は「ログの可読性」目的であり、暗号学的要請ではない

### 6.4 並行性

- tokens.db は WAL モード（token-store.ts:193）。proxy が `updateTokenAuth` を実行中に別プロセス（`cmux-team token rotate` CLI 等）が同じ token に書いても、後勝ちで一貫性は保たれる
- `updateTokenAuth` は単一 UPDATE 文。トランザクションでくくる必要はない

### 6.5 想定されるエッジケース

| ケース | 挙動 |
|---|---|
| `organization_id` が空文字 `""` | `getTokenByOrganizationId(db, "")` は null を返す（DB に空文字 org の row はない設計）→ Phase 4 (auto-discover) に流れ、`genAutoDiscoverHandle("")` で `@""` のような不正 handle が生成される懸念 → 既存挙動と同じなので本タスクでは触らない |
| `getTokenByOrganizationId` ヒット token が `selectable=0`（auto-discover 中） | auth_hash UPDATE は実行する。selectable は維持される（既存設計通り）。promote されていない自動登録 token の auth_hash も rotate しないと UPSERT が止まる |
| 同一 `organization_id` で別 handle に rotate されているケース | UNIQUE 制約により 1 行しかない。`getTokenByOrganizationId` は確定的に 1 行を返す |
| Keychain 側で発生する rotate と proxy 側 auto-rotate の race | 両者が同じ auth_hash を書く方向に収束する。最終的に DB と Keychain の auth_hash は一致する |

### 6.6 リスク

| リスク | 対策 |
|---|---|
| 設計判断「pool OFF でも auto-rotate を許可」がプロジェクト方針と合わない可能性 | ユーザー確認推奨。違う方針を採るなら `if (!tokenPoolEnabled) return;` を Phase 2 の冒頭にも入れる（差分は 1 行） |
| auth_hash が 12 文字 sha256 で衝突して別 token に誤 rotate する | 確率 1/2^48 ≒ 10^-14。ANTHROPIC_API_KEY の世代数を考えれば無視可能 |
| `organization_id` が **異なる Anthropic アカウント間で重複**することは仕様上ない（Anthropic 発行 ID） | スキーマ UNIQUE 制約と整合 |

---

## 7. 完了条件

- [ ] `proxy.ts:98-176` が §3.1 の擬似コード通りに改造され、`getTokenByOrganizationId` / `updateTokenAuth` を import している
- [ ] `proxy.test.ts` に新規 describe ブロック `proxy: auth_hash auto-rotate (T384)` が追加され、P1〜P8 + F1 の 9 テストが全 pass
- [ ] `bun test --timeout 30000 proxy.test.ts` が全 pass（既存テストの regression なし）
- [ ] 型検査 (`bun tsc --noEmit`) が pass
- [ ] `manager.log` に `token_auto_rotated handle=@xxx old_auth=AAAAAA new_auth=BBBBBB org=ORGORG12` フォーマットで 1 行記録されることをテストで検証済み
- [ ] auth_hash の masking ポリシー（ログ 6 文字 prefix、DB 12 文字フル）が docstring とコメントに明記されている

### 任意（PR レビューでの観測）

- [ ] 実機 `@tayo` の token rotate → リクエスト送信で `usage_snapshots.recorded_at` が更新され始めることを確認
