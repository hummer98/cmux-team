# T272 実装計画: GitHub issue/PR キャッシュ

対応 issue: #26
対応タスク: T272
Planner: Planner Agent（task-272-1776622205）
作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-272-1776622205`

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

---

## 3. Phase 1〜4 の詳細実装計画

### Phase 1: `.team/gh-cache.db` スキーマ + REST ETag キャッシュ + `cmux-team gh sync` (500 件初回)

#### 追加ファイル

| ファイル | 目的 | 主な export |
|---|---|---|
| `skills/cmux-team/manager/gh-cache-store.ts` | DB 初期化・CRUD | `openGhCacheDB(projectRoot)`, `upsertIssue(db, row)`, `upsertComment`, `upsertReview`, `upsertReviewComment`, `upsertLabel`, `upsertAssignee`, `upsertReaction`, `upsertMilestone`, `getSyncMeta(db)`, `setSyncMeta(db, patch)`, `purgeAll(db)` |
| `skills/cmux-team/manager/gh-cache-auth.ts` | 認証解決 | `resolveGithubToken(host)`, `tokenHash(token)`, `AuthResolution = { kind: "env" \| "gh-cli" \| "none"; token?: string; host: string }` |
| `skills/cmux-team/manager/gh-cache-repo.ts` | repo 解決 | `resolveOriginRepo(cwd): { host, owner, repo } \| null`, `isGitRepo(cwd): boolean` |
| `skills/cmux-team/manager/gh-cache-sync.ts` | 同期ロジック | `syncFull(db, deps): Promise<SyncResult>`, `syncIncremental(db, deps)`, `fetchRateLimit(deps): Promise<RateLimit>` |
| `skills/cmux-team/manager/gh-cache-types.ts` | zod 型 | `IssueRow`, `CommentRow`, `ReviewRow`, `SyncMeta`, `SyncResult` |

#### DB スキーマ（`CREATE TABLE` 案）

```sql
-- スキーマバージョン管理（ALTER TABLE の冪等マイグレーション先例は trace-store.ts:140 の
-- ensureTaskSessionsColumns パターンを踏襲する）
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

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
  raw_json       TEXT    NOT NULL           -- API レスポンス全体を保管（将来拡張用）
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
  raw_json      TEXT    NOT NULL,
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
  raw_json      TEXT    NOT NULL,
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
  raw_json      TEXT    NOT NULL,
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

-- issue / PR と assignee の多対多
CREATE TABLE IF NOT EXISTS assignees (
  login        TEXT    PRIMARY KEY,
  id           INTEGER,
  avatar_url   TEXT
);
CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_number INTEGER NOT NULL,
  login        TEXT    NOT NULL,
  PRIMARY KEY (issue_number, login),
  FOREIGN KEY (issue_number) REFERENCES issues(number)  ON DELETE CASCADE,
  FOREIGN KEY (login)        REFERENCES assignees(login) ON DELETE CASCADE
);

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
  raw_json    TEXT    NOT NULL
);

