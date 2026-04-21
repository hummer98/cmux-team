import { describe, test, expect } from "bun:test";
import {
  toGhJson,
  normalizeGhState,
  pickGhFields,
  formatIssueListRow,
  formatIssueShow,
  displayState,
} from "./gh-cache-format";
import type {
  IssueRow,
  LabelRow,
  AssigneeRow,
  CommentRow,
  ReviewRow,
  ReviewCommentRow,
} from "./gh-cache-types";

function makeIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    number: 1,
    type: "issue",
    state: "open",
    title: "hello",
    body: "body text",
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

function label(id: number, name: string): LabelRow {
  return { id, name, color: "ff0000", description: null };
}
function assignee(id: number, login: string): AssigneeRow {
  return { id, login, avatar_url: null };
}

describe("normalizeGhState", () => {
  test("issue の state は大文字化", () => {
    expect(normalizeGhState(makeIssue({ state: "open" }))).toBe("OPEN");
    expect(normalizeGhState(makeIssue({ state: "closed" }))).toBe("CLOSED");
  });

  test("PR + merged_at が立つと MERGED", () => {
    expect(
      normalizeGhState(
        makeIssue({ type: "pr", state: "closed", merged_at: "2026-02-01T00:00:00Z" }),
      ),
    ).toBe("MERGED");
  });

  test("PR + merged_at が null なら state を大文字化", () => {
    expect(
      normalizeGhState(makeIssue({ type: "pr", state: "open", merged_at: null })),
    ).toBe("OPEN");
  });
});

