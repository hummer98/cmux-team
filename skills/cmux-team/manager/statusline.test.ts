import { describe, test, expect } from "bun:test";
import {
  formatStatusline,
  resolveRole,
  shortModel,
  ctxPct,
  ctxColor,
  extractModel,
  truncateTitle,
  openTaskCount,
  workdirFromInput,
  type StatuslineState,
  type StatuslineInput,
  type StatuslineOptions,
} from "./statusline";

// 純粋フォーマッタのテストは外部 git 参照を避けるため cwd 解決を無効化する。
// workdir に存在しないパスを渡すと gitBranch が catch で "" を返す。
const NO_GIT = "/nonexistent-dir-for-cmux-test";

function baseInput(overrides: Partial<StatuslineInput> = {}): StatuslineInput {
  return {
    model: "claude-opus-4-6",
    context_window: { used_percentage: 42 },
    workspace: { current_dir: NO_GIT },
    ...overrides,
  };
}

function baseState(overrides: Partial<StatuslineState> = {}): StatuslineState {
  return {
    running: true,
    bootPhase: "ready",
    masters: [{ surface: "surface:100", status: "idle" }],
    conductors: new Map([
      [
        "surface:200",
        {
          surface: "surface:200",
          taskId: "042",
          taskTitle: "Test task",
          status: "running",
          agents: [
            { surface: "surface:300", role: "researcher", taskTitle: "Test task" },
          ],
        },
      ],
      [
        "surface:201",
        { surface: "surface:201", status: "idle", agents: [] },
      ],
    ]),
    taskList: [
      { id: "001", status: "ready", title: "A" },
      { id: "002", status: "assigned", title: "B" },
      { id: "003", status: "draft", title: "C" },
      { id: "004", status: "closed", title: "D" },
    ],
    ...overrides,
  };
}

function baseOpts(overrides: Partial<StatuslineOptions> = {}): StatuslineOptions {
  return {
    surface: "surface:100",
    nerdFont: false,
    color: false,
    workdir: NO_GIT,
    ...overrides,
  };
}

describe("shortModel", () => {
  test("`claude-` プレフィックス + 8 桁日付サフィックスを剥がす", () => {
    expect(shortModel("claude-opus-4-20250514")).toBe("opus-4");
  });

  test("`claude-` プレフィックスのみ剥がす（日付なし）", () => {
    expect(shortModel("claude-opus-4-6")).toBe("opus-4-6");
    expect(shortModel("claude-sonnet-4-6")).toBe("sonnet-4-6");
  });

  test("`claude-` が無い場合はそのまま", () => {
    expect(shortModel("opus-4")).toBe("opus-4");
  });

  test("空/undefined は空文字", () => {
    expect(shortModel("")).toBe("");
    expect(shortModel(undefined)).toBe("");
    expect(shortModel(null as any)).toBe("");
  });
});

describe("extractModel", () => {
  test("string の model", () => {
    expect(extractModel({ model: "claude-opus-4-6" })).toBe("claude-opus-4-6");
  });

  test("object の model.id", () => {
    expect(extractModel({ model: { id: "claude-sonnet-4-6" } })).toBe("claude-sonnet-4-6");
  });

  test("model 欠損", () => {
    expect(extractModel({})).toBe("");
    expect(extractModel({ model: {} })).toBe("");
  });
});

describe("ctxPct", () => {
  test("context_window.used_percentage が優先", () => {
    expect(
      ctxPct({
        context_window: { used_percentage: 42 },
        context: { used_percentage: 99 },
      }),
    ).toBe(42);
  });

  test("context.used_percentage フォールバック", () => {
    expect(ctxPct({ context: { used_percentage: 60 } })).toBe(60);
  });

  test("未指定は 0", () => {
    expect(ctxPct({})).toBe(0);
  });

  test("小数は round", () => {
    expect(ctxPct({ context_window: { used_percentage: 42.7 } })).toBe(43);
    expect(ctxPct({ context_window: { used_percentage: 42.4 } })).toBe(42);
  });
});

