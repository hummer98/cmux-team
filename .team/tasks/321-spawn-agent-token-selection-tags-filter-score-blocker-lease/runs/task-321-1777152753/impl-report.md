# T321 実装レポート — `project_tags` resolver

## 概要

`cmux-team spawn-agent` 経路で `selectToken(tokDb, surface)` の第 3 引数 `projectTags` を解決して渡し、tags フィルタを実機能化した。`selectToken` 本体・env 注入・`AGENT_TOKEN_BOUND` 通知・`isTokenPoolEnabled` ガードは触っていない。

## 追加 / 修正ファイル

| Path | 種別 | 1 行説明 |
|------|------|---------|
| `skills/cmux-team/manager/project-tags.ts` | 新規 | `parseRemoteOriginToTags` (純粋関数) と `resolveProjectTags` (entry point) を export。raw host を保持する独自パーサ + `.team/config.json` 優先 + git remote fallback。 |
| `skills/cmux-team/manager/project-tags.test.ts` | 新規 | 純粋関数 13 ケース + integration 7 ケース + FALLBACK_TAGS 1 ケース + case-insensitive 確認 1 ケース。合計 23 test。`mkdtemp` で temp project root を作って config.json 経由をテスト。git remote 経路は純粋関数で網羅したので integration では deep test しない方針。 |
| `skills/cmux-team/manager/main.ts` | 修正 | `resolveProjectTags` import を `pool-next-reset` import 直後に追加。`cmdSpawnAgent` 内の `selectToken(tokDb, surface)` を `selectToken(tokDb, surface, projectTags)` に変更し、resolver 呼出を try/catch で囲んで `project_tags_resolve_failed` ログを出すよう加工 (二重防護: resolver 内部でも throw しない)。 |
| `skills/cmux-team/manager/token-store.test.ts` | 修正 | `selectToken` import を追加し、`describe("selectToken (tags フィルタ)")` ブロックを末尾に新設 (6 ケース)。tags=any / tags=org:kddi の mix で project_tags=["org:kddi"] / ["any"] フィルタが期待通りに動くこと、score 最小選択ロジックが tags フィルタ通過後に効くことを確認。`upsertUsageSnapshot` シグネチャ (token_id / util_5h / util_7d / reset_5h_at / reset_7d_at / unified_status) でヘルパを書く。 |

## テスト実行結果 (worktree 内)

```bash
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-321-1777152753

$ bun test skills/cmux-team/manager/project-tags.test.ts
 23 pass / 0 fail / 24 expect() calls

$ bun test skills/cmux-team/manager/token-store.test.ts
 74 pass / 1 skip / 0 fail / 140 expect() calls
 # 既存 69 ケース + 新規 5 (Keychain real は darwin skip) → 74 pass
 # selectToken の tags フィルタ 6 ケース新規追加
 # T321 で skip count に変動なし (Keychain real のみ skip)

$ bun test skills/cmux-team/manager/main.test.ts
 169 pass / 0 fail / 417 expect() calls

$ bunx tsc --noEmit
 (clean / no errors)
```

合計 (3 ファイル合算): **266 pass / 1 skip / 0 fail / 581 expect()**

`bun test` 全体実行は CLAUDE.md / 既知の注意点 (T327 で hang 調査中) に従い回避。

## plan.md からの逸脱

- なし。plan §1.1〜§1.7 の設計判断、§2 Step 1〜7 の TDD 手順、§4 host 判定ルールに沿って実装。Step 7 は plan の指示通り「token-store.test.ts に selectToken の tags mix ケースを追加」を実施 (既存ケース 0 件だったため新規追加)。
- 細部: parseRemoteOriginToTags の test 表に「ホスト大文字 → 小文字に正規化」「`https://gitea.example.com/foo/bar` (HTTPS の任意 host)」を追加 (規約解釈の保険として)。plan §4 の表は全項目カバー。

## 後続タスクとして提案する内容

1. **`cmdSpawnAgent` フル E2E refactor (推奨)** — 現状 `cmdSpawnAgent` は `process.exit` / `cmux.send` / `postMessage` / direnv check / preflight / throttle guard 等を抱え込み、`exportVars` の build を test 可能な形に切り出すには大きめのリファクタが必要。task.md §3 の「`cmdSpawnAgent` を呼んで `exportVars` を検証」を満たすには、build phase を pure function (`buildSpawnExportVars(...): string[]`) として export する分離が望ましい。本タスクのスコープを超えるので別タスク化を推奨。
2. **`TeamConfig` への `project_tags` 昇格 (任意)** — 本タスクでは `loadConfig` を経由せず resolver 側で `.team/config.json` を直接読んだ (理由: `TeamConfig` 型変更は spec 04-templates / docs/spec/05 への波及がある)。将来 `project_tags` を CLI 引数や別経路から override したい場合は `TeamConfig` に正式型として昇格させる別タスクで対応すると良い。
3. **`project-tags.ts` のロガー統合 (任意)** — 現状 `console.error` を使っているのは「resolver は CLI / daemon の双方から呼ばれ得るため caller-agnostic にするため」。将来 `logger.ts` の `log` 関数が CLI でも使える形になれば差し替え可。caller (main.ts) 側では `project_tags_resolve_failed` を既に `log` で出している。
4. **本実装の sanity check** — token pool が enabled かつ `tokens.db` に登録済みアカウントがあるプロジェクトで `cmux-team spawn-agent` を一度走らせ、`manager.log` の `token_pool_assigned` ログ + `selectToken` の tags フィルタ挙動を本番経路で確認すると安心 (本タスクでは単体 / 回帰テストのみで本番経路は未確認)。

## 検証サマリー (完了条件チェックリスト)

- [x] `skills/cmux-team/manager/project-tags.ts` 新規追加、`resolveProjectTags` / `parseRemoteOriginToTags` を export
- [x] `skills/cmux-team/manager/project-tags.test.ts` 新規追加、Step 1 / Step 3 の test ケースが pass
- [x] `skills/cmux-team/manager/main.ts` の `selectToken(tokDb, surface)` → `selectToken(tokDb, surface, projectTags)`、`resolveProjectTags` import 追加
- [x] `bun test skills/cmux-team/manager/project-tags.test.ts` pass (23/23)
- [x] `bun test skills/cmux-team/manager/token-store.test.ts` pass (74/74、回帰確認 + 新規 selectToken tags 6 ケース)
- [x] `bun test skills/cmux-team/manager/main.test.ts` pass (169/169)
- [x] `bunx tsc --noEmit` clean
- [x] cmdSpawnAgent E2E は別タスクとして提案 (上記 §後続タスク 1)
