/**
 * gh-cache sync: GitHub REST fetch + DB 書き込み。
 *
 * - 初回 500 件 (`syncFull`): `/repos/{o}/{r}/issues?state=all&sort=updated` を 5 ページ
 * - 差分 (`syncIncremental`): `since=<last>` + ETag (`If-None-Match`) で 304 許容
 * - 各 issue/PR の comments / reviews / review_comments を追加取得
 * - rate limit ヘッダーを都度読み取り、不足時は中断
 *
 * 外部依存: 標準 `fetch` のみ。
 */
import type { Database } from "bun:sqlite";
import { log } from "./logger";
import {
  clearIssueAssignees,
  clearIssueLabels,
  getIssue,
  getSyncMeta,
  linkIssueAssignee,
  linkIssueLabel,
  setSyncMeta,
  upsertAssignee,
  upsertComment,
  upsertIssue,
  upsertLabel,
  upsertMilestone,
  upsertReview,
  upsertReviewComment,
} from "./gh-cache-store";
import { apiBaseUrl } from "./gh-cache-repo";
import {
  GhCommentSchema,
  GhIssueSchema,
  GhReviewCommentSchema,
  GhReviewSchema,
  GhUserSchema,
  type AuthResolution,
  type GhIssue,
  type IssueRow,
  type RateLimit,
  type RepoInfo,
  type SyncResult,
} from "./gh-cache-types";

export const RATE_LIMIT_FULL_THRESHOLD = 1200;
export const RATE_LIMIT_INCREMENTAL_THRESHOLD = 50;
export const RATE_LIMIT_WARN_THRESHOLD = 100;
export const DEFAULT_FULL_PAGES = 5;
export const DEFAULT_PER_PAGE = 100;

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

export interface SyncDeps {
  db: Database;
  repoInfo: RepoInfo;
  auth: AuthResolution;
  /** テスト差し替えポイント */
  fetchFn?: FetchLike;
  /** テスト用: 現在時刻を固定 */
  now?: () => Date;
}

/** 秒単位の Unix → ISO8601 */
function unixToIso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function nowIso(deps: SyncDeps): string {
  const d = deps.now ? deps.now() : new Date();
  return d.toISOString();
}

function readRateLimit(headers: Headers): RateLimit {
  const remainingStr = headers.get("x-ratelimit-remaining");
  const limitStr = headers.get("x-ratelimit-limit");
  const resetStr = headers.get("x-ratelimit-reset");
  return {
    remaining: remainingStr != null ? Number(remainingStr) : null,
    limit: limitStr != null ? Number(limitStr) : null,
    resetAt: resetStr != null ? unixToIso(Number(resetStr)) : null,
  };
}

/** GitHub API 呼び出しラッパー。
 *  - Authorization header を付与
 *  - User-Agent を付与（GitHub REST の必須）
 *  - ETag 付き GET (`If-None-Match`) をサポート
 */
export async function ghFetch(
  deps: SyncDeps,
  path: string,
  opts: { etag?: string | null; method?: string } = {},
): Promise<Response> {
  const base = apiBaseUrl(deps.repoInfo.host);
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cmux-team-gh-cache",
  };
  if (deps.auth.token) {
    headers.Authorization = `Bearer ${deps.auth.token}`;
  }
  if (opts.etag) {
    headers["If-None-Match"] = opts.etag;
  }
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as FetchLike);
  return await fetchFn(url, { method: opts.method ?? "GET", headers });
}

/** `Link: <...>; rel="next"` の next URL を抽出。 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** GET /user で viewer_login を取得し sync_meta に保存。 */
export async function resolveViewerLogin(deps: SyncDeps): Promise<string | null> {
  const res = await ghFetch(deps, "/user");
  if (!res.ok) {
    void log(
      "gh_viewer_resolved_failed",
      `host=${deps.repoInfo.host} status=${res.status}`,
    );
    return null;
  }
  const body = await res.json();
  const parsed = GhUserSchema.safeParse(body);
  if (!parsed.success) {
    void log("gh_viewer_resolved_failed", `host=${deps.repoInfo.host} reason=parse_failed`);
    return null;
  }
  setSyncMeta(deps.db, { viewer_login: parsed.data.login });
  void log("gh_viewer_resolved", `login=${parsed.data.login} host=${deps.repoInfo.host}`);
  return parsed.data.login;
}

