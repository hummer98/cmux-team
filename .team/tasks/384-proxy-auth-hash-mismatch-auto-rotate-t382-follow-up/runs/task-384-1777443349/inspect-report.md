---
verdict: GO
inspector: surface:139 (Inspector)
inspected_at: 2026-04-29T00:00:00Z
---

## 判定: GO

## サマリ

plan.md §3.1 の 4 phase 構造（auth_hash ヒット / auto-rotate / pool gate / auto-discover）が忠実に実装され、§4.1 の P1〜P8 + F1 全 9 ケースが期待通りの assertion で書かれている。`bun test --timeout 30000 proxy.test.ts` は 57 / 57 pass、`bunx tsc --noEmit` は exit 0、自分が触ったファイル起因の新規型エラーはゼロ。設計判断ポイント（pool gate は Phase 4 のみ / masking 6・8 桁 / `maybeApplyTokenHandle` を rotate 経路でも呼ぶ）も遵守されている。

## チェックリスト

- [x] plan §3.1 通りに proxy.ts が改造されている（proxy.ts:109-211）
- [x] P1-P8 + F1 の 9 テストが実装されており全 pass（proxy.test.ts:1782-2274）
- [x] 設計判断ポイント（pool gate / masking / handle apply）が守られている
- [x] `bun test --timeout 30000 proxy.test.ts`: 57 / 57 pass
- [x] `bunx tsc --noEmit`: 自分が触ったファイル起因の新規エラーゼロ（exit 0）
- [x] regression なし（既存 48 件 = T211 / T175 / T305 / T323 / T341-P1〜P4 / T367 系すべて pass）

## 検証詳細

### 1. plan §3.1 の擬似コード遵守

| plan §3.1 | 実装 (proxy.ts) | 一致 |
|---|---|---|
| Phase 1 `getTokenByAuthHash` | L126 | ○ |
| Phase 2 `getTokenByOrganizationId` + `updateTokenAuth` | L132-146 | ○ |
| `tok = { ...byOrg, auth_hash: authHash }` で差し替え | L138 | ○ |
| `token_auto_rotated handle=... old_auth=6 new_auth=6 org=8` | L140-144 | ○ |
| Phase 3 UPSERT + `maybeApplyTokenHandle` | L149-186 | ○ |
| Phase 4 `tokenPoolEnabled` gate + auto-discover INSERT | L187-207 | ○ |
| `getTokenByOrganizationId` / `updateTokenAuth` import | L25-26 | ○ |

### 2. P1-P8 + F1 の assertion 妥当性

- **P1 (proxy.test.ts:1782)**: `auth_hash` が `newAuthHash` に更新され `oldAuthHash` ではないことを **両方** assert（見せかけ pass 防止）。`util_5h=0.10`, `util_7d=0.20` も検証
- **P2 (1842)**: 1 回目 `u5h=0.10` → 2 回目 `u5h=0.50` で UPSERT が更新されることで「rotate は永続効果」を検証
- **P3 (1916)**: `org=null` upstream で `tokens` が変化しない + `usage_snapshots` が `null` のまま（auto-rotate / auto-discover の両 skip）
- **P4 (1974)**: `CMUX_TEAM_TOKEN_POOL=0` でも `auth_hash` UPDATE と UPSERT が成立
- **P5 (2030)**: org 未登録 + pool ON → `selectable=false`, `credential_source=auto-discover` で INSERT、`token_auto_rotated` ログが出ないことを正規表現で確認
- **P6 (2071)**: org 未登録 + pool OFF → `listTokens.length === 0`
- **P7 (2102)**: 正規表現で 6/6/8 桁 masking を検証 + `expect(content).not.toContain(`old_auth=${oldAuthHash}`)` でフル hash がログに混入しないことを **negative** assertion
- **P8 (2157)**: 同一 `auth_hash` で送り、`row?.auth_hash === authHash` で **未変更** を assert + `token_auto_rotated` が出ないこと
- **F1 (2217)**: `ALTER TABLE tokens DROP COLUMN auth_hash` で意図的に schema を壊し、`token_db_update_failed` ログが出る + proxy が 200 を返すことを検証

mock の固定値で見せかけ pass する箇所は見当たらず、各テストが「成功時に成功する」だけでなく「失敗時に失敗する」ことも negative assertion で確認している。

### 3. 設計判断ポイント (plan §3.2)

- **`tokenPoolEnabled` gate は Phase 4 のみ**: proxy.ts:189 の `if (!tokenPoolEnabled) return;` は `else if (organizationId)` ブロック（Phase 4）の中にある。Phase 2 にはガードなし → P4 で実証
- **masking**: ログ出力時のみ `slice(0, 6)` / `slice(0, 8)`（proxy.ts:142-143）。DB 内の auth_hash は 12 文字フル維持
- **`maybeApplyTokenHandle` を auto-rotate 経路でも呼ぶ**: Phase 2 で `tok` に差し替えて Phase 3 に合流させているため、L177-186 の handle 反映は rotate 経路でも実行される

### 4. impl-report §設計判断の補足

- **`startUpstreamWithOrgHeader` の lift**: T341 既存 5 callsites は `opts={}` default で互換（proxy.test.ts:1389-1416）。T384 では `{ u5h: ... }` 上書き / `null` で org ヘッダー除去の機能拡張を活用しており、最小限の変更で重複定義を回避している。妥当
- **T384-F1 の DROP TABLE → DROP COLUMN 変更**: `CREATE TABLE IF NOT EXISTS` で再作成されるため `DROP TABLE` ではエラーが起きないという発見は正しい。`ALTER TABLE ... DROP COLUMN auth_hash` で `getTokenByAuthHash` が `prepare` 時に throw → catch 経路到達 → 200 で fetch 完了、という条件を満たす。plan の意図（catch 経路で例外が呼び出し側に漏れないことの検証）は完全に保たれている

### 5. コード品質

- proxy.ts:88-108 の jsdoc は 4 phase の挙動と masking ポリシー（「ログ上の auth_hash は prefix 6 文字、organization_id は prefix 8 文字」「DB 内の auth_hash は 12 文字フル」）を明記
- Phase 2 直前の inline コメント（proxy.ts:128-131）が「`tokenPoolEnabled` には依存しない」設計判断を明示
- 不要な追加機能 / dead code なし。スコープ逸脱なし

## 指摘事項

### Critical（NOGO 理由）

なし

### Major

なし

### Minor

なし
