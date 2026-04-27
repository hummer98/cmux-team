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
import { buildConductorRow, buildConductorRowWithPool, formatConductorsSectionLabel } from "./dashboard";
import type { ConductorState, AgentState } from "./schema";
import type { PerHandleSummary } from "./pool-summary";
import { rgb } from "@rezi-ui/core";

const YELLOW_VALUE = rgb(200, 160, 0);
const CYAN_VALUE = rgb(0, 180, 180);

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

// ─────────────────────────────────────────────────────────────────────────────
// T352: Agent 行のスピナー直後に @handle を配置
// ─────────────────────────────────────────────────────────────────────────────

describe("buildConductorRowWithPool: T352 Agent 行 handle 表示", () => {
  // Conductor は @conductor、Agent は @kddi の別 handle を使う。
  // → @kddi の出現回数 == Agent 行に挿入された数（重複検出に使える）。
  // Conductor は status="idle" にして spinner ▖ や taskTitle "foo" 等が Conductor 行に
  // 混ざらないようにし、Agent 行内の順序 assertion をシンプルに保つ。
  function makeConductor(agent: AgentState): ConductorState & { agents: AgentState[]; status: string } {
    return {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "idle",
      tokenHandle: "@conductor",
      agents: [agent],
    };
  }

  function makePerHandle(): Map<string, PerHandleSummary> {
    return new Map<string, PerHandleSummary>([
      ["@conductor", { util5h: 0.10, util7d: 0.30, capPct: 80, selectable: true }],
      ["@kddi", { util5h: 0.10, util7d: 0.30, capPct: 80, selectable: true }],
    ]);
  }

  test("T352-1: running × bound → spinner 直後に @kddi、CYAN、suffix から handle 重複しない", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "running",
      role: "implementer",
      taskTitle: "foo",
      tokenHandle: "@kddi",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    // @kddi は 1 度だけ出現（Agent 行に挿入された分のみ。suffix からは除外される）
    const occurrences = json.split("@kddi").length - 1;
    expect(occurrences).toBe(1);
    expect(json).toContain("[201]");
    expect(json).toContain("foo");
    expect(json).toContain("▖"); // SPINNER_FRAMES[0]

    // 順序: [201] → spinner ▖ → @kddi → foo
    const idxSurface = json.indexOf("[201]");
    const idxSpinner = json.indexOf("▖");
    const idxHandle = json.indexOf("@kddi");
    const idxLabel = json.indexOf("foo");
    expect(idxSurface).toBeGreaterThan(-1);
    expect(idxSurface).toBeLessThan(idxSpinner);
    expect(idxSpinner).toBeLessThan(idxHandle);
    expect(idxHandle).toBeLessThan(idxLabel);

    // running の handle 色は CYAN
    // [201] は CYAN、spinner ▖ も CYAN、@kddi も CYAN
    // Agent 行の "@kddi" 直前直後に CYAN style が付くノードがあること
    // 簡易: @kddi を含む node の style.fg が CYAN
    const handleNodePattern = new RegExp(`"text":"@kddi"[^}]*"fg":${CYAN_VALUE}`);
    const handleNodePatternAlt = new RegExp(`"fg":${CYAN_VALUE}[^}]*"text":"@kddi"`);
    expect(handleNodePattern.test(json) || handleNodePatternAlt.test(json)).toBe(true);
  });

  test("T352-2: idle × bound → roleIcon 直後に @kddi、handle は dim でない、taskTitle は dim", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "idle",
      role: "implementer",
      taskTitle: "foo",
      tokenHandle: "@kddi",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    // @kddi は 1 度だけ
    expect(json.split("@kddi").length - 1).toBe(1);
    expect(json).toContain("[201]");
    expect(json).toContain("⚙");
    expect(json).toContain("foo");

    // 順序: [201] → ⚙ → @kddi → foo
    const idxSurface = json.indexOf("[201]");
    const idxIcon = json.indexOf("⚙");
    const idxHandle = json.indexOf("@kddi");
    const idxLabel = json.indexOf("foo");
    expect(idxSurface).toBeLessThan(idxIcon);
    expect(idxIcon).toBeLessThan(idxHandle);
    expect(idxHandle).toBeLessThan(idxLabel);

    // idle の @kddi node は dim でないこと（"text":"@kddi" を含むノードに "dim":true が付かない）
    // @kddi を含む text node オブジェクトを抽出して dim:true を含まないことを確認
    // 単純に「"text":"@kddi" が出現する箇所の前後 50 char に "dim":true が含まれない」で代用
    const idxV = json.indexOf('"text":"@kddi"');
    const around = json.slice(Math.max(0, idxV - 80), idxV + 80);
    expect(around).not.toContain('"dim":true');

    // taskTitle "foo" を含む node には dim:true が付くこと
    const idxFoo = json.indexOf('"text":"foo"');
    const aroundFoo = json.slice(Math.max(0, idxFoo - 80), idxFoo + 80);
    expect(aroundFoo).toContain('"dim":true');
  });

  test("T352-3: asking × bound → ? + roleIcon 直後に @kddi、YELLOW", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "asking",
      role: "implementer",
      taskTitle: "foo",
      tokenHandle: "@kddi",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    expect(json.split("@kddi").length - 1).toBe(1);
    expect(json).toContain("[201]");
    expect(json).toContain("?");
    expect(json).toContain("⚙");
    expect(json).toContain("foo");

    // 順序: [201] → ? → ⚙ → @kddi → foo
    const idxSurface = json.indexOf("[201]");
    // ? は質問プレフィックスにも使われうるが、Agent asking 行が child の最後 (Conductor 行が running なので ? は agent 行のみ)
    // ただし conductor の status="running" なので Conductor 行に ? は出ない
    const idxQ = json.indexOf('"text":"?"');
    const idxIcon = json.indexOf("⚙");
    const idxHandle = json.indexOf("@kddi");
    const idxLabel = json.indexOf('"text":"foo"');
    expect(idxSurface).toBeLessThan(idxQ);
    expect(idxQ).toBeLessThan(idxIcon);
    expect(idxIcon).toBeLessThan(idxHandle);
    expect(idxHandle).toBeLessThan(idxLabel);

    // asking の @kddi node は YELLOW
    const handleNodePattern = new RegExp(`"text":"@kddi"[^}]*"fg":${YELLOW_VALUE}`);
    const handleNodePatternAlt = new RegExp(`"fg":${YELLOW_VALUE}[^}]*"text":"@kddi"`);
    expect(handleNodePattern.test(json) || handleNodePatternAlt.test(json)).toBe(true);
  });

  test("T352-4: running × unbound → Agent 行に @kddi なし、(no token) も出ない", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "running",
      role: "implementer",
      taskTitle: "foo",
      // tokenHandle 未指定 → unbound
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    // Agent 行 unbound では handle ノードも (no token) も出さない
    expect(json).not.toContain("@kddi");
    expect(json).not.toContain("(no token)");
    // 既存要素は維持
    expect(json).toContain("[201]");
    expect(json).toContain("▖");
    expect(json).toContain("foo");
  });

  test("T352-5: idle × unbound → Agent 行に @kddi なし、(no token) も出ない", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "idle",
      role: "implementer",
      taskTitle: "foo",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    expect(json).not.toContain("@kddi");
    expect(json).not.toContain("(no token)");
    expect(json).toContain("[201]");
    expect(json).toContain("⚙");
    expect(json).toContain("foo");
  });

  test("T352-6: asking × unbound → Agent 行に @kddi なし、(no token) も出ない", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "asking",
      role: "implementer",
      taskTitle: "foo",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    expect(json).not.toContain("@kddi");
    expect(json).not.toContain("(no token)");
    expect(json).toContain("[201]");
    expect(json).toContain("?");
    expect(json).toContain("⚙");
    expect(json).toContain("foo");
  });

  test("T352-7: pool OFF (perHandle=null) → @ 文字を含まず util/cap 表記も混入しない", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "idle",
      role: "implementer",
      taskTitle: "foo",
      tokenHandle: "@kddi",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, null));

    // pool OFF なので suffix が一切出ない
    expect(json).not.toContain("@");
    expect(json).not.toContain("<5h:");
    expect(json).not.toContain("cap:");
    expect(json).not.toContain("(no token)");
    // 既存の Agent 行の表示要素は維持
    expect(json).toContain("[201]");
    expect(json).toContain("⚙");
    expect(json).toContain("foo");
  });

  test("T352-8: 順序契約 — running 行で [201] → ▖ → @kddi → foo の順", () => {
    const conductor = makeConductor({
      surface: "surface:201",
      spawnedAt: new Date(Date.now() - 500).toISOString(),
      status: "running",
      role: "implementer",
      taskTitle: "foo",
      tokenHandle: "@kddi",
    });
    const json = JSON.stringify(buildConductorRowWithPool(conductor, null, 0, makePerHandle()));

    const idxSurface = json.indexOf("[201]");
    const idxSpinner = json.indexOf("▖");
    const idxHandle = json.indexOf("@kddi");
    const idxLabel = json.indexOf('"text":"foo"');
    // 単方向不等式
    expect(idxSurface).toBeGreaterThan(-1);
    expect(idxSurface).toBeLessThan(idxSpinner);
    expect(idxSpinner).toBeLessThan(idxHandle);
    expect(idxHandle).toBeLessThan(idxLabel);
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
