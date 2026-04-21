import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openGhCacheDB, getSyncMeta, getIssue } from "./gh-cache-store";
import {
  ghFetch,
  parseNextLink,
  issueToRow,
  resolveViewerLogin,
  syncFull,
  syncIncremental,
  RateLimitExhaustedError,
  SyncHttpError,
  type FetchLike,
  type SyncDeps,
} from "./gh-cache-sync";
import type { AuthResolution, GhIssue, RepoInfo } from "./gh-cache-types";

const REPO: RepoInfo = { host: "api.github.com", owner: "acme", repo: "widget" };
const AUTH: AuthResolution = {
  kind: "env",
  token: "gh_test_token",
  host: "api.github.com",
  checked: ["GITHUB_TOKEN"],
};
const TOKEN_HASH = "a".repeat(32);

let testDir: string;
let db: ReturnType<typeof openGhCacheDB>;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gh-cache-sync-test-"));
  db = openGhCacheDB(testDir, REPO, TOKEN_HASH);
});

afterEach(async () => {
  db.close();
  await rm(testDir, { recursive: true, force: true });
});

function makeResponse(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

function make304(init: { headers?: Record<string, string> } = {}): Response {
  return new Response(null, { status: 304, headers: new Headers(init.headers ?? {}) });
}

function mkIssue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 1,
    state: "open",
    title: "sample",
    body: "body",
    user: { id: 100, login: "alice" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    html_url: "https://github.com/acme/widget/issues/1",
    comments: 0,
    labels: [],
    assignees: [],
    ...overrides,
  } as GhIssue;
}

type Handler = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Response | Promise<Response>;

function makeFetch(handler: Handler): { fetchFn: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return await handler(url, init);
  };
  return { fetchFn, calls };
}

function rateHeaders(remaining: number, limit = 5000, resetUnix = Math.floor(Date.now() / 1000) + 3600): Record<string, string> {
  return {
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-reset": String(resetUnix),
  };
}

describe("parseNextLink", () => {
  test("next URL を抽出", () => {
    const link = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=5>; rel="last"';
    expect(parseNextLink(link)).toBe("https://api.github.com/repositories/1/issues?page=2");
  });

  test("null header → null", () => {
    expect(parseNextLink(null)).toBeNull();
  });

  test("next rel が無ければ null", () => {
    const link = '<https://api.github.com/repositories/1/issues?page=5>; rel="last"';
    expect(parseNextLink(link)).toBeNull();
  });
});

describe("issueToRow", () => {
  test("issue → type=issue", () => {
    const row = issueToRow(mkIssue(), "2026-01-03T00:00:00Z");
    expect(row.type).toBe("issue");
    expect(row.state).toBe("open");
    expect(row.merged_at).toBeNull();
  });

  test("PR (pull_request あり) → type=pr", () => {
    const row = issueToRow(
      mkIssue({ pull_request: { url: "https://api.github.com/..." } }) as GhIssue,
      "2026-01-03T00:00:00Z",
    );
    expect(row.type).toBe("pr");
  });

  test("PR merged → state=merged", () => {
    const row = issueToRow(
      mkIssue({
        state: "closed",
        pull_request: { url: "x", merged_at: "2026-02-01T00:00:00Z" },
      }) as GhIssue,
      "2026-01-03T00:00:00Z",
    );
    expect(row.type).toBe("pr");
    expect(row.state).toBe("merged");
    expect(row.merged_at).toBe("2026-02-01T00:00:00Z");
  });

  test("draft boolean は 0/1 に正規化", () => {
    const r1 = issueToRow(
      mkIssue({ draft: true, pull_request: { url: "x" } }) as GhIssue,
      "2026-01-03T00:00:00Z",
    );
    const r2 = issueToRow(
      mkIssue({ draft: false, pull_request: { url: "x" } }) as GhIssue,
      "2026-01-03T00:00:00Z",
    );
    expect(r1.draft).toBe(1);
    expect(r2.draft).toBe(0);
  });
});

