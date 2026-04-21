# T272 Summary

## タスク概要

GitHub rate limit 枯渇対策として cmux-team daemon 管理の issue/PR キャッシュを整備。Phase 1（DB + REST ETag 差分同期）、Phase 2（CLI `issue/pr/gh`）、Phase 3（TUI Issues タブ）、Phase 4（Claude Code 誘導スキル）を実装。Phase 5（GraphQL Projects V2）は後送り。

## 実施フェーズ

1. **Plan（Planner Agent）** — `plan.md` v1 生成（926 行）
2. **Design Review（Design Reviewer Agent）** — Changes Requested。Must Fix 6 件: Rezi TUI への全面書き直し / pager 既存 viewer 再利用 / `assignees.id` PK / `(host, owner, repo)` 不一致 purge / WAL モード / `schema_version` 削除
3. **Plan v2（Planner Agent）** — Must 6 件 + Should 8 件を反映、1219 行
4. **Design Review v2（Design Reviewer Agent）** — **Approved**
5. **Implementation（Implementer Agent）** — Phase 1-4 を TDD で実装、4 commit、19 files changed、+4886 行
6. **Inspection（Inspector Agent）** — **GO (with minor notes)**

## commit（Phase 単位、4 本）

```
1a86ab5 feat(gh-cache): Phase 1 — DB schema + REST ETag sync + cmdGh (T272)
ce243e6 feat(gh-cache): CLI issue/pr list/show/search コマンド (T272 Phase 2)
b51a437 feat(gh-cache): TUI Issues タブ追加 (T272 Phase 3)
4b57a54 feat(gh-cache): Claude Code 誘導スキル cmux-team-gh 追加 (T272 Phase 4)
```

## 変更ファイル

### 新規
- `skills/cmux-team/manager/gh-cache-types.ts`（zod スキーマ）
- `skills/cmux-team/manager/gh-cache-repo.ts`（git remote 解決）
- `skills/cmux-team/manager/gh-cache-auth.ts`（トークン優先順位 + token_hash）
- `skills/cmux-team/manager/gh-cache-store.ts`（bun:sqlite、WAL、全 CREATE TABLE、CRUD、purge）
- `skills/cmux-team/manager/gh-cache-sync.ts`（REST fetch、初回 500 件、差分 ETag+since、付属データ）
- `skills/cmux-team/manager/gh-cache-format.ts`（gh 互換 JSON field selector）
- `skills/cmux-team/manager/gh-cache-cli.ts`（cmd 実装）
- `skills/cmux-team/manager/gh-cache-*.test.ts`（7 テストファイル）
- `skills/cmux-team-gh/SKILL.md`（誘導スキル）

### 編集
- `skills/cmux-team/manager/main.ts`（+246 行：`issue` / `pr` / `gh` dispatcher + `resolveGhContext`）
- `skills/cmux-team/manager/dashboard.tsx`（+291 行：Issues タブ、Rezi 辞書形式キーバインド、`openArtifactInViewer` 再利用、`O` キー open、`R` キー sync）
- `skills/cmux-team/manager/i18n.ts`（+122 行）
- `.gitignore`（`.team/gh-cache.db{,-wal,-shm}` 追記）

## テスト結果

`cd skills/cmux-team/manager && bun test`: **772 pass / 0 fail**（1883 expect、33 files、36.49 秒）

## Must Fix 反映（Inspector 確認済み、全 OK）

| # | 項目 | 結果 |
|---|---|---|
| 1 | Rezi TUI（ink API 不使用、辞書キーバインド、Shift+Enter → `O`） | OK |
| 2 | pager は `openArtifactInViewer` + `resolveMarkdownViewer` 再利用 | OK |
| 3 | `assignees.id INTEGER PRIMARY KEY, login UNIQUE`、`issue_assignees` FK 修正 | OK |
| 4 | `(host, owner, repo)` 不一致時の自動 purge + `gh_cache_purged reason=repo_mismatch` | OK |
| 5 | `PRAGMA journal_mode=WAL;` を `openGhCacheDB` で実行 | OK |
| 6 | `schema_version` テーブル削除（`PRAGMA table_info` ベース） | OK |

## セキュリティ観点（Inspector 確認済み、全 OK）

- トークン平文ログなし（`token_hash` のみ記録）
- SQL prepared statement `?` プレースホルダ
- 非 git (`exit 2`) / 未認証 (`exit 3`) 時の graceful 終了
- fetch 非 2xx の安全処理

## Minor Notes（PR レビューで対応可能）

- `gh-cache-cli.ts` の一部 CLI エラー文字列が英語ハードコード
- `cmux-team issue/pr --help` が汎用テキストを返す
- `--assignee @login` のドキュメント補強

## 納品

main にマージせず、作業ブランチから PR を作成。本文に #26 参照と Phase 範囲を明記。レビュー後のマージはユーザーが手動で行う。

## PR URL

（完了レポートで更新）