describe("toGhJson", () => {
  test("issue の基本フィールド", () => {
    const obj = toGhJson({
      issue: makeIssue(),
      labels: [label(1, "bug")],
      assignees: [assignee(2, "bob")],
    });
    expect(obj).toMatchObject({
      number: 1,
      title: "hello",
      body: "body text",
      state: "OPEN",
      author: { login: "alice" },
      assignees: [{ login: "bob" }],
      labels: [{ name: "bug", color: "ff0000" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      closedAt: null,
      url: "https://github.com/acme/widget/issues/1",
      isPullRequest: false,
      commentsCount: 0,
    });
    expect(obj.mergedAt).toBeUndefined();
    expect(obj.isDraft).toBeUndefined();
  });

  test("PR 専用フィールド (mergedAt / isDraft)", () => {
    const obj = toGhJson({
      issue: makeIssue({ type: "pr", merged_at: "2026-02-01T00:00:00Z", draft: 1 }),
      labels: [],
      assignees: [],
    });
    expect(obj.isPullRequest).toBe(true);
    expect(obj.state).toBe("MERGED");
    expect(obj.mergedAt).toBe("2026-02-01T00:00:00Z");
    expect(obj.isDraft).toBe(true);
  });

  test("author が null の issue", () => {
    const obj = toGhJson({
      issue: makeIssue({ author_login: null, author_id: null }),
      labels: [],
      assignees: [],
    });
    expect(obj.author).toBeNull();
  });

  test("comments を含めると配列として入る", () => {
    const comments: CommentRow[] = [
      {
        id: 10,
        issue_number: 1,
        author_login: "bob",
        body: "hi",
        created_at: "2026-01-03T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
        html_url: null,
        raw_json: null,
      },
    ];
    const obj = toGhJson({
      issue: makeIssue(),
      labels: [],
      assignees: [],
      comments,
    });
    expect(Array.isArray(obj.comments)).toBe(true);
    expect((obj.comments as unknown[])[0]).toMatchObject({
      author: { login: "bob" },
      body: "hi",
      createdAt: "2026-01-03T00:00:00Z",
    });
  });

  test("reviews / reviewComments を含める", () => {
    const reviews: ReviewRow[] = [
      {
        id: 20,
        pr_number: 1,
        author_login: "reviewer",
        state: "approved",
        body: "lgtm",
        submitted_at: "2026-01-04T00:00:00Z",
        raw_json: null,
      },
    ];
    const reviewComments: ReviewCommentRow[] = [
      {
        id: 30,
        pr_number: 1,
        review_id: 20,
        author_login: "reviewer",
        body: "nit",
        path: "src/index.ts",
        line: 42,
        original_line: null,
        commit_id: null,
        created_at: "2026-01-04T00:00:00Z",
        updated_at: "2026-01-04T00:00:00Z",
        raw_json: null,
      },
    ];
    const obj = toGhJson({
      issue: makeIssue({ type: "pr" }),
      labels: [],
      assignees: [],
      reviews,
      reviewComments,
    });
    expect((obj.reviews as unknown[])[0]).toMatchObject({
      state: "APPROVED",
      body: "lgtm",
      author: { login: "reviewer" },
    });
    expect((obj.reviewComments as unknown[])[0]).toMatchObject({
      body: "nit",
      path: "src/index.ts",
      line: 42,
    });
  });
});

describe("pickGhFields", () => {
  const source = {
    number: 1,
    title: "hello",
    author: { login: "alice" },
    assignees: [{ login: "bob" }, { login: "carol" }],
    labels: [{ name: "bug", color: "red" }],
    nested: { deep: { val: 42 } },
  };

  test("単純プロパティ", () => {
    expect(pickGhFields(source, ["number", "title"])).toEqual({
      number: 1,
      title: "hello",
    });
  });

  test("ドットパス (author.login)", () => {
    expect(pickGhFields(source, ["author.login"])).toEqual({
      author: "alice",
    });
  });

  test("配列マップ (assignees[].login)", () => {
    expect(pickGhFields(source, ["assignees[].login"])).toEqual({
      assignees: ["bob", "carol"],
    });
  });

  test("ネストしたドットパス (nested.deep.val)", () => {
    expect(pickGhFields(source, ["nested.deep.val"])).toEqual({
      nested: 42,
    });
  });

  test("未知フィールドは無視", () => {
    expect(pickGhFields(source, ["unknown", "number"])).toEqual({
      number: 1,
    });
  });

  test("空文字やスペースは無視", () => {
    expect(pickGhFields(source, ["", " ", "number"])).toEqual({
      number: 1,
    });
  });

  test("複数混在", () => {
    expect(
      pickGhFields(source, [
        "number",
        "author.login",
        "assignees[].login",
        "labels[].name",
      ]),
    ).toEqual({
      number: 1,
      author: "alice",
      assignees: ["bob", "carol"],
      labels: ["bug"],
    });
  });
});

describe("formatIssueListRow", () => {
  test("open issue with label + assignee", () => {
    const out = formatIssueListRow({
      issue: makeIssue({ number: 42, title: "bug fix" }),
      labels: [label(1, "bug")],
      assignees: [assignee(2, "bob")],
    });
    expect(out).toContain("#42");
    expect(out).toContain("open");
    expect(out).toContain("bug fix");
    expect(out).toContain("[bug]");
    expect(out).toContain("(@bob)");
  });

  test("merged PR state displayed as merged", () => {
    const out = formatIssueListRow({
      issue: makeIssue({
        number: 3,
        type: "pr",
        state: "closed",
        merged_at: "2026-02-01T00:00:00Z",
        title: "feat",
      }),
      labels: [],
      assignees: [],
    });
    expect(out).toContain("merged");
    expect(out).not.toContain("[");
    expect(out).not.toContain("(@");
  });
});

describe("displayState", () => {
  test("open / closed / merged", () => {
    expect(displayState(makeIssue({ state: "open" }))).toBe("open");
    expect(displayState(makeIssue({ state: "closed" }))).toBe("closed");
    expect(
      displayState(
        makeIssue({ type: "pr", state: "closed", merged_at: "2026-02-01T00:00:00Z" }),
      ),
    ).toBe("merged");
  });
});

describe("formatIssueShow", () => {
  test("本文と labels / assignees を含む", () => {
    const out = formatIssueShow({
      issue: makeIssue({ title: "first" }),
      labels: [label(1, "bug")],
      assignees: [assignee(2, "bob")],
    });
    expect(out).toContain("#1 first");
    expect(out).toContain("state:     open");
    expect(out).toContain("author:    @alice");
    expect(out).toContain("labels:    bug");
    expect(out).toContain("assignees: @bob");
    expect(out).toContain("body text");
  });

  test("comments セクション", () => {
    const out = formatIssueShow({
      issue: makeIssue(),
      labels: [],
      assignees: [],
      comments: [
        {
          id: 1,
          issue_number: 1,
          author_login: "bob",
          body: "hi there",
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
          html_url: null,
          raw_json: null,
        },
      ],
    });
    expect(out).toContain("── comments ──");
    expect(out).toContain("@bob");
    expect(out).toContain("hi there");
  });
});
