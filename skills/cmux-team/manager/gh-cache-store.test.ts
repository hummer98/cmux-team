import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  openGhCacheDB,
  upsertIssue,
  upsertComment,
  upsertLabel,
  upsertAssignee,
  linkIssueLabel,
  linkIssueAssignee,
  clearIssueLabels,
  clearIssueAssignees,
  getSyncMeta,
  setSyncMeta,
  getCacheStats,
  listIssues,
  getIssue,
  getIssueLabels,
  getIssueAssignees,
} from "./gh-cache-store";
import type { IssueRow, RepoInfo } from "./gh-cache-types";

const REPO: RepoInfo = {
  host: "api.github.com",
  owner: "acme",
  repo: "widget",
};
const TOKEN_HASH = "a".repeat(32);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gh-cache-store-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    number: 1,
    type: "issue",
    state: "open",
    title: "sample",
    body: "hello",
    author_login: "alice",
    author_id: 100,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    html_url: "https://github.com/acme/widget/issues/1",
    comments_count: 0,
    milestone_id: null,
    draft: null,
    etag: null,
    fetched_at: "2026-01-03T00:00:00Z",
    raw_json: null,
    ...overrides,
  };
}

describe("openGhCacheDB", () => {
  test("新規作成時 sync_meta に repo 情報が入る", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    const meta = getSyncMeta(db);
    expect(meta).toBeDefined();
    expect(meta!.token_hash).toBe(TOKEN_HASH);
    expect(meta!.host).toBe("api.github.com");
    expect(meta!.owner).toBe("acme");
    expect(meta!.repo).toBe("widget");
    db.close();
  });

  test("再 open で既存メタが保持される", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue());
    db.close();

    const db2 = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    expect(getIssue(db2, 1)).toBeDefined();
    db2.close();
  });

  test("token_hash 変更時に全テーブル purge", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 42 }));
    expect(getIssue(db, 42)).toBeDefined();
    db.close();

    const db2 = openGhCacheDB(testDir, REPO, "b".repeat(32));
    expect(getIssue(db2, 42) ?? undefined).toBeUndefined();
    const meta = getSyncMeta(db2);
    expect(meta!.token_hash).toBe("b".repeat(32));
    db2.close();
  });

  test("repo 不一致時に全テーブル purge", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 99 }));
    db.close();

    const OTHER: RepoInfo = { ...REPO, repo: "other" };
    const db2 = openGhCacheDB(testDir, OTHER, TOKEN_HASH);
    expect(getIssue(db2, 99) ?? undefined).toBeUndefined();
    const meta = getSyncMeta(db2);
    expect(meta!.repo).toBe("other");
    db2.close();
  });
});

describe("upserts", () => {
  test("upsertIssue は同 number で更新", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ title: "old" }));
    upsertIssue(db, makeIssue({ title: "new" }));
    const i = getIssue(db, 1);
    expect(i?.title).toBe("new");
    db.close();
  });

  test("upsertComment ON CONFLICT で更新", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 5 }));
    upsertComment(db, {
      id: 10,
      issue_number: 5,
      author_login: "bob",
      body: "first",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      html_url: null,
      raw_json: null,
    });
    upsertComment(db, {
      id: 10,
      issue_number: 5,
      author_login: "bob",
      body: "edited",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      html_url: null,
      raw_json: null,
    });
    const stats = getCacheStats(db);
    expect(stats.commentCount).toBe(1);
    db.close();
  });

  test("linkIssueLabel → getIssueLabels", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 7 }));
    upsertLabel(db, { id: 100, name: "bug", color: "red", description: null });
    upsertLabel(db, { id: 101, name: "feature", color: "green", description: null });
    linkIssueLabel(db, 7, 100);
    linkIssueLabel(db, 7, 101);
    const labels = getIssueLabels(db, 7);
    expect(labels.map((l) => l.name).sort()).toEqual(["bug", "feature"]);
    clearIssueLabels(db, 7);
    expect(getIssueLabels(db, 7)).toHaveLength(0);
    db.close();
  });

  test("linkIssueAssignee は assignees.id を PK に使う", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 11 }));
    upsertAssignee(db, { id: 501, login: "charlie", avatar_url: null });
    linkIssueAssignee(db, 11, 501);
    const assignees = getIssueAssignees(db, 11);
    expect(assignees[0]?.login).toBe("charlie");
    clearIssueAssignees(db, 11);
    expect(getIssueAssignees(db, 11)).toHaveLength(0);
    db.close();
  });
});

