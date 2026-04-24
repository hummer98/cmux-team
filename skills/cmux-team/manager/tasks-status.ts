import type { TaskMeta } from "./task";

/**
 * `cmux-team status` の Tasks セクション行を生成する。
 *
 * - open: draft / ready / assigned（進行中として扱う 3 ステータス）
 * - closed: closed（正常完了）
 * - aborted: aborted（中断済み。件数が 0 のときはセグメント自体を出さない）
 * - deleted: 表示しない（冗長）
 *
 * `OPEN_STATUSES` / `closed` / `aborted` 以外（`deleted` や想定外ステータス）は
 * 表示対象外。TaskStatus が拡張された場合、silent drop になる点に注意。
 */
export function buildTasksSectionLines(tasks: TaskMeta[]): string[] {
  const OPEN_STATUSES = new Set<string>(["draft", "ready", "assigned"]);
  let openCount = 0;
  let closedCount = 0;
  let abortedCount = 0;
  for (const t of tasks) {
    if (OPEN_STATUSES.has(t.status)) openCount++;
    else if (t.status === "closed") closedCount++;
    else if (t.status === "aborted") abortedCount++;
    // deleted および想定外ステータスは表示対象外
  }
  const segments = [`open: ${openCount}`, `closed: ${closedCount}`];
  if (abortedCount > 0) segments.push(`aborted: ${abortedCount}`);
  return [`  ${segments.join("  ")}`];
}
