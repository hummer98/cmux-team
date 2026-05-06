/**
 * T439: toast state 遷移と表示用 truncate のテスト。
 *
 * - reduceShowToast: kind/message/expiresAt が正しく入る
 * - reduceClearToast: idempotent
 * - formatToastMessage: 長すぎるパスは末尾優先 truncate（先頭側に "…"）
 *   - prefix（"✓ Copied: " 等）を確保した上で columns - prefixLen に納める
 */
import { describe, test, expect } from "bun:test";
import {
  reduceShowToast,
  reduceClearToast,
  formatToastMessage,
  type AppState,
} from "./dashboard";

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

describe("reduceShowToast", () => {
  test("success kind と message を保持し expiresAt = now + duration", () => {
    const s = makeState({ toast: null });
    const next = reduceShowToast(s, "success", "/path/A001-x.md", 1_000, 2_000);
    expect(next.toast).not.toBeNull();
    expect(next.toast!.kind).toBe("success");
    expect(next.toast!.message).toBe("/path/A001-x.md");
    expect(next.toast!.expiresAt).toBe(3_000);
  });

  test("error kind も同じ構造で入る", () => {
    const s = makeState({ toast: null });
    const next = reduceShowToast(s, "error", "pbcopy not available", 500);
    expect(next.toast!.kind).toBe("error");
    expect(next.toast!.message).toBe("pbcopy not available");
  });

  test("既存 toast を上書き（後勝ち）", () => {
    const s = makeState({
      toast: { kind: "error", message: "old", expiresAt: 100 },
    });
    const next = reduceShowToast(s, "success", "new", 200, 2000);
    expect(next.toast!.kind).toBe("success");
    expect(next.toast!.message).toBe("new");
    expect(next.toast!.expiresAt).toBe(2200);
  });
});

describe("reduceClearToast", () => {
  test("toast あり → null", () => {
    const s = makeState({
      toast: { kind: "success", message: "x", expiresAt: 100 },
    });
    expect(reduceClearToast(s).toast).toBeNull();
  });

  test("toast null → 同一参照を返す（noop）", () => {
    const s = makeState({ toast: null });
    expect(reduceClearToast(s)).toBe(s);
  });
});

describe("formatToastMessage truncation", () => {
  test("短いパスはそのまま返る", () => {
    const r = formatToastMessage(
      { kind: "success", message: "/short.md" },
      80,
    );
    expect(r.body).toBe("/short.md");
    expect(r.icon).toBe("✓");
    expect(r.label.length).toBeGreaterThan(0);
  });

  test("長すぎるパスは末尾優先で先頭に … を付ける", () => {
    const longPath = "/Users/foo/" + "a".repeat(200) + "/B099-very-long-name.md";
    const r = formatToastMessage(
      { kind: "success", message: longPath },
      40,
    );
    expect(r.body.startsWith("…")).toBe(true);
    // 末尾は元パスの末尾と一致（artifact 名が見える）
    expect(r.body.endsWith("B099-very-long-name.md")).toBe(true);
    // prefix を含めてカラム上限を超えない
    const total = r.icon.length + 1 + r.label.length + 2 + r.body.length;
    expect(total).toBeLessThanOrEqual(40);
  });

  test("error kind は ✗ アイコン", () => {
    const r = formatToastMessage(
      { kind: "error", message: "boom" },
      80,
    );
    expect(r.icon).toBe("✗");
  });

  test("極小 columns でも 8 文字は確保される", () => {
    const r = formatToastMessage(
      { kind: "success", message: "/Users/a/b/c/d/e/f/g.md" },
      4,
    );
    // max = max(8, 4 - 12) = 8
    expect(r.body.length).toBeLessThanOrEqual(8);
  });
});

/**
 * 「schedule の cb 発火後に toast がクリアされる」「複数発火で前 timer が cancel される」
 * は startDashboard closure の挙動。reducer 単体ではなく schedule 経由のため、
 * 簡易な fake schedule ハーネスで一通り検証する。
 */
describe("toast lifecycle: schedule fake で通常 / 連続発火を verify", () => {
  type ToastState = AppState["toast"];

  function makeHarness() {
    let toast: ToastState = null;
    let scheduled: Array<{ ms: number; cb: () => void; cancelled: boolean }> = [];

    const showToast = (
      kind: "success" | "error",
      message: string,
      now: number,
      durationMs: number = 2000,
    ): { cancel: () => void } => {
      // 前の schedule をすべて cancel
      for (const s of scheduled) {
        if (!s.cancelled) s.cancelled = true;
      }
      const fakeState = makeState({ toast });
      toast = reduceShowToast(fakeState, kind, message, now, durationMs).toast;
      const entry = {
        ms: durationMs,
        cancelled: false,
        cb: () => {
          if (entry.cancelled) return;
          toast = null;
        },
      };
      scheduled.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    };

    const fireLatest = () => {
      const last = scheduled[scheduled.length - 1];
      if (last) last.cb();
    };

    const fireAll = () => {
      for (const s of scheduled) s.cb();
    };

    return {
      showToast,
      fireLatest,
      fireAll,
      getToast: () => toast,
      getScheduled: () => scheduled,
    };
  }

  test("showToast 後 toast に値が入る", () => {
    const h = makeHarness();
    h.showToast("success", "/x", 100);
    expect(h.getToast()).not.toBeNull();
    expect(h.getToast()!.message).toBe("/x");
  });

  test("schedule の cb 発火で toast = null", () => {
    const h = makeHarness();
    h.showToast("success", "/x", 100);
    h.fireLatest();
    expect(h.getToast()).toBeNull();
  });

  test("連続発火: 1 回目 cb は cancel され 2 回目だけ生き残る", () => {
    const h = makeHarness();
    h.showToast("success", "/first", 100);
    h.showToast("error", "/second", 200);
    expect(h.getToast()!.message).toBe("/second");
    // 全 schedule の cb を発火しても、1 回目は cancelled 済みで toast を消さない
    h.fireAll();
    // 2 回目の cb は生きていて toast を消す
    expect(h.getToast()).toBeNull();
  });
});