describe("ctxColor (色境界)", () => {
  test("Color 無効時は空文字", () => {
    expect(ctxColor(50, false)).toBe("");
    expect(ctxColor(85, false)).toBe("");
  });

  test("0/59% は green", () => {
    expect(ctxColor(0, true)).toBe("\x1b[32m");
    expect(ctxColor(59, true)).toBe("\x1b[32m");
  });

  test("60/79% は yellow", () => {
    expect(ctxColor(60, true)).toBe("\x1b[33m");
    expect(ctxColor(79, true)).toBe("\x1b[33m");
  });

  test("80/100% は red", () => {
    expect(ctxColor(80, true)).toBe("\x1b[31m");
    expect(ctxColor(100, true)).toBe("\x1b[31m");
  });
});

describe("workdirFromInput", () => {
  test("workspace.current_dir 優先", () => {
    expect(
      workdirFromInput({
        workspace: { current_dir: "/a" },
        cwd: "/b",
        working_dir: "/c",
      }),
    ).toBe("/a");
  });

  test("cwd fallback", () => {
    expect(workdirFromInput({ cwd: "/b", working_dir: "/c" })).toBe("/b");
  });

  test("working_dir fallback", () => {
    expect(workdirFromInput({ working_dir: "/c" })).toBe("/c");
  });

  test("全部なしは空", () => {
    expect(workdirFromInput({})).toBe("");
  });
});

describe("truncateTitle", () => {
  test("20 文字以下はそのまま", () => {
    expect(truncateTitle("short")).toBe("short");
    expect(truncateTitle("01234567890123456789")).toBe("01234567890123456789"); // 20
  });

  test("21 文字以上は 20 codepoint + …", () => {
    expect(truncateTitle("012345678901234567890")).toBe("01234567890123456789…");
  });

  test("日本語は codepoint 単位で 20 まで", () => {
    const s = "あいうえおかきくけこさしすせそたちつてとな"; // 21 chars
    expect(truncateTitle(s)).toBe("あいうえおかきくけこさしすせそたちつてと…");
  });

  test("空は空", () => {
    expect(truncateTitle("")).toBe("");
  });
});

describe("openTaskCount", () => {
  test("ready と assigned のみ数える", () => {
    expect(openTaskCount(baseState())).toBe(2);
  });

  test("taskList 未設定は 0", () => {
    expect(openTaskCount({ conductors: new Map() })).toBe(0);
  });
});

describe("resolveRole", () => {
  test("master surface", () => {
    const role = resolveRole("surface:100", baseState());
    expect(role.kind).toBe("master");
  });

  test("conductor surface", () => {
    const role = resolveRole("surface:200", baseState());
    expect(role.kind).toBe("conductor");
    if (role.kind === "conductor") {
      expect(role.conductor.taskId).toBe("042");
    }
  });

  test("agent surface（conductor の agents 内を検索）", () => {
    const role = resolveRole("surface:300", baseState());
    expect(role.kind).toBe("agent");
    if (role.kind === "agent") {
      expect(role.conductorSurface).toBe("surface:200");
      expect(role.agent.role).toBe("researcher");
    }
  });

  test("unknown surface", () => {
    const role = resolveRole("surface:9999", baseState());
    expect(role.kind).toBe("unknown");
  });

  test("masters 0 件でも unknown にならず conductor 等を解決", () => {
    const state = baseState({ masters: [] });
    const role = resolveRole("surface:200", state);
    expect(role.kind).toBe("conductor");
  });
});

// --- formatStatusline の ロール別フォーマット一致テスト ---
//
// 以下のスナップショットは現行 `statusline.sh` を同じ入力で実行して取得した
// 出力（末尾改行を除外したもの）。TS 実装は 1 バイト単位で一致する必要がある。

