/**
 * gh-cache-cli: `cmux-team issue …` / `cmux-team pr …` のハンドラ
 *
 * - `issue list` / `issue show` / `issue search`
 * - `pr list` / `pr show`
 *
 * いずれもデフォルトはキャッシュ読み取り。`--sync` が付くと事前に
 * incremental 同期を走らせる。`--stale-ok` 指定時はキャッシュの古さ警告を
 * 抑止する（rate-limit 時や offline で有用）。
 *
 * Exit codes:
 *   0 success
 *   1 generic
 *   2 non-git / non-GitHub
 *   3 auth missing
 *   4 rate limit exhausted
 */
import type { Database } from "bun:sqlite";
import { t } from "./i18n";
import { log } from "./logger";
import {
  listIssues,
  searchIssues,
  getIssue,
  getIssueLabels,
  getIssueAssignees,
  getIssueComments,
  getPrReviews,
  getPrReviewComments,
  getSyncMeta,
  type IssueListFilter,
} from "./gh-cache-store";
import type {
  IssueRow,
  RepoInfo,
  AuthResolution,
} from "./gh-cache-types";
import {
  toGhJson,
  pickGhFields,
  formatIssueListRow,
  formatIssueShow,
  type IssueWithRelations,
} from "./gh-cache-format";
import { syncIncremental, RateLimitExhaustedError, SyncHttpError } from "./gh-cache-sync";

const STALE_DAYS = 7;

// --- 引数アクセスのヘルパ（main.ts の args 配列に対応）---

function getFlagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasBareFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** `--limit N` を整数化（不正値は 30） */
function parseLimit(args: string[]): number {
  const raw = getFlagValue(args, "limit");
  if (!raw) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 1000);
}

/** `--state open|closed|merged|all` → IssueListFilter.state */
function parseState(
  args: string[],
  defaultValue: "open" | "closed" | "merged" | "all" = "open",
): "open" | "closed" | "merged" | "all" {
  const raw = getFlagValue(args, "state");
  if (!raw) return defaultValue;
  const v = raw.toLowerCase();
  if (v === "open" || v === "closed" || v === "merged" || v === "all") return v;
  return defaultValue;
}

// --- 依存性（main.ts 側から注入される）---

export interface GhContext {
  db: Database;
  repoInfo: RepoInfo;
  auth: AuthResolution & { token: string };
}

export interface CliDeps extends GhContext {
  args: string[];
  fetchFn?: typeof fetch; // テスト用 DI
  stdout?: (s: string) => void;
}

function print(deps: CliDeps, s: string): void {
  (deps.stdout ?? console.log)(s);
}

/** キャッシュが stale（最終 full sync から STALE_DAYS 日以上）なら警告を出す */
function maybeWarnStale(deps: CliDeps): void {
  if (hasBareFlag(deps.args, "stale-ok")) return;
  const meta = getSyncMeta(deps.db);
  if (!meta?.last_full_sync) return;
  const then = Date.parse(meta.last_full_sync);
  if (!Number.isFinite(then)) return;
  const days = Math.floor((Date.now() - then) / (24 * 3600 * 1000));
  if (days >= STALE_DAYS) {
    console.error(t("gh_stale_warning", { days: String(days) }));
  }
}

/**
 * `--assignee @me` を `sync_meta.viewer_login` に解決する。
 * 解決できない場合は exit 1（@me を使うなら sync を先に実行する必要がある）。
 */
