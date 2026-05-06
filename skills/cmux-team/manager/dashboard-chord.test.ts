/**
 * T439: c c chord state machine の単体テスト。
 *
 * - reduceCKeyPress: 1 回目で pending 立つ、2 回目で pending クリア
 * - reduceClearChord: idempotent
 * - withChordCancellation: copy chord 自身は noop、その他 binding は cancelChord 経由
 * - registry に c binding が artifacts focus / category=action / statusBarKey="cc" で登録されること
 */
import { describe, test, expect } from "bun:test";
import {
  reduceCKeyPress,
  reduceClearChord,
  type AppState,
} from "./dashboard";
import {
  COPY_CHORD_BINDING_ID,
  createDashboardBindings,
  validateRegistry,
  withChordCancellation,
  type BindingSpec,
  type KeymapDeps,
} from "./dashboard-keymap";

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
    activeTab: "artifacts",
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
    focusedArea: "artifacts",
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

describe("reduceCKeyPress: chord state machine", () => {
  test("1 回目押下: cChordPending が立ち firstPress=true", () => {
    const s = makeState({ cChordPending: null });
    const r = reduceCKeyPress(s, 1000);
    expect(r.firstPress).toBe(true);
    expect(r.next.cChordPending).not.toBeNull();
    expect(r.next.cChordPending?.startedAtMs).toBe(1000);
  });

  test("2 回目押下 (pending 中): pending クリア firstPress=false", () => {
    const s = makeState({ cChordPending: { startedAtMs: 500 } });
    const r = reduceCKeyPress(s, 1000);
    expect(r.firstPress).toBe(false);
    expect(r.next.cChordPending).toBeNull();
  });

  test("他のフィールドは変更されない", () => {
    const s = makeState({ artifactCursor: 3, focusedArea: "artifacts" });
    const r = reduceCKeyPress(s, 1000);
    expect(r.next.artifactCursor).toBe(3);
    expect(r.next.focusedArea).toBe("artifacts");
  });
});

describe("reduceClearChord", () => {
  test("pending あり → クリア", () => {
    const s = makeState({ cChordPending: { startedAtMs: 500 } });
    expect(reduceClearChord(s).cChordPending).toBeNull();
  });

  test("pending null → 同一参照を返す（noop）", () => {
    const s = makeState({ cChordPending: null });
    expect(reduceClearChord(s)).toBe(s);
  });
});

describe("withChordCancellation", () => {
  function makeBinding(id: string): BindingSpec {
    return {
      id,
      keys: ["x"],
      scope: { kind: "global" },
      category: "action",
      description: "key_help",
      handler: () => {},
    };
  }

  test("copy chord binding 自身は cancelChord を呼ばずに handler 実行", () => {
    let cancelCalled = 0;
    let handlerCalled = 0;
    const handler: (ctx: any) => void = () => { handlerCalled++; };
    const binding = makeBinding(COPY_CHORD_BINDING_ID);
    const wrapped = withChordCancellation(handler, binding, {
      cancelChord: () => { cancelCalled++; },
    });
    wrapped({
      state: makeState({ cChordPending: { startedAtMs: 100 } }),
      update: () => {},
      focusedId: null,
    } as any);
    expect(cancelCalled).toBe(0);
    expect(handlerCalled).toBe(1);
  });

  test("copy chord 以外で pending 中 → cancelChord 呼ばれてから handler 実行", () => {
    let cancelCalled = 0;
    let handlerCalled = 0;
    const handler: (ctx: any) => void = () => { handlerCalled++; };
    const binding = makeBinding("nav.down");
    const wrapped = withChordCancellation(handler, binding, {
      cancelChord: () => { cancelCalled++; },
    });
    wrapped({
      state: makeState({ cChordPending: { startedAtMs: 100 } }),
      update: () => {},
      focusedId: null,
    } as any);
    expect(cancelCalled).toBe(1);
    expect(handlerCalled).toBe(1);
  });

  test("copy chord 以外で pending null → cancelChord は呼ばれない（無駄打ちしない）", () => {
    let cancelCalled = 0;
    let handlerCalled = 0;
    const handler: (ctx: any) => void = () => { handlerCalled++; };
    const binding = makeBinding("nav.down");
    const wrapped = withChordCancellation(handler, binding, {
      cancelChord: () => { cancelCalled++; },
    });
    wrapped({
      state: makeState({ cChordPending: null }),
      update: () => {},
      focusedId: null,
    } as any);
    expect(cancelCalled).toBe(0);
    expect(handlerCalled).toBe(1);
  });
});

describe("createDashboardBindings: c binding registration", () => {
  test("c binding が artifacts focus + category=action + statusBarKey=cc で登録されている", () => {
    const bindings = createDashboardBindings(makeDeps());
    const cbind = bindings.find((b) => b.id === COPY_CHORD_BINDING_ID);
    expect(cbind).toBeDefined();
    expect(cbind!.keys).toEqual(["c"]);
    expect(cbind!.scope.kind).toBe("focus");
    if (cbind!.scope.kind === "focus") {
      expect(cbind!.scope.areas).toEqual(["artifacts"]);
    }
    expect(cbind!.category).toBe("action");
    expect(cbind!.statusBarKey).toBe("cc");
  });

  test("validateRegistry が pass する（c 単発と他の chord prefix 衝突なし）", () => {
    const bindings = createDashboardBindings(makeDeps());
    expect(() => validateRegistry(bindings)).not.toThrow();
  });

  test("c binding の handler が deps.handleCopyChord を呼ぶ", () => {
    let called = 0;
    const deps = makeDeps({ handleCopyChord: () => { called++; } });
    const bindings = createDashboardBindings(deps);
    const cbind = bindings.find((b) => b.id === COPY_CHORD_BINDING_ID)!;
    // wrap 後の handler を呼ぶ。state.cChordPending は null なので cancelChord は走らず handleCopyChord に直通
    cbind.handler({
      state: makeState({ cChordPending: null }),
      update: () => {},
      focusedId: null,
    } as any);
    expect(called).toBe(1);
  });
});

describe("createDashboardBindings: 別キー押下時の cancellation 統合", () => {
  test("focus=artifacts で pending 中、j 押下 → cancelChord 呼ばれてから navigateDown 実行", () => {
    let cancelCalled = 0;
    let navigateCalled = 0;
    const deps = makeDeps({
      cancelChord: () => { cancelCalled++; },
      navigateDown: (s) => {
        navigateCalled++;
        return s;
      },
    });
    const bindings = createDashboardBindings(deps);
    const jbind = bindings.find((b) => b.id === "nav.down")!;
    let curState = makeState({ cChordPending: { startedAtMs: 100 } });
    jbind.handler({
      state: curState,
      update: (updater: any) => {
        curState = typeof updater === "function" ? updater(curState) : updater;
      },
      focusedId: null,
    } as any);
    expect(cancelCalled).toBe(1);
    expect(navigateCalled).toBe(1);
  });
});
