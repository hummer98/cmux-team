/**
 * gh-cache-format: gh CLI 互換の JSON 整形 + 表示整形
 *
 * `cmux-team issue list --json number,title,author.login` のような
 * フィールド指定（gh CLI 互換）をサポートする。
 *
 * - state は gh CLI 互換で大文字（`OPEN` / `CLOSED` / `MERGED`）
 * - author は `{ login }`、assignees は `[{ login }]`、labels は `[{ name }]`
 * - 日付キーは `createdAt` / `updatedAt` / `closedAt` / `mergedAt`（camelCase）
 *
 * **注意:** `--json` なしのテキスト出力側（list / show）では state は小文字のまま。
 */
import type {
  IssueRow,
  LabelRow,
  AssigneeRow,
  CommentRow,
  ReviewRow,
  ReviewCommentRow,
} from "./gh-cache-types";

export interface IssueWithRelations {
  issue: IssueRow;
  labels: LabelRow[];
  assignees: AssigneeRow[];
  comments?: CommentRow[];
  reviews?: ReviewRow[];
  reviewComments?: ReviewCommentRow[];
}

/** gh-compat JSON 用の完全オブジェクトを組み立てる */
export function toGhJson(rel: IssueWithRelations): Record<string, unknown> {
  const { issue, labels, assignees, comments, reviews, reviewComments } = rel;
  const state = normalizeGhState(issue);
  const obj: Record<string, unknown> = {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state,
    author: issue.author_login ? { login: issue.author_login } : null,
    assignees: assignees.map((a) => ({ login: a.login })),
    labels: labels.map((l) => ({ name: l.name, color: l.color ?? "" })),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    url: issue.html_url,
    isPullRequest: issue.type === "pr",
    commentsCount: issue.comments_count,
  };
  if (issue.type === "pr") {
    obj.mergedAt = issue.merged_at;
    obj.isDraft = issue.draft === 1 ? true : issue.draft === 0 ? false : null;
  }
  if (comments) {
    obj.comments = comments.map((c) => ({
      author: c.author_login ? { login: c.author_login } : null,
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }
  if (reviews) {
    obj.reviews = reviews.map((r) => ({
      author: r.author_login ? { login: r.author_login } : null,
      state: r.state.toUpperCase(),
      body: r.body ?? "",
      submittedAt: r.submitted_at,
    }));
  }
  if (reviewComments) {
    obj.reviewComments = reviewComments.map((rc) => ({
      author: rc.author_login ? { login: rc.author_login } : null,
      body: rc.body,
      path: rc.path,
      line: rc.line ?? rc.original_line,
      createdAt: rc.created_at,
      updatedAt: rc.updated_at,
    }));
  }
  return obj;
}

/**
 * issue の state を gh CLI 互換の大文字ラベルに正規化する。
 * - PR で `merged_at` が立っていれば `MERGED`
 * - それ以外は `state` を大文字化
 */
export function normalizeGhState(issue: IssueRow): string {
  if (issue.type === "pr" && issue.merged_at) return "MERGED";
  return (issue.state ?? "").toUpperCase();
}

/**
 * gh CLI 互換のフィールド指定（`number,title,author.login,assignees[].login`）で
 * JSON オブジェクトをサブセット化する。
 *
 * - `foo.bar` はドットパス（オブジェクト展開）
 * - `foo[].bar` は配列要素のマップ
 * - 未知フィールドは無視（空 object にならないよう null ではなく欠落）
 */
export function pickGhFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const normalized = f.trim();
    if (!normalized) continue;
    const value = resolveGhField(source, normalized);
    if (value === undefined) continue;
    // gh CLI は出力キーとして top-level フィールド名を使う（foo.bar → foo）
    const topKey = normalized.split(/[.\[]/)[0]!;
    out[topKey] = value;
  }
  return out;
}

/**
 * `author.login` / `assignees[].login` 等の path を解決する。
 * 配列要素のマップは `[].rest` で表現する（gh CLI に倣う）。
 */
function resolveGhField(root: unknown, path: string): unknown {
  // まず top-level を取得し、残りのパスを再帰的に辿る
  const firstDot = path.indexOf(".");
  const firstBracket = path.indexOf("[]");
  // セパレータが無ければ top-level のプロパティ
  if (firstDot < 0 && firstBracket < 0) {
    return getProp(root, path);
  }
  // 最初に現れたセパレータで分割
  const sep =
    firstBracket < 0 || (firstDot >= 0 && firstDot < firstBracket)
      ? { pos: firstDot, kind: "dot" as const }
      : { pos: firstBracket, kind: "bracket" as const };
  const head = path.slice(0, sep.pos);
  const tail = sep.kind === "dot" ? path.slice(sep.pos + 1) : path.slice(sep.pos + 2);
  const headValue = getProp(root, head);
  if (headValue === undefined || headValue === null) return headValue;

  if (sep.kind === "bracket") {
    if (!Array.isArray(headValue)) return undefined;
    // `.rest` の先頭ドットを取り除く
    const rest = tail.startsWith(".") ? tail.slice(1) : tail;
    if (!rest) return headValue;
    return headValue.map((item) => resolveGhField(item, rest));
  }
  // dot
  return resolveGhField(headValue, tail);
}

function getProp(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

// --- テキスト出力（list 向け）---

export interface IssueListRow {
  issue: IssueRow;
  labels: LabelRow[];
  assignees: AssigneeRow[];
}

/**
 * `cmux-team issue list` のテキスト出力（3 列固定幅）:
 *   #NUMBER  STATE  TITLE  [labels]  (@assignees)
 *
 * - NUMBER は右寄せ 5 桁
 * - STATE は 6 桁左寄せ（open / closed / merged）
 * - 末尾に labels / assignees を付ける（空なら省略）
 */
export function formatIssueListRow(row: IssueListRow): string {
  const { issue, labels, assignees } = row;
  const num = `#${issue.number}`.padStart(6);
  const state = displayState(issue).padEnd(7);
  const parts: string[] = [num, state, issue.title];
  if (labels.length > 0) {
    parts.push(`[${labels.map((l) => l.name).join(", ")}]`);
  }
  if (assignees.length > 0) {
    parts.push(`(@${assignees.map((a) => a.login).join(", @")})`);
  }
  return parts.join("  ");
}

/** `open` / `closed` / `merged` のテキスト表示用 state */
export function displayState(issue: IssueRow): string {
  if (issue.type === "pr" && issue.merged_at) return "merged";
  return issue.state ?? "";
}

/** `cmux-team issue show` のテキスト出力 */
export function formatIssueShow(rel: IssueWithRelations): string {
  const { issue, labels, assignees, comments, reviews, reviewComments } = rel;
  const lines: string[] = [];
  lines.push(`#${issue.number} ${issue.title}`);
  lines.push(`state:     ${displayState(issue)}`);
  lines.push(`author:    @${issue.author_login ?? "-"}`);
  lines.push(`created:   ${issue.created_at}`);
  lines.push(`updated:   ${issue.updated_at}`);
  if (issue.closed_at) lines.push(`closed:    ${issue.closed_at}`);
  if (issue.merged_at) lines.push(`merged:    ${issue.merged_at}`);
  if (labels.length > 0) {
    lines.push(`labels:    ${labels.map((l) => l.name).join(", ")}`);
  }
  if (assignees.length > 0) {
    lines.push(`assignees: ${assignees.map((a) => `@${a.login}`).join(", ")}`);
  }
  lines.push(`url:       ${issue.html_url}`);
  lines.push("");
  lines.push(issue.body ?? "");
  if (comments && comments.length > 0) {
    lines.push("");
    lines.push("── comments ──");
    for (const c of comments) {
      lines.push("");
      lines.push(`@${c.author_login ?? "-"}  ${c.created_at}`);
      lines.push(c.body);
    }
  }
  if (reviews && reviews.length > 0) {
    lines.push("");
    lines.push("── reviews ──");
    for (const r of reviews) {
      lines.push("");
      lines.push(`@${r.author_login ?? "-"}  ${r.state}  ${r.submitted_at ?? ""}`);
      if (r.body) lines.push(r.body);
    }
  }
  if (reviewComments && reviewComments.length > 0) {
    lines.push("");
    lines.push("── review comments ──");
    for (const rc of reviewComments) {
      lines.push("");
      const loc = rc.path ? `${rc.path}:${rc.line ?? rc.original_line ?? "?"}` : "";
      lines.push(`@${rc.author_login ?? "-"}  ${loc}  ${rc.created_at}`);
      lines.push(rc.body);
    }
  }
  return lines.join("\n");
}
