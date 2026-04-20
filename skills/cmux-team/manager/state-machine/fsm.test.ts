/**
 * T279: Conductor / Task FSM reducer のテーブル駆動テスト。
 *
 * A017 §1.2 (Conductor 遷移表) と §2.2 (Task 遷移表) の全セルを網羅する。
 * 既知 race / regression (T232 / T255 / T263 / T269 / T274 / T277) も個別に assert。
 *
 * 実行: `cd skills/cmux-team/manager && bun test state-machine/`
 */

import { describe, test, expect } from "bun:test";
import { conductorReduce } from "./conductor-fsm";
import { taskReduce } from "./task-fsm";
import {
  checkConductorInvariants,
  checkTaskInvariants,
} from "./invariants";
import type {
  ConductorStatus,
  ConductorCtx,
  FsmEvent,
  TaskStatus,
  TaskCtx,
  TaskFsmEvent,
} from "./events";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function ctx(partial: Partial<ConductorCtx> = {}): ConductorCtx {
  return {
    hasTaskRunId: partial.hasTaskRunId ?? false,
    clearSentAtElapsedSec: partial.clearSentAtElapsedSec,
    assigningSetAtElapsedSec: partial.assigningSetAtElapsedSec,
    disconnectedElapsedSec: partial.disconnectedElapsedSec,
    isMasterSurface: partial.isMasterSurface ?? false,
    now: partial.now ?? 1_700_000_000_000,
  };
}

function tctx(partial: Partial<TaskCtx> = {}): TaskCtx {
  return {
    hasConductor: partial.hasConductor ?? true,
    parentAborted: partial.parentAborted ?? false,
  };
}

const ALL_CONDUCTOR_STATES: ConductorStatus[] = [
  "starting",
  "assigning",
  "idle",
  "running",
  "asking",
  "disconnected",
  "broken",
];

const ALL_TASK_STATES: TaskStatus[] = [
  "draft",
  "ready",
  "assigned",
  "closed",
  "aborted",
  "deleted",
];

// -----------------------------------------------------------------------------
// Conductor FSM — A017 §1.2 の全セル
// -----------------------------------------------------------------------------

describe("Conductor FSM — broken は終端 state (A017 §1.4)", () => {
  // broken は全 event で no-op、actions=[] (clear-conductor のみ手動復帰)
  const events: FsmEvent[] = [
    { type: "SESSION_STARTED", source: "clear", isMasterSurface: false },
    { type: "SESSION_IDLE" },
    { type: "SESSION_CLEAR", manualUserInitiated: true },
    { type: "SESSION_ACTIVE" },
    { type: "SESSION_ASK" },
    { type: "SESSION_ENDED", reason: "stop" },
    { type: "TIMEOUT", kind: "disconnected" },
    { type: "ASSIGN", ok: true },
    { type: "DONE", success: true, unresolved: false },
    { type: "PID_DIED" },
    { type: "CLEAR_MANUAL" },
    { type: "REGISTERED" },
  ];
  for (const event of events) {
    test(`broken + ${event.type} → broken (no-op)`, () => {
      const { next, actions } = conductorReduce("broken", event, ctx({ hasTaskRunId: false }));
      expect(next).toBe("broken");
      expect(actions).toEqual([]);
    });
  }
});

describe("Conductor FSM — REGISTERED (A017 §1.1)", () => {
  test("starting + REGISTERED → starting (idempotent skip)", () => {
    const { next } = conductorReduce("starting", { type: "REGISTERED" }, ctx());
    expect(next).toBe("starting");
  });
  for (const s of ALL_CONDUCTOR_STATES.filter((s) => s !== "broken")) {
    test(`${s} + REGISTERED は state 変化なし`, () => {
      const { next } = conductorReduce(s, { type: "REGISTERED" }, ctx());
      expect(next).toBe(s);
    });
  }
});

