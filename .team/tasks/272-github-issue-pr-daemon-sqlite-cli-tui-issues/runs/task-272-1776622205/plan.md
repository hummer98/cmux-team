# T272 実装計画 v2: GitHub issue/PR キャッシュ

対応 issue: #26
対応タスク: T272
Planner: Planner Agent（task-272-1776622205）
作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-272-1776622205`
レビュー反映: `review-v1.md`（Must Fix 6 / Should Fix 8 / Nice to Have 2）

---

## 1. 概要

### 目的

GitHub rate limit 枯渇を避けるため、cmux-team daemon が管理する SQLite キャッシュを
導入し、issue / PR とその付属データ（comments, reviews, review_comments, labels,
assignees, reactions, milestones）へ読み取り系アクセスを提供する。`gh issue list` /
`gh pr view` に相当するオペレーションをキャッシュ経由で高速化しつつ、**書き込みは
`gh` に委ねる**。

### 非目的（やらないこと）

- **書き込み系 API のラッピング** — create / comment / close / merge は対象外。ユーザーは `gh` / `ghe` を引き続き使う
- **複数 repo 対応** — 1 プロジェクト = 1 フォルダ = 1 origin repo。モノレポ等で複数 origin を扱う要件は対象外
- **自動定期 sync** — rate 消費を読みにくくするため、daemon による定期 poll は実装しない。手動 `cmux-team gh sync` および TUI `R` キー のみ
- **Linux の `xdg-open` サポート** — Phase 3 のブラウザ起動は macOS `open` のみ。必要になれば後送り
- **Phase 5（GraphQL Projects V2）の本タスク内での完遂** — 任意・後送り可

### 前提

- 起動ディレクトリが git repo で、`origin` remote が GitHub（github.com または GHE）を指していること。非 git / 非 GitHub origin では機能を無効化する
- `GITHUB_TOKEN` / `GH_TOKEN` / `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` のいずれか、または `gh auth status` で認証済みであること
- cmux-team は Bun ランタイム前提（`bun:sqlite` を利用）
- macOS 前提（Phase 3 の `open` コマンドのみ影響）

---

## 2. アーキテクチャ

### DB ファイル配置

```
.team/
├── traces/traces.db          # 既存: trace DB（rotation 対象・短寿命）
└── gh-cache.db               # 新設: GitHub キャッシュ（長期保持、GC ポリシー分離）
```

**DB を分離する理由**（conductor-prompt.md の設計判断より）:
- trace DB は rotation 対象で WAL を短期で切る前提。gh キャッシュは長期保持が前提で GC が噛み合わない
- `.team/traces/` と `.team/` 直下を分ける既存慣習に沿う（artifacts / tasks / logs はすでに flat）

### モジュール責務分担

新規ファイルはすべて `skills/cmux-team/manager/` 配下に置く。

| ファイル | 責務 |
|---|---|
| `gh-cache-store.ts` | `gh-cache.db` 初期化・マイグレーション・CRUD アクセサ。bun:sqlite |
| `gh-cache-sync.ts` | GitHub REST fetch、初回 500 件、差分同期、ETag 管理、rate limit 監視 |
| `gh-cache-auth.ts` | トークン解決フロー（env → `gh auth token`）、token hash 生成、ghe host 検出 |
| `gh-cache-repo.ts` | `git remote get-url origin` からの `{host, owner, repo}` 解決、非 git 判定 |
| `gh-cache-format.ts` | gh 互換 JSON フィールド selector（`--json state,title,assignees[].login`）、gh 互換レコード整形 |
| `gh-cache-cli.ts` | `cmdGhSync`, `cmdGhStatus`, `cmdIssueList/Show/Search`, `cmdPrList/Show` の実装。main.ts から呼ぶ |
| `gh-cache-types.ts` | zod スキーマ（API レスポンス / CLI 引数 / DB レコード型） |
| `dashboard.tsx`（追記） | Issues タブ（Phase 3） |
| `main.ts`（追記） | switch 分岐に `gh` / `issue` / `pr` サブコマンドを追加 |

### 依存関係（text 図）

```
main.ts (switch)
  └─ gh-cache-cli.ts
       ├─ gh-cache-repo.ts        ── git remote 解決
       ├─ gh-cache-auth.ts        ── トークン解決
       ├─ gh-cache-store.ts       ── bun:sqlite
       ├─ gh-cache-sync.ts        ── fetch + 書き込み
       │    └─ (store, auth, repo)
       └─ gh-cache-format.ts      ── JSON 整形

dashboard.tsx
  └─ gh-cache-store.ts (read-only)  ── Issues タブのリスト
  └─ gh-cache-cli.ts (R キーで sync 呼び出し)