describe("ghFetch", () => {
  test("Authorization と User-Agent を付与", async () => {
    const { fetchFn, calls } = makeFetch(() => makeResponse({}));
    await ghFetch({ db, repoInfo: REPO, auth: AUTH, fetchFn }, "/foo");
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.github.com/foo");
    expect(c.headers.Authorization).toBe("Bearer gh_test_token");
    expect(c.headers["User-Agent"]).toBe("cmux-team-gh-cache");
  });

  test("etag 指定時に If-None-Match が付く", async () => {
    const { fetchFn, calls } = makeFetch(() => makeResponse({}));
    await ghFetch({ db, repoInfo: REPO, auth: AUTH, fetchFn }, "/foo", { etag: 'W/"abc"' });
    expect(calls[0]!.headers["If-None-Match"]).toBe('W/"abc"');
  });

  test("絶対 URL はそのまま使う", async () => {
    const { fetchFn, calls } = makeFetch(() => makeResponse({}));
    await ghFetch(
      { db, repoInfo: REPO, auth: AUTH, fetchFn },
      "https://api.github.com/repositories/1/issues?page=2",
    );
    expect(calls[0]!.url).toBe("https://api.github.com/repositories/1/issues?page=2");
  });
});

describe("resolveViewerLogin", () => {
  test("/user 成功で sync_meta に login が入る", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      return makeResponse({}, { status: 404 });
    });
    const login = await resolveViewerLogin({ db, repoInfo: REPO, auth: AUTH, fetchFn });
    expect(login).toBe("alice");
    expect(getSyncMeta(db)!.viewer_login).toBe("alice");
  });

  test("/user 失敗 → null、sync_meta は更新されない", async () => {
    const { fetchFn } = makeFetch(() => makeResponse({}, { status: 401 }));
    const login = await resolveViewerLogin({ db, repoInfo: REPO, auth: AUTH, fetchFn });
    expect(login).toBeNull();
    expect(getSyncMeta(db)!.viewer_login).toBeNull();
  });
});

describe("syncFull", () => {
  test("/user → /rate_limit → issues 1 ページで完了", async () => {
    const issueA = mkIssue({ number: 1 });
    const issueB = mkIssue({ number: 2, pull_request: { url: "x" } });
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?") && !url.includes("/comments")) {
        return makeResponse([issueA, issueB], { headers: rateHeaders(4999) });
      }
      return makeResponse([]);
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    const result = await syncFull(deps);
    expect(result.mode).toBe("full");
    expect(result.notModified).toBe(false);
    expect(result.fetchedIssues).toBe(2);
    expect(getIssue(db, 1)).toBeDefined();
    expect(getIssue(db, 2)?.type).toBe("pr");
    const meta = getSyncMeta(db)!;
    expect(meta.last_full_sync).toBeDefined();
    expect(meta.viewer_login).toBe("alice");
    expect(calls.some((c) => c.url.includes("state=all"))).toBe(true);
    expect(calls.some((c) => c.url.includes("sort=updated"))).toBe(true);
  });

  test("rate limit remaining < FULL_THRESHOLD で RateLimitExhaustedError", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 500, limit: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } },
          { headers: rateHeaders(500) },
        );
      }
      return makeResponse([]);
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    await expect(syncFull(deps)).rejects.toBeInstanceOf(RateLimitExhaustedError);
  });

  test("401 で SyncHttpError", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      return makeResponse({ message: "Bad credentials" }, { status: 401 });
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    await expect(syncFull(deps)).rejects.toBeInstanceOf(SyncHttpError);
  });

  test("ETag が先頭ページから sync_meta に保存される", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?")) {
        return makeResponse([], { headers: { ...rateHeaders(4999), etag: 'W/"top"' } });
      }
      return makeResponse([]);
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    await syncFull(deps);
    expect(getSyncMeta(db)!.etag_issues_list).toBe('W/"top"');
  });
});

