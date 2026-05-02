/**
 * T414: Agent 戦略分類 — task_sessions の agent_spawned 行を集約して role 分布を出し、
 *        6 値ラベル (solo / research-only / plan-impl / parallel-impl / full-cycle / other) に分類する。
 *
 * Step 3 で本実装。Step 2 では dashboard-server.ts から import するため最低限の export を提供する。
 *
 * 仕様の暫定性は docs/spec/12-web-dashboard.md に記載。実データを見て classifyStrategy を改訂する想定。
 */
import type { Database } from "bun:sqlite";
import { readTaskLifecycle, type Outcome } from "./metrics-aggregate";

export type AgentStrategyLabel =
  | "solo"
  | "research-only"
  | "plan-impl"
  | "parallel-impl"
  | "full-cycle"
  | "other";

export interface AgentStrategyRow {
  task_id: string;
  roles: Record<string, number>;
  label: AgentStrategyLabel;
}

export interface AgentStrategyDrillDownResponse {
  task_id: string;
  conductor: {
    surface: string | null;
    assignedTs: string;
    closedTs: string | null;
    outcome: Outcome;
  };
  agents: Array<{
    role: string;
    surface: string;
    spawnedTs: string;
    closedTs: string | null;
    sessionId: string;
  }>;
}

/** 純粋関数: roles 件数から 6 値ラベルへ分類 */
export function classifyStrategy(roles: Record<string, number>): AgentStrategyLabel {
  const has = (k: string) => (roles[k] ?? 0) > 0;
  const cnt = (k: string) => roles[k] ?? 0;
  const total = Object.values(roles).reduce((a, b) => a + b, 0);

  if (total === 0) return "solo";
  if (has("researcher") && total === cnt("researcher")) return "research-only";
  if (has("planner") && has("implementer") && total === cnt("planner") + cnt("implementer")) return "plan-impl";
  if (cnt("implementer") >= 2) return "parallel-impl";
  if (has("researcher") && has("planner") && has("implementer") && has("reviewer")) return "full-cycle";
  return "other";
}

/**
 * 期間内の task_id ごとに role 別の agent_spawned 件数と分類ラベルを返す。
 * 直近 limit task に絞る（task_id 文字列の MAX(timestamp) で降順）。
 */
export function aggregateAgentStrategyByTask(
  db: Database,
  opts: { sinceIso: string; untilIso: string; limit?: number },
): AgentStrategyRow[] {
  const limit = opts.limit ?? 30;
  // まず期間内に出現した task_id を最新 limit 件取得
  const taskRows = db
    .prepare(
      `SELECT task_id, MAX(timestamp) AS last_ts
       FROM task_sessions
       WHERE event = 'agent_spawned'
         AND timestamp >= $sinceIso
         AND timestamp <= $untilIso
         AND task_id IS NOT NULL
       GROUP BY task_id
       ORDER BY last_ts DESC
       LIMIT $limit`,
    )
    .all({
      $sinceIso: opts.sinceIso,
      $untilIso: opts.untilIso,
      $limit: limit,
    }) as Array<{ task_id: string; last_ts: string }>;

  if (taskRows.length === 0) return [];

  const taskIds = taskRows.map((r) => r.task_id);
  const placeholders = taskIds.map((_, i) => `$t${i}`).join(",");
  const params: Record<string, string> = {
    $sinceIso: opts.sinceIso,
    $untilIso: opts.untilIso,
  };
  taskIds.forEach((id, i) => {
    params[`$t${i}`] = id;
  });

  const detailRows = db
    .prepare(
      `SELECT task_id, COALESCE(role, 'other') AS role, COUNT(*) AS n
       FROM task_sessions
       WHERE event = 'agent_spawned'
         AND task_id IN (${placeholders})
         AND timestamp >= $sinceIso
         AND timestamp <= $untilIso
       GROUP BY task_id, role`,
    )
    .all(params) as Array<{ task_id: string; role: string; n: number }>;

  const byTask = new Map<string, Record<string, number>>();
  for (const r of detailRows) {
    const cur = byTask.get(r.task_id) ?? {};
    cur[r.role] = (cur[r.role] ?? 0) + r.n;
    byTask.set(r.task_id, cur);
  }

  return taskRows.map((tr) => {
    const roles = byTask.get(tr.task_id) ?? {};
    return {
      task_id: tr.task_id,
      roles,
      label: classifyStrategy(roles),
    };
  });
}

/** bucket × role の積み上げを返す。groupBy: day (10 chars) / hour (13 chars)。 */
export function aggregateAgentSpawnTimeline(
  db: Database,
  opts: { sinceIso: string; untilIso: string; groupBy: "day" | "hour" },
): Array<{ bucket: string; counts: Record<string, number> }> {
  const bucketLen = opts.groupBy === "hour" ? 13 : 10;
  const rows = db
    .prepare(
      `SELECT
         substr(timestamp, 1, $bucketLen) AS bucket,
         COALESCE(role, 'other') AS role,
         COUNT(*) AS n
       FROM task_sessions
       WHERE event = 'agent_spawned'
         AND timestamp >= $sinceIso
         AND timestamp <= $untilIso
       GROUP BY bucket, role
       ORDER BY bucket ASC`,
    )
    .all({
      $bucketLen: bucketLen,
      $sinceIso: opts.sinceIso,
      $untilIso: opts.untilIso,
    }) as Array<{ bucket: string; role: string; n: number }>;
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const cur = map.get(r.bucket) ?? {};
    cur[r.role] = (cur[r.role] ?? 0) + r.n;
    map.set(r.bucket, cur);
  }
  return [...map.entries()].map(([bucket, counts]) => ({ bucket, counts }));
}

/**
 * 特定 task の drill-down: conductor + agent 一覧 + outcome。
 * 該当 task_id が task_sessions に 1 件もなければ null を返す。
 */
export async function getAgentStrategyForTask(
  db: Database,
  eventsFile: string,
  taskId: string,
): Promise<AgentStrategyDrillDownResponse | null> {
  const sessions = db
    .prepare(
      `SELECT timestamp, role, surface, session_id, event
       FROM task_sessions
       WHERE task_id = $taskId
       ORDER BY id ASC`,
    )
    .all({ $taskId: taskId }) as Array<{
      timestamp: string;
      role: string | null;
      surface: string | null;
      session_id: string;
      event: string;
    }>;

  if (sessions.length === 0) return null;

  const conductorRow = sessions.find((s) => s.event === "assigned");
  const closedRow = sessions.find(
    (s) => s.event === "closed" || s.event === "aborted",
  );
  const agentRows = sessions.filter((s) => s.event === "agent_spawned");

  // outcome は events.jsonl の lifecycle が真。失敗したら "open" にフォールバック。
  let outcome: Outcome = "open";
  try {
    const lc = await readTaskLifecycle(eventsFile, null);
    const found = lc.get(taskId);
    if (found) outcome = found.outcome;
  } catch {
    // events.jsonl 不在は "open" のまま
  }

  return {
    task_id: taskId,
    conductor: {
      surface: conductorRow?.surface ?? null,
      assignedTs: conductorRow?.timestamp ?? sessions[0]!.timestamp,
      closedTs: closedRow?.timestamp ?? null,
      outcome,
    },
    agents: agentRows.map((a) => ({
      role: a.role ?? "other",
      surface: a.surface ?? "",
      spawnedTs: a.timestamp,
      closedTs: null,
      sessionId: a.session_id,
    })),
  };
}