describe("setSyncMeta / getSyncMeta", () => {
  test("patch で部分更新", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    setSyncMeta(db, { viewer_login: "alice", last_full_sync: "2026-04-01T00:00:00Z" });
    const meta = getSyncMeta(db)!;
    expect(meta.viewer_login).toBe("alice");
    expect(meta.last_full_sync).toBe("2026-04-01T00:00:00Z");
    db.close();
  });

  test("undefined は無視", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    setSyncMeta(db, { viewer_login: "keep" });
    setSyncMeta(db, { viewer_login: undefined, last_full_sync: "2026-04-02T00:00:00Z" });
    const meta = getSyncMeta(db)!;
    expect(meta.viewer_login).toBe("keep");
    expect(meta.last_full_sync).toBe("2026-04-02T00:00:00Z");
    db.close();
  });
});

describe("listIssues", () => {
  test("type / state フィルタ", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 1, type: "issue", state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, type: "issue", state: "closed" }));
    upsertIssue(db, makeIssue({ number: 3, type: "pr", state: "open" }));
    upsertIssue(
      db,
      makeIssue({
        number: 4,
        type: "pr",
        state: "closed",
        merged_at: "2026-02-01T00:00:00Z",
      }),
    );

    expect(listIssues(db, { type: "issue" }).map((i) => i.number).sort()).toEqual([
      1, 2,
    ]);
    expect(listIssues(db, { type: "pr" }).map((i) => i.number).sort()).toEqual([3, 4]);
    expect(
      listIssues(db, { type: "pr", state: "merged" }).map((i) => i.number),
    ).toEqual([4]);
    expect(listIssues(db, { state: "open" }).map((i) => i.number).sort()).toEqual([
      1, 3,
    ]);
    db.close();
  });

  test("assignee / label / author フィルタ", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 1, author_login: "alice" }));
    upsertIssue(db, makeIssue({ number: 2, author_login: "bob" }));
    upsertAssignee(db, { id: 11, login: "alice", avatar_url: null });
    linkIssueAssignee(db, 1, 11);
    upsertLabel(db, { id: 50, name: "bug", color: "red", description: null });
    linkIssueLabel(db, 2, 50);

    expect(listIssues(db, { authorLogin: "bob" }).map((i) => i.number)).toEqual([2]);
    expect(
      listIssues(db, { assigneeLogin: "alice" }).map((i) => i.number),
    ).toEqual([1]);
    expect(listIssues(db, { labelName: "bug" }).map((i) => i.number)).toEqual([2]);
    db.close();
  });

  test("更新日時降順", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 1, updated_at: "2026-01-01T00:00:00Z" }));
    upsertIssue(db, makeIssue({ number: 2, updated_at: "2026-02-01T00:00:00Z" }));
    upsertIssue(db, makeIssue({ number: 3, updated_at: "2026-01-15T00:00:00Z" }));
    const ids = listIssues(db).map((i) => i.number);
    expect(ids).toEqual([2, 3, 1]);
    db.close();
  });
});

describe("getCacheStats", () => {
  test("issue / PR / merged / comment をカウント", () => {
    const db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
    upsertIssue(db, makeIssue({ number: 1, type: "issue", state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, type: "issue", state: "closed" }));
    upsertIssue(db, makeIssue({ number: 3, type: "pr", state: "open" }));
    upsertIssue(
      db,
      makeIssue({
        number: 4,
        type: "pr",
        state: "closed",
        merged_at: "2026-02-01T00:00:00Z",
      }),
    );
    upsertComment(db, {
      id: 10,
      issue_number: 1,
      author_login: "alice",
      body: "hi",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      html_url: null,
      raw_json: null,
    });
    const s = getCacheStats(db);
    expect(s.issueCount).toBe(2);
    expect(s.issueOpenCount).toBe(1);
    expect(s.issueClosedCount).toBe(1);
    expect(s.prCount).toBe(2);
    expect(s.prOpenCount).toBe(1);
    expect(s.prClosedCount).toBe(1);
    expect(s.prMergedCount).toBe(1);
    expect(s.commentCount).toBe(1);
    db.close();
  });
});
