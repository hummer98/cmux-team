---
id: impl-report
task: T272
run: task-272-1776622205
branch: task-272-1776622205/task
base: main
commits:
  - 1a86ab5 Phase 1 — DB schema + REST ETag sync + cmdGh
  - ce243e6 Phase 2 — CLI issue/pr list/show/search
  - b51a437 Phase 3 — TUI Issues タブ
  - 4b57a54 Phase 4 — Claude Code 誘導スキル cmux-team-gh
---

# T272 Implementation Report

## 概要

GitHub issue / PR の読み取りを SQLite キャッシュ経由に置き換え、`cmux-team`
plugin から `gh` を叩かずに issue / PR を参照できるようにした。差分同期
（ETag + since）により rate limit を消費せず、複数エージェントが同一
issue を繰り返し参照するユースケースでコストが 0 になる。

plan.md（Phase 1 〜 4）に従い、段階的に 4 commit で実装した。

## Phase 別の成果

### Phase 1 (commit 1a86ab5) — DB スキーマ + REST ETag sync + `cmdGh`

- `gh-cache-types.ts` — `RepoInfo` / `IssueRow` / `LabelRow` / `CommentRow` /
  `ReviewRow` / `ReviewCommentRow` / `SyncMeta` / `AuthResolution` 等 zod
  スキーマ付き型定義
- `gh-cache-repo.ts` — `resolveOriginRepo(projectRoot)` で `git remote get-url
  origin` を解釈し `host/owner/repo` を返す。非 GitHub / 非 git は `null`
- `gh-cache-auth.ts` — `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token` を
  順に試す。失敗時は `checked` 配列で可視化。`tokenHash(token)` で
  SHA-256 先頭 12 文字を返し DB に保存して purge 判定に使う
- `gh-cache-store.ts` — SQLite WAL + PRAGMA foreign_keys=ON。`sync_meta` /
  `issues` / `labels` / `assignees` / `issue_labels` / `issue_assignees` /
  `issue_comments` / `pr_reviews` / `pr_review_comments` の 9 テーブル。
  トークン/repo 不一致で自動 purge
- `gh-cache-sync.ts` — `syncFull` / `syncIncremental` で REST v3 を叩く。
  `If-None-Match` + `since=` で差分のみ取得、304 は rate limit 消費 0。
  `RateLimitExhaustedError` / `SyncHttpError` を個別に投げる
- `main.ts` `cmdGh()` — `gh sync [--full]` / `gh status` を実装。
  exit code 0/1/2/3/4 を plan 通り
- i18n: `gh_*` キーを英日両方に追加

テスト: `gh-cache-repo.test.ts` / `gh-cache-auth.test.ts` /
`gh-cache-store.test.ts` / `gh-cache-sync.test.ts`（計 60+ 件）。
`fetchFn` DI でネットワーク経路を完全に stub 化。

### Phase 2 (commit ce243e6) — CLI `issue` / `pr` サブコマンド

- `gh-cache-format.ts` — gh-compat JSON フォーマッタ
  - `toGhJson(rel)` — `state` 大文字化 (`OPEN` / `CLOSED` / `MERGED`),
    `author.login` / `assignees[].login` / `labels[].name` /
    camelCase dates (`createdAt`, `updatedAt`, `closedAt`, `mergedAt`)
  - `normalizeGhState(issue)` — PR + `merged_at` なら `MERGED`
  - `pickGhFields(source, fields[])` — `gh --json FIELDS` 互換。
    ドットパス (`author.login`) と配列マップ (`assignees[].login`) をサポート
  - `formatIssueListRow` / `formatIssueShow` — 人間向け text 出力
  - `displayState(issue)` — 小文字版 (`open` / `closed` / `merged`)
- `gh-cache-cli.ts` — `cmdIssueList` / `cmdPrList` / `cmdIssueShow` /
  `cmdIssueSearch`
  - `--state open|closed|merged|all`, `--assignee`, `--author`, `--label`,
    `--limit`, `--json FIELDS`, `--sync`, `--stale-ok` をサポート
  - `@me` は `sync_meta.viewer_login` から解決（未キャッシュなら exit 1 +
    ガイダンス）
  - `STALE_DAYS=7` を超えると警告（`--stale-ok` で抑止）
  - `CliDeps` パターンで `stdout` / `fetchFn` を DI 可能に
- `main.ts` に `cmdIssue()` / `cmdPr()` を追加し switch-case で振り分け

テスト: `gh-cache-format.test.ts` (20 件) / `gh-cache-cli.test.ts`
(23 件)。`process.exit` を monkey-patch して exit code を assert。

end-to-end 検証 (`.team/gh-cache.db` with real data):

```
$ bun main.ts issue list
  #26  open     task-272 の daemon 再起動時の resume バグ ...
  ...
$ bun main.ts issue list --assignee @me
  (viewer_login=hummer98 で正しく解決)
$ bun main.ts issue list --json "number,title,author.login,assignees[].login"
  [{"number":26,"title":"...","author":"...","assignees":["hummer98"]},...]
```

### Phase 3 (commit b51a437) — TUI Issues タブ