describe("Conductor FSM — SESSION_STARTED (A017 §1.2)", () => {
  test("Master surface は全 state で no-op", () => {
    for (const s of ALL_CONDUCTOR_STATES.filter((s) => s !== "broken")) {
      const { next, actions } = conductorReduce(
        s,
        { type: "SESSION_STARTED", source: "startup", isMasterSurface: true },
        ctx(),
      );
      expect(next).toBe(s);
      expect(actions).toEqual([]);
    }
  });

  test("starting + SESSION_STARTED → idle + spawn_pid_watcher + conductor_ready", () => {
    const { next, actions } = conductorReduce(
      "starting",
      { type: "SESSION_STARTED", source: "startup", isMasterSurface: false },
      ctx(),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "spawn_pid_watcher")).toBeDefined();
    expect(actions.find((a) => a.type === "log" && a.event === "conductor_ready")).toBeDefined();
  });

  test("disconnected + SESSION_STARTED → idle + conductor_recovered", () => {
    const { next, actions } = conductorReduce(
      "disconnected",
      { type: "SESSION_STARTED", source: "resume", isMasterSurface: false },
      ctx(),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "log" && a.event === "conductor_recovered")).toBeDefined();
  });

  test("assigning + SESSION_STARTED(source=clear) → running (T232 メイン経路)", () => {
    const { next, actions } = conductorReduce(
      "assigning",
      { type: "SESSION_STARTED", source: "clear", isMasterSurface: false },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
    expect(actions.find((a) => a.type === "log" && a.event === "conductor_running")).toBeDefined();
  });

  test("idle + SESSION_STARTED → idle (pid 更新のみ)", () => {
    const { next, actions } = conductorReduce(
      "idle",
      { type: "SESSION_STARTED", source: "startup", isMasterSurface: false },
      ctx(),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "spawn_pid_watcher")).toBeDefined();
  });

  test("running + SESSION_STARTED → running (pid 更新のみ)", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "SESSION_STARTED", source: "compact", isMasterSurface: false },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
    expect(actions.find((a) => a.type === "spawn_pid_watcher")).toBeDefined();
  });

  test("asking + SESSION_STARTED → asking (pid 更新のみ)", () => {
    const { next } = conductorReduce(
      "asking",
      { type: "SESSION_STARTED", source: "resume", isMasterSurface: false },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("asking");
  });
});

describe("Conductor FSM — SESSION_IDLE (A017 §1.2, T277 修正反映)", () => {
  test("starting + SESSION_IDLE → idle", () => {
    const { next } = conductorReduce("starting", { type: "SESSION_IDLE" }, ctx());
    expect(next).toBe("idle");
  });
  test("assigning + SESSION_IDLE → assigning (T277: no-op, R1 保険撤去済み)", () => {
    const { next, actions } = conductorReduce(
      "assigning",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("assigning");
    expect(actions).toEqual([]);
  });
  test("idle + SESSION_IDLE → idle (no-op)", () => {
    const { next } = conductorReduce("idle", { type: "SESSION_IDLE" }, ctx());
    expect(next).toBe("idle");
  });
  test("running + SESSION_IDLE → running (no-op)", () => {
    const { next } = conductorReduce(
      "running",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });
  test("asking + SESSION_IDLE (hasTaskRunId=true) → running", () => {
    const { next, actions } = conductorReduce(
      "asking",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
    expect(actions.find((a) => a.type === "log" && a.event === "conductor_ask_resolved")).toBeDefined();
  });
  test("asking + SESSION_IDLE (hasTaskRunId=false) → idle", () => {
    const { next } = conductorReduce(
      "asking",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: false }),
    );
    expect(next).toBe("idle");
  });
  test("disconnected + SESSION_IDLE (hasTaskRunId=true) → running", () => {
    const { next } = conductorReduce(
      "disconnected",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });
  test("disconnected + SESSION_IDLE (hasTaskRunId=false) → idle", () => {
    const { next } = conductorReduce(
      "disconnected",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: false }),
    );
    expect(next).toBe("idle");
  });
});

