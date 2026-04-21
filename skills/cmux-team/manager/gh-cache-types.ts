/**
 * gh-cache 型定義（zod スキーマ）
 *
 * GitHub REST API レスポンスの型チェック、DB レコード、CLI 引数を
 * zod 経由で一元管理する。生 JSON のフィールド欠損を raw_json 以外で
 * 扱う前に必ず parse を通す。
 */
import { z } from "zod";

// --- GitHub API レスポンス（最小限、未知フィールドは passthrough）---

export const GhUserSchema = z
  .object({
    id: z.number().int(),
    login: z.string(),
    avatar_url: z.string().optional().nullable(),
  })
  .passthrough();

export const GhLabelSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    color: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })
  .passthrough();

export const GhMilestoneSchema = z
  .object({
    id: z.number().int(),
    number: z.number().int(),
    title: z.string(),
    state: z.string().optional().nullable(),
    due_on: z.string().optional().nullable(),
  })
  .passthrough();

export const GhPullRequestRefSchema = z
  .object({
    url: z.string().optional(),
    merged_at: z.string().optional().nullable(),
  })
  .passthrough();

export const GhIssueSchema = z
  .object({
    number: z.number().int(),
    state: z.string(),
    title: z.string(),
    body: z.string().optional().nullable(),
    user: GhUserSchema.optional().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().optional().nullable(),
    html_url: z.string(),
    comments: z.number().int().optional().default(0),
    labels: z.array(GhLabelSchema).optional().default([]),
    assignees: z.array(GhUserSchema).optional().default([]),
    milestone: GhMilestoneSchema.optional().nullable(),
    pull_request: GhPullRequestRefSchema.optional().nullable(),
    draft: z.boolean().optional().nullable(),
    // PR 本体 (GET /pulls/{n}) では merged_at が直接 top level
    merged_at: z.string().optional().nullable(),
  })
  .passthrough();

export type GhIssue = z.infer<typeof GhIssueSchema>;

export const GhCommentSchema = z
  .object({
    id: z.number().int(),
    body: z.string(),
    user: GhUserSchema.optional().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string().optional().nullable(),
  })
  .passthrough();

export type GhComment = z.infer<typeof GhCommentSchema>;

export const GhReviewSchema = z
  .object({
    id: z.number().int(),
    user: GhUserSchema.optional().nullable(),
    state: z.string(),
    body: z.string().optional().nullable(),
    submitted_at: z.string().optional().nullable(),
  })
  .passthrough();

export type GhReview = z.infer<typeof GhReviewSchema>;

export const GhReviewCommentSchema = z
  .object({
    id: z.number().int(),
    pull_request_review_id: z.number().int().optional().nullable(),
    user: GhUserSchema.optional().nullable(),
    body: z.string(),
    path: z.string().optional().nullable(),
    line: z.number().int().optional().nullable(),
    original_line: z.number().int().optional().nullable(),
    commit_id: z.string().optional().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export type GhReviewComment = z.infer<typeof GhReviewCommentSchema>;

// --- DB レコード（row 型）---

export interface IssueRow {
  number: number;
  type: "issue" | "pr";
  state: string;
  title: string;
  body: string | null;
  author_login: string | null;
  author_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  html_url: string;
  comments_count: number;
  milestone_id: number | null;
  draft: number | null;
  etag: string | null;
  fetched_at: string;
  raw_json: string | null;
}

export interface CommentRow {
  id: number;
  issue_number: number;
  author_login: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string | null;
  raw_json: string | null;
}

export interface ReviewRow {
  id: number;
  pr_number: number;
  author_login: string | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
  raw_json: string | null;
}

export interface ReviewCommentRow {
  id: number;
  pr_number: number;
  review_id: number | null;
  author_login: string | null;
  body: string;
  path: string | null;
  line: number | null;
  original_line: number | null;
  commit_id: string | null;
  created_at: string;
  updated_at: string;
  raw_json: string | null;
}

export interface LabelRow {
  id: number;
  name: string;
  color: string | null;
  description: string | null;
}

export interface AssigneeRow {
  id: number;
  login: string;
  avatar_url: string | null;
}

export interface MilestoneRow {
  id: number;
  number: number;
  title: string;
  state: string | null;
  due_on: string | null;
  raw_json: string | null;
}

export interface SyncMeta {
  key: "global";
  token_hash: string;
  host: string;
  owner: string;
  repo: string;
  viewer_login: string | null;
  etag_issues_list: string | null;
  last_full_sync: string | null;
  last_incremental_sync: string | null;
  rate_limit_remaining: number | null;
  rate_limit_reset: string | null;
  last_error: string | null;
}

export interface SyncResult {
  mode: "full" | "incremental";
  notModified: boolean;
  fetchedIssues: number;
  fetchedComments: number;
  fetchedReviews: number;
  fetchedReviewComments: number;
  durationMs: number;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
}

export interface RepoInfo {
  /** host: "api.github.com" or "ghe.example.com/api/v3" */
  host: string;
  owner: string;
  repo: string;
}

export type AuthKind = "env" | "gh-cli" | "none";

export interface AuthResolution {
  kind: AuthKind;
  token?: string;
  host: string;
  /** どの env 変数 / コマンドを試したかのリスト（未認証エラー表示用） */
  checked: string[];
}

export interface RateLimit {
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
}