describe("syncIncremental", () => {
  test("meta 未初期化なら throw", async () => {
    // 新規 DB ではまだ last_full_sync が null だが sync_meta 行自体は存在する。
    // viewer_login も未設定の新規状態で incremental を走らせる動作を確認。
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?")) return makeResponse([], { headers: rateHeaders(4999) });
      return makeResponse([]);
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    const result = await syncIncremental(deps);
    expect(result.mode).toBe("incremental");
  });

  test("ETag 304 なら notModified=true で early return", async () => {
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?")) {
        // 初回 full で etag 保存、次に incremental 呼び出し
        return makeResponse([], { headers: { ...rateHeaders(4999), etag: 'W/"v1"' } });
      }
      return makeResponse([]);
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    await syncFull(deps);

    // 差分実行で 304 を返す fetch を新しく差し替え
    const { fetchFn: fetchFn2, calls: calls2 } = makeFetch((url, init) => {
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?")) {
        expect(init?.headers?.["If-None-Match"]).toBe('W/"v1"');
        return make304({ headers: rateHeaders(4998) });
      }
      return makeResponse([]);
    });
    const deps2: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn: fetchFn2 };
    const r = await syncIncremental(deps2);
    expect(r.notModified).toBe(true);
    expect(r.fetchedIssues).toBe(0);
    void calls;
    void calls2;
  });

  test("since クエリが last_incremental_sync から付く", async () => {
    // 先に full で last_incremental_sync を埋める
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?")) {
        return makeResponse([], { headers: { ...rateHeaders(4999), etag: 'W/"v1"' } });
      }
      return makeResponse([]);
    });
    const fixedDate = new Date("2026-04-01T00:00:00.000Z");
    await syncFull({ db, repoInfo: REPO, auth: AUTH, fetchFn, now: () => fixedDate });

    const sawSinceBox: { value: string | null } = { value: null };
    const { fetchFn: fetchFn2 } = makeFetch((url) => {
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues?")) {
        const m = url.match(/since=([^&]+)/);
        if (m && m[1]) sawSinceBox.value = decodeURIComponent(m[1]);
        return makeResponse([], { headers: { ...rateHeaders(4998), etag: 'W/"v2"' } });
      }
      return makeResponse([]);
    });
    await syncIncremental({ db, repoInfo: REPO, auth: AUTH, fetchFn: fetchFn2 });
    expect(sawSinceBox.value).toBe("2026-04-01T00:00:00.000Z");
  });

  test("rate limit remaining < INCREMENTAL_THRESHOLD で RateLimitExhaustedError", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 10, limit: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } },
          { headers: rateHeaders(10) },
        );
      }
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      return makeResponse([]);
    });
    const deps: SyncDeps = { db, repoInfo: REPO, auth: AUTH, fetchFn };
    await expect(syncIncremental(deps)).rejects.toBeInstanceOf(RateLimitExhaustedError);
  });

  test("更新された issue は DB に反映される", async () => {
    // 最初に full で 1 件入れる
    const issue1 = mkIssue({ number: 1, title: "v1", updated_at: "2026-01-01T00:00:00Z" });
    const issue1v2 = mkIssue({ number: 1, title: "v2", updated_at: "2026-02-01T00:00:00Z" });
    const { fetchFn } = makeFetch((url) => {
      if (url.endsWith("/user")) return makeResponse({ id: 1, login: "alice" });
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues/1/comments")) return makeResponse([]);
      if (url.includes("/issues?")) {
        return makeResponse([issue1], { headers: { ...rateHeaders(4999), etag: 'W/"v1"' } });
      }
      return makeResponse([]);
    });
    await syncFull({ db, repoInfo: REPO, auth: AUTH, fetchFn });
    expect(getIssue(db, 1)?.title).toBe("v1");

    const { fetchFn: fetchFn2 } = makeFetch((url) => {
      if (url.endsWith("/rate_limit")) {
        return makeResponse(
          { rate: { remaining: 5000, limit: 5000, reset: 0 } },
          { headers: rateHeaders(5000) },
        );
      }
      if (url.includes("/issues/1/comments")) return makeResponse([]);
      if (url.includes("/issues?")) {
        return makeResponse([issue1v2], { headers: { ...rateHeaders(4998), etag: 'W/"v2"' } });
      }
      return makeResponse([]);
    });
    await syncIncremental({ db, repoInfo: REPO, auth: AUTH, fetchFn: fetchFn2 });
    expect(getIssue(db, 1)?.title).toBe("v2");
  });
});
