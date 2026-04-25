/**
 * T326: Conductor / Agent の asking 描画テスト。
 *
 * - dashboard.tsx の buildConductorRow / formatConductorsSectionLabel を直接叩いて、
 *   YELLOW + ⚠/? マーク + asking ラベル + truncate 等の表示仕様を回帰防止する。
 * - dashboard-issues.test.tsx と同じく、ui.text / ui.row オブジェクトは JSON.stringify
 *   してから toContain で文字列検証する。
 *
 * YELLOW (rgb(200, 160, 0)) は @rezi-ui/core の rgb() で 24bit 整数化されると 13148160。
 */
import { describe, test, expect } from "bun:test";
import { buildConductorRow, formatConductorsSectionLabel } from "./dashboard";
import type { ConductorState, AgentState } from "./schema";
import { rgb } from "@rezi-ui/core";

const YELLOW_VALUE = rgb(200, 160, 0);

function stringifyRow(row: any): string {
  return JSON.stringify(row);
}

function countYellow(json: string): number {
  // `"fg":13148160` の出現回数
  const needle = `"fg":${YELLOW_VALUE}`;
  let count = 0;
  let idx = 0;
  while ((idx = json.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

describe("buildConductorRow: Conductor asking", () => {
  test("⚠ + asking + T326 + 質問本文を含み YELLOW が 2 箇所以上", () => {
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:c1",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      status: "asking",
      askQuestion: "デプロイ先は本番ですか?",
      taskId: "326",
      taskTitle: "demo",
      agents: [],
    };
    const row = buildConductorRow(conductor, null, 0);
    const json = stringifyRow(row);

    expect(json).toContain("⚠");
    expect(json).toContain("asking");
    expect(json).toContain("T326");
    expect(json).toContain("デプロイ先は本番ですか?");
    expect(json).toContain("[c1]");

    // ⚠ + asking ラベル + ? 行先頭で少なくとも 2 箇所 YELLOW を期待
    expect(countYellow(json)).toBeGreaterThanOrEqual(2);
  });

  test("質問本文は 120 char を超えると 117 char + '...' で truncate される", () => {
    const long = "あ".repeat(200);
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      status: "asking",
      askQuestion: long,
      taskId: "326",
      taskTitle: "demo",
      agents: [],
    };
    const json = stringifyRow(buildConductorRow(conductor, null, 0));

    const truncated = "あ".repeat(117) + "...";
    expect(json).toContain(truncated);
    // 元の 200 文字版が丸ごと出ていないこと
    expect(json.includes("あ".repeat(200))).toBe(false);
  });
});

describe("buildConductorRow: Agent asking サブツリー", () => {
  test("Agent 行に '?' / role icon (⚙) / taskTitle / surface ラベルを含む", () => {
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:c1",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      status: "running",
      taskId: "326",
      taskTitle: "demo conductor",
      agents: [
        {
          surface: "surface:a1",
          spawnedAt: new Date(Date.now() - 500).toISOString(),
          status: "asking",
          role: "implementer",
          taskTitle: "fix bug",
        },
      ],
    };
    const json = stringifyRow(buildConductorRow(conductor, null, 0));

    // Agent asking 行の構成要素 (dashboard.tsx:638-648)
    expect(json).toContain("?"); // ? マーク
    expect(json).toContain("⚙"); // implementer の role icon
    expect(json).toContain("fix bug"); // label = taskTitle
    expect(json).toContain("[a1]"); // surface ラベル

    // Agent 行は YELLOW で 3 ノード（[a1], ?, ⚙ fix bug）に塗られる → 親 Conductor の YELLOW と合わせて多数
    expect(countYellow(json)).toBeGreaterThanOrEqual(3);
  });
});

describe("formatConductorsSectionLabel", () => {
  test("各 status のカウントが正確に連結される", () => {
    const conductors = [
      { status: "starting" },
      { status: "assigning" },
      { status: "asking" },
      { status: "asking" },
      { status: "running" },
      { status: "broken" },
    ];
    const label = formatConductorsSectionLabel(conductors);
    expect(label).toBe(
      "Conductors 1 starting 1 assigning 2 asking 1 running 1 broken",
    );
  });

  test("0 件の status はラベルから除外される (Conductors プレフィックスのみ)", () => {
    expect(formatConductorsSectionLabel([])).toBe("Conductors");
  });

  test("asking のみ 2 件のときは '2 asking' を含む (他のラベルは出ない)", () => {
    const label = formatConductorsSectionLabel([
      { status: "asking" },
      { status: "asking" },
      { status: "idle" }, // idle は集計対象外（既存実装と一致）
    ]);
    expect(label).toBe("Conductors 2 asking");
    expect(label).toContain("2 asking");
  });
});
