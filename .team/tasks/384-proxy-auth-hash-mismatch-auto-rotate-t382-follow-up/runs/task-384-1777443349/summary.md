---
task_id: 384
title: "proxy: auth_hash mismatch 時の auto rotate（T382 follow-up）"
run_id: task-384-1777443349
conductor: surface:139
status: completed
---

## 完了サマリ

T382 follow-up として、proxy.ts の `updateTokensDB` に auth_hash auto-rotate 経路を追加。
OAuth refresh で auth_hash が乖離した token についても、`organization_id` が一致すれば
既存レコードの `auth_hash` を UPDATE して通常 UPSERT 経路に合流させ、`usage_snapshots`
の更新が止まらないようにした。

## フェーズ実行（中規模フロー）

| Phase | Agent | 成果物 | 結果 |
|---|---|---|---|
| Phase 1 (Plan) | Planner (surface:286) | plan.md | 完了（4 phase 設計、9 テストケース定義） |
| Phase 3 (Impl) | Implementer (surface:291) | impl-report.md | 完了（57/57 pass、tsc exit 0） |
| Phase 4 (Inspect) | Inspector (surface:300) | inspect-report.md | **GO**（Critical/Major/Minor なし） |

Phase 2 (Design Review) は中規模なのでスキップ。

## 変更ファイル

- `skills/cmux-team/manager/proxy.ts` (+49)
  - import: `getTokenByOrganizationId`, `updateTokenAuth` 追加
  - `updateTokensDB` に **Phase 2 (auto-rotate)** を新設
  - jsdoc を 4 phase 構成 + masking 規約で更新
- `skills/cmux-team/manager/proxy.test.ts` (+587)
  - `startUpstreamWithOrgHeader` を file scope に lift（既存 callsite 互換）
  - `describe("proxy: auth_hash auto-rotate (T384)", ...)` 追加
  - 9 テスト (P1-P8 + F1) 全 pass

## テスト結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 proxy.test.ts
57 pass / 0 fail / 221 expect() calls (3.15s)
```

- 新規 9 件全 pass、既存 48 件 (T211/T175/T305/T323/T341/T367 系) regression なし
- `bunx tsc --noEmit`: exit 0（自分が触ったファイル起因の新規エラーなし）

## 設計判断（採用したもの）

| 判断 | 採用 | 根拠 |
|---|---|---|
| auto-rotate を `tokenPoolEnabled` で gate するか | gate しない | Dear T318 事故は `@tayo`（手動 add の正規 token）で発生。pool OFF の手動運用派こそ rotate が必要 |
| ログ masking | auth_hash 6 桁 / org 8 桁 | 衝突確率十分低く既存 `org=...slice(0, 8)` と整合 |
| `tok` 差し替え方法 | `{ ...byOrg, auth_hash: authHash }` spread | DB 再読み不要 |
| `maybeApplyTokenHandle` を rotate 経路でも呼ぶ | 呼ぶ | rotate 後の挙動を auth_hash ヒット時と同等にする |

## plan からの乖離点（実装側で補正）

- **`startUpstreamWithOrgHeader` の lift**: T341 内 local helper を file scope に抽出し T384 と共有。既存 5 callsites は引数 1 個のままで互換維持（opts は default `{}`）
- **T384-F1 のエラー誘発**: `DROP TABLE` は `CREATE TABLE IF NOT EXISTS` で再生成されるため使えず、`ALTER TABLE tokens DROP COLUMN auth_hash` に変更（plan の意図「catch 経路で例外を吸収できること」は完全に保たれる）

## 完了条件

- [x] proxy.ts が plan §3.1 の擬似コード通りに改造
- [x] proxy.test.ts に 9 テスト追加、全 pass
- [x] regression なし
- [x] 型検査 pass
- [x] `token_auto_rotated handle=@xxx old_auth=AAAAAA new_auth=BBBBBB org=ORGORG12` ログ仕様をテストで検証
- [x] masking 規約が docstring/コメントに明記

## 納品

- 納品方式: ローカル ff-only マージ（main へ）
- ブランチ: `task-384-1777443349/task` → main
- マージコミット: `da1dd0d` (`92d93ea..da1dd0d` ff-only)