-- 同期メタデータ（キー = 固定文字列 'global' の 1 行だけ使う）
CREATE TABLE IF NOT EXISTS sync_meta (
  key                   TEXT    PRIMARY KEY,      -- 'global' 固定
  token_hash            TEXT    NOT NULL,         -- SHA-256(token) 先頭 16hex
  host                  TEXT    NOT NULL,         -- 'api.github.com' or 'ghe.example.com/api/v3'
  owner                 TEXT    NOT NULL,
  repo                  TEXT    NOT NULL,
  etag_issues_list      TEXT,                     -- /repos/{o}/{r}/issues?... の ETag
  last_full_sync        TEXT,
  last_incremental_sync TEXT,
  rate_limit_remaining  INTEGER,
  rate_limit_reset      TEXT,                     -- ISO 8601
  last_error            TEXT                      -- 直近の sync エラーメッセージ
);
```

**マイグレーション方式**: 初回は `db.exec(SCHEMA)` で `CREATE TABLE IF NOT EXISTS` により冪等。
将来の列追加は `trace-store.ts:140 ensureTaskSessionsColumns` のパターンで `PRAGMA table_info` → 欠損列のみ `ALTER TABLE ADD COLUMN`。`schema_version` テーブルでバージョンを番号管理し、将来の破壊的変更時に使う。

**トークンローテ対応**:
- `openGhCacheDB` 内で `sync_meta.token_hash` と現行トークンの hash を比較
- 不一致なら全テーブルを `DELETE` し、`sync_meta.key='global'` を新 hash で `INSERT OR REPLACE`
- ETag も無効化（token 単位で発行されるため）

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

**引数パース方針**: 既存 `cmdTraceHooks`（main.ts:3829 付近）と同一の `getArg` / `requireArg` / `hasFlag` を使う。サブサブコマンド（例: `cmux-team gh sync`）は `args[1]` を見て分岐する（既存 `cmdSend` が似た形式）。

```ts
async function cmdGh(): Promise<void> {
  const sub = args[1];
  switch (sub) {
    case "sync":   return cmdGhSync();
    case "status": return cmdGhStatus();
    default:
      if (!sub || hasHelpFlag()) {
        console.log(t("help_gh"));
        process.exit(0);
      }
      console.error(`Unknown gh subcommand: ${sub}`);
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
    console.error("Error: not a git repo or origin does not point to GitHub.");
    process.exit(2);
  }
  const auth = await resolveGithubToken(repoInfo.host);
  if (auth.kind === "none") {
    console.error("Error: no GitHub token found (GITHUB_TOKEN / GH_TOKEN / gh auth token).");
    console.error("Run `gh auth login` or set GITHUB_TOKEN.");
    process.exit(3);
  }
  const db = openGhCacheDB(PROJECT_ROOT);
  const deps = { auth, repoInfo, db, logger: log };
  const result = full ? await syncFull(deps) : await syncIncremental(deps);
  db.close();
  console.log(formatSyncResult(result));
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
- `gh_cache_purged` — `reason=token_rotated old_hash=... new_hash=...`

#### `cmdGhStatus`

```
最終 full sync:        2026-04-20T09:12:00+09:00
最終 incremental sync: 2026-04-20T14:30:00+09:00
host:                  api.github.com
repo:                  owner/repo
issue:                 342 件 (open=87, closed=255)
PR:                    158 件 (open=12, closed=140, merged=128)
comments:              1423 件
rate limit:            4832 / 5000（reset: 2026-04-20T15:00:00+09:00）
token hash:            e3b0c442...
```

#### Phase 1 完了条件

- `cmux-team gh sync --full` が初回 500 件取得し `.team/gh-cache.db` に書き込める
- `cmux-team gh sync`（差分）が ETag 304 で no-op になる
- `cmux-team gh status` がキャッシュ概況と rate limit を表示
- トークン変更時に自動 purge が走る
- 非 git / 認証不備時に crash せず exit code + 案内メッセージで停止

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
| `--assignee @me` | `@me` は認証中のユーザー（`gh api user` で解決） |

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

3 カラム固定幅で、`tput cols` による折り返しは最小限。

#### 非 git / 未認証ディレクトリの扱い

- `resolveOriginRepo` が `null` → 「このディレクトリは GitHub repo ではありません。`cmux-team issue` / `pr` は無効です。」と案内し exit 2
- 認証不備 → exit 3

#### Phase 2 完了条件

- `cmux-team issue list --state open` がキャッシュから取り出せる
- `--json number,title` 等が gh 互換で機能する
- `--sync` フラグで事前差分同期される
- 非 git / 未認証時の案内が出る

---

### Phase 3: TUI Issues タブ

#### dashboard.tsx への追記

**state 追加**（現 `activeTab: "journal" | "artifacts" | "log" | "settings"`）:

```ts
activeTab: "journal" | "artifacts" | "log" | "settings" | "issues";
issuesTabState: {
  items: IssueListItem[];            // number, type, state, title, updated_at, author
  cursorIndex: number;
  filterState: "open" | "closed" | "all";
  syncing: boolean;                  // R キー押下中の inflight
  lastSyncError?: string;
  visible: boolean;                  // 非 git 時は false（タブ自体を隠す）
};
```

**タブボタン追加**（dashboard.tsx:1183 付近）:

```tsx
{state.issuesTabState.visible && (
  <Button id="tab-issues" label="Issues"
    style={state.activeTab === "issues" ? { bold: true } : { dim: true }}
    onPress={() => switchTab("issues")}
  />
)}
```

**タブ本体**（dashboard.tsx:1212 付近の条件分岐に追加）:

```
┌ Issues ──────────────────────────────────────────────────────────────┐
│ ● #272 OPEN   T272 GitHub issue/PR キャッシュ       @yamamoto 04-20 │
│ ⇄ #271 OPEN   feat: rate limit poller              @yamamoto 04-19 │
│ ● #270 CLOSED fix(manager): persistMainBranch ...  @yamamoto 04-19 │
│ ...                                                                  │
│ [R] sync  [Enter] preview  [Shift+Enter] open in browser             │
└──────────────────────────────────────────────────────────────────────┘
```

- issue と PR は単一リスト統合表示、種別は **アイコン** で区別: `●` = issue、`⇄` = PR
- 色分けも併用: issue = green、PR(open) = purple、PR(merged) = magenta、closed = dim

**キーバインド追加**（dashboard.tsx:1382 付近）:

```ts
"5": () => switchTab("issues"),
I:   () => switchTab("issues"),
R:   (ctx) => {
  if (ctx.state.activeTab !== "issues") return;
  void triggerSync();  // setState({ syncing: true }) → cmdGhSync spawn
},
Enter: (ctx) => {
  if (ctx.state.activeTab !== "issues") return;
  void openInPager(currentItem);
},
"shift+return": (ctx) => {   // ink の useInput: { shift: true } で判定
  if (ctx.state.activeTab !== "issues") return;
  void openInBrowser(currentItem);
},
ArrowUp:   () => setState(s => ({ cursorIndex: Math.max(0, s.cursorIndex - 1) })),
ArrowDown: () => setState(s => ({ cursorIndex: Math.min(s.items.length - 1, s.cursorIndex + 1) })),
```

**pager 起動** (Enter):

```ts
async function openInPager(item: IssueListItem) {
  const issue = await loadIssueWithComments(db, item.number);
  const markdown = renderIssueMarkdown(issue);
  const tmp = await writeFile(tempFile(".md"), markdown);
  const pager = process.env.PAGER || "less -R";
  const [cmd, ...pagerArgs] = pager.split(/\s+/);
  await spawn(cmd, [...pagerArgs, tmp], { stdio: "inherit" });
  await unlink(tmp);
}
```

**ink / ダッシュボードとの干渉に注意**: pager 表示中は ink の raw mode を一時停止する必要がある。既存 dashboard に stdin フック切替のヘルパがあれば使う。なければ「外部コマンド起動前に `unmountDashboard()` → pager 終了後 `startDashboard()` で再描画」の簡易パターンで良い（既存 `unmountDashboard` は main.ts:35 で import 済み）。

**ブラウザ起動** (Shift+Enter):

```ts
async function openInBrowser(item: IssueListItem) {
  await spawn("open", [item.html_url], { detached: true });
}
```

**sync トリガー** (R):

```ts
async function triggerSync() {
  setState({ syncing: true });
  try {
    await syncIncremental({ auth, repoInfo, db, logger: log });
    reloadItems();
  } catch (e) {
    setState({ lastSyncError: String(e) });
    log("gh_sync_failed", `stage=tui_trigger message=${e}`);
  } finally {
    setState({ syncing: false });
  }
}
```

**非 git ディレクトリの扱い**:
- dashboard 起動時に `resolveOriginRepo` を呼び、null なら `issuesTabState.visible = false`
- `visible=false` の場合タブボタン自体を描画しない（条件レンダリング）
- キーバインド `5` / `I` も `visible` チェックで no-op にする

#### Phase 3 完了条件

- 現状のタブ群（Dashboard / Journal / Artifacts / Log / Settings）と並んで Issues が出る
- ↑↓ / Enter / Shift+Enter / R キーが動作
- `$PAGER` が未設定なら `less -R` が使われる
- 非 git ディレクトリでは Issues タブが非表示

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
- `cmux-team gh sync --full` で 500 件再取得（初回 / トークン変更後）
- `cmux-team gh status` で最終 sync 時刻 / rate limit を確認

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
- exit code 3 で即停止し、以下ガイダンスを stderr に出す:

```
Error: No GitHub token found.
  host: api.github.com
  checked: GITHUB_TOKEN, GH_TOKEN, `gh auth token`
Run one of:
  gh auth login
  export GITHUB_TOKEN=<your token>
```

TUI の場合は Issues タブに「未認証」メッセージを表示してタブは見せる（ユーザーが原因把握できるように）。

### token_hash

```ts
import { createHash } from "crypto";
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
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

#### 付属データ fetch 戦略

本体 500 件取得後、各 issue/PR に対して以下を追加取得:

| 対象 | エンドポイント | 備考 |
|---|---|---|
| comments | `GET /repos/{o}/{r}/issues/{n}/comments?per_page=100` | issue/PR 共通。`comments_count=0` なら skip |
| PR reviews | `GET /repos/{o}/{r}/pulls/{n}/reviews?per_page=100` | PR のみ |
| PR review_comments | `GET /repos/{o}/{r}/pulls/{n}/comments?per_page=100` | PR のみ |
| reactions | **Phase 1 では省略**（初回 500 件 × reactions で rate 消費過大） | 本体 `reactions` フィールドのみ保存し、個別 fetch は incremental で必要時 |
| milestones | 本体 JSON に含まれる `milestone` フィールドをそのまま `milestones` テーブルに upsert | 追加 API 呼び出し不要 |

**追加 API コール数の見積**: 500 issue/PR × ~2 回（comments + PR 系）= **最悪 1000 コール**。5000/hour の 20% を使う。許容内。rate limit 監視で 100 未満になったら一旦 break。

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
- 閾値: full=1200、incremental=50（full は最大 1000 コール想定）
- 中断時は exit 4 で「rate limit 枯渇。reset 時刻 <...> まで待機してください」

### ETag とトークンの紐付け

- `sync_meta.etag_issues_list` は `token_hash` と 1-to-1
- `tokenHash(currentToken) !== sync_meta.token_hash` 時に `purgeAll(db)` → ETag も同時クリア

---

## 6. TDD 戦略

### 単体テスト対象（`bun:test`）

既存テスト形式（`trace-store.test.ts:1` の `describe` / `beforeEach` / `mkdtemp` パターン）を踏襲。

| ファイル | 対象 |
|---|---|
| `gh-cache-store.test.ts` | `openGhCacheDB` 初期化、`upsertIssue` の idempotency、FK cascade、`purgeAll` の完全消去 |
| `gh-cache-auth.test.ts` | env 優先順位（GITHUB_TOKEN > GH_TOKEN > gh-cli）、GHE host の enterprise env 解決、`tokenHash` 安定性 |
| `gh-cache-repo.test.ts` | `git@github.com:o/r.git` / `https://github.com/o/r` / `https://ghe.example.com/o/r` の各パース、非 git / 非 GitHub 時の null |
| `gh-cache-sync.test.ts` | fetch を mock し、304 レスポンスで DB が書き換わらない、200 で upsert される、`pull_request` キー有無で type 判別、rate limit ヘッダー反映 |
| `gh-cache-format.test.ts` | `--json state,title` / `--json assignees[].login` / ネストした `--json labels[].name,color` の field selector、gh との大文字整形（OPEN / CLOSED / MERGED） |
| `gh-cache-cli.test.ts` | 引数パース、exit code（非 git=2、未認証=3、rate=4）、テキスト出力のカラム幅 |

### 統合テスト

**本タスクでは手動確認で代替する。** 自動化しない理由:
- GitHub API を叩く E2E は rate を消費する
- VCR 的な録画再生は追加依存を増やす（cassette 管理が重い）
- 手動確認手順は明確（`cmux-team gh sync --full` → `cmux-team issue list` の目視）

手動確認シナリオ（README 不要、plan.md に列挙するだけ）:

1. 新規 checkout で `cmux-team gh sync --full` を実行 → DB が作られ、rate 消費 ~1000 で 500 件取得
2. 直後に `cmux-team gh sync` → 304 returned, 1 API call のみ
3. `gh issue close <N>` を別セッションで実行 → `cmux-team gh sync` → 状態が反映
4. `cmux-team issue list --state open --json state,title,assignees[].login | jq` が動く
5. TUI の Issues タブで ↑↓ / Enter / Shift+Enter / R が動く
6. `GITHUB_TOKEN` を別アカウントに変えて `cmux-team gh sync` → 自動 purge + 再 fetch のログが出る
7. 非 git ディレクトリで `cmux-team issue list` → exit 2 + 案内

---

## 7. 誘導スキル（Phase 4）の配置と内容構造

上記 Phase 4 で詳述済み。再掲省略。

ポイント:
- 配置: `skills/cmux-team-gh/SKILL.md`（独立 skill）
- frontmatter の description にトリガー条件を明示（`gh issue` / `#N` 言及 / `ghe` コマンド）
- 本文: 置換表 + キャッシュ更新手順 + 書き込み系は gh 使え + 無効化条件
- `.claude-plugin/plugin.json` は `"skills": "./skills/"` のまま変更不要

---

## 8. リスク・未解決事項

### 既知リスク

- **ETag がトークン依存**: アカウント切替で etag がまるごと無効化される。`tokenHash` 不一致での自動 purge で対処
- **初回 500 件の rate 消費**: issue 本体 5 コール + 付属データ ~1000 コール = 約 1005/5000。連続して `--full` を走らせると枯渇する。ガードを sync 開始時の `/rate_limit` チェックで入れる
- **GHE host 検出の網羅性**: `ghe.example.com` のような単純パターン以外（subpath 型 / カスタム API base）は未対応。本タスクでは **`git remote` URL の host 部分を GHE と仮定**し、API base は `https://<host>/api/v3` で決め打ち。想定外 GHE 構成は「未解決事項」へ
- **TUI pager 起動時の ink 干渉**: `less -R` 起動中に ink の raw mode を一時解除する必要がある。既存 dashboard にハンドラがないので、pager 起動前に `unmountDashboard()` → exit 後に再 `startDashboard()` する簡易策で始める
- **`Shift+Enter` 検出**: ink の `useInput` は `{ shift: true, return: true }` を提供する想定だが、端末によっては `Shift+Enter` が区別できない（特に一部の tmux 環境）。フォールバックとして `O`（open）キーも併用キーバインドにする
- **rate limit 表示の I18n**: `status` 出力が日本語前提。既存 `i18n.ts` に合わせる or 英語固定か要決定（本タスクは既存習慣に合わせ日本語）

### 未解決事項

1. **トークンの `scope` 確認を行うか？**
   `gh auth status` の結果から scope を取れるが、issue/PR 読み取りは `repo` / `public_repo` scope があれば十分。scope 不足時の案内をどこまで細かくするかは Conductor 判断
2. **`assignee=@me` の解決タイミング**
   `@me` を `gh-cache-cli.ts` 側で `GET /user` を叩いて解決するか、キャッシュの assignee login とトークン所有者を別途紐付けておくか
3. **reactions の取得タイミング**
   Phase 1 では本体 JSON の `reactions` サマリーのみで、個別 reaction 一覧は未取得。Phase 2 以降で必要性が判明してから別エンドポイント（`/repos/{o}/{r}/issues/{n}/reactions`）を実装するか
4. **milestones の独立 sync**
   本タスクでは issue JSON に含まれる milestone のみ扱う。`/repos/{o}/{r}/milestones` を別途全件 fetch するかは保留
5. **.gitignore の追記**
   `.team/` 配下は既に個別に ignore パターンがあり（`.team/output/` 等）、 `.team/gh-cache.db` / `.team/gh-cache.db-wal` / `.team/gh-cache.db-shm` を追加すべきか確認要。既存 `traces.db` は `.team/logs/` が ignore されるため問題化していないが、`.team/` 直下に置く gh-cache.db は明示的に ignore 必須。**推奨: `.gitignore` に `.team/gh-cache.db*` を追加**
6. **TUI の `R` による sync 中の UI block**
   sync は数秒～十数秒かかる可能性がある。`syncing: true` のスピナー表示で十分か、バックグラウンドで abort 可能にするかは Phase 3 実装時に調整
7. **proxy.ts との関係**
   既存 `proxy.ts` は API Proxy（Anthropic）で、GitHub fetch とは独立。GitHub fetch は `proxy.ts` を経由しない（trace-task 対象外）。この分離は自明だが plan で明示しておく
8. **Phase 5 実装前の GraphQL token scope**
   Projects V2 API は `project` scope が必要。Phase 5 でしか使わないので Phase 4 までは無視

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

### PR 戦略（Planner 推奨）

**Phase ごとの分割 PR を推奨**。

理由:
- Phase 1（DB 設計 + REST fetch + auth）は独立でレビューしやすい。ここでマージ済みにできれば後続 PR は差分が小さくなる
- Phase 2 の CLI 形状（特に `--json` 互換）はユーザーからのフィードバックを受けやすい
- Phase 3 の TUI は UI 変更で動作確認が必要。前 Phase のキャッシュが動いていれば実機確認が楽
- Phase 4 の skill は純ドキュメントで Phase 2 マージ後に単独で追加できる

ただし conductor-prompt.md で「一括 PR でも可」とあるため、**Conductor が Phase 1〜3 を一括で済ませ、Phase 4 を別 PR にする 2 PR 構成**でも十分妥当。Phase 4 を分けるのは「skill の更新サイクルが実装と独立」するため。

**Phase ごとの分割パターン:**

| PR | 内容 | 想定サイズ |
|---|---|---|
| PR #1 | Phase 1: `gh-cache-*.ts` 新規 + `cmux-team gh sync/status` | +1200 行 / -0 |
| PR #2 | Phase 2: `cmux-team issue/pr` CLI | +600 行 / -30 |
| PR #3 | Phase 3: TUI Issues タブ（dashboard.tsx 追記） | +400 行 / -10 |
| PR #4 | Phase 4: `skills/cmux-team-gh/SKILL.md` | +150 行 / -0 |

### 見積もり（参考値、Conductor が最終判断）

- Phase 1: 実装 + 単体テスト = 約 4〜6 時間相当
- Phase 2: 実装 + 単体テスト = 約 2〜3 時間相当
- Phase 3: 実装 + 目視確認 = 約 3〜4 時間相当
- Phase 4: skill 本文執筆 = 約 1 時間相当

合計見積: **約 10〜14 時間相当**。Conductor が 1 走行で終わらせる場合は Phase 単位でコミットを分け、途中アボート時のロスト範囲を小さく保つ。

---

以上。
