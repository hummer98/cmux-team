/**
 * gh-cache store: .team/gh-cache.db の初期化・CRUD アクセサ。
 *
 * - bun:sqlite を使用、WAL モード、prepared statement のみ
 * - (host, owner, repo) / token_hash 不一致時は全テーブル purge
 * - マイグレーションは PRAGMA table_info ベース（trace-store.ts に倣う）
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { log } from "./logger";
import type {
  AssigneeRow,
  CommentRow,
  IssueRow,
  LabelRow,
  MilestoneRow,
  RepoInfo,
  ReviewCommentRow,
  ReviewRow,
  SyncMeta,
} from "./gh-cache-types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  number         INTEGER PRIMARY KEY,
  type           TEXT    NOT NULL CHECK (type IN ('issue','pr')),
  state          TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  body           TEXT,
  author_login   TEXT,
  author_id      INTEGER,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  closed_at      TEXT,
  merged_at      TEXT,
  html_url       TEXT    NOT NULL,
  comments_count INTEGER NOT NULL DEFAULT 0,
  milestone_id   INTEGER,
  draft          INTEGER,
  etag           TEXT,
  fetched_at     TEXT    NOT NULL,
  raw_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_updated  ON issues(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_state    ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_type     ON issues(type);

CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY,
  pr_number     INTEGER NOT NULL,
  author_login  TEXT,
  state         TEXT    NOT NULL,
  body          TEXT,
  submitted_at  TEXT,
  raw_json      TEXT,
  FOREIGN KEY (pr_number) REFERENCES issues(number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number);

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

CREATE TABLE IF NOT EXISTS labels (
  id          INTEGER PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS assignees (
  id           INTEGER PRIMARY KEY,
  login        TEXT    NOT NULL,
  avatar_url   TEXT,
  UNIQUE(login)
);
CREATE INDEX IF NOT EXISTS idx_assignees_login ON assignees(login);

CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_number INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  PRIMARY KEY (issue_number, user_id),
  FOREIGN KEY (issue_number) REFERENCES issues(number)   ON DELETE CASCADE,
  FOREIGN KEY (user_id)      REFERENCES assignees(id)    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_assignees_user ON issue_assignees(user_id);

CREATE TABLE IF NOT EXISTS reactions (
  id            INTEGER PRIMARY KEY,
  target_type   TEXT    NOT NULL CHECK (target_type IN ('issue','comment','review_comment')),
  target_id     INTEGER NOT NULL,
  content       TEXT    NOT NULL,
  user_login    TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);

CREATE TABLE IF NOT EXISTS milestones (
  id          INTEGER PRIMARY KEY,
  number      INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  state       TEXT,
  due_on      TEXT,
  raw_json    TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key                   TEXT    PRIMARY KEY,
  token_hash            TEXT    NOT NULL,
  host                  TEXT    NOT NULL,
  owner                 TEXT    NOT NULL,
  repo                  TEXT    NOT NULL,
  viewer_login          TEXT,
  etag_issues_list      TEXT,
  last_full_sync        TEXT,
  last_incremental_sync TEXT,
  rate_limit_remaining  INTEGER,
  rate_limit_reset      TEXT,
  last_error            TEXT
);
`;

/** DB を開き、スキーマ適用・WAL 有効化・purge 判定まで行う。 */
export function openGhCacheDB(
  projectRoot: string,
  repoInfo: RepoInfo,
  currentTokenHash: string,
): Database {
  const dir = join(projectRoot, ".team");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "gh-cache.db"));

  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  db.exec(SCHEMA);
  ensureSyncMetaColumns(db);
  ensureAssigneesColumns(db);

  const existing = db
    .prepare("SELECT token_hash, host, owner, repo FROM sync_meta WHERE key=?")
    .get("global") as
    | { token_hash: string; host: string; owner: string; repo: string }
    | undefined;

  if (existing) {
    const tokenMismatch = existing.token_hash !== currentTokenHash;
    const repoMismatch =
      existing.host !== repoInfo.host ||
      existing.owner !== repoInfo.owner ||
      existing.repo !== repoInfo.repo;

    if (tokenMismatch || repoMismatch) {
      const reason = tokenMismatch ? "token_rotated" : "repo_mismatch";
      purgeAll(db, reason, repoInfo, currentTokenHash);
      void log(
        "gh_cache_purged",
        `reason=${reason} old_hash=${existing.token_hash} new_hash=${currentTokenHash} ` +
          `old_repo=${existing.host}/${existing.owner}/${existing.repo} ` +
          `new_repo=${repoInfo.host}/${repoInfo.owner}/${repoInfo.repo}`,
      );
    }
  } else {
    // 初期行を INSERT
    db.prepare(
      `INSERT INTO sync_meta (key, token_hash, host, owner, repo)
       VALUES ('global', ?, ?, ?, ?)`,
    ).run(currentTokenHash, repoInfo.host, repoInfo.owner, repoInfo.repo);
  }

  return db;
}

function ensureSyncMetaColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(sync_meta)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required: Array<{ name: string; type: string }> = [
    { name: "viewer_login", type: "TEXT" },
    { name: "etag_issues_list", type: "TEXT" },
    { name: "last_full_sync", type: "TEXT" },
    { name: "last_incremental_sync", type: "TEXT" },
    { name: "rate_limit_remaining", type: "INTEGER" },
    { name: "rate_limit_reset", type: "TEXT" },
    { name: "last_error", type: "TEXT" },
  ];
  for (const { name, type } of required) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE sync_meta ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureAssigneesColumns(db: Database): void {
  const rows = db
    .prepare("PRAGMA table_info(assignees)")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  if (!existing.has("avatar_url")) {
    db.exec(`ALTER TABLE assignees ADD COLUMN avatar_url TEXT`);
  }
}

/** 全テーブルをクリアし、sync_meta に新 key を INSERT する。 */
export function purgeAll(
  db: Database,
  reason: string,
  repoInfo: RepoInfo,
  tokenHash: string,
): void {
  const tables = [
    "reactions",
    "issue_labels",
    "issue_assignees",
    "labels",
    "assignees",
    "review_comments",
    "reviews",
    "comments",
    "issues",
    "milestones",
    "sync_meta",
  ];
  const tx = db.transaction(() => {
    for (const t of tables) db.exec(`DELETE FROM ${t}`);
    db.prepare(
      `INSERT INTO sync_meta (key, token_hash, host, owner, repo)
       VALUES ('global', ?, ?, ?, ?)`,
    ).run(tokenHash, repoInfo.host, repoInfo.owner, repoInfo.repo);
  });
  tx();
  void log("gh_cache_purged_tx", `reason=${reason}`);
}

// --- upsert ---

export function upsertIssue(db: Database, row: IssueRow): void {
  db.prepare(
    `INSERT INTO issues (
       number, type, state, title, body, author_login, author_id,
       created_at, updated_at, closed_at, merged_at, html_url,
       comments_count, milestone_id, draft, etag, fetched_at, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET
       type=excluded.type,
       state=excluded.state,
       title=excluded.title,
       body=excluded.body,
       author_login=excluded.author_login,
       author_id=excluded.author_id,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at,
       closed_at=excluded.closed_at,
       merged_at=excluded.merged_at,
       html_url=excluded.html_url,
       comments_count=excluded.comments_count,
       milestone_id=excluded.milestone_id,
       draft=excluded.draft,
       etag=excluded.etag,
       fetched_at=excluded.fetched_at,
       raw_json=excluded.raw_json`,
  ).run(
    row.number,
    row.type,
    row.state,
    row.title,
    row.body,
    row.author_login,
    row.author_id,
    row.created_at,
    row.updated_at,
    row.closed_at,
    row.merged_at,
    row.html_url,
    row.comments_count,
    row.milestone_id,
    row.draft,
    row.etag,
    row.fetched_at,
    row.raw_json,
  );
}

export function upsertComment(db: Database, row: CommentRow): void {
  db.prepare(
    `INSERT INTO comments (
       id, issue_number, author_login, body, created_at, updated_at, html_url, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       issue_number=excluded.issue_number,
       author_login=excluded.author_login,
       body=excluded.body,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at,
       html_url=excluded.html_url,
       raw_json=excluded.raw_json`,
  ).run(
    row.id,
    row.issue_number,
    row.author_login,
    row.body,
    row.created_at,
    row.updated_at,
    row.html_url,
    row.raw_json,
  );
}

export function upsertReview(db: Database, row: ReviewRow): void {
  db.prepare(
    `INSERT INTO reviews (
       id, pr_number, author_login, state, body, submitted_at, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pr_number=excluded.pr_number,
       author_login=excluded.author_login,
       state=excluded.state,
       body=excluded.body,
       submitted_at=excluded.submitted_at,
       raw_json=excluded.raw_json`,
  ).run(
    row.id,
    row.pr_number,
    row.author_login,
    row.state,
    row.body,
    row.submitted_at,
    row.raw_json,
  );
}

