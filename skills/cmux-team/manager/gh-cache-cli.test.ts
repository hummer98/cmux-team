import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  openGhCacheDB,
  upsertIssue,
  upsertLabel,
  upsertAssignee,
  linkIssueLabel,
  linkIssueAssignee,
  setSyncMeta,
} from "./gh-cache-store";
import {
  cmdIssueList,
  cmdIssueShow,
  cmdIssueSearch,
  cmdPrList,
  type CliDeps,
} from "./gh-cache-cli";
import type { IssueRow, RepoInfo, AuthResolution } from "./gh-cache-types";

const REPO: RepoInfo = { host: "api.github.com", owner: "acme", repo: "widget" };
const TOKEN_HASH = "a".repeat(32);

let testDir: string;
let db: ReturnType<typeof openGhCacheDB>;
let printed: string[];

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

function makeDeps(args: string[]): CliDeps {
  const auth: AuthResolution & { token: string } = {
    kind: "env",
    token: "xxx",
    host: REPO.host,
    checked: ["GITHUB_TOKEN"],
  };
  return {
    db,
    repoInfo: REPO,
    auth,
    args,
    stdout: (s) => printed.push(s),
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gh-cli-test-"));
  db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
  printed = [];
});

afterEach(async () => {
  db.close();
  await rm(testDir, { recursive: true, force: true });
});

describe("cmdIssueList", () => {
  test("state=open のみ返る（デフォルト）", async () => {
    upsertIssue(db, makeIssue({ number: 1, state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, state: "closed" }));
    await cmdIssueList(makeDeps(["issue", "list"]));
    expect(printed.some((l) => l.includes("#1"))).toBe(true);
    expect(printed.some((l) => l.includes("#2"))).toBe(false);
  });

  test("PR はリスト除外", async () => {
    upsertIssue(db, makeIssue({ number: 1, type: "issue", state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, type: "pr", state: "open" }));
    await cmdIssueList(makeDeps(["issue", "list"]));
    expect(printed.some((l) => l.includes("#1"))).toBe(true);
    expect(printed.some((l) => l.includes("#2"))).toBe(false);
  });

  test("--state closed", async () => {
    upsertIssue(db, makeIssue({ number: 1, state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, state: "closed" }));
    await cmdIssueList(makeDeps(["issue", "list", "--state", "closed"]));
    expect(printed.some((l) => l.includes("#2"))).toBe(true);
    expect(printed.some((l) => l.includes("#1"))).toBe(false);
  });

  test("--state all", async () => {
    upsertIssue(db, makeIssue({ number: 1, state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, state: "closed" }));
    await cmdIssueList(makeDeps(["issue", "list", "--state", "all"]));
    const text = printed.join("\n");
    expect(text).toContain("#1");
    expect(text).toContain("#2");
  });

  test("--limit N", async () => {
    for (let i = 1; i <= 5; i++) {
      upsertIssue(db, makeIssue({ number: i, updated_at: `2026-01-0${i}T00:00:00Z` }));
    }
    await cmdIssueList(makeDeps(["issue", "list", "--state", "all", "--limit", "2"]));
    expect(printed.length).toBe(2);
  });

  test("--assignee <login>", async () => {
    upsertIssue(db, makeIssue({ number: 1 }));
    upsertIssue(db, makeIssue({ number: 2 }));
    upsertAssignee(db, { id: 10, login: "carol", avatar_url: null });
    linkIssueAssignee(db, 1, 10);
    await cmdIssueList(makeDeps(["issue", "list", "--assignee", "carol"]));
    expect(printed.some((l) => l.includes("#1"))).toBe(true);
    expect(printed.some((l) => l.includes("#2"))).toBe(false);
  });

  test("--assignee @me は viewer_login に解決", async () => {
    setSyncMeta(db, { viewer_login: "dave" });
    upsertIssue(db, makeIssue({ number: 1 }));
    upsertIssue(db, makeIssue({ number: 2 }));
    upsertAssignee(db, { id: 11, login: "dave", avatar_url: null });
    linkIssueAssignee(db, 2, 11);
    await cmdIssueList(makeDeps(["issue", "list", "--assignee", "@me"]));
    expect(printed.some((l) => l.includes("#2"))).toBe(true);
    expect(printed.some((l) => l.includes("#1"))).toBe(false);
  });

  test("--label フィルタ", async () => {
    upsertIssue(db, makeIssue({ number: 1 }));
    upsertIssue(db, makeIssue({ number: 2 }));
    upsertLabel(db, { id: 1, name: "bug", color: "red", description: null });
    linkIssueLabel(db, 2, 1);
    await cmdIssueList(makeDeps(["issue", "list", "--label", "bug"]));
    expect(printed.some((l) => l.includes("#2"))).toBe(true);
    expect(printed.some((l) => l.includes("#1"))).toBe(false);
  });

  test("--author フィルタ", async () => {
    upsertIssue(db, makeIssue({ number: 1, author_login: "alice" }));
    upsertIssue(db, makeIssue({ number: 2, author_login: "bob" }));
    await cmdIssueList(makeDeps(["issue", "list", "--author", "bob"]));
    expect(printed.some((l) => l.includes("#2"))).toBe(true);
    expect(printed.some((l) => l.includes("#1"))).toBe(false);
  });

  test("空結果のとき empty メッセージ", async () => {
    await cmdIssueList(makeDeps(["issue", "list"]));
    // en: "(no issues / PRs matched)" / ja: "(該当する issue / PR はありません)" — 両方に含まれる語
    expect(printed.join("\n")).toContain("issue");
  });

  test("--json で JSON 出力", async () => {
    upsertIssue(db, makeIssue({ number: 1, title: "hello" }));
    await cmdIssueList(makeDeps(["issue", "list", "--json", "number,title"]));
    expect(printed.length).toBe(1);
    const parsed = JSON.parse(printed[0]!);
    expect(parsed).toEqual([{ number: 1, title: "hello" }]);
  });

  test("--json 空指定で全フィールド", async () => {
    upsertIssue(db, makeIssue({ number: 1 }));
    await cmdIssueList(makeDeps(["issue", "list", "--json", ""]));
    const parsed = JSON.parse(printed[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].number).toBe(1);
    expect(parsed[0].state).toBe("OPEN"); // gh-compat uppercase
  });

  test("--json author.login / assignees[].login", async () => {
    upsertIssue(db, makeIssue({ number: 1 }));
    upsertAssignee(db, { id: 10, login: "bob", avatar_url: null });
    linkIssueAssignee(db, 1, 10);
    await cmdIssueList(
      makeDeps([
        "issue",
        "list",
        "--json",
        "number,author.login,assignees[].login",
      ]),
    );
    const parsed = JSON.parse(printed[0]!);
    expect(parsed[0]).toEqual({
      number: 1,
      author: "alice",
      assignees: ["bob"],
    });
  });
});