/** /rate_limit で残量を取得し sync_meta に記録。 */
export async function fetchRateLimit(deps: SyncDeps): Promise<RateLimit> {
  const res = await ghFetch(deps, "/rate_limit");
  const rl = readRateLimit(res.headers);
  try {
    const body = (await res.json()) as {
      rate?: { remaining?: number; limit?: number; reset?: number };
    };
    const core = body.rate;
    if (core) {
      rl.remaining = core.remaining ?? rl.remaining;
      rl.limit = core.limit ?? rl.limit;
      rl.resetAt = core.reset ? unixToIso(core.reset) : rl.resetAt;
    }
  } catch {
    // ignore body parse errors; header 値を返す
  }
  setSyncMeta(deps.db, {
    rate_limit_remaining: rl.remaining,
    rate_limit_reset: rl.resetAt,
  });
  return rl;
}

/** GhIssue から IssueRow（type/draft/merged_at 判別）を作る。 */
export function issueToRow(issue: GhIssue, fetchedAt: string): IssueRow {
  const isPr = issue.pull_request != null || issue.draft != null;
  const mergedAt =
    (issue as { merged_at?: string | null }).merged_at ??
    issue.pull_request?.merged_at ??
    null;
  const state = isPr && mergedAt ? "merged" : issue.state;
  return {
    number: issue.number,
    type: isPr ? "pr" : "issue",
    state,
    title: issue.title,
    body: issue.body ?? null,
    author_login: issue.user?.login ?? null,
    author_id: issue.user?.id ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at ?? null,
    merged_at: mergedAt,
    html_url: issue.html_url,
    comments_count: issue.comments ?? 0,
    milestone_id: issue.milestone?.id ?? null,
    draft: issue.draft == null ? null : issue.draft ? 1 : 0,
    etag: null,
    fetched_at: fetchedAt,
    raw_json: JSON.stringify(issue),
  };
}

/** issue 1 件分を DB に反映（本体 + labels + assignees + milestone）。 */
function persistIssue(db: Database, issue: GhIssue, fetchedAt: string): void {
  const row = issueToRow(issue, fetchedAt);
  upsertIssue(db, row);

  clearIssueLabels(db, row.number);
  for (const label of issue.labels ?? []) {
    upsertLabel(db, {
      id: label.id,
      name: label.name,
      color: label.color ?? null,
      description: label.description ?? null,
    });
    linkIssueLabel(db, row.number, label.id);
  }

  clearIssueAssignees(db, row.number);
  for (const user of issue.assignees ?? []) {
    upsertAssignee(db, {
      id: user.id,
      login: user.login,
      avatar_url: user.avatar_url ?? null,
    });
    linkIssueAssignee(db, row.number, user.id);
  }

  if (issue.milestone) {
    upsertMilestone(db, {
      id: issue.milestone.id,
      number: issue.milestone.number,
      title: issue.milestone.title,
      state: issue.milestone.state ?? null,
      due_on: issue.milestone.due_on ?? null,
      raw_json: JSON.stringify(issue.milestone),
    });
  }
}

