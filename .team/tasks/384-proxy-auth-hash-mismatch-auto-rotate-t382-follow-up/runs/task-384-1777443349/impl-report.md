---
task_id: 384
run_id: task-384-1777443349
implementer: surface:139 (Implementer)
implemented_at: 2026-04-29
plan_ref: ./plan.md
---

## サマリ

T384 計画書 §3.1 / §4.1 / §5 通りに実装完了。proxy.ts に auth_hash auto-rotate 経路を追加し、proxy.test.ts に T384-P1〜P8 + F1 の 9 テストを追加。`bun test --timeout 30000 proxy.test.ts` で 57 / 57 全 pass、`bunx tsc --noEmit` も exit 0。

## 変更ファイル

```
skills/cmux-team/manager/proxy.ts      |  49 ++-
skills/cmux-team/manager/proxy.test.ts | 587 +++++++++++++++++++++++++++++++--
```

(`package-lock.json` の 4 行差分は本タスクと無関係の既存差分)

### proxy.ts (49 行差分)
- import: `getTokenByOrganizationId`, `updateTokenAuth` を追加（plan §3.3）
- jsdoc: §3.4 通りに 4 phase の挙動と masking ポリシーを記載
- `updateTokensDB`:
  - **Phase 2 を新設**: `getTokenByAuthHash` が null かつ `organizationId` 一致時は `getTokenByOrganizationId` で再検索 → ヒットすれば `updateTokenAuth` で auth_hash 列を UPDATE → `tok = { ...byOrg, auth_hash: authHash }` で UPSERT 経路に合流
  - `tokenPoolEnabled` ガードは Phase 4 (auto-discover INSERT) のみに維持。auto-rotate は pool OFF でも実行する
  - `token_auto_rotated handle=@xxx old_auth=AAAAAA new_auth=BBBBBB org=ORGORG12` を log（auth=6/org=8 桁マスキング）
  - 既存 Phase 1 (auth_hash ヒット) と Phase 4 (両方未知) のロジックは無変更

### proxy.test.ts (587 行差分)
- ファイル先頭付近に `startUpstreamWithOrgHeader(orgId, opts)` を抽出（T341 内 local helper を file-scope に lift し、`u5h` / `u7d` を opts で上書き可能に拡張。T341 既存呼び出しは引数互換）
- 末尾に `describe("proxy: auth_hash auto-rotate (T384)", ...)` を新設
  - beforeEach / afterEach は T341 パターンを丸コピー（DB path 隔離 + Keychain in-memory + 環境変数 restore + `__resetTokensDbForTest()`）
  - **9 テスト**: P1〜P8 + F1（plan §4.1 の表通り）

## テスト実行結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 proxy.test.ts
bun test v1.3.13 (bf2e2cec)

 57 pass
 0 fail
 221 expect() calls
Ran 57 tests across 1 file. [3.15s]
```

- 新規 9 件（T384-P1〜P8 + F1）すべて pass
- 既存 48 件 (T211 / T175 / T305 / T323 / T341-P1〜P4 / T367 系) は **regression なし**
- 実行時間 ~3.2 秒（既存と同等、CLAUDE.md の `bun test` 全体実行禁忌は回避し proxy.test.ts 単体実行のみ）

### TDD タイムライン

| ステップ | 結果 |
|---|---|
| 1. helper lift + T384-P1 のみ追加 | P1 fail（auth_hash 列が古いまま、想定通り） |
| 2. proxy.ts に import + Phase 2 追加 | P1 pass |
| 3. P2〜P8 + F1 追加 | 全 pass |
| 4. `bunx tsc --noEmit` | exit 0 |

## 型検査

```
$ bunx tsc --noEmit
=== exit 0 ===
```

自分が touch した `proxy.ts` / `proxy.test.ts` 起因の新規エラーゼロ。リポジトリ全体でも 0 件。

## 設計判断の補足（plan からの乖離点）

### 1. `startUpstreamWithOrgHeader` を file scope に lift

plan §5 step 1.3「重複定義しない」に従うため、T341 describe 内 local だった helper を **file scope に抽出**し、T341 / T384 両方から共有可能にした。

互換性維持のため：
- T341 既存呼び出し `startUpstreamWithOrgHeader("org-...")` は引数 1 個で引き続き動作（`opts` は optional default `{}`）
- 既存 5 callsites の挙動は無変更（`u5h="0.10"` / `u7d="0.20"` の固定値が維持される）
- T384 では P2 などで `{ u5h: "0.50" }` のように上書き、P3 では `null` を渡して `anthropic-organization-id` ヘッダーを返さない動作を実現

### 2. T384-F1 のエラー誘発手段

plan §4.2 は「`db.exec("DROP TABLE tokens")` などで壊した上で fetch」を例示しているが、proxy 側 `initTokenDB` が `CREATE TABLE IF NOT EXISTS` でテーブルを再生成するため、**`DROP TABLE` 単体ではエラーが発生しない**ことを実装中に発見。

代替案として **`ALTER TABLE tokens DROP COLUMN auth_hash`** を採用：
- v1 schema migration 配列 (`required: Array<...>`) は空なので `ensureTokensColumns` は drop された列を再追加しない
- proxy の最初の `getTokenByAuthHash` の `prepare("SELECT * FROM tokens WHERE auth_hash = ?")` が "no such column: auth_hash" で throw
- → updateTokensDB の catch 経路に到達 → `token_db_update_failed` log 出力 → fetch は 200 で返る

これにより plan §4.2 の意図（「auto-rotate 経路で DB エラーが起きても呼び出し側に例外が漏れない」）を確実に検証できる形にした。

### 3. その他

- `tok = { ...byOrg, auth_hash: authHash }` で spread した object を Phase 3 に流す方式（plan §3.2）はそのまま採用
- `maybeApplyTokenHandle` を auto-rotate 経路でも呼ぶ方針（plan §3.2）はそのまま採用
- ログ masking（auth_hash 6 文字 / organization_id 8 文字）はコードコメントと jsdoc に明記

## 完了条件チェック (plan §7)

- [x] `proxy.ts` が §3.1 の擬似コード通りに改造され、`getTokenByOrganizationId` / `updateTokenAuth` を import している
- [x] `proxy.test.ts` に新規 describe ブロック `proxy: auth_hash auto-rotate (T384)` が追加され、P1〜P8 + F1 の 9 テストが全 pass
- [x] `bun test --timeout 30000 proxy.test.ts` が全 pass（既存テストの regression なし）
- [x] 型検査 (`bunx tsc --noEmit`) が pass（exit 0）
- [x] `manager.log` に `token_auto_rotated handle=@xxx old_auth=AAAAAA new_auth=BBBBBB org=ORGORG12` フォーマットで 1 行記録されることをテスト T384-P7 で正規表現により検証
- [x] auth_hash の masking ポリシー（ログ 6 文字 prefix、DB 12 文字フル）が docstring とコメントに明記

## やらないこと（守った）

- main への push / merge は未実施（Conductor の役割）
- commit / staging は未実施（Conductor の一括 stage に委ねる）
- 別タスクへの波及なし（proxy.ts / proxy.test.ts の T384 関連変更のみ。T341 既存テストの helper lift のみ最小限）
