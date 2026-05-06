/**
 * T435 S8: 主要 binding が期待通り発火することを検証する統合テスト。
 *
 * `TestEventBuilder` を使った synthetic event ベースのテスト harness は
 * 既存の dashboard テストには存在しないため、registry の handler を
 * 直接呼ぶ形（buildXSection と同じパターン）で検証する。
 *
 * チェック対象:
 *   - gg → top, ge → bottom (focus journal)
 *   - gt → 次タブ, gp → 前タブ
 *   - ? → showHelp=true / Esc で false
 *   - 1-6 → 各タブに jump
 *   - Ctrl+s (issues focus) → syncIssuesFromGh が spy される
 *   - Ctrl+o (issues / metrics) → 適切な open ハンドラに dispatch
 *   - deprecated alias J が switchTab に届く + log 呼び出し
 */
import { describe, test, expect } from "bun:test";
import {
  createDashboardBindings,
  buildAppKeys,
  type KeymapDeps,
} from "./dashboard-keymap";
import type { AppState } from "./dashboard";

function makeDeps(overrides: Partial<KeymapDeps> = {}): KeymapDeps {
  return {
    switchTab: () => {},
    syncIssuesFromGh: async () => {},
    openSelectedIssueInViewer: async () => {},
    openTaskInViewer: () => {},
    openSettingsItemInViewer: () => {},
    openSelectedArtifactInViewer: () => {},
    openMetricsDashboardInBrowser: () => {},
    openSelectedIssueInBrowser: () => {},
    navigateUp: (s) => s,
    navigateDown: (s) => s,
    navigateTop: (s) => ({ ...s, journalScrollOffset: 0, journalAutoScroll: true }),
    navigateBottom: (s) => ({ ...s, journalScrollOffset: 999, journalAutoScroll: false }),
    navigateHalfPageDown: (s) => s,
    navigateHalfPageUp: (s) => s,
    cycleArtifactSort: (s) => s,
    cycleArtifactFilter: (s) => s,
    reload: () => {},
    quit: () => {},
    fullQuit: () => {},
    log: () => {},
    handleCopyChord: () => {},
    cancelChord: () => {},
    schedule: () => () => {},
    ...overrides,
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    daemon: {} as any,
    activeTab: "journal",
    journalEntries: [],
    logLines: [],
    artifacts: [],
    artifactCursor: 0,
    artifactSort: "id",
    artifactTypeFilter: null,
    artifactSearch: null,
    taskCursor: 0,
    version: "",
    repoUrl: null,
    confirmingFullQuit: false,
    logScrollOffset: 0,
    logAutoScroll: true,
    spinnerFrame: 0,
    focusedArea: "global",
    journalScrollOffset: 0,
    journalAutoScroll: true,
    settingsItems: [],
    settingsCursor: 0,
    issuesAvailability: "unknown",
    issueItems: [],
    issueCursor: 0,
    issueSyncing: false,
    issueLastSync: null,
    issueLastError: null,
    metricsData: null,
    metricsError: null,
    metricsLastLoadedMs: 0,
    metricsScrollOffset: 0,
    metricsStatusMessage: null,
    showHelp: false,
    toast: null,
    cChordPending: null,
    ...overrides,
  };
}

/** ハンドラ駆動用の最小 KeyContext モック。app.update を spy する */
function makeCtx(state: AppState) {
  let lastState = state;
  const ctx = {
    state: lastState,
    update: (updater: any) => {
      lastState = typeof updater === "function" ? updater(lastState) : updater;
    },
    focusedId: null,
  };
  return {
    ctx,
    getState: () => lastState,
  };
}

describe("S8: nav top/bottom (gg / ge)", () => {
  test("gg (focus=journal) で navigateTop が呼ばれ scrollOffset=0 になる", () => {
    const bindings = createDashboardBindings(makeDeps());
    const map = buildAppKeys(bindings);
    const handler = (map as any)["g g"];
    expect(typeof handler).toBe("function");

    const { ctx, getState } = makeCtx(
      makeState({ focusedArea: "journal", journalScrollOffset: 50 }),
    );
    handler(ctx);
    expect(getState().journalScrollOffset).toBe(0);
    expect(getState().journalAutoScroll).toBe(true);
  });

  test("ge (focus=journal) で navigateBottom が呼ばれる", () => {
    const bindings = createDashboardBindings(makeDeps());
    const map = buildAppKeys(bindings);
    const handler = (map as any)["g e"];
    expect(typeof handler).toBe("function");

    const { ctx, getState } = makeCtx(
      makeState({ focusedArea: "journal", journalScrollOffset: 0 }),
    );
    handler(ctx);
    expect(getState().journalScrollOffset).toBe(999);
    expect(getState().journalAutoScroll).toBe(false);
  });
});