export function upsertReviewComment(db: Database, row: ReviewCommentRow): void {
  db.prepare(
    `INSERT INTO review_comments (
       id, pr_number, review_id, author_login, body, path, line, original_line,
       commit_id, created_at, updated_at, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pr_number=excluded.pr_number,
       review_id=excluded.review_id,
       author_login=excluded.author_login,
       body=excluded.body,
       path=excluded.path,
       line=excluded.line,
       original_line=excluded.original_line,
       commit_id=excluded.commit_id,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at,
       raw_json=excluded.raw_json`,
  ).run(
    row.id,
    row.pr_number,
    row.review_id,
    row.author_login,
    row.body,
    row.path,
    row.line,
    row.original_line,
    row.commit_id,
    row.created_at,
    row.updated_at,
    row.raw_json,
  );
}

export function upsertLabel(db: Database, row: LabelRow): void {
  db.prepare(
    `INSERT INTO labels (id, name, color, description)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       color=excluded.color,
       description=excluded.description`,
  ).run(row.id, row.name, row.color, row.description);
}

export function linkIssueLabel(
  db: Database,
  issueNumber: number,
  labelId: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO issue_labels (issue_number, label_id) VALUES (?, ?)`,
  ).run(issueNumber, labelId);
}

export function clearIssueLabels(db: Database, issueNumber: number): void {
  db.prepare(`DELETE FROM issue_labels WHERE issue_number=?`).run(issueNumber);
}

export function upsertAssignee(db: Database, row: AssigneeRow): void {
  db.prepare(
    `INSERT INTO assignees (id, login, avatar_url)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       login=excluded.login,
       avatar_url=excluded.avatar_url`,
  ).run(row.id, row.login, row.avatar_url);
}

export function linkIssueAssignee(
  db: Database,
  issueNumber: number,
  userId: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO issue_assignees (issue_number, user_id) VALUES (?, ?)`,
  ).run(issueNumber, userId);
}

export function clearIssueAssignees(db: Database, issueNumber: number): void {
  db.prepare(`DELETE FROM issue_assignees WHERE issue_number=?`).run(issueNumber);
}

export function upsertMilestone(db: Database, row: MilestoneRow): void {
  db.prepare(
    `INSERT INTO milestones (id, number, title, state, due_on, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       number=excluded.number,
       title=excluded.title,
       state=excluded.state,
       due_on=excluded.due_on,
       raw_json=excluded.raw_json`,
  ).run(
    row.id,
    row.number,
    row.title,
    row.state,
    row.due_on,
    row.raw_json,
  );
}

// --- sync_meta ---

export function getSyncMeta(db: Database): SyncMeta | undefined {
  return db
    .prepare(
      `SELECT key, token_hash, host, owner, repo, viewer_login,
              etag_issues_list, last_full_sync, last_incremental_sync,
              rate_limit_remaining, rate_limit_reset, last_error
         FROM sync_meta WHERE key='global'`,
    )
    .get() as SyncMeta | undefined;
}

type SyncMetaPatch = Partial<Omit<SyncMeta, "key" | "host" | "owner" | "repo">>;

export function setSyncMeta(db: Database, patch: SyncMetaPatch): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k}=?`).join(", ");
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE sync_meta SET ${setClause} WHERE key='global'`).run(
    ...(values as (string | number | null)[]),
  );
}

// --- read helpers ---

export interface IssueListFilter {
  type?: "issue" | "pr" | "all";
  state?: "open" | "closed" | "merged" | "all";
  assigneeLogin?: string;
  authorLogin?: string;
  labelName?: string;
  limit?: number;
}

