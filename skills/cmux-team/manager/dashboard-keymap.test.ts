/**
 * T435: dashboard-keymap.ts の単体テスト。
 *
 * - createDashboardBindings の id 一意性
 * - validateRegistry が正しい registry で throw しないこと
 * - chord prefix 衝突を意図的に作った fixture で throw すること (C5)
 * - buildAppKeys が key→handler の dispatch を行うこと
 * - buildStatusBarItems が現在の focus/tab で active な binding を抽出すること
 * - buildHelpOverlayRows が全 binding を category 別に出力すること
 */
import { describe, test, expect } from "bun:test";
import {
  createDashboardBindings,
  validateRegistry,
  buildAppKeys,
  buildStatusBarItems,
  buildHelpOverlayRows,
  type BindingSpec,
  type KeymapDeps,
} from "./dashboard-keymap";
import type { AppState } from "./dashboard";

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<KeymapDeps> = {}): KeymapDeps {
  // 全部 no-op で構築。spy したい場合は overrides で個別に差し替える
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
    navigateTop: (s) => s,
    navigateBottom: (s) => s,
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

// ─────────────────────────────────────────────────────────────────────────────
// id uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe("createDashboardBindings: id uniqueness", () => {
  test("registry の id がユニーク", () => {
    const bindings = createDashboardBindings(makeDeps());
    const ids = bindings.map((b) => b.id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe("validateRegistry: 正常系", () => {
  test("DASHBOARD_BINDINGS は throw しない", () => {
    const bindings = createDashboardBindings(makeDeps());
    expect(() => validateRegistry(bindings)).not.toThrow();
  });
});

describe("validateRegistry: negative cases", () => {
  test("DUPLICATE_ID で throw する", () => {
    const dup: BindingSpec[] = [
      {
        id: "dup",
        keys: ["a"],
        scope: { kind: "global" },
        category: "system",
        description: "key_help",
        handler: () => {},
      },
      {
        id: "dup",
        keys: ["b"],
        scope: { kind: "global" },
        category: "system",
        description: "key_help",
        handler: () => {},
      },
    ];
    expect(() => validateRegistry(dup)).toThrow(/DUPLICATE_ID/);
  });

  test("INVALID_KEY (parseKeySequence 失敗) で throw する", () => {
    const invalid: BindingSpec[] = [
      {
        id: "x",
        keys: ["not-a-real-key-name-xyz"],
        scope: { kind: "global" },
        category: "system",
        description: "key_help",
        handler: () => {},
      },
    ];
    expect(() => validateRegistry(invalid)).toThrow(/INVALID_KEY/);
  });

  test("CHORD_PREFIX_CONFLICT (C5): 単発 'g' と chord 'g g' 共存で throw", () => {
    const conflict: BindingSpec[] = [
      {
        id: "single-g",
        keys: ["g"],
        scope: { kind: "global" },
        category: "navigation",
        description: "key_nav_top",
        handler: () => {},
      },
      {
        id: "chord-gg",
        keys: ["g g"],
        scope: { kind: "global" },
        category: "navigation",
        description: "key_nav_top",
        handler: () => {},
      },
    ];
    expect(() => validateRegistry(conflict)).toThrow(/CHORD_PREFIX_CONFLICT/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildAppKeys
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAppKeys", () => {
  test("key 文字列から handler 関数への map を返す", () => {
    const bindings = createDashboardBindings(makeDeps());
    const map = buildAppKeys(bindings);
    // 主要なキーが含まれることを確認
    expect(typeof (map as any)["?"]).toBe("function");
    expect(typeof (map as any)["Tab"]).toBe("function");
    expect(typeof (map as any)["Enter"]).toBe("function");
    expect(typeof (map as any)["g g"]).toBe("function");
    expect(typeof (map as any)["g e"]).toBe("function");
    expect(typeof (map as any)["g t"]).toBe("function");
    expect(typeof (map as any)["g p"]).toBe("function");
    expect(typeof (map as any)["ctrl+r"]).toBe("function");
    expect(typeof (map as any)["ctrl+s"]).toBe("function");
    expect(typeof (map as any)["ctrl+o"]).toBe("function");
  });

  test("number キー 1-6 が登録されている", () => {
    const bindings = createDashboardBindings(makeDeps());
    const map = buildAppKeys(bindings);
    for (const n of ["1", "2", "3", "4", "5", "6"]) {
      expect(typeof (map as any)[n]).toBe("function");
    }
  });

  test("scope/when を満たす binding だけが発火する (Enter は focus 内のみ)", () => {
    let openCount = 0;
    const bindings = createDashboardBindings(makeDeps({
      openSelectedArtifactInViewer: () => { openCount++; },
    }));
    const map = buildAppKeys(bindings);
    const enterHandler = (map as any)["Enter"];

    // global focus では Enter は発火しない
    enterHandler({
      state: makeState({ focusedArea: "global" }),
      update: () => {},
      focusedId: null,
    });
    expect(openCount).toBe(0);

    // artifacts focus では発火する
    enterHandler({
      state: makeState({ focusedArea: "artifacts" }),
      update: () => {},
      focusedId: null,
    });
    expect(openCount).toBe(1);
  });

  test("modal.confirm: confirmingFullQuit=true のときだけ y で fullQuit() が呼ばれる", () => {
    let fullQuitCount = 0;
    const bindings = createDashboardBindings(makeDeps({
      fullQuit: () => { fullQuitCount++; },
    }));
    const map = buildAppKeys(bindings);
    const yHandler = (map as any)["y"];
    expect(typeof yHandler).toBe("function");

    // confirmingFullQuit=false → 発火しない
    yHandler({
      state: makeState({ confirmingFullQuit: false }),
      update: () => {},
      focusedId: null,
    });
    expect(fullQuitCount).toBe(0);

    // confirmingFullQuit=true → 発火する
    yHandler({
      state: makeState({ confirmingFullQuit: true }),
      update: () => {},
      focusedId: null,
    });
    expect(fullQuitCount).toBe(1);
  });

  test("deprecated alias J が switchTab('journal') を呼ぶ", () => {
    let calledWith: string = "";
    const bindings = createDashboardBindings(makeDeps({
      switchTab: (tab: AppState["activeTab"]) => { calledWith = tab; },
    }));
    const map = buildAppKeys(bindings);
    const jHandler = (map as any)["J"];
    expect(typeof jHandler).toBe("function");
    jHandler({
      state: makeState(),
      update: () => {},
      focusedId: null,
    });
    expect(calledWith).toBe("journal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildStatusBarItems
// ─────────────────────────────────────────────────────────────────────────────

describe("buildStatusBarItems", () => {
  test("focus=journal: nav, gg/ge, 1-6, ?, Esc が含まれる", () => {
    const bindings = createDashboardBindings(makeDeps());
    const items = buildStatusBarItems(
      bindings,
      makeState({ activeTab: "journal", focusedArea: "journal" }),
    );
    const keys = items.map((i) => i.key);
    expect(keys).toContain("↑/↓");
    expect(keys).toContain("gg/ge");
    expect(keys).toContain("1-6");
    expect(keys).toContain("?");
    expect(keys).toContain("Esc");
  });

  test("focus=global: q / Ctrl+q / Ctrl+r が出る", () => {
    const bindings = createDashboardBindings(makeDeps());
    const items = buildStatusBarItems(
      bindings,
      makeState({ activeTab: "journal", focusedArea: "global" }),
    );
    const keys = items.map((i) => i.key);
    expect(keys).toContain("q");
    expect(keys).toContain("Ctrl+q");
    expect(keys).toContain("Ctrl+r");
  });

  test("focus=artifacts: s (sort) / f (filter) / Enter/o が出る", () => {
    const bindings = createDashboardBindings(makeDeps());
    const items = buildStatusBarItems(
      bindings,
      makeState({ activeTab: "artifacts", focusedArea: "artifacts" }),
    );
    const keys = items.map((i) => i.key);
    expect(keys).toContain("s");
    expect(keys).toContain("f");
    expect(keys).toContain("Enter/o");
  });

  test("activeTab=issues: Ctrl+s (sync) / Ctrl+o (browser) が出る", () => {
    const bindings = createDashboardBindings(makeDeps());
    const items = buildStatusBarItems(
      bindings,
      makeState({ activeTab: "issues", focusedArea: "issues" }),
    );
    const keys = items.map((i) => i.key);
    expect(keys).toContain("Ctrl+s");
    expect(keys).toContain("Ctrl+o");
  });

  test("deprecated alias は status bar に出ない", () => {
    const bindings = createDashboardBindings(makeDeps());
    const items = buildStatusBarItems(
      bindings,
      makeState({ focusedArea: "global" }),
    );
    const keys = items.map((i) => i.key);
    expect(keys).not.toContain("J");
    expect(keys).not.toContain("L");
    expect(keys).not.toContain("A");
    expect(keys).not.toContain("I");
    expect(keys).not.toContain("M");
    expect(keys).not.toContain("T");
    expect(keys).not.toContain("B");
    expect(keys).not.toContain("O");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildHelpOverlayRows
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHelpOverlayRows", () => {
  test("全 binding (deprecated 含む) を出力する", () => {
    const bindings = createDashboardBindings(makeDeps());
    const rows = buildHelpOverlayRows(bindings);
    expect(rows.length).toBeGreaterThan(0);
    // category が ORDER 順に並ぶ
    const cats = [...new Set(rows.filter((r) => !r.deprecated).map((r) => r.category))];
    expect(cats[0]).toBe("system");
    // deprecated 行は末尾
    const firstDeprecatedIdx = rows.findIndex((r) => r.deprecated);
    if (firstDeprecatedIdx >= 0) {
      for (let i = firstDeprecatedIdx; i < rows.length; i++) {
        expect(rows[i]!.deprecated).toBe(true);
      }
    }
  });

  test("deprecated エントリは replacement を含む", () => {
    const bindings = createDashboardBindings(makeDeps());
    const rows = buildHelpOverlayRows(bindings);
    const dep = rows.filter((r) => r.deprecated);
    expect(dep.length).toBeGreaterThan(0);
    for (const d of dep) {
      expect(d.replacement).toBeTruthy();
    }
  });

  test("scopeLabel に focus/tab/global の情報が出る", () => {
    const bindings = createDashboardBindings(makeDeps());
    const rows = buildHelpOverlayRows(bindings);
    // sys.help は global
    const help = rows.find((r) => r.key === "?");
    expect(help?.scopeLabel).toBe("global");
    // issues.sync は tab=issues
    const issuesSync = rows.find((r) => r.key === "Ctrl+s");
    expect(issuesSync?.scopeLabel).toBe("issues");
  });
});