describe("S8: tab chord (gt / gp)", () => {
  test("gt → 次タブへ", () => {
    let nextTab: AppState["activeTab"] | "" = "";
    const bindings = createDashboardBindings(makeDeps({
      switchTab: (t: AppState["activeTab"]) => { nextTab = t; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["g t"];
    expect(typeof handler).toBe("function");

    const { ctx } = makeCtx(makeState({ activeTab: "journal" }));
    handler(ctx);
    expect(nextTab as string).toBe("artifacts");
  });

  test("gp → 前タブへ (journal → metrics 巻き戻し)", () => {
    let prevTab: AppState["activeTab"] | "" = "";
    const bindings = createDashboardBindings(makeDeps({
      switchTab: (t: AppState["activeTab"]) => { prevTab = t; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["g p"];
    expect(typeof handler).toBe("function");

    const { ctx } = makeCtx(makeState({ activeTab: "journal" }));
    handler(ctx);
    expect(prevTab as string).toBe("metrics");
  });
});

describe("S8: help overlay (?, Esc)", () => {
  test("? → showHelp=true に toggle", () => {
    const bindings = createDashboardBindings(makeDeps());
    const map = buildAppKeys(bindings);
    const handler = (map as any)["?"];
    expect(typeof handler).toBe("function");

    const { ctx, getState } = makeCtx(makeState({ showHelp: false }));
    handler(ctx);
    expect(getState().showHelp).toBe(true);
  });

  test("Esc → showHelp=false / focusedArea=global / confirmingFullQuit=false", () => {
    const bindings = createDashboardBindings(makeDeps());
    const map = buildAppKeys(bindings);
    const handler = (map as any)["Escape"];
    expect(typeof handler).toBe("function");

    const { ctx, getState } = makeCtx(
      makeState({ showHelp: true, focusedArea: "tasks", confirmingFullQuit: true }),
    );
    handler(ctx);
    const s = getState();
    expect(s.showHelp).toBe(false);
    expect(s.focusedArea).toBe("global");
    expect(s.confirmingFullQuit).toBe(false);
  });
});

describe("S8: tab jump (1-6)", () => {
  test("数字キーで各タブに jump", () => {
    const tabsByKey: Record<string, AppState["activeTab"]> = {
      "1": "journal",
      "2": "artifacts",
      "3": "log",
      "4": "settings",
      "5": "issues",
      "6": "metrics",
    };
    for (const [key, tab] of Object.entries(tabsByKey)) {
      let calledWith: string = "";
      const bindings = createDashboardBindings(makeDeps({
        switchTab: (t: AppState["activeTab"]) => { calledWith = t; },
      }));
      const map = buildAppKeys(bindings);
      const handler = (map as any)[key];
      expect(typeof handler).toBe("function");
      const { ctx } = makeCtx(makeState());
      handler(ctx);
      expect(calledWith).toBe(tab);
    }
  });
});

describe("S8: issues sync (Ctrl+s)", () => {
  test("Ctrl+s (focus=issues) → syncIssuesFromGh が呼ばれる", async () => {
    let called = false;
    const bindings = createDashboardBindings(makeDeps({
      syncIssuesFromGh: async () => { called = true; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["ctrl+s"];
    expect(typeof handler).toBe("function");
    const { ctx } = makeCtx(makeState({ activeTab: "issues", focusedArea: "issues" }));
    handler(ctx);
    // syncIssuesFromGh は async 即時実行 → microtask 経由
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(true);
  });

  test("Ctrl+s (focus=journal) → 発火しない (scope違反)", async () => {
    let called = false;
    const bindings = createDashboardBindings(makeDeps({
      syncIssuesFromGh: async () => { called = true; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["ctrl+s"];
    const { ctx } = makeCtx(makeState({ activeTab: "journal", focusedArea: "journal" }));
    handler(ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
  });
});

describe("S8: open.browser (Ctrl+o)", () => {
  test("Ctrl+o (issues) → openSelectedIssueInBrowser", () => {
    let issuesOpened = false;
    let metricsOpened = false;
    const bindings = createDashboardBindings(makeDeps({
      openSelectedIssueInBrowser: () => { issuesOpened = true; },
      openMetricsDashboardInBrowser: () => { metricsOpened = true; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["ctrl+o"];
    expect(typeof handler).toBe("function");
    const { ctx } = makeCtx(makeState({ activeTab: "issues", focusedArea: "issues" }));
    handler(ctx);
    expect(issuesOpened).toBe(true);
    expect(metricsOpened).toBe(false);
  });

  test("Ctrl+o (metrics) → openMetricsDashboardInBrowser", () => {
    let issuesOpened = false;
    let metricsOpened = false;
    const bindings = createDashboardBindings(makeDeps({
      openSelectedIssueInBrowser: () => { issuesOpened = true; },
      openMetricsDashboardInBrowser: () => { metricsOpened = true; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["ctrl+o"];
    const { ctx } = makeCtx(makeState({ activeTab: "metrics", focusedArea: "metrics" }));
    handler(ctx);
    expect(issuesOpened).toBe(false);
    expect(metricsOpened).toBe(true);
  });
});

describe("S8: deprecated alias", () => {
  test("J (deprecated) → switchTab('journal') + log('deprecated_key_used')", () => {
    let switched: string = "";
    const events: string[] = [];
    const bindings = createDashboardBindings(makeDeps({
      switchTab: (t: AppState["activeTab"]) => { switched = t; },
      log: (event) => { events.push(event); },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["J"];
    expect(typeof handler).toBe("function");
    const { ctx } = makeCtx(makeState());
    handler(ctx);
    expect(switched).toBe("journal");
    expect(events).toContain("deprecated_key_used");
  });

  test("Ctrl+r (focus=global) → reload が呼ばれる、(focus=tasks) → 呼ばれない", () => {
    let reloadCount = 0;
    const bindings = createDashboardBindings(makeDeps({
      reload: () => { reloadCount++; },
    }));
    const map = buildAppKeys(bindings);
    const handler = (map as any)["ctrl+r"];
    expect(typeof handler).toBe("function");

    handler({ ...makeCtx(makeState({ focusedArea: "tasks" })).ctx });
    expect(reloadCount).toBe(0);

    handler({ ...makeCtx(makeState({ focusedArea: "global" })).ctx });
    expect(reloadCount).toBe(1);
  });
});

describe("S8: full-quit confirm flow", () => {
  test("Ctrl+q → confirmingFullQuit=true, y → fullQuit() 発火", () => {
    let fullQuitCount = 0;
    const bindings = createDashboardBindings(makeDeps({
      fullQuit: () => { fullQuitCount++; },
    }));
    const map = buildAppKeys(bindings);
    const ctrlQ = (map as any)["ctrl+q"];
    const yKey = (map as any)["y"];

    const { ctx, getState } = makeCtx(makeState({ focusedArea: "global" }));
    ctrlQ(ctx);
    expect(getState().confirmingFullQuit).toBe(true);

    // 次に y を押す: ctx.state を最新版にし直す
    yKey({ ...ctx, state: getState() });
    expect(fullQuitCount).toBe(1);
  });

  test("y を confirm 状態でない時に押しても fullQuit() は呼ばれない", () => {
    let fullQuitCount = 0;
    const bindings = createDashboardBindings(makeDeps({
      fullQuit: () => { fullQuitCount++; },
    }));
    const map = buildAppKeys(bindings);
    const yKey = (map as any)["y"];
    const { ctx } = makeCtx(makeState({ confirmingFullQuit: false }));
    yKey(ctx);
    expect(fullQuitCount).toBe(0);
  });
});

describe("T439: c key dispatch", () => {
  test("focus=artifacts で c → handleCopyChord が呼ばれる", () => {
    let copyChordCalled = 0;
    const bindings = createDashboardBindings(makeDeps({
      handleCopyChord: () => { copyChordCalled++; },
    }));
    const map = buildAppKeys(bindings);
    const cKey = (map as any)["c"];
    expect(typeof cKey).toBe("function");
    const { ctx } = makeCtx(makeState({ focusedArea: "artifacts" }));
    cKey(ctx);
    expect(copyChordCalled).toBe(1);
  });

  test("focus=journal で c → 何もしない（scope 違反で binding が match しない）", () => {
    let copyChordCalled = 0;
    const bindings = createDashboardBindings(makeDeps({
      handleCopyChord: () => { copyChordCalled++; },
    }));
    const map = buildAppKeys(bindings);
    const cKey = (map as any)["c"];
    const { ctx } = makeCtx(makeState({ focusedArea: "journal" }));
    cKey(ctx);
    expect(copyChordCalled).toBe(0);
  });

  test("focus=artifacts で pending 中、k 押下 → cancelChord 呼ばれてから navigateUp", () => {
    let cancelCalled = 0;
    let navigateCalled = 0;
    const bindings = createDashboardBindings(makeDeps({
      cancelChord: () => { cancelCalled++; },
      navigateUp: (s) => { navigateCalled++; return s; },
    }));
    const map = buildAppKeys(bindings);
    const kKey = (map as any)["k"];
    const { ctx } = makeCtx(makeState({
      focusedArea: "artifacts",
      cChordPending: { startedAtMs: 100 },
    }));
    kKey(ctx);
    expect(cancelCalled).toBe(1);
    expect(navigateCalled).toBe(1);
  });

  test("focus=artifacts で pending 中、c 押下 → cancelChord は呼ばれず handleCopyChord が呼ばれる（自身は noop）", () => {
    let cancelCalled = 0;
    let copyChordCalled = 0;
    const bindings = createDashboardBindings(makeDeps({
      cancelChord: () => { cancelCalled++; },
      handleCopyChord: () => { copyChordCalled++; },
    }));
    const map = buildAppKeys(bindings);
    const cKey = (map as any)["c"];
    const { ctx } = makeCtx(makeState({
      focusedArea: "artifacts",
      cChordPending: { startedAtMs: 100 },
    }));
    cKey(ctx);
    expect(cancelCalled).toBe(0);
    expect(copyChordCalled).toBe(1);
  });
});