```

**外部依存（新規）:**
- **なし（最小構成）** — fetch は Node 18+ / Bun の global `fetch` を使う。`@octokit/*` は入れない
- 既存 `zod` / `bun:sqlite` だけで完結させる
- 理由: `@octokit/rest` を入れるとリクエスト整形は楽になるが、ETag / `If-None-Match` / rate limit ヘッダー取得等を自力で触る必要があり、薄い fetch ラッパのほうが挙動把握しやすい

### 既存 rate-limit 実装との役割分担（Should Fix 5 反映）

`skills/cmux-team/manager/rate-limit-display.ts` / `rate-limit-persistence.ts` は
**Anthropic API の rate limit 表示 / 永続化専用**。GitHub の rate limit と混同しない。

- **再利用しない**（責務が異なる: Anthropic は 5h / API weights 単位、GitHub は 5000/hour / REST 単位）
- 同ファイルから `buildRateLimitDisplay` や `isStale` を import しない
- GitHub 側の rate limit 表示は本タスクで新設する。UI デザイン（色分け、残量警告）は
  参考にしてよいが、ロジックは共有しない

---

## 3. Phase 1〜4 の詳細実装計画

### Phase 1 実装原則（全ファイル共通 — Should Fix 8 反映）

- **bun:sqlite の prepared statement を必ず使う**。`db.prepare("INSERT ... VALUES (?, ?)")` +
  `.run(value1, value2)` の形式。テンプレートリテラルの `${}` で GitHub 由来文字列を埋め込まない
- **zod 経由で API レスポンスを parse** してから DB に入れる。生 JSON のフィールド欠損を
  `raw_json` 以外の列で扱う前に検証する
- **UI / ログ / エラーメッセージの文字列は `i18n.ts` に集約**（Should Fix 4 反映）。
  `cmdGhSync` / `cmdGhStatus` / Issues タブ / 認証エラー案内は全て新規キーを
  `i18n.ts` に追加して `t()` 経由で出す。ハードコードした日本語・英語文字列を置かない

### Phase 1: `.team/gh-cache.db` スキーマ + REST ETag キャッシュ + `cmux-team gh sync` (500 件初回)

#### 追加ファイル

| ファイル | 目的 | 主な export |
|---|---|---|
| `skills/cmux-team/manager/gh-cache-store.ts` | DB 初期化・CRUD | `openGhCacheDB(projectRoot, repoInfo, authTokenHash)`, `upsertIssue(db, row)`, `upsertComment`, `upsertReview`, `upsertReviewComment`, `upsertLabel`, `upsertAssignee`, `upsertReaction`, `upsertMilestone`, `getSyncMeta(db)`, `setSyncMeta(db, patch)`, `purgeAll(db, reason)` |
| `skills/cmux-team/manager/gh-cache-auth.ts` | 認証解決 | `resolveGithubToken(host)`, `tokenHash(token)`, `AuthResolution = { kind: "env" \| "gh-cli" \| "none"; token?: string; host: string }` |
| `skills/cmux-team/manager/gh-cache-repo.ts` | repo 解決 | `resolveOriginRepo(cwd): { host, owner, repo } \| null`, `isGitRepo(cwd): boolean` |
| `skills/cmux-team/manager/gh-cache-sync.ts` | 同期ロジック | `syncFull(db, deps): Promise<SyncResult>`, `syncIncremental(db, deps)`, `fetchRateLimit(deps): Promise<RateLimit>`, `resolveViewerLogin(db, deps)` |
| `skills/cmux-team/manager/gh-cache-types.ts` | zod 型 | `IssueRow`, `CommentRow`, `ReviewRow`, `SyncMeta`, `SyncResult` |

#### DB スキーマ（`CREATE TABLE` 案）

`schema_version` テーブルは **削除**（Must Fix 6 反映 — YAGNI）。マイグレーションは
`trace-store.ts:140 ensureTaskSessionsColumns` と同じ `PRAGMA table_info` ベースで行う。
実際に破壊的変更が必要になった時点で `schema_version` を導入する。

```sql
-- issue / PR 本体（同一テーブルに格納、type 列で区別）
CREATE TABLE IF NOT EXISTS issues (
  number         INTEGER PRIMARY KEY,
  type           TEXT    NOT NULL CHECK (type IN ('issue','pr')),
  state          TEXT    NOT NULL,          -- open / closed / merged（PR のみ）
  title          TEXT    NOT NULL,
  body           TEXT,
  author_login   TEXT,
  author_id      INTEGER,
  created_at     TEXT    NOT NULL,          -- ISO 8601
  updated_at     TEXT    NOT NULL,          -- ISO 8601（差分同期の基準）
  closed_at      TEXT,
  merged_at      TEXT,                      -- PR のみ
  html_url       TEXT    NOT NULL,
  comments_count INTEGER NOT NULL DEFAULT 0,
  milestone_id   INTEGER,
  draft          INTEGER,                   -- PR のみ 0/1
  etag           TEXT,                      -- 個別 issue fetch 時の ETag
  fetched_at     TEXT    NOT NULL,          -- キャッシュ取得時刻
  raw_json       TEXT                       -- API レスポンス全体（将来 NULL 化 GC の対象）
);
CREATE INDEX IF NOT EXISTS idx_issues_updated  ON issues(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_state    ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_type     ON issues(type);

-- issue コメント
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY,         -- GitHub comment ID
  issue_number  INTEGER NOT NULL,
  author_login  TEXT,
  body          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  html_url      TEXT,
  raw_json      TEXT,
  FOREIGN KEY (issue_number) REFERENCES issues(number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_number);

-- PR レビュー（review イベント単位）
CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY,         -- GitHub review ID
  pr_number     INTEGER NOT NULL,
  author_login  TEXT,
  state         TEXT    NOT NULL,            -- APPROVED / CHANGES_REQUESTED / COMMENTED 等
  body          TEXT,
  submitted_at  TEXT,
  raw_json      TEXT,
  FOREIGN KEY (pr_number) REFERENCES issues(number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number);

-- PR レビューコメント（diff に紐づく inline コメント）
CREATE TABLE IF NOT EXISTS review_comments (
  id            INTEGER PRIMARY KEY,
  pr_number     INTEGER NOT NULL,
  review_id     INTEGER,
  author_login  TEXT,
  body          TEXT    NOT NULL,
  path          TEXT,
  line          INTEGER,
  original_line INTEGER,
  commit_id     TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  raw_json      TEXT,
  FOREIGN KEY (pr_number) REFERENCES issues(number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_comments_pr ON review_comments(pr_number);

-- issue / PR と label の多対多
CREATE TABLE IF NOT EXISTS labels (
  id          INTEGER PRIMARY KEY,           -- GitHub label ID
  name        TEXT    NOT NULL,
  color       TEXT,
  description TEXT
);
CREATE TABLE IF NOT EXISTS issue_labels (
  issue_number INTEGER NOT NULL,
  label_id     INTEGER NOT NULL,
  PRIMARY KEY (issue_number, label_id),
  FOREIGN KEY (issue_number) REFERENCES issues(number) ON DELETE CASCADE,
  FOREIGN KEY (label_id)     REFERENCES labels(id)     ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_labels_issue ON issue_labels(issue_number);

-- issue / PR と assignee の多対多（Must Fix 3 反映）
-- stable PK は GitHub user ID。login は変更可能なので UNIQUE 列に格下げ。
CREATE TABLE IF NOT EXISTS assignees (
  id           INTEGER PRIMARY KEY,           -- GitHub user ID（stable）
  login        TEXT    NOT NULL,              -- 変更可能（表示用）
  avatar_url   TEXT,
  UNIQUE(login)
);
CREATE INDEX IF NOT EXISTS idx_assignees_login ON assignees(login);

CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_number INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,              -- GitHub user ID（assignees.id と一致）
  PRIMARY KEY (issue_number, user_id),
  FOREIGN KEY (issue_number) REFERENCES issues(number)   ON DELETE CASCADE,
  FOREIGN KEY (user_id)      REFERENCES assignees(id)    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_assignees_user ON issue_assignees(user_id);

-- reaction（issue / comment / review_comment への :+1: 等）
CREATE TABLE IF NOT EXISTS reactions (
  id            INTEGER PRIMARY KEY,          -- GitHub reaction ID
  target_type   TEXT    NOT NULL CHECK (target_type IN ('issue','comment','review_comment')),
  target_id     INTEGER NOT NULL,             -- issue.number / comment.id / review_comment.id
  content       TEXT    NOT NULL,             -- +1 / -1 / laugh / hooray / confused / heart / rocket / eyes
  user_login    TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);

-- milestone
CREATE TABLE IF NOT EXISTS milestones (
  id          INTEGER PRIMARY KEY,
  number      INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  state       TEXT,
  due_on      TEXT,
  raw_json    TEXT
);

-- 同期メタデータ（キー = 固定文字列 'global' の 1 行だけ使う）
CREATE TABLE IF NOT EXISTS sync_meta (
  key                   TEXT    PRIMARY KEY,      -- 'global' 固定
  token_hash            TEXT    NOT NULL,         -- SHA-256(token) 先頭 32hex（Nice to Have 4 反映）
  host                  TEXT    NOT NULL,         -- 'api.github.com' or 'ghe.example.com/api/v3'
  owner                 TEXT    NOT NULL,
  repo                  TEXT    NOT NULL,
  viewer_login          TEXT,                     -- Should Fix 3: GET /user の login（@me 解決用）
  etag_issues_list      TEXT,                     -- /repos/{o}/{r}/issues?... の ETag
  last_full_sync        TEXT,
  last_incremental_sync TEXT,
  rate_limit_remaining  INTEGER,
  rate_limit_reset      TEXT,                     -- ISO 8601
  last_error            TEXT                      -- 直近の sync エラーメッセージ
);
```

**マイグレーション方式**: 初回は `db.exec(SCHEMA)` で `CREATE TABLE IF NOT EXISTS` により冪等。
将来の列追加は `trace-store.ts:140 ensureTaskSessionsColumns` のパターンで `PRAGMA table_info` → 欠損列のみ `ALTER TABLE ADD COLUMN`。
`schema_version` テーブルは設けない（Must Fix 6）。

#### `openGhCacheDB` の初期化フロー（Must Fix 4, 5 反映）

```ts
export function openGhCacheDB(
  projectRoot: string,
  repoInfo: { host: string; owner: string; repo: string },
  currentTokenHash: string,
): Database {
  const dir = join(projectRoot, ".team");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "gh-cache.db"));

  // Must Fix 5: WAL モードで開く（trace-store.ts:115 と同一）。
  // TUI Issues タブの reader と `gh sync` の writer が並行するため必須。
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  db.exec(SCHEMA);
  ensureAssigneesColumns(db);   // PRAGMA table_info ベースの欠損列補完
  ensureSyncMetaColumns(db);    // viewer_login 等の追加に対応

  // Must Fix 4: token_hash / (host, owner, repo) のいずれかが不一致なら purge
  const meta = db.prepare("SELECT token_hash, host, owner, repo FROM sync_meta WHERE key='global'").get() as
    | { token_hash: string; host: string; owner: string; repo: string }
    | undefined;

  if (meta) {
    const tokenMismatch = meta.token_hash !== currentTokenHash;
    const repoMismatch  = meta.host !== repoInfo.host
                       || meta.owner !== repoInfo.owner
                       || meta.repo  !== repoInfo.repo;

    if (tokenMismatch || repoMismatch) {
      const reason = tokenMismatch ? "token_rotated" : "repo_mismatch";
      purgeAll(db, reason);   // 全テーブル DELETE + sync_meta 再 INSERT
      log("gh_cache_purged", `reason=${reason} old_hash=${meta.token_hash} new_hash=${currentTokenHash} ` +
                             `old_repo=${meta.host}/${meta.owner}/${meta.repo} ` +
                             `new_repo=${repoInfo.host}/${repoInfo.owner}/${repoInfo.repo}`);
    }
  }
  return db;
}
```

**`purgeAll(db, reason)` の責務**:
- `issues` / `comments` / `reviews` / `review_comments` / `issue_labels` / `labels` /
  `issue_assignees` / `assignees` / `reactions` / `milestones` を `DELETE`
- `sync_meta` に新 `(token_hash, host, owner, repo)` を `INSERT OR REPLACE`（ETag / last_*_sync / viewer_login は NULL に戻す）
- ログ `gh_cache_purged reason=...` を emit（reason は `token_rotated` / `repo_mismatch`）

#### `cmux-team gh sync` 実装（main.ts への追記）

**switch 分岐の追加**（main.ts:4258 付近）:

```ts
case "gh":
  await cmdGh();          // sync / status / list / sub-sub dispatch
  break;
case "issue":
  await cmdIssue();       // list / show / search dispatch
  break;
case "pr":
  await cmdPr();          // list / show dispatch
  break;
```

**引数パース方針**（Should Fix 6 反映）: 既存 `cmdSend` / `cmdTraceHooks`（main.ts:3829 付近）と
**同じ引数パース方式**に揃える。独自の `hasHelpFlag()` ヘルパは新設しない — `hasFlag("help")`
で統一する。サブサブコマンドは `args[1]` を見て分岐する（既存 `cmdSend` が同形式）。

```ts
async function cmdGh(): Promise<void> {
  const sub = args[1];
  if (!sub || hasFlag("help")) {
    console.log(t("gh_help"));   // i18n キー（Should Fix 4）
    process.exit(0);
  }
  switch (sub) {
    case "sync":   return cmdGhSync();
    case "status": return cmdGhStatus();
    default:
      console.error(t("gh_unknown_subcommand", { sub }));
      process.exit(1);
  }
}
```

**`cmdGhSync` の骨子**:

```ts
async function cmdGhSync(): Promise<void> {
  const full = hasFlag("full");
  const repoInfo = resolveOriginRepo(process.cwd());
  if (!repoInfo) {
    console.error(t("gh_not_a_github_repo"));
    process.exit(2);
  }
  const auth = await resolveGithubToken(repoInfo.host);
  if (auth.kind === "none") {
    console.error(t("gh_auth_missing", { host: repoInfo.host }));
    process.exit(3);
  }
  const db = openGhCacheDB(PROJECT_ROOT, repoInfo, tokenHash(auth.token!));
  const deps = { auth, repoInfo, db, logger: log };

  // Should Fix 3: sync 開始時に GET /user で viewer_login を一度だけ保存
  await resolveViewerLogin(db, deps);

  const result = full ? await syncFull(deps) : await syncIncremental(deps);
  db.close();
  console.log(formatSyncResult(result));   // i18n 経由
}
```

**exit code 規約**:
- 0: 成功
- 1: 一般エラー
- 2: 前提不備（非 git、origin 非 GitHub）
- 3: 認証不備
- 4: rate limit 枯渇（sync 中断）

**ログイベント名**（logger.ts 経由、全て snake_case + `key=value` 形式）:
- `gh_sync_started` — `mode=full|incremental host=... owner=... repo=...`
- `gh_sync_completed` — `fetched_issues=N fetched_comments=M duration_ms=...`
- `gh_sync_failed` — `stage=... http_status=... message=...`
- `gh_sync_rate_limited` — `remaining=0 reset_at=...`
- `gh_auth_resolved` — `kind=env|gh-cli host=...`
- `gh_auth_failed` — `reason=no_token|gh_auth_token_failed`
- `gh_cache_purged` — `reason=token_rotated|repo_mismatch ...`（Must Fix 4 で reason 拡張）
- `gh_viewer_resolved` — `login=... host=...`（Should Fix 3）

#### `cmdGhStatus`（Should Fix 1 反映）

**出力は i18n 経由**（Should Fix 4）。以下は日本語ロケールの例:

```
最終 full sync:        2026-04-20T09:12:00+09:00（4 日前）   ← Should Fix 1: N 日経過を表示
最終 incremental sync: 2026-04-20T14:30:00+09:00
host:                  api.github.com
repo:                  owner/repo
viewer:                yamamoto                               ← Should Fix 3: @me 解決の根拠
issue:                 342 件 (open=87, closed=255)
PR:                    158 件 (open=12, closed=140, merged=128)
comments:              1423 件
rate limit:            4832 / 5000（reset: 2026-04-20T15:00:00+09:00）
token hash:            e3b0c442b98f1a2c...                    ← Nice to Have 4: 32 hex
```

「最終 full sync から N 日経過」が閾値（例: 30 日）を超えた場合は警告文を追加表示
（削除 / transfer された issue が残っている可能性があるため — §8 運用ガイド参照）。

#### Phase 1 完了条件

- `cmux-team gh sync --full` が初回 500 件取得し `.team/gh-cache.db` に書き込める
- `cmux-team gh sync`（差分）が ETag 304 で no-op になる
- `cmux-team gh status` がキャッシュ概況と rate limit、**最終 full sync からの経過日数**、viewer login を表示
- トークン変更時 / `(host, owner, repo)` 不一致時に自動 purge が走る（Must Fix 4）
- WAL モードで DB が開く（`PRAGMA journal_mode` が `wal` を返す — Must Fix 5）
- `assignees` の PK が `id` になっている（Must Fix 3）
- 非 git / 認証不備時に crash せず exit code + i18n 経由の案内メッセージで停止
- **`.gitignore` に `.team/gh-cache.db` / `.team/gh-cache.db-wal` / `.team/gh-cache.db-shm` を追加**（Should Fix 7）
- 文字列が全て `i18n.ts` 経由になっている（Should Fix 4）
- SQL は全て prepared statement + `?` プレースホルダ（Should Fix 8）

---

### Phase 2: CLI

#### 追加ファイル

| ファイル | 目的 |
|---|---|
| `skills/cmux-team/manager/gh-cache-cli.ts` | `cmdIssueList/Show/Search`, `cmdPrList/Show` の実装 |
| `skills/cmux-team/manager/gh-cache-format.ts` | gh 互換 JSON field selector（`--json state,title,assignees[].login`） |

#### サブコマンド構造

```
cmux-team issue list   [--state open|closed|all] [--assignee @me] [--label NAME]
                       [--author LOGIN] [--limit N=30] [--json FIELDS] [--sync] [--stale-ok]
cmux-team issue show   <N>        [--json FIELDS] [--sync]
cmux-team issue search <QUERY>    [--state ...] [--limit N] [--json FIELDS]
cmux-team pr    list   [--state open|closed|merged|all] [--author LOGIN]
                       [--limit N=30] [--json FIELDS] [--sync] [--stale-ok]
cmux-team pr    show   <N>        [--json FIELDS] [--sync]
```

#### 各フラグの意味

| フラグ | 意味 |
|---|---|
| `--sync` | キャッシュ読み出し前に `syncIncremental` を 1 回走らせる |
| `--stale-ok` | キャッシュ最終同期時刻に関わらず即返却（rate limit 枯渇時の逃げ道） |
| `--json FIELDS` | gh 互換 field selector。`--json state,title,assignees[].login` のように指定 |
| `--limit N` | 最大表示件数（デフォルト 30） |
| `--state` | フィルタ。`all` は全件 |
| `--assignee @me` | Should Fix 3: `sync_meta.viewer_login` から解決。`GET /user` の都度呼び出しはしない |

#### `@me` 解決（Should Fix 3）

```ts
async function resolveAssigneeFilter(
  db: Database,
  input: string | undefined,
): Promise<string | undefined> {
  if (!input) return undefined;
  if (input !== "@me") return input;

  const viewer = getSyncMeta(db)?.viewer_login;
  if (!viewer) {
    // 未 sync 状態（初回 `gh sync` を走らせる前）はエラー案内
    console.error(t("gh_me_not_resolved"));
    process.exit(3);
  }
  return viewer;
}
```

`viewer_login` は `syncFull` / `syncIncremental` 開始時に `resolveViewerLogin` が
`GET /user` を 1 回だけ叩いて保存する（Phase 1 `cmdGhSync` で反映済み）。
`gh-cache-cli.ts` 側から `/user` を叩かない。

#### JSON 出力スキーマ（gh 互換キー）

`gh issue list --json` と同じキー名を使い、置換不要で移行できるようにする。

```json
[
  {
    "number": 123,
    "state": "OPEN",
    "title": "例",
    "body": "...",
    "author": { "login": "someone" },
    "assignees": [{ "login": "user1" }],
    "labels":    [{ "name": "bug", "color": "d73a4a" }],
    "url": "https://github.com/owner/repo/issues/123",
    "createdAt": "2026-04-20T00:00:00Z",
    "updatedAt": "2026-04-20T12:00:00Z",
    "comments": [ ... ]
  }
]
```

**注意**: `state` は gh に合わせ **大文字**（`OPEN` / `CLOSED` / `MERGED`）。DB の内部表現（小文字）との変換は `gh-cache-format.ts` で吸収する。

#### テキスト出力（デフォルト）

```
#272  OPEN   T272 GitHub issue/PR キャッシュ                @yamamoto     2026-04-20
#270  CLOSED fix(manager): persistMainBranch ENOENT          @yamamoto     2026-04-19
```

3 カラム固定幅で、`tput cols` による折り返しは最小限。表示文字列（ヘッダー行、empty 時の案内）は
`i18n.ts` 経由（Should Fix 4）。

#### 非 git / 未認証ディレクトリの扱い

- `resolveOriginRepo` が `null` → i18n キー `gh_not_a_github_repo` を stderr、exit 2
- 認証不備 → i18n キー `gh_auth_missing`、exit 3

#### Phase 2 完了条件

- `cmux-team issue list --state open` がキャッシュから取り出せる
- `--json number,title` 等が gh 互換で機能する
- `--sync` フラグで事前差分同期される
- `--assignee @me` が `viewer_login` 経由で解決される
- 非 git / 未認証時の i18n 案内が出る
- 文字列が全て `t()` 経由（Should Fix 4）

---

### Phase 3: TUI Issues タブ（Must Fix 1, 2 反映で全面書き直し）

本 Phase は **`@rezi-ui/core` + `@rezi-ui/node` ベースで実装する**。
既存 `skills/cmux-team/manager/dashboard.tsx` は ink 版から Rezi 版に移行済み
（dashboard.tsx:10-11 の import、冒頭コメント「Ink 版を Rezi TUI フレームワークで
書き直し」を参照）。ink API（`useInput`、raw mode、`useApp`、`Box`/`Text`）は
**使わない**。

#### state 拡張（既存 `AppState` に追加）

```ts
// dashboard.tsx の AppState に以下を追記
activeTab: "journal" | "artifacts" | "log" | "settings" | "issues";   // 既存 union を拡張
issuesTabState: {
  items: IssueListItem[];            // number, type, state, title, updated_at, author
  cursorIndex: number;
  filterState: "open" | "closed" | "all";
  syncing: boolean;                  // R キー押下中の inflight
  lastSyncError?: string;
  visible: boolean;                  // 非 git 時は false（タブ自体を隠す）
};
```

#### タブボタン追加

既存のタブボタン群（dashboard.tsx の `ui.row` 内の `ui.button` 並び）に合わせて追加:

```ts
state.issuesTabState.visible
  ? ui.button({
      id: "tab-issues",
      label: "Issues",
      focusable: false,
      style: state.activeTab === "issues" ? { bold: true } : { dim: true },
      onPress: () => switchTab("issues"),
    })
  : ui.text("", {})   // 非 git 時は描画しない
```

#### タブ本体の描画

既存タブ（journal / artifacts / log / settings）の描画分岐に合わせて以下を追加:

```
┌ Issues ──────────────────────────────────────────────────────────────┐
│ ● #272 OPEN   T272 GitHub issue/PR キャッシュ       @yamamoto 04-20 │
│ ⇄ #271 OPEN   feat: rate limit poller              @yamamoto 04-19 │
│ ● #270 CLOSED fix(manager): persistMainBranch ...  @yamamoto 04-19 │
│ ...                                                                  │
│ [R] sync  [Enter/O] open in viewer  [B] open in browser              │
└──────────────────────────────────────────────────────────────────────┘
```

- issue と PR は単一リスト統合表示、種別は **アイコン** で区別: `●` = issue、`⇄` = PR
- 色分けも併用: issue = green、PR(open) = purple、PR(merged) = magenta、closed = dim
- 表示文字列（ヘッダー、行フォーマット、sync 中メッセージ、空リスト時の案内）は
  `i18n.ts` キー（Should Fix 4）

#### キーバインド（Rezi の辞書形式 — Must Fix 1 反映）

既存 `dashboard.tsx:1382-1396` の形式（`"1": () => switchTab(...)`, `Tab`, `J`, `L`, `A`）と
**完全に同じ辞書形式**で書く。ink の `useInput` / `{ shift: true, return: true }` は使わない。

```ts
// 既存 keybindings dict（dashboard.tsx:1382 付近）への追記
"5": () => switchTab("issues"),            // 既存 "1"〜"4" に続く
I:   () => switchTab("issues"),            // 既存 J / L / A と同系統
R:   (ctx) => {
  if (ctx.state.activeTab !== "issues") return;
  void triggerSync(ctx);
},
Enter: (ctx) => {
  // 既存 Enter ハンドラ（tasks / settings / artifacts — :1397-1454）に
  // issues 分岐を追加
  if (ctx.state.focusedArea === "issues") {
    const item = currentIssueItem(ctx.state);
    if (!item) return;
    void openInViewer(app, item);      // Must Fix 2: openArtifactInViewer を再利用
    return;
  }
  // ...既存の tasks / settings / artifacts 分岐...
},
// Must Fix 1: Shift+Enter は Rezi のキー名仕様が不明なため、
// 最初から O キー（open）で「ビューアで開く」に代替する。
// ブラウザ起動は B キーに分離（Issues タブ専用で衝突しない）。
O: (ctx) => {
  if (ctx.state.focusedArea !== "issues") return;
  const item = currentIssueItem(ctx.state);
  if (!item) return;
  void openInViewer(app, item);
},
B: (ctx) => {
  if (ctx.state.focusedArea !== "issues") return;
  const item = currentIssueItem(ctx.state);
  if (!item) return;
  void openInBrowser(item);
},
```

**↑↓ 操作は既存のカーソル移動ハンドラ（dashboard.tsx:1348 付近の
`ArrowUp` / `ArrowDown` 相当）に `focusedArea === "issues"` 分岐を追加**。
既存の `artifactCursor` / `taskCursor` / `settingsCursor` と同じパターンで
`issuesTabState.cursorIndex` を動かす。

**キー名注意**:
- Rezi は `"Enter"` / `"Tab"` / `"1"`〜`"9"` / 単文字大小（`J` / `j` など）を辞書キーとして
  受け付けている（dashboard.tsx:1382-1489 の実装から確認）。**`Shift+Enter` / `shift+return`
  は Rezi 仕様が不明なため本タスクでは採用しない**（Must Fix 1）
- `I` / `O` / `B` / `R` は既存キーバインドと衝突しない（`J` / `L` / `A` / `T` / `r` 等は既存使用、
  大文字・小文字で分離されている）

#### ビューア起動（Must Fix 2 — 既存 `openArtifactInViewer` を再利用）

独自 `spawn(cmd, args, { stdio: "inherit" })` を書かない。`resolveMarkdownViewer`
（dashboard.tsx:123）+ `openArtifactInViewer`（dashboard.tsx:970）をそのまま使う。
これにより:
- `$CMUX_TEAM_MD_VIEWER` → `mo` → `cat` の既存解決ロジックを踏襲
- `mo` の場合は TUI を止めずにブラウザ surface で表示
- `cat` フォールバックは `app.stop()` → `app.start()` で TUI 復帰
- Artifacts タブ（:1443）/ tasks タブ（:1405）/ settings タブ（:1423）と完全に同じ
  コードパス

```ts
async function openInViewer(app: NodeApp<AppState>, item: IssueListItem): Promise<void> {
  // Phase 3 では issue 本体 + コメントを markdown として一時ファイルに書き出す
  const issueDoc = await loadIssueWithComments(db, item.number);
  const markdown = renderIssueMarkdown(issueDoc);
  const tmp = await writeTempMarkdown(markdown);   // /tmp/cmux-team-issue-<N>-<ts>.md

  // 既存 Artifacts タブと同じパスで呼ぶ（dashboard.tsx:1443）
  await openArtifactInViewer(
    app,
    tmp,
    () => {
      // 復帰時コールバック — 既存 Artifacts / tasks / settings と同一
      dashboardActive = true;
      spinnerInterval = setInterval(() => {
        try { app.update((s) => ({ ...s, spinnerFrame: s.spinnerFrame + 1 })); } catch {}
      }, SPINNER_INTERVAL);
      refresh();
    },
  );
  await unlink(tmp).catch(() => {});
}
```

#### ブラウザ起動（B キー）

```ts
async function openInBrowser(item: IssueListItem): Promise<void> {
  // macOS 前提（非目的で明記済み）。xdg-open 等のクロスプラットフォーム対応はしない。
  Bun.spawn(["open", item.html_url], { stdio: ["ignore", "ignore", "ignore"] });
}
```

#### sync トリガー (R キー)

```ts
async function triggerSync(ctx: KeyContext<AppState>): Promise<void> {
  app.update((s) => ({ ...s, issuesTabState: { ...s.issuesTabState, syncing: true } }));
  try {
    // 既存 cmdGhSync ロジックを関数化して呼ぶ（子プロセス spawn ではなく同一プロセス内）
    await runSyncIncremental(ctx.state);
    await reloadIssues(app);
  } catch (e) {
    app.update((s) => ({
      ...s,
      issuesTabState: { ...s.issuesTabState, lastSyncError: String(e) },
    }));
    log("gh_sync_failed", `stage=tui_trigger message=${e}`);
  } finally {
    app.update((s) => ({ ...s, issuesTabState: { ...s.issuesTabState, syncing: false } }));
  }
}
```

#### 非 git ディレクトリの扱い

- dashboard 起動時に `resolveOriginRepo` を呼び、null なら `issuesTabState.visible = false`
- `visible=false` の場合タブボタン自体を描画しない（条件レンダリング）
- キーバインド `"5"` / `I` も `visible` チェックで no-op にする
- 未認証時はタブを見せて「認証が必要」メッセージを表示（ユーザーが原因把握できるように）

#### Phase 3 完了条件

- 現状のタブ群（Dashboard / Journal / Artifacts / Log / Settings）と並んで Issues が出る
- Rezi の辞書形式キーバインド（`"5"` / `I` / `R` / `Enter` / `O` / `B` / `ArrowUp` / `ArrowDown`）が動作（Must Fix 1）
- ink API（`useInput` / raw mode / `Box` / `Text` / `shift+return`）を一切使っていない（Must Fix 1）
- pager / ビューア起動は `openArtifactInViewer` + `resolveMarkdownViewer` を再利用
  （Must Fix 2 — `spawn(..., { stdio: "inherit" })` を新規に書いていない）
- 非 git ディレクトリでは Issues タブが非表示
- 表示文字列が全て `i18n.ts` キー経由（Should Fix 4）

---

### Phase 4: Claude Code 誘導スキル

#### 配置先

**結論: 既存 `cmux-team` スキル配下の追加ファイルではなく、独立スキル `skills/cmux-team-gh/SKILL.md` として配置する。**

理由:
- 既存 `cmux-team` スキルは 4 層オーケストレーションの知識で、トリガー条件も `.team/` 前提
- 誘導スキルのトリガーは `gh issue` / `gh pr` / `ghe ...` / issue/PR 番号言及など、`.team/` の有無と独立
- スキルが分かれていると Claude 側の `skills` 列挙時に用途が明確

既存 `skills/` には `cmux-team` / `cmux-team-guide` / `cmux-agent-role` / `dockeeper` / `trace-task` があり、`cmux-team-gh` も同じフラット配置で問題ない。

#### `skills/cmux-team-gh/SKILL.md` の frontmatter 案

```yaml
---
name: cmux-team-gh
description: >
  Use when reading GitHub issues / PRs (github.com or GHE) from the current
  project. Triggers: mention of an issue/PR number (e.g. "#272"), user asks
  to run `gh issue`, `gh pr`, `ghe issue`, `ghe pr`, wants to see review /
  comment status, or asks "show me open issues / review requests".
  Use `cmux-team issue` / `cmux-team pr` / `cmux-team gh` instead of invoking
  gh directly for read operations — the local SQLite cache avoids rate limit.
  Writing (create/comment/close/merge) still goes through gh.
---
```

#### 本文の骨子

```markdown
# cmux-team-gh: GitHub issue/PR キャッシュ経由の読み取り

このスキルは `cmux-team` plugin に同梱される GitHub issue/PR キャッシュの
使い方リファレンスです。`gh issue` / `gh pr` の **読み取り系** は
`cmux-team issue` / `cmux-team pr` に置き換えてください。

## トリガー判定（Claude 向け）

- ユーザーが issue/PR 番号に言及（`#272`, `issue 272`, `PR #42`）
- ユーザーが `gh issue list` / `gh pr view` 等を実行したがっている
- `ghe ...` を実行したがっている（企業 GitHub も同じキャッシュでカバー）
- 「レビュー待ち」「open な PR」「直近 closed」など issue/PR 問い合わせ全般

## 置換表

| 代わりに | 使うもの |
|---|---|
| `gh issue list --state open --limit 20` | `cmux-team issue list --state open --limit 20` |
| `gh issue view 272`                     | `cmux-team issue show 272` |
| `gh pr list --state open`               | `cmux-team pr list --state open` |
| `gh pr view 42 --json state,title,reviews` | `cmux-team pr show 42 --json state,title,reviews` |
| `gh issue list --json ... \| jq ...`     | `cmux-team issue list --json ... \| jq ...`（キー名 gh 互換） |

## キャッシュが古いと感じたら

- `cmux-team gh sync` で差分同期（ほぼ無料）
- `cmux-team gh sync --full` で 500 件再取得（初回 / トークン変更後 / **月 1 回の運用推奨**）
- `cmux-team gh status` で最終 sync 時刻 / rate limit を確認
  - 「最終 full sync から N 日経過」表示に注意: 削除・transfer された issue が残っている
    可能性があるため、30 日を超えたら `--full` 推奨

## 書き込み系は `gh` を使う

create / comment / close / merge は本 skill の対象外。
引き続き `gh issue create`, `gh pr comment` 等を使ってください。

## 無効化される状況

- 起動ディレクトリが git repo でない
- `origin` が GitHub / GHE でない
- 認証トークンが無い（`gh auth login` か `GITHUB_TOKEN` 設定）
```

#### `.claude-plugin/plugin.json` への登録追記

現行（plugin.json:13）:
```json
"skills": "./skills/",
```

→ **変更不要**。`skills` ディレクトリ配下が自動で列挙されるため、新 skill ディレクトリを追加するだけで plugin に含まれる。

#### Phase 4 完了条件

- `skills/cmux-team-gh/SKILL.md` が frontmatter + 本文付きで存在
- plugin インストール時に skill 一覧に `cmux-team-gh` が現れる
- トリガー条件の description が具体的（`gh issue` / `#N` 言及）
- 本文に §8 運用ガイド（月 1 回 `--full` 推奨）が反映されている

---

### Phase 5（任意・後送り可）: GraphQL Projects V2 updatedAt diff

本タスクでは実装しない。`gh-cache-sync.ts` の差分同期ロジックを差し替えやすいよう、
`syncIncremental` の内部で「REST pagination 担当」と「DB 書き込み担当」を分離しておく
（後で GraphQL に差し替えられるように）。

---

## 4. 認証解決フロー

### 優先順位（`gh-cache-auth.ts:resolveGithubToken` の実装順）

```
1. host = 'api.github.com' の場合:
   a. GITHUB_TOKEN が空でなければ採用
   b. GH_TOKEN が空でなければ採用
   c. `gh auth token --hostname github.com` の exit=0 かつ非空なら採用

2. host = GHE（例 'ghe.example.com/api/v3'）の場合:
   a. GH_ENTERPRISE_TOKEN が空でなければ採用
   b. GITHUB_ENTERPRISE_TOKEN が空でなければ採用
   c. `gh auth token --hostname ghe.example.com` の exit=0 かつ非空なら採用

3. 上記全て失敗 → AuthResolution{ kind: "none", host }
```

### host 判定

`git remote get-url origin` の結果から以下パターンを解釈:

| URL 形式 | host 判定 |
|---|---|
| `git@github.com:owner/repo.git` | `api.github.com` |
| `https://github.com/owner/repo.git` | `api.github.com` |
| `git@ghe.example.com:owner/repo.git` | `ghe.example.com/api/v3`（host = ghe.example.com、API base = `https://ghe.example.com/api/v3`） |
| `https://ghe.example.com/owner/repo.git` | 同上 |
| その他（GitLab 等） | null（機能無効化） |

### 未認証時の振る舞い

- **crash しない**（既知の注意点より）
- exit code 3 で即停止し、以下ガイダンスを stderr に出す（i18n キー `gh_auth_missing` の placeholder で host / checked channels を展開）:

```
Error: No GitHub token found.
  host: api.github.com
  checked: GITHUB_TOKEN, GH_TOKEN, `gh auth token`
Run one of:
  gh auth login
  export GITHUB_TOKEN=<your token>
```

TUI の場合は Issues タブに「未認証」メッセージを表示してタブは見せる（ユーザーが原因把握できるように）。

### token_hash（Nice to Have 4 反映: 32 hex）

```ts
import { createHash } from "crypto";
export function tokenHash(token: string): string {
  // 32 hex（128 bit）— 衝突確率は実用十分かつ監査ログで識別しやすい
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}
```

`main.ts:41` ですでに `createHash` を import しているので、同じ crypto モジュールを使う。

---

## 5. 同期アルゴリズム

### 初回 500 件（`syncFull`）

#### エンドポイント

```
GET /repos/{owner}/{repo}/issues
  ?state=all
  &sort=updated
  &direction=desc
  &per_page=100
  &page=1..5
```

- GitHub REST `/repos/.../issues` は **issue と PR の両方を返す**。レスポンスの各要素に `pull_request` キー（object）があれば PR、なければ issue
- `state=all` で open / closed 両方を取る（PR は追加で `merged_at` を検査して merged 判定）
- `sort=updated desc` + 5 ページ（100 × 5 = 500）= 直近 500 件

#### sync 開始時の `viewer_login` 解決（Should Fix 3）

`syncFull` / `syncIncremental` の冒頭で以下を 1 回だけ実行:

```ts
async function resolveViewerLogin(db: Database, deps: SyncDeps): Promise<void> {
  const res = await ghFetch(deps, "/user");
  if (res.ok) {
    const user = await res.json() as { login: string };
    setSyncMeta(db, { viewer_login: user.login });
    log("gh_viewer_resolved", `login=${user.login} host=${deps.repoInfo.host}`);
  }
}
```

rate limit 消費は 1 コール。`sync_meta.viewer_login` にキャッシュされるので以後の
`--assignee @me` で API を叩かない。

#### 付属データ fetch 戦略

本体 500 件取得後、各 issue/PR に対して以下を追加取得:

| 対象 | エンドポイント | 備考 |
|---|---|---|
| comments | `GET /repos/{o}/{r}/issues/{n}/comments?per_page=100` | issue/PR 共通。`comments_count=0` なら skip |
| PR reviews | `GET /repos/{o}/{r}/pulls/{n}/reviews?per_page=100` | PR のみ |
| PR review_comments | `GET /repos/{o}/{r}/pulls/{n}/comments?per_page=100` | PR のみ |
| reactions | **Phase 1 では省略**（初回 500 件 × reactions で rate 消費過大） | 本体 `reactions` フィールドのみ保存し、個別 fetch は incremental で必要時 |
| milestones | 本体 JSON に含まれる `milestone` フィールドをそのまま `milestones` テーブルに upsert | 追加 API 呼び出し不要 |

**追加 API コール数の見積**: 500 issue/PR × ~2 回（comments + PR 系）= **最悪 1000 コール**。
5000/hour の 20% を使う。`viewer_login` の 1 コールを合わせて最悪 1001。許容内。
rate limit 監視で 100 未満になったら一旦 break。

#### pagination

ヘッダー `Link: <...>; rel="next"` の有無で継続判定。`page=` を進めるだけの素朴実装で十分。

#### rate limit 監視

各レスポンスの以下ヘッダーを読む:
- `x-ratelimit-remaining`
- `x-ratelimit-reset`
- `x-ratelimit-limit`

`remaining < 100` で warning ログ。`remaining == 0` で sync 中断し exit 4。

### 差分同期（`syncIncremental`）

```
GET /repos/{owner}/{repo}/issues
  ?state=all
  &sort=updated
  &direction=desc
  &per_page=100
  &since={sync_meta.last_incremental_sync || last_full_sync}
  + Header: If-None-Match: {sync_meta.etag_issues_list}
```

- `since=<ISO8601>` で前回同期以降に更新されたものだけ取得
- ETag が一致すれば **304 Not Modified** → ほぼ無料（API 呼び出し 1 回、rate 消費 1）
- 304 以外（200）なら `etag_issues_list` を更新し、返ってきた issue/PR を upsert
- 各 issue/PR の comment / review / review_comment は、本体の `updated_at` が DB より新しい場合のみ再 fetch

### 304 時の扱い

- `last_incremental_sync` のみ更新
- 他テーブルは触らない
- ログ: `gh_sync_completed mode=incremental not_modified=true`

### rate limit 保護

- `/rate_limit` を各 syncFull / syncIncremental 開始時に 1 回叩き、remaining が閾値未満なら中断
- 閾値: full=1200、incremental=50（full は最大 1001 コール想定）
- 中断時は exit 4 で i18n キー `gh_rate_limit_exhausted`（reset 時刻を placeholder で埋める）

### ETag とトークンの紐付け

- `sync_meta.etag_issues_list` は `token_hash` と 1-to-1
- `tokenHash(currentToken) !== sync_meta.token_hash` 時に `purgeAll(db, "token_rotated")`
  → ETag も同時クリア
- `(host, owner, repo)` 不一致時は `purgeAll(db, "repo_mismatch")`（Must Fix 4）

---

## 6. TDD 戦略

### 単体テスト対象（`bun:test`）

既存テスト形式（`trace-store.test.ts:1` の `describe` / `beforeEach` / `mkdtemp` パターン）を踏襲。

| ファイル | 対象 |
|---|---|
| `gh-cache-store.test.ts` | `openGhCacheDB` 初期化、WAL モード確認（Must Fix 5）、`assignees.id` PK（Must Fix 3）、`upsertIssue` の idempotency、FK cascade、`purgeAll` の完全消去、token_hash 不一致 purge、`(host, owner, repo)` 不一致 purge（Must Fix 4） |
| `gh-cache-auth.test.ts` | env 優先順位（GITHUB_TOKEN > GH_TOKEN > gh-cli）、GHE host の enterprise env 解決、`tokenHash` 安定性と 32 hex 長 |
| `gh-cache-repo.test.ts` | `git@github.com:o/r.git` / `https://github.com/o/r` / `https://ghe.example.com/o/r` の各パース、非 git / 非 GitHub 時の null |
| `gh-cache-sync.test.ts` | fetch を mock し、304 レスポンスで DB が書き換わらない、200 で upsert される、`pull_request` キー有無で type 判別、rate limit ヘッダー反映、`resolveViewerLogin` 1 回呼び出し（Should Fix 3） |
| `gh-cache-format.test.ts` | `--json state,title` / `--json assignees[].login` / ネストした `--json labels[].name,color` の field selector、gh との大文字整形（OPEN / CLOSED / MERGED） |
| `gh-cache-cli.test.ts` | 引数パース、exit code（非 git=2、未認証=3、rate=4）、テキスト出力のカラム幅、`@me` 解決（Should Fix 3）、全文字列が `t()` 経由（Should Fix 4） |

### 統合テスト

**本タスクでは手動確認で代替する。** 自動化しない理由:
- GitHub API を叩く E2E は rate を消費する
- VCR 的な録画再生は追加依存を増やす（cassette 管理が重い）
- 手動確認手順は明確（`cmux-team gh sync --full` → `cmux-team issue list` の目視）

手動確認シナリオ（README 不要、plan.md に列挙するだけ）:

1. 新規 checkout で `cmux-team gh sync --full` を実行 → DB が作られ、rate 消費 ~1001 で 500 件取得
2. 直後に `cmux-team gh sync` → 304 returned, 1 API call のみ
3. `gh issue close <N>` を別セッションで実行 → `cmux-team gh sync` → 状態が反映
4. `cmux-team issue list --state open --json state,title,assignees[].login | jq` が動く
5. `cmux-team issue list --assignee @me` が viewer 本人の issue を返す（Should Fix 3）
6. TUI の Issues タブで ↑↓ / Enter / O / B / R が動く（Must Fix 1 — 全て Rezi キー）
7. `GITHUB_TOKEN` を別アカウントに変えて `cmux-team gh sync` → `gh_cache_purged reason=token_rotated` のログが出る
8. 別 repo の `.team/gh-cache.db` を上書きコピー → `openGhCacheDB` が `gh_cache_purged reason=repo_mismatch` で自動 purge（Must Fix 4）
9. 非 git ディレクトリで `cmux-team issue list` → exit 2 + 案内
10. `.gitignore` に `.team/gh-cache.db*` が追加され、DB ファイルが `git status` に出ない（Should Fix 7）

### fixture 配置（Nice to Have 2 反映）

fetch mock 用の fixture（GitHub REST レスポンスの JSON サンプル）は以下に置く:

```
skills/cmux-team/manager/__fixtures__/gh/
  issues-list-page-1.json
  issues-list-304.json
  pr-reviews.json
  user.json             ← GET /user のサンプル
```

既存の manager ディレクトリに `__fixtures__/` は無いが、`trace-store.test.ts` が
`mkdtemp` を使う形式に倣いつつ、JSON は静的 fixture として切り出す。

---

## 7. 誘導スキル（Phase 4）の配置と内容構造

上記 Phase 4 で詳述済み。再掲省略。

ポイント:
- 配置: `skills/cmux-team-gh/SKILL.md`（独立 skill）
- frontmatter の description にトリガー条件を明示（`gh issue` / `#N` 言及 / `ghe` コマンド）
- 本文: 置換表 + キャッシュ更新手順 + 書き込み系は gh 使え + 無効化条件 + 運用ガイド（月 1 回 `--full`）
- `.claude-plugin/plugin.json` は `"skills": "./skills/"` のまま変更不要

---

## 8. 運用ガイド・リスク・未解決事項

### 運用ガイド（Should Fix 1 反映）

- **月 1 回程度 `cmux-team gh sync --full` を推奨**
  - GitHub REST `/issues` は transferred / deleted issue を返さないため、差分同期では
    キャッシュから消えない（開いている古い issue が archive されたように見える）
  - `cmdGhStatus` が「最終 full sync から N 日経過」を表示するため、30 日超で警告表示
- **トークンを変えたら自動 purge されるので手動対応は不要**（`gh_cache_purged reason=token_rotated`）
- **別プロジェクトから DB を流用しない**（repo 不一致も自動 purge されるが、無駄な再 fetch を
  避けるためプロジェクトごとに `.team/gh-cache.db` を持つのが前提）

### 既知リスク

- **ETag がトークン依存**: アカウント切替で etag がまるごと無効化される。`tokenHash` 不一致での自動 purge で対処
- **初回 500 件の rate 消費**: issue 本体 5 コール + 付属データ ~1000 コール + viewer 1 = 約 1001/5000。連続して `--full` を走らせると枯渇する。ガードを sync 開始時の `/rate_limit` チェックで入れる
- **GHE host 検出の網羅性**: `ghe.example.com` のような単純パターン以外（subpath 型 / カスタム API base）は未対応。本タスクでは **`git remote` URL の host 部分を GHE と仮定**し、API base は `https://<host>/api/v3` で決め打ち。想定外 GHE 構成は「未解決事項」へ
- **TUI ビューア切替時の画面干渉**: Must Fix 2 で `openArtifactInViewer` を再利用することで解消。`mo` の場合は TUI 継続、`cat` フォールバックは `app.stop()` → `app.start()` で復帰（既存 Artifacts タブと同一挙動）
- **Rezi の Shift+Enter 仕様が不明**: Must Fix 1 で採用見送り。`O`（open）キーで同等機能を提供

### 将来作業項目（Should Fix 2 反映 — plan 本文に明示）

- **`raw_json` 列の GC**: 半年運用で 100MB 超が現実的。以下の GC ポリシーを後続 Phase で実装:
  - `closed_at < now - 90 days` の issue/PR は `raw_json` を NULL に更新
  - `created_at < now - 180 days` の comment / review / review_comment も同様
  - GC 実行は `cmux-team gh sync` 完了時に条件付きで走る（閾値超過時のみ）
  - または別コマンド `cmux-team gh vacuum` で手動実行
  - 実装は本タスク完了後、運用中に DB サイズが 50MB を超えた時点で着手
- **reactions の個別 fetch**: Phase 1 では本体 JSON の `reactions` サマリーのみ保存。
  個別 reaction 一覧（`/repos/{o}/{r}/issues/{n}/reactions`）は必要性が判明してから実装
- **milestones の独立 sync**: issue JSON に含まれる milestone のみ扱う。
  `/repos/{o}/{r}/milestones` の全件 fetch は保留
- **Phase 5**: GraphQL Projects V2 updatedAt diff（本タスク外）

### 未解決事項

1. **トークンの `scope` 確認**
   `gh auth status` から scope を取れるが、issue/PR 読み取りは `repo` / `public_repo` で十分。
   scope 不足時の案内をどこまで細かくするかは Conductor 判断
2. **Phase 5 実装前の GraphQL token scope**
   Projects V2 API は `project` scope が必要。Phase 5 でしか使わないので Phase 4 までは無視
3. **proxy.ts との関係**
   既存 `proxy.ts` は API Proxy（Anthropic）で、GitHub fetch とは独立。GitHub fetch は `proxy.ts` を経由しない（trace-task 対象外）。**本 plan で明示**
4. **TUI の `R` による sync 中の UI block**
   sync は数秒～十数秒かかる可能性がある。`syncing: true` のスピナー表示で十分か、
   バックグラウンドで abort 可能にするかは Phase 3 実装時に調整

---

## 9. 作業順序・見積もり

### 依存関係

```
Phase 1 (DB + sync基盤)
   ↓
Phase 2 (CLI list/show/search)
   ↓
Phase 3 (TUI Issues タブ) ────┐
   ↓                           ├── 任意順
Phase 4 (誘導 skill)       ────┘
   ↓
Phase 5 (GraphQL diff)  ← 任意・本タスク外で OK
```

- Phase 2 は Phase 1 の DB / sync 関数に依存
- Phase 3 は Phase 1 の store、Phase 2 の sync トリガーに依存
- Phase 4 は Phase 2 の CLI が存在すれば独立に書ける

### PR 戦略（Planner 推奨 — Nice to Have 3 反映で優先順位明記）

**第 1 推奨: Phase ごとの分割 PR（特に Phase 1 だけ先行マージ）**

理由:
- Phase 1（DB 設計 + REST fetch + auth）は独立でレビューしやすい。ここでマージ済みにできれば後続 PR は差分が小さくなる
- reviewer のレビュー負荷を最小化できる
- Phase 2 の CLI 形状（特に `--json` 互換）はユーザーからのフィードバックを受けやすい
- Phase 3 の TUI は UI 変更で動作確認が必要。前 Phase のキャッシュが動いていれば実機確認が楽
- Phase 4 の skill は純ドキュメントで Phase 2 マージ後に単独で追加できる

**第 2 推奨: Phase 1〜3 を一括 PR + Phase 4 を別 PR の 2 PR 構成**

- conductor-prompt.md で「一括 PR でも可」とあるため許容
- Phase 4 を分けるのは「skill の更新サイクルが実装と独立」するため

**Phase ごとの分割パターン:**

| PR | 内容 | 想定サイズ |
|---|---|---|
| PR #1 | Phase 1: `gh-cache-*.ts` 新規 + `cmux-team gh sync/status` + `.gitignore` 追記 | +1200 行 / -0 |
| PR #2 | Phase 2: `cmux-team issue/pr` CLI + `i18n.ts` に文字列追加 | +600 行 / -30 |
| PR #3 | Phase 3: TUI Issues タブ（dashboard.tsx 追記、Rezi ベース） | +400 行 / -10 |
| PR #4 | Phase 4: `skills/cmux-team-gh/SKILL.md` | +150 行 / -0 |

### 見積もり（参考値、Conductor が最終判断）

- Phase 1: 実装 + 単体テスト = 約 4〜6 時間相当
- Phase 2: 実装 + 単体テスト = 約 2〜3 時間相当
- Phase 3: 実装 + 目視確認 = 約 3〜4 時間相当
- Phase 4: skill 本文執筆 = 約 1 時間相当

合計見積: **約 10〜14 時間相当**。Conductor が 1 走行で終わらせる場合は Phase 単位でコミットを分け、途中アボート時のロスト範囲を小さく保つ。

---

## 10. レビュー反映サマリ

### Must Fix（全 6 件反映）

1. **Phase 3 TUI を Rezi ベースで全面書き直し** — §3 Phase 3 全体。ink API の記述を削除し、
   Rezi の辞書形式キーバインド（`"5"` / `I` / `R` / `Enter` / `O` / `B`）で実装。
   Shift+Enter は `O` キー（open）に置き換え、最初から bound する
2. **pager 起動は `openArtifactInViewer` + `resolveMarkdownViewer` 再利用** — §3 Phase 3
   「ビューア起動」。独自 spawn は書かない。Artifacts / tasks / settings タブと同一のコードパス
3. **`assignees.id` を PRIMARY KEY に** — §3 Phase 1 DB スキーマ。`login` は `UNIQUE` 列に
   格下げ。`issue_assignees` の PK / FK も `(issue_number, user_id)` に変更
4. **`(host, owner, repo)` 不一致 purge を追加** — §3 Phase 1 `openGhCacheDB` の初期化フロー。
   ログイベント `gh_cache_purged` の reason に `repo_mismatch` を追加
5. **WAL モードを明記** — §3 Phase 1 `openGhCacheDB` 内で `db.exec("PRAGMA journal_mode=WAL;")`。
   trace-store.ts:115 と同一
6. **`schema_version` テーブルを削除** — §3 Phase 1 スキーマ冒頭から削除。
   PRAGMA table_info ベースの既存慣習（trace-store.ts:140）に揃える

### Should Fix（全 8 件反映）

1. **削除・transfer 運用ガイド** — §8 運用ガイド + `cmdGhStatus` に「N 日経過」表示 + §7 skill 本文
2. **`raw_json` GC を将来作業項目に** — §8「将来作業項目」に閾値と発動条件を明示。
   スキーマも `raw_json TEXT`（NOT NULL なし）に変更
3. **`@me` 解決方式決定** — `sync_meta.viewer_login` 列追加 + `syncFull/Incremental` 開始時に
   `GET /user` 1 回、`gh-cache-cli.ts` の `resolveAssigneeFilter` で使用
4. **i18n 一貫性** — §3 Phase 1 実装原則 + 各 Phase 完了条件に「全文字列 `t()` 経由」を明記
5. **rate-limit-display.ts 等を再利用しない** — §2「既存 rate-limit 実装との役割分担」で明示
6. **`cmdGh` の help ヘルパ** — `hasFlag("help")` に統一（独自 `hasHelpFlag` は使わない）
7. **`.gitignore` 追記を Phase 1 完了条件に** — §3 Phase 1 完了条件、§6 手動確認シナリオ #10
8. **bun:sqlite prepared statement 原則** — §3 Phase 1 実装原則の冒頭に明記

### Nice to Have（採用分を明示）

- **fixture 配置** — §6「fixture 配置」で `skills/cmux-team/manager/__fixtures__/gh/` を指定
- **PR 戦略の優先順位明記** — §9「PR 戦略」で第 1 / 第 2 推奨を明示
- **`token_hash` を 32 hex に** — §4「token_hash」で採用
- 「初回 sync の進捗表示」は Phase 1 実装時に Conductor が判断（本 plan では未採用だが禁止もしない）

以上。