/** comments / reviews / review_comments を個別 fetch して DB に反映。 */
async function syncIssueAttachments(
  deps: SyncDeps,
  issue: GhIssue,
  counters: {
    fetchedComments: number;
    fetchedReviews: number;
    fetchedReviewComments: number;
  },
): Promise<{
  fetchedComments: number;
  fetchedReviews: number;
  fetchedReviewComments: number;
}> {
  const { db, repoInfo } = deps;
  const issueNumber = issue.number;
  const isPr = issue.pull_request != null || issue.draft != null;

  if ((issue.comments ?? 0) > 0) {
    const res = await ghFetch(
      deps,
      `/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body)) {
        for (const raw of body) {
          const parsed = GhCommentSchema.safeParse(raw);
          if (!parsed.success) continue;
          upsertComment(db, {
            id: parsed.data.id,
            issue_number: issueNumber,
            author_login: parsed.data.user?.login ?? null,
            body: parsed.data.body,
            created_at: parsed.data.created_at,
            updated_at: parsed.data.updated_at,
            html_url: parsed.data.html_url ?? null,
            raw_json: JSON.stringify(parsed.data),
          });
          counters.fetchedComments += 1;
        }
      }
    }
  }

  if (isPr) {
    const reviewsRes = await ghFetch(
      deps,
      `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${issueNumber}/reviews?per_page=100`,
    );
    if (reviewsRes.ok) {
      const body = await reviewsRes.json();
      if (Array.isArray(body)) {
        for (const raw of body) {
          const parsed = GhReviewSchema.safeParse(raw);
          if (!parsed.success) continue;
          upsertReview(db, {
            id: parsed.data.id,
            pr_number: issueNumber,
            author_login: parsed.data.user?.login ?? null,
            state: parsed.data.state,
            body: parsed.data.body ?? null,
            submitted_at: parsed.data.submitted_at ?? null,
            raw_json: JSON.stringify(parsed.data),
          });
          counters.fetchedReviews += 1;
        }
      }
    }

    const rcRes = await ghFetch(
      deps,
      `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${issueNumber}/comments?per_page=100`,
    );
    if (rcRes.ok) {
      const body = await rcRes.json();
      if (Array.isArray(body)) {
        for (const raw of body) {
          const parsed = GhReviewCommentSchema.safeParse(raw);
          if (!parsed.success) continue;
          upsertReviewComment(db, {
            id: parsed.data.id,
            pr_number: issueNumber,
            review_id: parsed.data.pull_request_review_id ?? null,
            author_login: parsed.data.user?.login ?? null,
            body: parsed.data.body,
            path: parsed.data.path ?? null,
            line: parsed.data.line ?? null,
            original_line: parsed.data.original_line ?? null,
            commit_id: parsed.data.commit_id ?? null,
            created_at: parsed.data.created_at,
            updated_at: parsed.data.updated_at,
            raw_json: JSON.stringify(parsed.data),
          });
          counters.fetchedReviewComments += 1;
        }
      }
    }
  }

  return counters;
}

/** 初回 sync。 /issues?sort=updated を 5 ページ（最大 500 件）+ 付属データ。 */
export async function syncFull(deps: SyncDeps): Promise<SyncResult> {
  const started = performance.now();
  const fetchedAt = nowIso(deps);
  void log(
    "gh_sync_started",
    `mode=full host=${deps.repoInfo.host} owner=${deps.repoInfo.owner} repo=${deps.repoInfo.repo}`,
  );

  // viewer_login を先に解決（@me 解決用）
  await resolveViewerLogin(deps);

  // rate limit ガード
  const rl0 = await fetchRateLimit(deps);
  if (rl0.remaining != null && rl0.remaining < RATE_LIMIT_FULL_THRESHOLD) {
    void log(
      "gh_sync_rate_limited",
      `remaining=${rl0.remaining} reset_at=${rl0.resetAt ?? "unknown"}`,
    );
    throw new RateLimitExhaustedError(rl0);
  }

  const counters = {
    fetchedIssues: 0,
    fetchedComments: 0,
    fetchedReviews: 0,
    fetchedReviewComments: 0,
  };

  let lastRate: RateLimit = rl0;
  let url: string | null =
    `/repos/${deps.repoInfo.owner}/${deps.repoInfo.repo}/issues?state=all&sort=updated&direction=desc&per_page=${DEFAULT_PER_PAGE}&page=1`;
  let page = 0;
  let topEtag: string | null = null;

  while (url && page < DEFAULT_FULL_PAGES) {
    page += 1;
    const res = await ghFetch(deps, url);
    lastRate = readRateLimit(res.headers);
    if (page === 1) {
      topEtag = res.headers.get("etag");
    }

    if (res.status === 401 || res.status === 403) {
      void log("gh_sync_failed", `stage=full_list http_status=${res.status}`);
      throw new SyncHttpError(res.status, `fetch issues failed`);
    }
    if (!res.ok) {
      void log("gh_sync_failed", `stage=full_list http_status=${res.status}`);
      throw new SyncHttpError(res.status, `fetch issues failed`);
    }

    const body = await res.json();
    if (!Array.isArray(body)) break;

    for (const raw of body) {
      const parsed = GhIssueSchema.safeParse(raw);
      if (!parsed.success) continue;
      persistIssue(deps.db, parsed.data, fetchedAt);
      counters.fetchedIssues += 1;

      // rate limit がゆるくなっていれば attachments も取る
      if (
        lastRate.remaining == null ||
        lastRate.remaining > RATE_LIMIT_WARN_THRESHOLD
      ) {
        await syncIssueAttachments(deps, parsed.data, counters);
      }
    }

    const next = parseNextLink(res.headers.get("link"));
    url = next;
  }

  setSyncMeta(deps.db, {
    etag_issues_list: topEtag,
    last_full_sync: fetchedAt,
    last_incremental_sync: fetchedAt,
    rate_limit_remaining: lastRate.remaining ?? null,
    rate_limit_reset: lastRate.resetAt ?? null,
    last_error: null,
  });

  const durationMs = Math.round(performance.now() - started);
  void log(
    "gh_sync_completed",
    `mode=full fetched_issues=${counters.fetchedIssues} fetched_comments=${counters.fetchedComments} duration_ms=${durationMs}`,
  );

  return {
    mode: "full",
    notModified: false,
    fetchedIssues: counters.fetchedIssues,
    fetchedComments: counters.fetchedComments,
    fetchedReviews: counters.fetchedReviews,
    fetchedReviewComments: counters.fetchedReviewComments,
    durationMs,
    rateLimitRemaining: lastRate.remaining ?? null,
    rateLimitReset: lastRate.resetAt ?? null,
  };
}

/** 差分 sync。ETag 304 なら書き込まず early return。 */
export async function syncIncremental(deps: SyncDeps): Promise<SyncResult> {
  const started = performance.now();
  const fetchedAt = nowIso(deps);
  void log(
    "gh_sync_started",
    `mode=incremental host=${deps.repoInfo.host} owner=${deps.repoInfo.owner} repo=${deps.repoInfo.repo}`,
  );

  const meta = getSyncMeta(deps.db);
  if (!meta) {
    throw new Error("gh-cache.db not initialized; run syncFull first");
  }

  // viewer_login が未解決なら取得
  if (!meta.viewer_login) {
    await resolveViewerLogin(deps);
  }

  // rate limit ガード
  const rl0 = await fetchRateLimit(deps);
  if (rl0.remaining != null && rl0.remaining < RATE_LIMIT_INCREMENTAL_THRESHOLD) {
    void log(
      "gh_sync_rate_limited",
      `remaining=${rl0.remaining} reset_at=${rl0.resetAt ?? "unknown"}`,
    );
    throw new RateLimitExhaustedError(rl0);
  }

  const counters = {
    fetchedIssues: 0,
    fetchedComments: 0,
    fetchedReviews: 0,
    fetchedReviewComments: 0,
  };

  const since = meta.last_incremental_sync ?? meta.last_full_sync;
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";
  let url: string | null =
    `/repos/${deps.repoInfo.owner}/${deps.repoInfo.repo}/issues?state=all&sort=updated&direction=desc&per_page=${DEFAULT_PER_PAGE}${sinceQuery}`;

  let lastRate: RateLimit = rl0;
  let notModified = false;
  let topEtag: string | null = meta.etag_issues_list ?? null;
  let firstPage = true;

  while (url) {
    const res = await ghFetch(deps, url, {
      etag: firstPage ? meta.etag_issues_list : undefined,
    });
    lastRate = readRateLimit(res.headers);

    if (firstPage && res.status === 304) {
      notModified = true;
      break;
    }

    if (res.status === 401 || res.status === 403) {
      void log("gh_sync_failed", `stage=incremental_list http_status=${res.status}`);
      throw new SyncHttpError(res.status, "fetch issues failed");
    }
    if (!res.ok) {
      void log("gh_sync_failed", `stage=incremental_list http_status=${res.status}`);
      throw new SyncHttpError(res.status, "fetch issues failed");
    }

    if (firstPage) {
      topEtag = res.headers.get("etag");
    }
    firstPage = false;

    const body = await res.json();
    if (!Array.isArray(body)) break;

    for (const raw of body) {
      const parsed = GhIssueSchema.safeParse(raw);
      if (!parsed.success) continue;

      // updated_at が DB と同じなら skip（冪等）
      const prev = getIssue(deps.db, parsed.data.number);
      if (prev && prev.updated_at >= parsed.data.updated_at) {
        // 念のため labels / assignees 再リンクだけ通す
        persistIssue(deps.db, parsed.data, fetchedAt);
        counters.fetchedIssues += 1;
        continue;
      }
      persistIssue(deps.db, parsed.data, fetchedAt);
      counters.fetchedIssues += 1;

      if (
        lastRate.remaining == null ||
        lastRate.remaining > RATE_LIMIT_WARN_THRESHOLD
      ) {
        await syncIssueAttachments(deps, parsed.data, counters);
      }
    }

    const next = parseNextLink(res.headers.get("link"));
    url = next;
  }

  setSyncMeta(deps.db, {
    etag_issues_list: topEtag,
    last_incremental_sync: fetchedAt,
    rate_limit_remaining: lastRate.remaining ?? null,
    rate_limit_reset: lastRate.resetAt ?? null,
    last_error: null,
  });

  const durationMs = Math.round(performance.now() - started);
  void log(
    "gh_sync_completed",
    `mode=incremental not_modified=${notModified} fetched_issues=${counters.fetchedIssues} duration_ms=${durationMs}`,
  );

  return {
    mode: "incremental",
    notModified,
    fetchedIssues: counters.fetchedIssues,
    fetchedComments: counters.fetchedComments,
    fetchedReviews: counters.fetchedReviews,
    fetchedReviewComments: counters.fetchedReviewComments,
    durationMs,
    rateLimitRemaining: lastRate.remaining ?? null,
    rateLimitReset: lastRate.resetAt ?? null,
  };
}

// --- エラー ---

export class SyncHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export class RateLimitExhaustedError extends Error {
  constructor(public readonly rateLimit: RateLimit) {
    super(
      `GitHub rate limit exhausted: remaining=${rateLimit.remaining} reset_at=${rateLimit.resetAt ?? "unknown"}`,
    );
    this.name = "RateLimitExhaustedError";
  }
}