describe("formatStatusline - master", () => {
  test("NF off / Color off — ASCII fallback 完全一致", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:100", nerdFont: false, color: false }),
    );
    // `♦ Master |  opus-4-6 | ctx 42% | T:2 |  `
    expect(out).toBe("\u2666 Master |  opus-4-6 | ctx 42% | T:2 |  ");
  });

  test("NF on / Color off — 空 glyph + 󰝖", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:100", nerdFont: true, color: false }),
    );
    // ` Master |  opus-4-6 |  42% | 󰝖:2 |  `
    expect(out).toBe(" Master |  opus-4-6 |  42% | \u{F0756}:2 |  ");
  });

  test("NF on / Color on — ANSI 色付き", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:100", nerdFont: true, color: true }),
    );
    // bash 版と同じ色コードで完全一致
    const expected =
      "\x1b[36m Master\x1b[0m \x1b[2m|\x1b[0m  opus-4-6 \x1b[2m|\x1b[0m " +
      "\x1b[32m 42%\x1b[0m \x1b[2m|\x1b[0m " +
      "\x1b[32m\u{F0756}:2\x1b[0m \x1b[2m|\x1b[0m  ";
    expect(out).toBe(expected);
  });

  test("open task 数 0（taskList 空）", () => {
    const out = formatStatusline(
      baseInput(),
      baseState({ taskList: [] }),
      baseOpts({ surface: "surface:100", nerdFont: false, color: false }),
    );
    expect(out).toContain("T:0");
  });
});

describe("formatStatusline - conductor busy", () => {
  test("NF off / Color off", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:200", nerdFont: false, color: false }),
    );
    // `♦ T042 Test task |  | ctx 42% |  opus-4-6`
    expect(out).toBe("\u2666 T042 Test task |  | ctx 42% |  opus-4-6");
  });

  test("長いタスク名は 20 codepoint + … で切り詰め", () => {
    const state = baseState();
    const cond = state.conductors.get("surface:200")!;
    cond.taskTitle = "012345678901234567890"; // 21 chars
    const out = formatStatusline(
      baseInput(),
      state,
      baseOpts({ surface: "surface:200", nerdFont: false, color: false }),
    );
    expect(out).toContain("T042 01234567890123456789…");
  });
});

describe("formatStatusline - conductor idle", () => {
  test("NF off / Color off — branch セクションなし", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:201", nerdFont: false, color: false }),
    );
    // `♦ idle | ctx 42% |  opus-4-6`
    expect(out).toBe("\u2666 idle | ctx 42% |  opus-4-6");
  });

  test("NF on / Color on — dim prefix + 色付き", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:201", nerdFont: true, color: true }),
    );
    const expected =
      "\x1b[2m idle\x1b[0m \x1b[2m|\x1b[0m " +
      "\x1b[32m 42%\x1b[0m \x1b[2m|\x1b[0m  opus-4-6";
    expect(out).toBe(expected);
  });
});

describe("formatStatusline - agent", () => {
  test("task id あり / NF off / Color off", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:300", nerdFont: false, color: false }),
    );
    // `▸ researcher | T042 | ctx 42%`
    expect(out).toBe("\u25B8 researcher | T042 | ctx 42%");
  });

  test("task id なし（conductor.taskId 空）/ NF off / Color off", () => {
    const state = baseState();
    const cond = state.conductors.get("surface:200")!;
    cond.taskId = undefined;
    const out = formatStatusline(
      baseInput(),
      state,
      baseOpts({ surface: "surface:300", nerdFont: false, color: false }),
    );
    // `▸ researcher | ctx 42%`（`T<id>` セクションなし）
    expect(out).toBe("\u25B8 researcher | ctx 42%");
  });

  test("role 欠損時は 'agent' フォールバック", () => {
    const state = baseState();
    const cond = state.conductors.get("surface:200")!;
    cond.agents = [{ surface: "surface:300", role: undefined }];
    const out = formatStatusline(
      baseInput(),
      state,
      baseOpts({ surface: "surface:300", nerdFont: false, color: false }),
    );
    expect(out).toContain("\u25B8 agent");
  });
});

describe("formatStatusline - unknown", () => {
  test("surface が state 内のどこにもない場合は空文字", () => {
    const out = formatStatusline(
      baseInput(),
      baseState(),
      baseOpts({ surface: "surface:9999", nerdFont: false, color: false }),
    );
    expect(out).toBe("");
  });
});

describe("formatStatusline - model オブジェクト形", () => {
  test("`model.id` 形式も short model に反映される", () => {
    const out = formatStatusline(
      baseInput({ model: { id: "claude-sonnet-4-6" } }),
      baseState(),
      baseOpts({ surface: "surface:200", nerdFont: false, color: false }),
    );
    expect(out).toContain("sonnet-4-6");
  });
});