export function listIssues(db: Database, f: IssueListFilter = {}): IssueRow[] {
  const wheres: string[] = [];
  const params: (string | number)[] = [];

  if (f.type && f.type !== "all") {
    wheres.push("i.type=?");
    params.push(f.type);
  }
  if (f.state && f.state !== "all") {
    if (f.state === "merged") {
      wheres.push("i.type='pr' AND i.merged_at IS NOT NULL");
    } else {
      wheres.push("i.state=?");
      params.push(f.state);
    }
  }
  if (f.authorLogin) {
    wheres.push("i.author_login=?");
    params.push(f.authorLogin);
  }
  if (f.assigneeLogin) {
    wheres.push(
      `i.number IN (SELECT ia.issue_number FROM issue_assignees ia
                      JOIN assignees a ON a.id = ia.user_id
                     WHERE a.login=?)`,
    );
    params.push(f.assigneeLogin);
  }
  if (f.labelName) {
    wheres.push(
      `i.number IN (SELECT il.issue_number FROM issue_labels il
                      JOIN labels l ON l.id = il.label_id
                     WHERE l.name=?)`,
    );
    params.push(f.labelName);
  }

  const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(f.limit ?? 30, 1000));
  const sql = `SELECT i.* FROM issues i ${where} ORDER BY i.updated_at DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...params) as IssueRow[];
}

export function getIssue(db: Database, number: number): IssueRow | undefined {
  return db
    .prepare(`SELECT * FROM issues WHERE number=?`)
    .get(number) as IssueRow | undefined;
}

export function getIssueLabels(db: Database, issueNumber: number): LabelRow[] {
  return db
    .prepare(
      `SELECT l.* FROM labels l
         JOIN issue_labels il ON il.label_id = l.id
        WHERE il.issue_number=?
        ORDER BY l.name`,
    )
    .all(issueNumber) as LabelRow[];
}

export function getIssueAssignees(
  db: Database,
  issueNumber: number,
): AssigneeRow[] {
  return db
    .prepare(
      `SELECT a.* FROM assignees a
         JOIN issue_assignees ia ON ia.user_id = a.id
        WHERE ia.issue_number=?
        ORDER BY a.login`,
    )
    .all(issueNumber) as AssigneeRow[];
}

export function getIssueComments(db: Database, issueNumber: number): CommentRow[] {
  return db
    .prepare(
      `SELECT * FROM comments WHERE issue_number=? ORDER BY created_at ASC`,
    )
    .all(issueNumber) as CommentRow[];
}

export function getPrReviews(db: Database, prNumber: number): ReviewRow[] {
  return db
    .prepare(`SELECT * FROM reviews WHERE pr_number=? ORDER BY id ASC`)
    .all(prNumber) as ReviewRow[];
}

export function getPrReviewComments(
  db: Database,
  prNumber: number,
): ReviewCommentRow[] {
  return db
    .prepare(
      `SELECT * FROM review_comments WHERE pr_number=? ORDER BY created_at ASC`,
    )
    .all(prNumber) as ReviewCommentRow[];
}

export function searchIssues(
  db: Database,
  query: string,
  filter: IssueListFilter = {},
): IssueRow[] {
  // LIKE ベースの素朴検索（title / body にマッチ）。
  // FTS5 は別の機会で導入可能（plan §8 将来作業）。
  const qLike = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const wheres: string[] = ["(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')"];
  const params: (string | number)[] = [qLike, qLike];

  if (filter.type && filter.type !== "all") {
    wheres.push("i.type=?");
    params.push(filter.type);
  }
  if (filter.state && filter.state !== "all") {
    if (filter.state === "merged") {
      wheres.push("i.type='pr' AND i.merged_at IS NOT NULL");
    } else {
      wheres.push("i.state=?");
      params.push(filter.state);
    }
  }

  const limit = Math.max(1, Math.min(filter.limit ?? 30, 1000));
  const sql = `SELECT i.* FROM issues i WHERE ${wheres.join(" AND ")} ORDER BY i.updated_at DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...params) as IssueRow[];
}

// --- stats（status コマンド用）---

export interface CacheStats {
  issueCount: number;
  issueOpenCount: number;
  issueClosedCount: number;
  prCount: number;
  prOpenCount: number;
  prClosedCount: number;
  prMergedCount: number;
  commentCount: number;
}

export function getCacheStats(db: Database): CacheStats {
  const issueCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM issues WHERE type='issue'`)
    .get() as { c: number }).c;
  const issueOpenCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM issues WHERE type='issue' AND state='open'`)
    .get() as { c: number }).c;
  const issueClosedCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM issues WHERE type='issue' AND state='closed'`)
    .get() as { c: number }).c;
  const prCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM issues WHERE type='pr'`)
    .get() as { c: number }).c;
  const prOpenCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM issues WHERE type='pr' AND state='open'`)
    .get() as { c: number }).c;
  const prClosedCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM issues WHERE type='pr' AND state='closed'`)
    .get() as { c: number }).c;
  const prMergedCount = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM issues WHERE type='pr' AND merged_at IS NOT NULL`,
    )
    .get() as { c: number }).c;
  const commentCount = (db.prepare(`SELECT COUNT(*) AS c FROM comments`).get() as {
    c: number;
  }).c;

  return {
    issueCount,
    issueOpenCount,
    issueClosedCount,
    prCount,
    prOpenCount,
    prClosedCount,
    prMergedCount,
    commentCount,
  };
}
