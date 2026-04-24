/**
 * buildIssueRows (Issues タブの行ビルダー) のユニットテスト。
 *
 * Rezi UI の `ui.text` / `ui.row` オブジェクトはそのまま比較しにくいため、
 * ここでは「行数」と「行オブジェクトが期待するテキストを含むかどうか」を
 * JSON シリアライズしてから assert する。
 */
import { describe, test, expect } from "bun:test";
import { buildIssueRows, type AppState, type IssueListItem } from "./dashboard";
import type { IssueRow, LabelRow, AssigneeRow } from "./gh-cache-types";

function makeIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    number: 1,
    type: "issue",
    state: "open",
    title: "hello",
    body: null,
    author_login: "alice",
    author_id: 1,
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

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    daemon: {} as any,
    activeTab: "issues",
    journalEntries: [],
    logLines: [],
    artifacts: [],
    artifactCursor: 0,
    artifactSort: "id",
    artifactTypeFilter: null,
    artifactSearch: null,
    taskCursor: 0,
    version: "",
    repoUrl: null,
    logScrollOffset: 0,
    logAutoScroll: true,
    spinnerFrame: 0,
    focusedArea: "issues",
    journalScrollOffset: 0,
    journalAutoScroll: true,
    settingsItems: [],
    settingsCursor: 0,
    issuesAvailability: "available",
    issueItems: [],
    issueCursor: 0,
    issueSyncing: false,
    issueLastSync: null,
    issueLastError: null,
    // T307: Metrics タブ用フィールド
    metricsData: null,
    metricsError: null,
    metricsLastLoadedMs: 0,
    metricsScrollOffset: 0,
    ...overrides,
  };
}

function stringifyRows(rows: any[]): string {
  return JSON.stringify(rows);
}

describe("buildIssueRows", () => {
  test("non_git の場合 disabled メッセージを返す", () => {
    const rows = buildIssueRows(makeState({ issuesAvailability: "non_git" }));
    expect(rows.length).toBe(1);
    const s = stringifyRows(rows);
    // 英日どちらのロケールでも "git" を含む
    expect(s).toContain("git");
  });

  test("no_auth の場合 disabled メッセージを返す", () => {
    const rows = buildIssueRows(makeState({ issuesAvailability: "no_auth" }));
    expect(rows.length).toBe(1);
    const s = stringifyRows(rows);
    // 英日どちらのロケールでも "auth" or "認証" を含む
    expect(s.toLowerCase().includes("auth") || s.includes("認証")).toBe(true);
  });

  test("available + 空の場合 empty メッセージを返す", () => {
    const rows = buildIssueRows(makeState({ issuesAvailability: "available", issueItems: [] }));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // empty メッセージは gh_issue_empty（英: "no issues" / 日: "該当する issue"）
    const s = stringifyRows(rows);
    expect(s.toLowerCase().includes("issue") || s.includes("該当")).toBe(true);
  });

  test("last sync 行が表示される", () => {
    const rows = buildIssueRows(
      makeState({
        issueLastSync: "2026-04-20T12:00:00Z",
        issueItems: [],
      }),
    );
    const s = stringifyRows(rows);
    expect(s).toContain("last sync");
    expect(s).toContain("2026-04-20T12:00:00Z");
  });

  test("syncing 中はプログレス表記", () => {
    const rows = buildIssueRows(
      makeState({
        issueLastSync: null,
        issueSyncing: true,
        issueItems: [],
      }),
    );
    const s = stringifyRows(rows);
    // 英日: "Syncing" または "同期"
    expect(s.toLowerCase().includes("syncing") || s.includes("同期")).toBe(true);
  });

  test("issueItems を行としてレンダリング", () => {
    const items: IssueListItem[] = [
      {
        issue: makeIssue({ number: 42, title: "bug fix", type: "issue" }),
        labels: [{ id: 1, name: "bug", color: "f00", description: null }],
        assignees: [{ id: 1, login: "bob", avatar_url: null }],
      },
      {
        issue: makeIssue({ number: 7, title: "new feature", type: "pr" }),
        labels: [],
        assignees: [],
      },
    ];
    const rows = buildIssueRows(makeState({ issueItems: items }));
    // 2 個の行が出るはず (last_sync なし、error なし)
    expect(rows.length).toBe(2);
    const s = stringifyRows(rows);
    expect(s).toContain("#42");
    expect(s).toContain("bug fix");
    expect(s).toContain("[bug]"); // labels
    expect(s).toContain("#7");
    expect(s).toContain("new feature");
    expect(s).toContain("PR"); // type prefix
  });

  test("cursor 位置の行が強調される", () => {
    const items: IssueListItem[] = [
      {
        issue: makeIssue({ number: 1, title: "a" }),
        labels: [],
        assignees: [],
      },
      {
        issue: makeIssue({ number: 2, title: "b" }),
        labels: [],
        assignees: [],
      },
    ];
    const rows = buildIssueRows(makeState({ issueItems: items, issueCursor: 1 }));
    // JSON 内で 2 番目の行に ">" 記号（選択マーカー）が入っているはず
    const s = stringifyRows(rows);
    expect(s).toContain(">");
  });

  test("エラーがあれば最終行に表示", () => {
    const rows = buildIssueRows(
      makeState({
        issueItems: [],
        issueLastError: "rate limit: remaining=0 reset=...",
      }),
    );
    const s = stringifyRows(rows);
    expect(s).toContain("rate limit");
  });

  test("issueItems.length > VISIBLE + カーソル末尾 → 選択行が含まれる", () => {
    const VISIBLE = 20;
    const total = VISIBLE + 10; // 30
    const items: IssueListItem[] = Array.from({ length: total }, (_, i) => ({
      issue: makeIssue({ number: i + 1, title: `issue-${i + 1}` }),
      labels: [],
      assignees: [],
    }));
    const rows = buildIssueRows(
      makeState({ issueItems: items, issueCursor: total - 1 }),
    );
    const s = stringifyRows(rows);
    expect(s).toContain(`#${total}`); // 選択行 #30 が含まれる
    expect(s).not.toContain(`"#1"`); // 先頭 #1 は window 外（#10 などとの誤マッチ回避のため "#1" 完全一致で判定）
    expect(rows.length).toBeLessThanOrEqual(VISIBLE);
  });

  test("カーソル 0 → 先頭アイテムが描画される", () => {
    const VISIBLE = 20;
    const total = VISIBLE + 10;
    const items: IssueListItem[] = Array.from({ length: total }, (_, i) => ({
      issue: makeIssue({ number: i + 1, title: `issue-${i + 1}` }),
      labels: [],
      assignees: [],
    }));
    const rows = buildIssueRows(
      makeState({ issueItems: items, issueCursor: 0 }),
    );
    const s = stringifyRows(rows);
    expect(s).toContain(`"#1"`);
    expect(s).toContain(`#${VISIBLE}`); // 先頭 20 件
    expect(s).not.toContain(`#${total}`); // 末尾は window 外
  });

  test("issueItems.length <= VISIBLE → 全件描画", () => {
    const items: IssueListItem[] = Array.from({ length: 3 }, (_, i) => ({
      issue: makeIssue({ number: i + 1, title: `issue-${i + 1}` }),
      labels: [],
      assignees: [],
    }));
    const rows = buildIssueRows(
      makeState({ issueItems: items, issueCursor: 2 }),
    );
    expect(rows.length).toBe(3); // last sync / error なし
    const s = stringifyRows(rows);
    expect(s).toContain(`"#1"`);
    expect(s).toContain(`"#3"`);
  });
});
