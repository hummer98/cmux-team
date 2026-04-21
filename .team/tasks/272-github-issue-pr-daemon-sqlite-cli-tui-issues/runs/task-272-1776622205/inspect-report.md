# T272 Inspection Report

## 判定
GO (with minor notes)

## 総評

Implementer の成果物は plan.md の Phase 1〜4 を完遂しており、Must Fix 6 件すべて
反映済み。Rezi TUI の dict 形式キーバインド、pager 再利用、assignees.id PK、
repo_mismatch purge、WAL モード、schema_version 削除がすべてソースコード上で確認
できた。セキュリティ観点（トークン平文ログなし、prepared statement、fetch 非 2xx
の安全処理、非 git/未認証時の exit 2/3 での graceful 終了）も問題なし。テスト 7
ファイルが揃い `bun test` 772 pass / 0 fail を達成。CLI の一部 `Usage:` /
`Error: invalid ...` 文字列と `issue --help` / `pr --help` の汎用化が軽微な改善
余地として残るが、GO 判定を妨げるレベルではない。

## Must Fix 反映状況

1. Must-1 (Rezi TUI): **OK** — `dashboard.tsx` に `useInput` / `rawMode` / `ink` /
   `shift+Enter` の痕跡なし（grep 0 件）。キーバインドは辞書形式（`"1"`〜`"5"`,
   `Tab`, `"J"`, `"L"`, `"A"`, `"I"`, `"R"`, `"B"`, `"O"`, `"Enter"`）。
   Shift+Enter の代替として `"O"` キーが `openSelectedIssueInViewer` に bind
   されている（dashboard.tsx:1535-1540）
2. Must-2 (pager 再利用): **OK** — `openSelectedIssueInViewer`（dashboard.tsx:
   1758-1799）は既存 `openArtifactInViewer(app, tmpPath, callback)` を再利用し、
   artifacts/tasks/settings タブと同じ callback パターン。独自 `spawn(...
   { stdio: "inherit" })` は Issues タブ導線に存在しない
3. Must-3 (assignees PK): **OK** — `gh-cache-store.ts:107-122` で
   `assignees (id INTEGER PRIMARY KEY, login TEXT NOT NULL, UNIQUE(login))` と
   `issue_assignees (..., PRIMARY KEY (issue_number, user_id),
   FOREIGN KEY (user_id) REFERENCES assignees(id))` が確認できた。対応テスト
   `linkIssueAssignee は assignees.id を PK に使う` が `gh-cache-store.test.ts`
   line 167 に存在
4. Must-4 (repo_mismatch purge): **OK** — `openGhCacheDB`（gh-cache-store.ts:
   182-198）で現在 DB の `(host, owner, repo)` と新規 repoInfo の不一致時、
   および `token_hash` 不一致時に `purgeAll` + `gh_cache_purged reason=
   repo_mismatch|token_rotated` をログ出力する実装になっている
5. Must-5 (WAL): **OK** — `gh-cache-store.ts:169` で `db.exec("PRAGMA journal_mode
   =WAL;")` が DB オープン直後に実行され、`PRAGMA foreign_keys=ON` と合わせて
   初期化される
6. Must-6 (schema_version 削除): **OK** — `grep -n schema_version
   gh-cache-store.ts` で 0 件。マイグレーションは `ensureSyncMetaColumns` /
   `ensureAssigneesColumns` が `PRAGMA table_info` ベースで実装されており、
   trace-store.ts の `ensureTaskSessionsColumns` 相当パターンを踏襲している

## セキュリティ観点

- トークン漏れ: **OK** — `gh-cache-auth.ts` / `gh-cache-sync.ts` /
  `gh-cache-cli.ts` / `main.ts`（cmdGhStatus）すべて token を平文で
  `console.log` / `log()` / エラーメッセージに出していない。`tokenHash()`
  （SHA-256 先頭 32hex）のみが status 表示や `sync_meta.token_hash` 比較に使用
- SQL インジェクション対策: **OK** — `gh-cache-store.ts` のクエリはすべて
  prepared statement（`?` プレースホルダ）。`setSyncMeta` で使う `${setClause}`
  は `Object.entries(SyncMetaPatch)` から生成される固定キーセット（ユーザー入力
  非依存）なので安全
- 非 git/未認証時の crash 回避: **OK** — `resolveGhContext`（main.ts:4130-4152）
  で非 git 時 exit 2、auth 解決不能時 exit 3 を返し、`t("gh_not_a_github_repo")` /
  `t("gh_auth_missing")` のガイダンスメッセージを表示。dashboard.tsx の
  Issues タブも `issuesAvailability = "non_git" | "no_auth"` を介して UI 側で
  ガードされ crash しない

## テスト

- `bun test` pass/fail: 772 pass / 0 fail（prompt で確認済み）
- テストファイル網羅: **OK**
  - `gh-cache-store.test.ts`（WAL / assignees.id PK / token_hash purge /
    repo_mismatch purge / FK cascade / upsert）
  - `gh-cache-auth.test.ts`（env 優先順位・ghe host 判定・token_hash）
  - `gh-cache-repo.test.ts`（git remote 解決・非 git 判定）
  - `gh-cache-sync.test.ts`（fetch mock で初回 / 差分 / 304）
  - `gh-cache-format.test.ts`（JSON field selector `assignees[].login`）
  - `gh-cache-cli.test.ts`（CLI 引数パーサ）
  - `dashboard-issues.test.tsx`（TUI state 単体テスト）

## Minor Notes (GO でも気になる点)

- `gh-cache-cli.ts:256, 264, 279, 314` の CLI エラー文字列（`Usage: cmux-team
  issue show <number>` / `Error: invalid number: ${numRaw}` / `Error: #${number}
  is a ${issue.type}...` / `Usage: cmux-team issue search <query>`）がハード
  コードの英語のまま。CLI エラー経路としては許容範囲だが、plan §i18n 方針に
  厳密に沿うなら `t()` 経由が望ましい
- `cmux-team issue --help` / `cmux-team pr --help` が汎用 `gh_help` テキストを
  返すため、issue/pr 固有のサブコマンド一覧・フラグが表示されない。UX の観点では
  将来 `gh_issue_help` / `gh_pr_help` を追加するとよい
- `gh-cache-cli.ts:128, 143` の `raw.startsWith("@") ? raw.slice(1) : raw` で
  `--assignee @foo` が動作するが、コメント・ドキュメントに `@me` 以外の
  `@login` 形式もサポートする旨を明記するとユーザーが分かりやすい