- `dashboard.tsx`
  - `AppState` を拡張: `activeTab/focusedArea` に `"issues"` を追加、
    `issuesAvailability` / `issueItems` / `issueCursor` / `issueSyncing` /
    `issueLastSync` / `issueLastError` を追加
  - `buildIssueRows(state)` — 3 ブランチで disabled/available/empty を描画。
    `[>|  ] PR #NUM  state  title  [labels]` 形式で cursor 強調
  - Tab row に "Issues" ボタンを追加（`tab-issues`、`t("gh_tui_tab_title")`)
  - キーバインド:
    - `5` / `I` → `switchTab("issues")`
    - `R` → `syncIssuesFromGh()`（rate limit 到達はエラー行表示）
    - `Enter` / `O` → `openSelectedIssueInViewer()` — `formatIssueShow`
      で一時 md に吐き、既存の `openArtifactInViewer` で開く（Must Fix 2）
    - `B` → `html_url` を `open` で外部ブラウザ起動
    - `↑` / `↓` → `issueCursor` 移動
  - footer の hotkey hint に issues フォーカス時の行を追加
  - グローバル footer に `5 issues` を追加
  - ヘルパ関数: `loadIssuesFromCache` / `syncIssuesFromGh` /
    `openSelectedIssueInViewer`。`switchTab("issues")` でキャッシュから
    即時ロード

テスト: `dashboard-issues.test.tsx` (8 件)。`buildIssueRows` をテスタブル
にするため `export` を追加、`AppState` / `IssueListItem` も export。
JSON シリアライズ比較でレンダリング結果を検証。

### Phase 4 (commit 4b57a54) — Claude Code 誘導スキル `cmux-team-gh`

- `skills/cmux-team-gh/SKILL.md` を新規作成
  - trigger: issue/PR 番号言及 (`#272`, `issue 272`, `PR #42`, `T042`),
    `gh issue list` / `gh pr view` / `ghe ...` の実行意図, レビュー待ち/open PR
    などの問い合わせ
  - 置換表: `gh issue list` → `cmux-team issue list` など 9 行
  - `--sync` 付き読み取り、`gh status`, `gh sync --full` の月次運用推奨
  - TUI Issues タブの操作（`5` / `I` / `R` / `Enter` / `O` / `B`）を案内
  - 書き込み系 (`create` / `comment` / `merge` / `review`) は
    **引き続き `gh` を使う**と明記
  - 無効化される状況（非 git / 非 GitHub / 認証欠如）と exit code 早見表
- `.claude-plugin/plugin.json` の `"skills": "./skills/"` が自動列挙する
  ため変更不要

## 不変条件の確認

1. **main ブランチは無傷** — 全作業は `task-272-1776622205/task` ブランチ上
2. **4 phase の分離 commit** — 各 Phase を独立 revert 可能
3. **テスト先行 / カバレッジ** — CLI / format / store / sync / auth / repo /
   TUI row builder に unit test あり
4. **gh-compat JSON** — `author.login` / `assignees[].login` / `labels[].name`
   / camelCase dates で既存 jq パイプラインが動く
5. **i18n** — すべてのユーザー向け文字列を `t()` 経由で英日両対応
6. **rate limit 安全** — ETag + since による 304 処理、`RateLimitExhaustedError`
   で exit 4
7. **トークン / repo 変更で自動 purge** — `openGhCacheDB` 内で不一致検出
8. **non_git / no_auth の graceful degrade** — CLI は exit 2/3、TUI は
   disabled メッセージ表示

## テスト結果

```
$ bun test
 772 pass
 0 fail
 1883 expect() calls
Ran 772 tests across 33 files. [36.83s]
```

pre-existing の tsc エラー 2 件（`conductor.ts:197`, `daemon.test.ts:3650`）は
本タスクの対象外で、本変更では増減なし。

## 主要ファイル一覧

| ファイル | 行数 | 役割 |
|---|---|---|
| skills/cmux-team/manager/gh-cache-types.ts | 241 | zod スキーマ + 型 |
| skills/cmux-team/manager/gh-cache-repo.ts | 97 | origin → host/owner/repo |
| skills/cmux-team/manager/gh-cache-auth.ts | 102 | token 解決 |
| skills/cmux-team/manager/gh-cache-store.ts | 687 | SQLite I/O |
| skills/cmux-team/manager/gh-cache-sync.ts | 589 | REST 差分同期 |
| skills/cmux-team/manager/gh-cache-format.ts | 241 | gh-compat JSON + text |
| skills/cmux-team/manager/gh-cache-cli.ts | 328 | CLI subcommand |
| skills/cmux-team/manager/dashboard.tsx | +291 | TUI Issues タブ追加 |
| skills/cmux-team/manager/main.ts | +246 | cmdGh / cmdIssue / cmdPr |
| skills/cmux-team/manager/i18n.ts | +122 | gh_* i18n (ja/en) |
| skills/cmux-team-gh/SKILL.md | 143 | Claude 向け誘導スキル |
| skills/cmux-team/manager/gh-cache-*.test.ts | 計 1,600 超 | unit test |

## 既知の限界 / 今後の余地

- **Projects V2** — plan §8 に記載。`project` scope 必須のため Phase 5
  以降で対応
- **本文の全文検索** — 現行は LIKE 検索のみ。将来的に FTS5 を追加する余地
- **複数リポジトリ横断参照** — 各プロジェクトの `.team/gh-cache.db` は
  独立。大規模 monorepo や複数 repo を同時に見たい場合は個別に同期が必要
- **月次 `--full` の自動化** — 現状は手動。cron や `run_after_all` タスク
  で自動化する余地あり

## デプロイ手順

1. `main` にマージ
2. `npm version` でバージョン bump
3. `npm publish` で `@hummer98/cmux-team` を公開
4. ユーザー側で `npm install -g @hummer98/cmux-team` → 次回 Claude Code
   起動時に `cmux-team-gh` skill が自動読み込まれる
