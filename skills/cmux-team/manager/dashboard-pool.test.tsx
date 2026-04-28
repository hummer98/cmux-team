/**
 * dashboard-pool.test.tsx (T374 / A024)
 *
 * dashboard.tsx の Conductor / Agent 行が per-surface decoration を持たないことを検証する
 * 回帰テスト（A024 §per-handle 行は出さない）。
 *
 * 旧 (T351/T352/T363/T366) buildPoolHeader / buildSurfaceRowSuffix /
 * buildConductorRowWithPool の per-handle suffix テストは T374 で全削除。
 * 新仕様 spark+next の表示は `pool-header-display.test.ts` で検証。
 */
import { describe, expect, test } from "bun:test";
import { buildConductorRow } from "./dashboard";
import type { ConductorState, AgentState } from "./schema";

function stringify(node: any): string {
  return JSON.stringify(node);
}

function countSurfaceLabel(json: string, surface: string): number {
  const needle = `[${surface}]`;
  let count = 0;
  let idx = 0;
  while ((idx = json.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

describe("buildConductorRow (T374): per-surface pool decoration を持たない", () => {
  test("Conductor 行に @handle / <5h: / cap: が含まれない", () => {
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      taskId: "351",
      taskTitle: "demo",
      tokenHandle: "@kddi",
      agents: [],
    };
    const json = stringify(buildConductorRow(conductor, null, 0));
    expect(json).not.toContain("@kddi");
    expect(json).not.toContain("<5h:");
    expect(json).not.toContain("cap:");
    expect(json).not.toContain("(no token)");
    // surface ラベル `[100]` は 1 度だけ
    expect(countSurfaceLabel(json, "100")).toBe(1);
  });

  test("Agent 行にも @handle / <5h: / cap: が含まれない", () => {
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      taskId: "351",
      taskTitle: "demo",
      tokenHandle: "@kddi",
      agents: [
        {
          surface: "surface:200",
          spawnedAt: new Date(Date.now() - 500).toISOString(),
          status: "running",
          role: "implementer",
          taskTitle: "fix bug",
          tokenHandle: "@tayo",
        },
      ],
    };
    const json = stringify(buildConductorRow(conductor, null, 0));
    expect(json).not.toContain("@kddi");
    expect(json).not.toContain("@tayo");
    expect(json).not.toContain("<5h:");
    expect(json).not.toContain("cap:");
    expect(countSurfaceLabel(json, "200")).toBe(1);
    expect(countSurfaceLabel(json, "100")).toBe(1);
  });
});
