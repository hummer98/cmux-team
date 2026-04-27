/**
 * dashboard-pool.test.tsx (T351)
 *
 * dashboard.tsx の pool 関連表示を検証する:
 *   - buildPoolHeader: pool capacity ボックスのレンダリングと閾値色分け
 *   - buildSurfaceRowSuffix: per-surface handle/util suffix の構造（[surface] を含まない API 案 X）
 *   - buildConductorRowWithPool: Conductor / Agent 行末尾に handle/util suffix が append されること
 *
 * 既存 dashboard test と同じく ui.text / ui.row オブジェクトは JSON.stringify して文字列検証する。
 */
import { describe, test, expect } from "bun:test";
import { rgb } from "@rezi-ui/core";
import { buildPoolHeader, buildConductorRow, buildConductorRowWithPool } from "./dashboard";
import { buildSurfaceRowSuffix } from "./pool-surface-row";
import type { PoolSummary, PerHandleSummary } from "./pool-summary";
import type { ConductorState, AgentState } from "./schema";

const GREEN_VALUE = rgb(0, 160, 0);
const YELLOW_VALUE = rgb(200, 160, 0);
const RED_VALUE = rgb(180, 40, 40);

function stringify(node: any): string {
  return JSON.stringify(node);
}

function countSurfaceLabel(json: string, surface: string): number {
  // dashboard 側は `[<n>]` 形式で surface label を出力する。raw `surface:N` を使った場合は 0 件期待。
  const needle = `[${surface}]`;
  let count = 0;
  let idx = 0;
  while ((idx = json.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function makeSummary(
  capacity5hPct: number,
  capacity7dPct: number = capacity5hPct,
  perHandle?: Map<string, PerHandleSummary>,
): PoolSummary {
  return {
    header: { capacity5hPct, capacity7dPct, nextReset: null },
    perHandle: perHandle ?? new Map(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPoolHeader
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPoolHeader", () => {
  test("case 1: summary=null → 空配列", () => {
    expect(buildPoolHeader(null)).toEqual([]);
  });

  test("case 2: summary 有効 → pool capacity 行を含む node 配列を返す", () => {
    const out = buildPoolHeader(makeSummary(50));
    const json = stringify(out);
    expect(out.length).toBeGreaterThan(0);
    expect(json).toContain("pool capacity:");
    expect(json).toContain("5h 50%");
    expect(json).toContain("7d 50%");
  });

  test("case 3: capacity 173% (>=100%) で GREEN が適用される", () => {
    const out = buildPoolHeader(makeSummary(173));
    const json = stringify(out);
    expect(json).toContain("5h 173%");
    expect(json).toContain("7d 173%");
    expect(json).toContain(`"fg":${GREEN_VALUE}`);
    expect(json).not.toContain(`"fg":${RED_VALUE}`);
  });

  test("case 4: capacity 30% (<40%) で RED が適用される", () => {
    const out = buildPoolHeader(makeSummary(30));
    const json = stringify(out);
    expect(json).toContain("5h 30%");
    expect(json).toContain("7d 30%");
    expect(json).toContain(`"fg":${RED_VALUE}`);
  });

  test("case 5: capacity 60% (40〜100%) で YELLOW が適用される", () => {
    const out = buildPoolHeader(makeSummary(60));
    const json = stringify(out);
    expect(json).toContain("5h 60%");
    expect(json).toContain("7d 60%");
    expect(json).toContain(`"fg":${YELLOW_VALUE}`);
  });

  test("case 5b: 5h=173 / 7d=30 → 二値表示 + min ベースで RED", () => {
    const out = buildPoolHeader(makeSummary(173, 30));
    const json = stringify(out);
    expect(json).toContain("5h 173%");
    expect(json).toContain("7d 30%");
    expect(json).toContain(`"fg":${RED_VALUE}`);
  });

  test("case 5c: 5h=120 / 7d=80 → min=80 で YELLOW", () => {
    const out = buildPoolHeader(makeSummary(120, 80));
    const json = stringify(out);
    expect(json).toContain("5h 120%");
    expect(json).toContain("7d 80%");
    expect(json).toContain(`"fg":${YELLOW_VALUE}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSurfaceRowSuffix（[surface] を含まないことを assertion 化）
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSurfaceRowSuffix (T351 dashboard 用 UiNode API)", () => {
  test("bind 済み: @kddi / <5h:2%/7d:33%> / cap:80% を含み [100] / [surface:100] は含まない", () => {
    const out = buildSurfaceRowSuffix({
      surface: "surface:100",
      handle: "@kddi",
      util5h: 0.02,
      util7d: 0.33,
      capPct: 80,
    });
    const json = stringify(out);
    expect(json).toContain("@kddi");
    expect(json).toContain("<5h:2%/7d:33%>");
    expect(json).toContain("cap:80%");
    // 二重出力禁止: surface ラベルは含まない（dashboard 側で別 node として描画）
    expect(json).not.toContain("[100]");
    expect(json).not.toContain("[surface:100]");
    expect(json).not.toContain("surface:100");
  });

  test("bind なし (handle: undefined) → (no token)、surface ラベル含まない", () => {
    const out = buildSurfaceRowSuffix({
      surface: "surface:101",
      handle: undefined,
      util5h: null,
      util7d: null,
      capPct: null,
    });
    const json = stringify(out);
    expect(json).toContain("(no token)");
    expect(json).not.toContain("[101]");
    expect(json).not.toContain("[surface:101]");
  });

  test("util_5h=0.85 で警告マーク ⚠ が YELLOW で末尾追加される", () => {
    const out = buildSurfaceRowSuffix({
      surface: "surface:102",
      handle: "@kddi",
      util5h: 0.85,
      util7d: 0.50,
      capPct: 60,
    });
    const json = stringify(out);
    expect(json).toContain("⚠");
    expect(json).toContain(`"fg":${YELLOW_VALUE}`);
  });

  test("pool ON だが該当 handle の cap/util データなし (capPct:null, util:null) → cap セクション省略", () => {
    // minor 2 反映: 厳密には pool ON だが該当 handle が perHandle Map にない場合の入力。
    // pool OFF なら呼び出し元（dashboard）が空配列を返すのでこの関数自体に到達しない。
    const out = buildSurfaceRowSuffix({
      surface: "surface:103",
      handle: "@x",
      util5h: null,
      util7d: null,
      capPct: null,
    });
    const json = stringify(out);
    expect(json).toContain("@x");
    expect(json).toContain("<5h:--/7d:--%>");
    expect(json).not.toContain("cap:");
    expect(json).not.toContain("⚠");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildConductorRow / buildConductorRowWithPool — Conductor / Agent 行末尾の suffix
// ─────────────────────────────────────────────────────────────────────────────

describe("buildConductorRowWithPool: pool ON で Conductor 行末尾に handle/util を append", () => {
  test("case 6: pool ON / tokenHandle=@kddi で Conductor 行に @kddi と <5h: が含まれ surface ラベル [100] は 1 度だけ出現", () => {
    const perHandle = new Map<string, PerHandleSummary>([
      ["@kddi", { util5h: 0.10, util7d: 0.30, capPct: 80, selectable: true }],
    ]);
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      taskId: "351",
      taskTitle: "demo",
      tokenHandle: "@kddi",
      agents: [],
    };
    const json = stringify(buildConductorRowWithPool(conductor, null, 0, perHandle));
    expect(json).toContain("@kddi");
    expect(json).toContain("<5h:10%/7d:30%>");
    expect(json).toContain("cap:80%");
    // 二重出力禁止: surface ラベル `[100]` は 1 度だけ
    expect(countSurfaceLabel(json, "100")).toBe(1);
  });

  test("case 7: pool OFF (perHandle=null) で Conductor 行に @ 文字が含まれず既存挙動を維持", () => {
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      taskId: "351",
      taskTitle: "demo",
      tokenHandle: "@kddi",
      agents: [],
    };
    const json = stringify(buildConductorRowWithPool(conductor, null, 0, null));
    expect(json).not.toContain("@kddi");
    expect(json).not.toContain("<5h:");
    // surface ラベル `[100]` は 1 度だけ
    expect(countSurfaceLabel(json, "100")).toBe(1);
  });

  test("case 8: pool ON / agent.tokenHandle=undefined → Agent 行に (no token) は出ない、surface ラベルは 1 度だけ (T352)", () => {
    const perHandle = new Map<string, PerHandleSummary>([
      ["@kddi", { util5h: 0.10, util7d: 0.30, capPct: 80, selectable: true }],
    ]);
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
          // tokenHandle 未指定 → T352 仕様で handle 部分は完全省略（(no token) も出さない）
        },
      ],
    };
    const json = stringify(buildConductorRowWithPool(conductor, null, 0, perHandle));
    // T352: Agent 行 unbound では (no token) を出さない
    expect(json).not.toContain("(no token)");
    // surface ラベルの重複禁止 invariant は維持
    expect(countSurfaceLabel(json, "200")).toBe(1);
    expect(countSurfaceLabel(json, "100")).toBe(1);
  });

  test("case 9: util_5h=0.85（警告閾値超過）で Conductor 行に ⚠ + YELLOW が含まれる", () => {
    const perHandle = new Map<string, PerHandleSummary>([
      ["@kddi", { util5h: 0.85, util7d: 0.30, capPct: 80, selectable: true }],
    ]);
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      taskId: "351",
      taskTitle: "demo",
      tokenHandle: "@kddi",
      agents: [],
    };
    const json = stringify(buildConductorRowWithPool(conductor, null, 0, perHandle));
    expect(json).toContain("⚠");
  });

  test("既存 buildConductorRow (3 引数) は perHandle=null 経路と完全一致（後方互換シム）", () => {
    const conductor: ConductorState & { agents: AgentState[]; status: string } = {
      surface: "surface:100",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      taskId: "351",
      taskTitle: "demo",
      tokenHandle: "@kddi",
      agents: [],
    };
    const a = stringify(buildConductorRow(conductor, null, 0));
    const b = stringify(buildConductorRowWithPool(conductor, null, 0, null));
    expect(a).toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// case 10: buildSurfaceRowSuffix の戻り値そのものに [surface] / surface: が含まれない
// （API 契約: suffix は surface を含まない）
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSurfaceRowSuffix API 契約: surface ラベル二重出力禁止", () => {
  test("case 10: 各種入力で戻り値配列に [N] / [surface:N] / surface:N の文字列が含まれない", () => {
    const inputs = [
      { surface: "surface:100", handle: "@kddi", util5h: 0.10, util7d: 0.30, capPct: 80 },
      { surface: "surface:200", handle: undefined, util5h: null, util7d: null, capPct: null },
      { surface: "surface:300", handle: "@kddi", util5h: 0.85, util7d: 0.95, capPct: 15 },
      { surface: "raw-id", handle: "@a", util5h: 0.1, util7d: 0.1, capPct: 100 },
    ];
    for (const input of inputs) {
      const json = stringify(buildSurfaceRowSuffix(input));
      expect(json).not.toContain(`[${input.surface}]`);
      expect(json).not.toContain(`[${input.surface.replace("surface:", "")}]`);
      expect(json).not.toContain(input.surface);
    }
  });

  // T352: dashboard.tsx の `buildPoolSuffixForSurface(includeHandle:false)` 経路は
  // `buildSurfaceRowSuffix(...).slice(1)` で先頭の handle ノードを削るため、
  // 戻り値配列の先頭が必ず `@handle` の text node であることを契約として固定化する。
  test("case 11 (T352 順序契約): bound 入力で戻り値配列の先頭が必ず @handle の text node", () => {
    const inputs = [
      { surface: "surface:100", handle: "@kddi", util5h: 0.10, util7d: 0.30, capPct: 80 },
      { surface: "surface:300", handle: "@kddi", util5h: 0.85, util7d: 0.95, capPct: 15 },
      { surface: "raw-id", handle: "@a", util5h: 0.1, util7d: 0.1, capPct: 100 },
      { surface: "surface:103", handle: "@x", util5h: null, util7d: null, capPct: null },
    ];
    for (const input of inputs) {
      const out = buildSurfaceRowSuffix(input);
      expect(out.length).toBeGreaterThan(0);
      const head = out[0]!;
      const headJson = stringify(head);
      // 先頭ノードに handle 文字列が "value" として含まれる
      expect(headJson).toContain(`"text":"${input.handle}"`);
      // 後続ノードには handle 文字列が含まれない（単独ノード保証）
      const restJson = stringify(out.slice(1));
      expect(restJson).not.toContain(`"text":"${input.handle}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 共有 fixture: pool-summary.test.ts case A と同じ入力で capacityPct ≒ 50.0 を再現
// （CLI / dashboard の cross-validate）
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI / dashboard cross-validate (case A 共有 fixture)", () => {
  test("buildPoolHeader を case A 想定の summary (capacity_7d_pct=50) で呼ぶと '7d 50%' が出力される", () => {
    // T366 case A: capacity_5h_pct ≒ 1680%, capacity_7d_pct ≒ 50% (7d 律速)
    const out = buildPoolHeader(makeSummary(1680, 50));
    const json = stringify(out);
    expect(json).toContain("5h 1680%");
    expect(json).toContain("7d 50%");
  });
});
