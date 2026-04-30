# T321 完了サマリー

## タスク

`cmux-team spawn-agent` の token selection で `project_tags` resolver を実装し、`selectToken` の第 3 引数を解決済み tags 配列で渡すようにする。

## 変更ファイル

| Path | 種別 | 内容 |
|------|------|------|
| `skills/cmux-team/manager/project-tags.ts` | 新規 | `resolveProjectTags(projectRoot)` / `parseRemoteOriginToTags(url)` を export |
| `skills/cmux-team/manager/project-tags.test.ts` | 新規 | 純粋関数 13 + integration 7 + その他 3 = 23 ケース |
| `skills/cmux-team/manager/main.ts` | 修正 | `cmdSpawnAgent` 内で resolver を await + try/catch + `["any"]` fallback |
| `skills/cmux-team/manager/token-store.test.ts` | 修正 | selectToken の tags フィルタ 6 ケースを末尾に追加 |

## 解決方針（A019 設計に準拠）

1. `.team/config.json` の `project_tags` 明示優先（型ガード: Array.isArray + every string）
2. git remote origin URL から host を抽出して org 推定
   - `github.com` / `www.github.com` / `gitlab.com` / `bitbucket.org` → `["any"]`
   - `github.kddi.com` → `["org:kddi"]`、`github.acme.com` → `["org:acme"]`、それ以外は host の最初のラベル
3. 失敗時は `["any"]` で fail-safe（resolver 内部 + caller 側の二重防護）

## テスト結果

```
$ bun test skills/cmux-team/manager/project-tags.test.ts
 23 pass / 0 fail / 24 expect()
$ bun test skills/cmux-team/manager/token-store.test.ts
 74 pass / 1 skip / 0 fail / 140 expect()    # 既存 69 + 新規 5
$ bun test skills/cmux-team/manager/main.test.ts
 169 pass / 0 fail / 417 expect()
$ bunx tsc --noEmit
 (clean)
```

合計 266 pass / 1 skip（Keychain real darwin、既存）/ 0 fail。

## 検品（Inspector）

判定: **GO**（リリース可能）。Critical / Major なし。Minor 4 件はいずれも実機影響極小で後続タスク化推奨:
1. HTTPS URL に port が付くと host にコロンが残る（実環境ではほぼ存在しない）
2. SSH 形式の trailing slash が解析失敗（実環境ではほぼ存在しない）
3. resolver が `TeamConfig` 経由でなく `.team/config.json` 直読み（plan で意識的に選択）
4. git fallback パスは integration test で deep test しない（pure 関数で網羅済）

## 後続タスク提案

1. **`cmdSpawnAgent` フル E2E refactor**（推奨）— `exportVars` build 部分を pure 関数 `buildSpawnExportVars(...)` として export 切り出し
2. **`TeamConfig` への `project_tags` 昇格**（任意）— 仕様 04/05 に正式追加する別タスク
3. **本番 sanity check** — token pool が enabled なプロジェクトで 1 度 spawn-agent を走らせ、`token_pool_assigned` ログを `manager.log` で確認

## 納品

ローカル ff-only マージ → main。