describe("cmdPrList", () => {
  test("PR のみ返る", async () => {
    upsertIssue(db, makeIssue({ number: 1, type: "issue", state: "open" }));
    upsertIssue(db, makeIssue({ number: 2, type: "pr", state: "open" }));
    await cmdPrList(makeDeps(["pr", "list"]));
    expect(printed.some((l) => l.includes("#2"))).toBe(true);
    expect(printed.some((l) => l.includes("#1"))).toBe(false);
  });

  test("--state merged で merged PR のみ", async () => {
    upsertIssue(db, makeIssue({ number: 1, type: "pr", state: "open" }));
    upsertIssue(
      db,
      makeIssue({
        number: 2,
        type: "pr",
        state: "closed",
        merged_at: "2026-02-01T00:00:00Z",
      }),
    );
    await cmdPrList(makeDeps(["pr", "list", "--state", "merged"]));
    expect(printed.some((l) => l.includes("#2"))).toBe(true);
    expect(printed.some((l) => l.includes("#1"))).toBe(false);
  });
});

describe("cmdIssueShow", () => {
  test("存在する issue を表示", async () => {
    upsertIssue(db, makeIssue({ number: 7, title: "seven" }));
    await cmdIssueShow(makeDeps(["issue", "show", "7"]), "issue");
    const out = printed.join("\n");
    expect(out).toContain("#7 seven");
    expect(out).toContain("state:");
    expect(out).toContain("hello");
  });

  test("存在しない番号で exit(1)", async () => {
    const exitSpy = mock((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const origExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;
    try {
      await expect(
        cmdIssueShow(makeDeps(["issue", "show", "999"]), "issue"),
      ).rejects.toThrow("exit 1");
    } finally {
      process.exit = origExit;
    }
  });

  test("PR を issue show すると type mismatch エラー", async () => {
    upsertIssue(db, makeIssue({ number: 5, type: "pr" }));
    const exitSpy = mock((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const origExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;
    try {
      await expect(
        cmdIssueShow(makeDeps(["issue", "show", "5"]), "issue"),
      ).rejects.toThrow("exit 1");
    } finally {
      process.exit = origExit;
    }
  });

  test("--json で JSON 出力（gh-compat）", async () => {
    upsertIssue(db, makeIssue({ number: 3, title: "three" }));
    await cmdIssueShow(
      makeDeps(["issue", "show", "3", "--json", "number,title,state"]),
      "issue",
    );
    const parsed = JSON.parse(printed[0]!);
    expect(parsed).toEqual({ number: 3, title: "three", state: "OPEN" });
  });

  test("数字以外の number で exit(1)", async () => {
    const exitSpy = mock((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const origExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;
    try {
      await expect(
        cmdIssueShow(makeDeps(["issue", "show", "abc"]), "issue"),
      ).rejects.toThrow("exit 1");
    } finally {
      process.exit = origExit;
    }
  });
});

describe("cmdIssueSearch", () => {
  test("title / body に LIKE マッチ", async () => {
    upsertIssue(db, makeIssue({ number: 1, title: "alpha bug", body: "foo" }));
    upsertIssue(db, makeIssue({ number: 2, title: "beta", body: "bug in body" }));
    upsertIssue(db, makeIssue({ number: 3, title: "gamma", body: "none" }));
    await cmdIssueSearch(makeDeps(["issue", "search", "bug"]));
    const text = printed.join("\n");
    expect(text).toContain("#1");
    expect(text).toContain("#2");
    expect(text).not.toContain("#3");
  });

  test("query 未指定で exit(1)", async () => {
    const exitSpy = mock((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const origExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;
    try {
      await expect(cmdIssueSearch(makeDeps(["issue", "search"]))).rejects.toThrow(
        "exit 1",
      );
    } finally {
      process.exit = origExit;
    }
  });
});

describe("@me 解決失敗", () => {
  test("viewer_login 未設定で --assignee @me は exit(1)", async () => {
    const exitSpy = mock((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const origExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;
    try {
      await expect(
        cmdIssueList(makeDeps(["issue", "list", "--assignee", "@me"])),
      ).rejects.toThrow("exit 1");
    } finally {
      process.exit = origExit;
    }
  });
});