describe("Conductor FSM — SESSION_CLEAR (A017 §1.2)", () => {
  test("starting + SESSION_CLEAR → idle", () => {
    const { next } = conductorReduce(
      "starting",
      { type: "SESSION_CLEAR", manualUserInitiated: false },
      ctx(),
    );
    expect(next).toBe("idle");
  });
  test("assigning + SESSION_CLEAR → assigning (session_clear_expected, daemon /clear 戻り)", () => {
    const { next, actions } = conductorReduce(
      "assigning",
      { type: "SESSION_CLEAR", manualUserInitiated: false },
      ctx(),
    );
    expect(next).toBe("assigning");
    expect(actions.find((a) => a.type === "log" && a.event === "session_clear_expected")).toBeDefined();
  });
  test("idle + SESSION_CLEAR → idle (no-op)", () => {
    const { next } = conductorReduce(
      "idle",
      { type: "SESSION_CLEAR", manualUserInitiated: false },
      ctx(),
    );
    expect(next).toBe("idle");
  });
  test("running + SESSION_CLEAR (manualUserInitiated=true) → idle + task abort + cascade + reset", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "SESSION_CLEAR", manualUserInitiated: true },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "abort_task" && a.reason === "user_clear")).toBeDefined();
    expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
    expect(actions.find((a) => a.type === "reset_conductor")).toBeDefined();
  });
  test("running + SESSION_CLEAR (manualUserInitiated=false) → running (異常 log のみ)", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "SESSION_CLEAR", manualUserInitiated: false },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
    expect(actions.find((a) => a.type === "log" && a.event === "session_clear_unexpected_running")).toBeDefined();
  });
  test("asking + SESSION_CLEAR → asking (no-op)", () => {
    const { next } = conductorReduce(
      "asking",
      { type: "SESSION_CLEAR", manualUserInitiated: false },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("asking");
  });
  test("disconnected + SESSION_CLEAR → idle", () => {
    const { next } = conductorReduce(
      "disconnected",
      { type: "SESSION_CLEAR", manualUserInitiated: false },
      ctx(),
    );
    expect(next).toBe("idle");
  });
});