function resolveAssignee(deps: CliDeps): string | undefined {
  const raw = getFlagValue(deps.args, "assignee");
  if (!raw) return undefined;
  if (raw === "@me") {
    const meta = getSyncMeta(deps.db);
    if (!meta?.viewer_login) {
      console.error(t("gh_me_not_resolved"));
      process.exit(1);
    }
    return meta.viewer_login;
  }
  // `@login` の先頭 @ は取り除く
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

/** 同じく `--author @me` を解決する */
function resolveAuthor(deps: CliDeps): string | undefined {
  const raw = getFlagValue(deps.args, "author");
  if (!raw) return undefined;
  if (raw === "@me") {
    const meta = getSyncMeta(deps.db);
    if (!meta?.viewer_login) {
      console.error(t("gh_me_not_resolved"));
      process.exit(1);
    }
    return meta.viewer_login;
  }
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

/** `--sync` フラグが立っていれば事前に incremental sync を走らせる */
async function maybeSync(deps: CliDeps): Promise<void> {
  if (!hasBareFlag(deps.args, "sync")) return;
  try {
    await syncIncremental({
      db: deps.db,
      repoInfo: deps.repoInfo,
      auth: deps.auth,
      fetchFn: deps.fetchFn,
    });
  } catch (e) {
    if (e instanceof RateLimitExhaustedError) {
      console.error(
        t("gh_rate_limit_exhausted", {
          remaining: String(e.rateLimit.remaining ?? "?"),
          reset_at: e.rateLimit.resetAt ?? "?",
        }),
      );
      process.exit(4);
    }
    if (e instanceof SyncHttpError) {
      console.error(`Error: GitHub API ${e.status}: ${e.message}`);
      process.exit(1);
    }
    const msg = e instanceof Error ? e.message : String(e);
    log("error", `gh_cli_sync_failed: ${msg}`);
    // sync 失敗時はキャッシュ読み取りにフォールバック
    console.error(`Warning: sync failed, reading from cache: ${msg}`);
  }
}

// --- issue list / show / search ---

/**
 * `cmux-team issue list [--state open|closed|merged|all] [--assignee @me]
 *                      [--author <name>] [--label <name>] [--limit 30]
 *                      [--json FIELDS] [--sync] [--stale-ok]`
 *
 * - `issue` type のみ（PR は除外）
 * - デフォルト state=open
 */
export async function cmdIssueList(deps: CliDeps): Promise<void> {
  await maybeSync(deps);
  maybeWarnStale(deps);

  const filter: IssueListFilter = {
    type: "issue",
    state: parseState(deps.args, "open"),
    assigneeLogin: resolveAssignee(deps),
    authorLogin: resolveAuthor(deps),
    labelName: getFlagValue(deps.args, "label"),
    limit: parseLimit(deps.args),
  };
  const rows = listIssues(deps.db, filter);
  printIssueList(deps, rows);
}

/** `cmux-team pr list ...` (type="pr") */
export async function cmdPrList(deps: CliDeps): Promise<void> {
  await maybeSync(deps);
  maybeWarnStale(deps);

  const filter: IssueListFilter = {
    type: "pr",
    state: parseState(deps.args, "open"),
    assigneeLogin: resolveAssignee(deps),
    authorLogin: resolveAuthor(deps),
    labelName: getFlagValue(deps.args, "label"),
    limit: parseLimit(deps.args),
  };
  const rows = listIssues(deps.db, filter);
  printIssueList(deps, rows);
}

function printIssueList(deps: CliDeps, rows: IssueRow[]): void {
  const jsonFields = getFlagValue(deps.args, "json");

  if (jsonFields !== undefined) {
    const fields = jsonFields.split(",").map((s) => s.trim()).filter((s) => s);
    const out = rows.map((r) => {
      const labels = getIssueLabels(deps.db, r.number);
      const assignees = getIssueAssignees(deps.db, r.number);
      const full = toGhJson({ issue: r, labels, assignees });
      return fields.length > 0 ? pickGhFields(full, fields) : full;
    });
    print(deps, JSON.stringify(out, null, 2));
    return;
  }

  if (rows.length === 0) {
    print(deps, t("gh_issue_empty"));
    return;
  }
  for (const r of rows) {
    const labels = getIssueLabels(deps.db, r.number);
    const assignees = getIssueAssignees(deps.db, r.number);
    print(deps, formatIssueListRow({ issue: r, labels, assignees }));
  }
}

/**
 * `cmux-team issue show <N> [--json FIELDS] [--sync]`
 * `cmux-team pr show <N> [--json FIELDS] [--sync]`
 *
 * 両者で同じ処理（PR は reviews / review_comments を追加で付ける）。
 */
export async function cmdIssueShow(deps: CliDeps, kind: "issue" | "pr"): Promise<void> {
  const numRaw = deps.args[2]; // `issue show <N>` or `pr show <N>`
  if (!numRaw) {
    console.error(
      kind === "issue"
        ? "Usage: cmux-team issue show <number>"
        : "Usage: cmux-team pr show <number>",
    );
    process.exit(1);
  }
  const number = Number(numRaw);
  if (!Number.isInteger(number) || number <= 0) {
    console.error(`Error: invalid number: ${numRaw}`);
    process.exit(1);
  }

  await maybeSync(deps);
  maybeWarnStale(deps);

  const issue = getIssue(deps.db, number);
  if (!issue) {
    console.error(t("gh_cache_not_initialized"));
    process.exit(1);
  }
  // kind が指定されたら type が一致しているか検証（不一致なら cache miss 扱い）
  if (issue.type !== kind) {
    console.error(
      `Error: #${number} is a ${issue.type}, not ${kind}. Try 'cmux-team ${issue.type} show ${number}'.`,
    );
    process.exit(1);
  }

  const labels = getIssueLabels(deps.db, number);
  const assignees = getIssueAssignees(deps.db, number);
  const comments = getIssueComments(deps.db, number);
  const rel: IssueWithRelations = { issue, labels, assignees, comments };
  if (kind === "pr") {
    rel.reviews = getPrReviews(deps.db, number);
    rel.reviewComments = getPrReviewComments(deps.db, number);
  }

  const jsonFields = getFlagValue(deps.args, "json");
  if (jsonFields !== undefined) {
    const fields = jsonFields.split(",").map((s) => s.trim()).filter((s) => s);
    const full = toGhJson(rel);
    const out = fields.length > 0 ? pickGhFields(full, fields) : full;
    print(deps, JSON.stringify(out, null, 2));
    return;
  }

  print(deps, formatIssueShow(rel));
}

/**
 * `cmux-team issue search <query> [--state ...] [--limit 30] [--json FIELDS]`
 *
 * キャッシュ内 LIKE 検索（title + body）。`--sync` で事前に incremental を
 * 走らせられるが、キャッシュにない issue はヒットしない（そもそも未取得）。
 */
export async function cmdIssueSearch(deps: CliDeps): Promise<void> {
  const query = deps.args[2];
  if (!query) {
    console.error("Usage: cmux-team issue search <query>");
    process.exit(1);
  }

  await maybeSync(deps);
  maybeWarnStale(deps);

  const filter: IssueListFilter = {
    type: "issue",
    state: parseState(deps.args, "all"),
    limit: parseLimit(deps.args),
  };
  const rows = searchIssues(deps.db, query, filter);
  printIssueList(deps, rows);
}