describe("Conductor FSM — SESSION_ACTIVE (A017 §1.2)", () => {
  test("starting + SESSION_ACTIVE → idle", () => {
    const { next } = conductorReduce("starting", { type: "SESSION_ACTIVE" }, ctx());
    expect(next).toBe("idle");
  });
  test("assigning + SESSION_ACTIVE (hasTaskRunId=true) → running (T232 R1)", () => {
    const { next } = conductorReduce(
      "assigning",
      { type: "SESSION_ACTIVE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });
  test("assigning + SESSION_ACTIVE (hasTaskRunId=false) → assigning", () => {
    const { next } = conductorReduce(
      "assigning",
      { type: "SESSION_ACTIVE" },
      ctx({ hasTaskRunId: false }),
    );
    expect(next).toBe("assigning");
  });
  test("idle + SESSION_ACTIVE → idle", () => {
    const { next } = conductorReduce("idle", { type: "SESSION_ACTIVE" }, ctx());
    expect(next).toBe("idle");
  });
  test("running + SESSION_ACTIVE → running", () => {
    const { next } = conductorReduce(
      "running",
      { type: "SESSION_ACTIVE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });
  test("asking + SESSION_ACTIVE → asking", () => {
    const { next } = conductorReduce(
      "asking",
      { type: "SESSION_ACTIVE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("asking");
  });
  test("disconnected + SESSION_ACTIVE → running", () => {
    const { next } = conductorReduce(
      "disconnected",
      { type: "SESSION_ACTIVE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });
});

describe("Conductor FSM — SESSION_ASK (A017 §1.2)", () => {
  for (const s of ALL_CONDUCTOR_STATES.filter((s) => s !== "broken")) {
    test(`${s} + SESSION_ASK → asking`, () => {
      const { next, actions } = conductorReduce(s, { type: "SESSION_ASK" }, ctx({ hasTaskRunId: true }));
      expect(next).toBe("asking");
      expect(actions.find((a) => a.type === "log" && a.event === "conductor_asking")).toBeDefined();
    });
  }
});

describe("Conductor FSM — SESSION_ENDED (A017 §1.2)", () => {
  for (const s of ALL_CONDUCTOR_STATES.filter((s) => s !== "broken" && s !== "disconnected")) {
    test(`${s} + SESSION_ENDED(reason=stop) → disconnected`, () => {
      const { next, actions } = conductorReduce(
        s,
        { type: "SESSION_ENDED", reason: "stop" },
        ctx(),
      );
      expect(next).toBe("disconnected");
      expect(actions.find((a) => a.type === "log" && a.event === "conductor_disconnected")).toBeDefined();
    });
  }
  test("disconnected + SESSION_ENDED → disconnected (no-op、重複通知)", () => {
    const { next, actions } = conductorReduce(
      "disconnected",
      { type: "SESSION_ENDED", reason: "stop" },
      ctx(),
    );
    expect(next).toBe("disconnected");
    expect(actions).toEqual([]);
  });
  test("SESSION_ENDED(reason=other) は全 state で no-op", () => {
    for (const s of ALL_CONDUCTOR_STATES.filter((s) => s !== "broken")) {
      const { next } = conductorReduce(
        s,
        { type: "SESSION_ENDED", reason: "other" },
        ctx(),
      );
      expect(next).toBe(s);
    }
  });
});

describe("Conductor FSM — PID_DIED (A017 §1.2)", () => {
  for (const s of ALL_CONDUCTOR_STATES.filter((s) => s !== "broken" && s !== "disconnected")) {
    test(`${s} + PID_DIED → disconnected`, () => {
      const { next, actions } = conductorReduce(s, { type: "PID_DIED" }, ctx());
      expect(next).toBe("disconnected");
      expect(actions.find((a) => a.type === "log" && a.event === "conductor_disconnected")).toBeDefined();
    });
  }
  test("disconnected + PID_DIED → disconnected (no-op)", () => {
    const { next } = conductorReduce("disconnected", { type: "PID_DIED" }, ctx());
    expect(next).toBe("disconnected");
  });
});

describe("Conductor FSM — TIMEOUT (A017 §1.3)", () => {
  test("starting + TIMEOUT(starting) → disconnected", () => {
    const { next } = conductorReduce(
      "starting",
      { type: "TIMEOUT", kind: "starting" },
      ctx(),
    );
    expect(next).toBe("disconnected");
  });
  test("assigning + TIMEOUT(assigning) → disconnected", () => {
    const { next, actions } = conductorReduce(
      "assigning",
      { type: "TIMEOUT", kind: "assigning" },
      ctx(),
    );
    expect(next).toBe("disconnected");
    expect(actions.find((a) => a.type === "log" && a.event === "assigning_window_close")).toBeDefined();
  });
  test("disconnected + TIMEOUT(disconnected) → broken + abort + cascade + reset", () => {
    const { next, actions } = conductorReduce(
      "disconnected",
      { type: "TIMEOUT", kind: "disconnected" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("broken");
    expect(actions.find((a) => a.type === "abort_task" && a.reason === "disconnect_timeout")).toBeDefined();
    expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
    expect(actions.find((a) => a.type === "reset_conductor" && a.targetStatus === "broken")).toBeDefined();
  });
  test("idle + TIMEOUT(starting) → idle (kind 不一致で no-op)", () => {
    const { next } = conductorReduce(
      "idle",
      { type: "TIMEOUT", kind: "starting" },
      ctx(),
    );
    expect(next).toBe("idle");
  });
});

describe("Conductor FSM — ASSIGN (A017 §1.2)", () => {
  test("idle + ASSIGN(ok=true) → assigning", () => {
    const { next, actions } = conductorReduce(
      "idle",
      { type: "ASSIGN", ok: true },
      ctx(),
    );
    expect(next).toBe("assigning");
    expect(actions.find((a) => a.type === "log" && a.event === "conductor_assigning")).toBeDefined();
  });
  test("idle + ASSIGN(ok=false, errorKind=conductor) → disconnected", () => {
    const { next } = conductorReduce(
      "idle",
      { type: "ASSIGN", ok: false, errorKind: "conductor" },
      ctx(),
    );
    expect(next).toBe("disconnected");
  });
  test("idle + ASSIGN(ok=false, errorKind=task) → idle (task 側のみ影響)", () => {
    const { next, actions } = conductorReduce(
      "idle",
      { type: "ASSIGN", ok: false, errorKind: "task" },
      ctx(),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "log" && a.event === "assign_failed")).toBeDefined();
  });
  test("assigning + ASSIGN(ok=false, errorKind=task) → disconnected (R2 保険、daemon.ts:2487)", () => {
    const { next } = conductorReduce(
      "assigning",
      { type: "ASSIGN", ok: false, errorKind: "task" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("disconnected");
  });
  test("running + ASSIGN(ok=true) → running (no-op、既に割当済)", () => {
    const { next } = conductorReduce(
      "running",
      { type: "ASSIGN", ok: true },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });
});

describe("Conductor FSM — DONE (T263 / T269 / T274)", () => {
  test("running + DONE(success=true, task=closed) → idle + reset (task_completed)", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "DONE", success: true, unresolved: false, currentTaskStatus: "closed" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "reset_conductor" && a.reason === "done")).toBeDefined();
    expect(actions.find((a) => a.type === "log" && a.event === "task_completed")).toBeDefined();
  });

  test("T274: running + DONE(success=true, task=assigned) → idle + close_task_auto", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "DONE", success: true, unresolved: false, currentTaskStatus: "assigned" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "close_task_auto")).toBeDefined();
    expect(
      actions.find((a) => a.type === "log" && a.event === "task_completed_state_mismatch"),
    ).toBeDefined();
  });

  test("T269: running + DONE(success=false, unresolved=true) → idle + abort(judgment_pending) + preserveWorktree", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "DONE", success: false, unresolved: true, currentTaskStatus: "assigned" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "abort_task" && a.reason === "judgment_pending")).toBeDefined();
    expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
    const reset = actions.find((a) => a.type === "reset_conductor");
    expect(reset).toBeDefined();
    if (reset && reset.type === "reset_conductor") {
      expect(reset.preserveWorktree).toBe(true);
    }
  });

  test("T263: running + DONE(success=false, unresolved=false, task=closed) → idle (late regression guard)", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "DONE", success: false, unresolved: false, currentTaskStatus: "closed" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "log" && a.event === "task_completed")).toBeDefined();
  });

  test("asking + DONE(success=true) → idle (asking からも done 受理)", () => {
    const { next } = conductorReduce(
      "asking",
      { type: "DONE", success: true, unresolved: false, currentTaskStatus: "closed" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
  });

  test("idle + DONE → idle (late_cleanup 経路、no-op)", () => {
    const { next } = conductorReduce(
      "idle",
      { type: "DONE", success: true, unresolved: false },
      ctx(),
    );
    expect(next).toBe("idle");
  });

  test("disconnected + DONE → disconnected (no-op)", () => {
    const { next } = conductorReduce(
      "disconnected",
      { type: "DONE", success: true, unresolved: false },
      ctx(),
    );
    expect(next).toBe("disconnected");
  });
});

describe("Conductor FSM — CLEAR_MANUAL (予約 event、exhaustive check 用)", () => {
  test("running + CLEAR_MANUAL → idle + abort + cascade + reset", () => {
    const { next, actions } = conductorReduce(
      "running",
      { type: "CLEAR_MANUAL" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
    expect(actions.find((a) => a.type === "abort_task" && a.reason === "clear_manual")).toBeDefined();
  });
  test("asking + CLEAR_MANUAL → idle", () => {
    const { next } = conductorReduce("asking", { type: "CLEAR_MANUAL" }, ctx({ hasTaskRunId: true }));
    expect(next).toBe("idle");
  });
  test("idle + CLEAR_MANUAL → idle (no-op)", () => {
    const { next } = conductorReduce("idle", { type: "CLEAR_MANUAL" }, ctx());
    expect(next).toBe("idle");
  });
});

// -----------------------------------------------------------------------------
// Task FSM — A017 §2.2 の全セル
// -----------------------------------------------------------------------------

describe("Task FSM — deleted は終端 state", () => {
  const events: TaskFsmEvent[] = [
    { type: "CREATE" },
    { type: "UPDATE_STATUS", to: "ready" },
    { type: "ASSIGN_OK" },
    { type: "ASSIGN_FAIL", errorKind: "task" },
    { type: "CLOSE" },
    { type: "ABORT", reason: "user_clear" },
    { type: "DELETE" },
    { type: "RESTART" },
    { type: "PARENT_ABORTED" },
  ];
  for (const e of events) {
    test(`deleted + ${e.type} → deleted (no-op)`, () => {
      const { next, actions } = taskReduce("deleted", e, tctx());
      expect(next).toBe("deleted");
      expect(actions).toEqual([]);
    });
  }
});

describe("Task FSM — UPDATE_STATUS", () => {
  test("draft + UPDATE_STATUS(ready) → ready", () => {
    const { next } = taskReduce("draft", { type: "UPDATE_STATUS", to: "ready" }, tctx());
    expect(next).toBe("ready");
  });
  test("ready + UPDATE_STATUS(draft) → draft", () => {
    const { next } = taskReduce("ready", { type: "UPDATE_STATUS", to: "draft" }, tctx());
    expect(next).toBe("draft");
  });
  test("assigned + UPDATE_STATUS(ready) → assigned (no-op)", () => {
    const { next } = taskReduce("assigned", { type: "UPDATE_STATUS", to: "ready" }, tctx());
    expect(next).toBe("assigned");
  });
});

describe("Task FSM — ASSIGN_OK (A017 §2.2)", () => {
  test("ready + ASSIGN_OK → assigned", () => {
    const { next, actions } = taskReduce("ready", { type: "ASSIGN_OK" }, tctx());
    expect(next).toBe("assigned");
    expect(actions.find((a) => a.type === "log" && a.event === "task_assigned")).toBeDefined();
  });
  for (const s of ALL_TASK_STATES.filter((s) => s !== "ready" && s !== "deleted")) {
    test(`${s} + ASSIGN_OK → ${s} (no-op)`, () => {
      const { next } = taskReduce(s, { type: "ASSIGN_OK" }, tctx());
      expect(next).toBe(s);
    });
  }
});

describe("Task FSM — ASSIGN_FAIL (A017 §2.2)", () => {
  test("ready + ASSIGN_FAIL(task) → aborted + cascade", () => {
    const { next, actions } = taskReduce("ready", { type: "ASSIGN_FAIL", errorKind: "task" }, tctx());
    expect(next).toBe("aborted");
    expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
  });
  test("ready + ASSIGN_FAIL(conductor) → ready (Conductor 側問題、task はそのまま)", () => {
    const { next } = taskReduce("ready", { type: "ASSIGN_FAIL", errorKind: "conductor" }, tctx());
    expect(next).toBe("ready");
  });
});

describe("Task FSM — CLOSE (A017 §2.2)", () => {
  test("assigned + CLOSE → closed", () => {
    const { next } = taskReduce("assigned", { type: "CLOSE" }, tctx());
    expect(next).toBe("closed");
  });
  test("ready + CLOSE → closed (手動 close 経路)", () => {
    const { next } = taskReduce("ready", { type: "CLOSE" }, tctx({ hasConductor: false }));
    expect(next).toBe("closed");
  });
  test("draft + CLOSE → closed", () => {
    const { next } = taskReduce("draft", { type: "CLOSE" }, tctx({ hasConductor: false }));
    expect(next).toBe("closed");
  });
  test("closed + CLOSE → closed (no-op)", () => {
    const { next } = taskReduce("closed", { type: "CLOSE" }, tctx({ hasConductor: false }));
    expect(next).toBe("closed");
  });
  test("aborted + CLOSE → aborted (no-op)", () => {
    const { next } = taskReduce("aborted", { type: "CLOSE" }, tctx({ hasConductor: false }));
    expect(next).toBe("aborted");
  });
});

describe("Task FSM — ABORT (A017 §2.2)", () => {
  for (const s of ["draft", "ready", "assigned"] as const) {
    test(`${s} + ABORT → aborted + cascade`, () => {
      const { next, actions } = taskReduce(
        s,
        { type: "ABORT", reason: "user_clear" },
        tctx(),
      );
      expect(next).toBe("aborted");
      expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
    });
  }
  test("closed + ABORT → closed (no-op)", () => {
    const { next } = taskReduce("closed", { type: "ABORT", reason: "x" }, tctx({ hasConductor: false }));
    expect(next).toBe("closed");
  });
  test("aborted + ABORT → aborted (no-op)", () => {
    const { next } = taskReduce("aborted", { type: "ABORT", reason: "x" }, tctx({ hasConductor: false }));
    expect(next).toBe("aborted");
  });
});

describe("Task FSM — DELETE (A017 §2.2)", () => {
  test("draft + DELETE → deleted", () => {
    const { next } = taskReduce("draft", { type: "DELETE" }, tctx({ hasConductor: false }));
    expect(next).toBe("deleted");
  });
  test("ready + DELETE → deleted", () => {
    const { next } = taskReduce("ready", { type: "DELETE" }, tctx({ hasConductor: false }));
    expect(next).toBe("deleted");
  });
  test("assigned + DELETE → assigned (A017 §2.2 では直接の遷移はない、禁止経路)", () => {
    const { next } = taskReduce("assigned", { type: "DELETE" }, tctx());
    expect(next).toBe("assigned");
  });
});

describe("Task FSM — RESTART (A017 §2.2)", () => {
  test("aborted + RESTART → ready", () => {
    const { next } = taskReduce("aborted", { type: "RESTART" }, tctx({ hasConductor: false }));
    expect(next).toBe("ready");
  });
  test("closed + RESTART → ready", () => {
    const { next } = taskReduce("closed", { type: "RESTART" }, tctx({ hasConductor: false }));
    expect(next).toBe("ready");
  });
  test("ready + RESTART → ready (no-op)", () => {
    const { next } = taskReduce("ready", { type: "RESTART" }, tctx({ hasConductor: false }));
    expect(next).toBe("ready");
  });
});

describe("Task FSM — PARENT_ABORTED (T241 cascade)", () => {
  test("ready + PARENT_ABORTED → draft", () => {
    const { next, actions } = taskReduce(
      "ready",
      { type: "PARENT_ABORTED" },
      tctx({ parentAborted: true }),
    );
    expect(next).toBe("draft");
    expect(actions.find((a) => a.type === "log" && a.event === "child_reverted_to_draft")).toBeDefined();
  });
  test("draft + PARENT_ABORTED → draft (no-op)", () => {
    const { next } = taskReduce("draft", { type: "PARENT_ABORTED" }, tctx());
    expect(next).toBe("draft");
  });
  test("assigned + PARENT_ABORTED → assigned (走行中の作業は止めない)", () => {
    const { next } = taskReduce("assigned", { type: "PARENT_ABORTED" }, tctx());
    expect(next).toBe("assigned");
  });
  test("closed + PARENT_ABORTED → closed (no-op)", () => {
    const { next } = taskReduce("closed", { type: "PARENT_ABORTED" }, tctx({ hasConductor: false }));
    expect(next).toBe("closed");
  });
});

// -----------------------------------------------------------------------------
// Invariants (log-only、violation の再現)
// -----------------------------------------------------------------------------

describe("Conductor invariants (I1, I2)", () => {
  test("I1: running ⇒ hasTaskRunId (違反検出)", () => {
    const { violations } = checkConductorInvariants("running", ctx({ hasTaskRunId: false }));
    expect(violations.some((v) => v.startsWith("I1"))).toBe(true);
  });
  test("I1: running with hasTaskRunId=true は違反なし", () => {
    const { violations } = checkConductorInvariants("running", ctx({ hasTaskRunId: true }));
    expect(violations).toEqual([]);
  });
  test("I2: broken with hasTaskRunId=true (違反検出)", () => {
    const { violations } = checkConductorInvariants("broken", ctx({ hasTaskRunId: true }));
    expect(violations.some((v) => v.startsWith("I2"))).toBe(true);
  });
  test("I2: broken with hasTaskRunId=false は違反なし", () => {
    const { violations } = checkConductorInvariants("broken", ctx({ hasTaskRunId: false }));
    expect(violations).toEqual([]);
  });
});

describe("Task invariants (T1, T2)", () => {
  test("T1: assigned ⇒ hasConductor (違反検出)", () => {
    const { violations } = checkTaskInvariants("assigned", tctx({ hasConductor: false }));
    expect(violations.some((v) => v.startsWith("T1"))).toBe(true);
  });
  test("T1: assigned with hasConductor=true は違反なし", () => {
    const { violations } = checkTaskInvariants("assigned", tctx({ hasConductor: true }));
    expect(violations).toEqual([]);
  });
  test("T2: ready with parentAborted=true (違反検出)", () => {
    const { violations } = checkTaskInvariants(
      "ready",
      tctx({ hasConductor: false, parentAborted: true }),
    );
    expect(violations.some((v) => v.startsWith("T2"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Known race patterns (T232 / T255 / T277)
// -----------------------------------------------------------------------------

describe("Known race patterns", () => {
  test("T232: assigning + SESSION_STARTED(source=clear) → running (メイン経路)", () => {
    const { next } = conductorReduce(
      "assigning",
      { type: "SESSION_STARTED", source: "clear", isMasterSurface: false },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("running");
  });

  test("T255: broken + SESSION_IDLE → broken (自動復帰しない)", () => {
    const { next, actions } = conductorReduce("broken", { type: "SESSION_IDLE" }, ctx());
    expect(next).toBe("broken");
    expect(actions).toEqual([]);
  });

  test("T277: assigning + SESSION_IDLE → assigning (R1 保険撤去済み、no-op)", () => {
    const { next, actions } = conductorReduce(
      "assigning",
      { type: "SESSION_IDLE" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("assigning");
    expect(actions).toEqual([]);
  });

  test("T263: running + DONE(success=false, task=aborted) → idle (late regression guard)", () => {
    const { next } = conductorReduce(
      "running",
      { type: "DONE", success: false, unresolved: false, currentTaskStatus: "aborted" },
      ctx({ hasTaskRunId: true }),
    );
    expect(next).toBe("idle");
  });
});
