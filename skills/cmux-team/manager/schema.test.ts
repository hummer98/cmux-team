import { describe, test, expect } from "bun:test";
import {
  AGENT_ROLES,
  AgentSpawnedMessage,
  AgentTokenBoundMessage,
  ConductorRegisteredMessage,
  ConductorState,
  MasterRegisteredMessage,
  MasterStateSchema,
  NotificationMessage,
  OVERLAY_ROLES,
  OverlayRole,
  PreToolUseDeniedMessage,
  PreToolUseMessage,
  PostToolUseMessage,
  QueueMessage,
  SessionStartedMessage,
  StopFailureMessage,
  normalizeOverlayRole,
} from "./schema";

describe("NotificationMessage", () => {
  const base = {
    type: "NOTIFICATION" as const,
    surface: "surface:100",
    pid: 12345,
    timestamp: "2026-04-19T10:00:00.000Z",
  };

  test("正常系: 最小構成でパース成功", () => {
    const parsed = NotificationMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("正常系: payload 任意 JSON を受け付ける", () => {
    const parsed = NotificationMessage.safeParse({
      ...base,
      payload: { message: "Claude is waiting", notification_type: "idle_prompt" },
    });
    expect(parsed.success).toBe(true);
  });

  test("正常系: surfaceUuid / workspaceUuid 任意の文字列を受け付ける（UUID 形式制約なし）", () => {
    const parsed = NotificationMessage.safeParse({
      ...base,
      surfaceUuid: "22d8f9ab-1234-5678-9abc-def012345678",
      workspaceUuid: "any-string-value",
    });
    expect(parsed.success).toBe(true);
  });

  test("正常系: role は master/conductor/agent のいずれか", () => {
    for (const role of ["master", "conductor", "agent"] as const) {
      const parsed = NotificationMessage.safeParse({ ...base, role });
      expect(parsed.success).toBe(true);
    }
  });

  test("異常系: role enum 範囲外は reject", () => {
    const parsed = NotificationMessage.safeParse({ ...base, role: "unknown" });
    expect(parsed.success).toBe(false);
  });

  test("異常系: type が NOTIFICATION 以外は reject", () => {
    const parsed = NotificationMessage.safeParse({ ...base, type: "SESSION_STARTED" });
    expect(parsed.success).toBe(false);
  });

  test("異常系: pid 未指定は reject（Minor 5: required）", () => {
    const { pid: _pid, ...withoutPid } = base;
    const parsed = NotificationMessage.safeParse(withoutPid);
    expect(parsed.success).toBe(false);
  });

  test("異常系: surface 未指定は reject", () => {
    const { surface: _surface, ...withoutSurface } = base;
    const parsed = NotificationMessage.safeParse(withoutSurface);
    expect(parsed.success).toBe(false);
  });
});

describe("QueueMessage discriminated union", () => {
  test("NOTIFICATION は QueueMessage にも含まれる", () => {
    const parsed = QueueMessage.safeParse({
      type: "NOTIFICATION",
      surface: "surface:100",
      pid: 1234,
      timestamp: "2026-04-19T10:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  // T323: AGENT_TOKEN_BOUND（spawn-agent 経路で selectToken 成功直後に POST される第 2 メッセージ）
  test("AGENT_TOKEN_BOUND は QueueMessage にも含まれる", () => {
    const parsed = QueueMessage.safeParse({
      type: "AGENT_TOKEN_BOUND",
      surface: "surface:201",
      tokenHandle: "@kddi",
      timestamp: "2026-04-25T10:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("AgentTokenBoundMessage", () => {
  const base = {
    type: "AGENT_TOKEN_BOUND" as const,
    surface: "surface:201",
    tokenHandle: "@kddi",
    timestamp: "2026-04-25T10:00:00.000Z",
  };

  test("正常系: 必須フィールドでパース成功", () => {
    const parsed = AgentTokenBoundMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("異常系: surface 欠落は reject", () => {
    const { surface: _surface, ...withoutSurface } = base;
    const parsed = AgentTokenBoundMessage.safeParse(withoutSurface);
    expect(parsed.success).toBe(false);
  });

  test("異常系: tokenHandle 欠落は reject", () => {
    const { tokenHandle: _h, ...withoutHandle } = base;
    const parsed = AgentTokenBoundMessage.safeParse(withoutHandle);
    expect(parsed.success).toBe(false);
  });

  test("異常系: type 不一致は reject", () => {
    const parsed = AgentTokenBoundMessage.safeParse({ ...base, type: "AGENT_SPAWNED" });
    expect(parsed.success).toBe(false);
  });
});

describe("MasterStateSchema tokenHandle", () => {
  test("正常系: tokenHandle なしでパース可能（後方互換）", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "idle",
      startedAt: "2026-04-25T09:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  test("正常系: tokenHandle ありでパース可能", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "running",
      startedAt: "2026-04-25T09:00:00.000Z",
      tokenHandle: "@pers",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tokenHandle).toBe("@pers");
    }
  });
});

describe("ConductorState tokenHandle", () => {
  test("正常系: tokenHandle なしでパース可能（後方互換）", () => {
    const parsed = ConductorState.safeParse({
      surface: "surface:123",
      startedAt: "2026-04-25T09:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  test("正常系: tokenHandle ありでパース可能", () => {
    const parsed = ConductorState.safeParse({
      surface: "surface:123",
      startedAt: "2026-04-25T09:00:00.000Z",
      tokenHandle: "@kddi",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tokenHandle).toBe("@kddi");
    }
  });
});

// --- T342: OverlayRole ---

describe("OverlayRole / OVERLAY_ROLES (T342)", () => {
  test("OVERLAY_ROLES contains all AGENT_ROLES + master + conductor", () => {
    for (const r of AGENT_ROLES) {
      expect(OVERLAY_ROLES).toContain(r);
    }
    expect(OVERLAY_ROLES).toContain("master");
    expect(OVERLAY_ROLES).toContain("conductor");
  });

  test("OVERLAY_ROLES.length === AGENT_ROLES.length + 2", () => {
    expect(OVERLAY_ROLES.length).toBe(AGENT_ROLES.length + 2);
  });

  test("OverlayRole.options preserves AgentRole order then appends master, conductor", () => {
    expect(OverlayRole.options[OverlayRole.options.length - 2]).toBe("master");
    expect(OverlayRole.options[OverlayRole.options.length - 1]).toBe("conductor");
  });
});

// --- T392: StopFailureMessage ---

describe("StopFailureMessage (T392)", () => {
  const base = {
    type: "STOP_FAILURE" as const,
    surface: "surface:100",
    pid: 12345,
    payload: { error: "rate_limit" },
    timestamp: "2026-04-30T10:00:00.000Z",
  };

  test("正常系: 最小構成でパース成功", () => {
    const parsed = StopFailureMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("正常系: payload に session_id / transcript_path / last_assistant_message を含めても OK", () => {
    const parsed = StopFailureMessage.safeParse({
      ...base,
      payload: {
        error: "server_error",
        session_id: "fake-uuid",
        transcript_path: "/tmp/t.jsonl",
        last_assistant_message: "API Error: ...",
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("正常系: role は master/conductor/agent のいずれか", () => {
    for (const role of ["master", "conductor", "agent"] as const) {
      const parsed = StopFailureMessage.safeParse({ ...base, role });
      expect(parsed.success).toBe(true);
    }
  });

  test("異常系: pid 未指定は reject (required 契約)", () => {
    const { pid: _pid, ...withoutPid } = base;
    const parsed = StopFailureMessage.safeParse(withoutPid);
    expect(parsed.success).toBe(false);
  });

  test("異常系: payload.error 欠落は reject", () => {
    const parsed = StopFailureMessage.safeParse({ ...base, payload: {} });
    expect(parsed.success).toBe(false);
  });

  test("異常系: surface 未指定は reject", () => {
    const { surface: _surface, ...withoutSurface } = base;
    const parsed = StopFailureMessage.safeParse(withoutSurface);
    expect(parsed.success).toBe(false);
  });

  test("QueueMessage 経由でも parse 可能", () => {
    const parsed = QueueMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });
});

describe("AgentState (T392) lastApiError + status='error'", () => {
  test("型定義レベル: AgentState の status は 'error' を許容、lastApiError optional", () => {
    // この test は実質コンパイルチェック。型が合っていれば通る
    const a: import("./schema").AgentState = {
      surface: "surface:5",
      spawnedAt: "2026-04-30T10:00:00.000Z",
      status: "error",
      lastApiError: {
        kind: "rate_limit",
        message: "API Error: ...",
        at: "2026-04-30T10:00:00.000Z",
      },
    };
    expect(a.status).toBe("error");
    expect(a.lastApiError?.kind).toBe("rate_limit");
  });
});

describe("MasterState (T392) lastApiError + status='error'", () => {
  test("正常系: status='error' + lastApiError でパース成功", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "error",
      startedAt: "2026-04-30T10:00:00.000Z",
      lastApiError: {
        kind: "billing_error",
        message: "credit balance is too low",
        at: "2026-04-30T10:00:00.000Z",
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("正常系: lastApiError なしでも従来通り parse できる", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "idle",
      startedAt: "2026-04-30T10:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ConductorState (T392) lastApiError", () => {
  test("正常系: lastApiError でパース成功", () => {
    const parsed = ConductorState.safeParse({
      surface: "surface:200",
      startedAt: "2026-04-30T10:00:00.000Z",
      lastApiError: {
        kind: "authentication_failed",
        at: "2026-04-30T10:00:00.000Z",
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("normalizeOverlayRole (T342)", () => {
  test("master → master", () => {
    expect(normalizeOverlayRole("master")).toBe("master");
  });

  test("conductor → conductor", () => {
    expect(normalizeOverlayRole("conductor")).toBe("conductor");
  });

  test("AgentRole alias inheritance: impl → implementer", () => {
    expect(normalizeOverlayRole("impl")).toBe("implementer");
  });

  test("AgentRole alias inheritance: reviewer → design-reviewer", () => {
    expect(normalizeOverlayRole("reviewer")).toBe("design-reviewer");
  });

  test("canonical agent role passes through", () => {
    expect(normalizeOverlayRole("planner")).toBe("planner");
    expect(normalizeOverlayRole("implementer")).toBe("implementer");
  });

  test("unknown role → undefined", () => {
    expect(normalizeOverlayRole("foobar")).toBeUndefined();
  });
});

// --- T379: PreToolUse / PostToolUse / PreToolUseDenied ---

describe("PreToolUseMessage (T379)", () => {
  const base = {
    type: "PRE_TOOL_USE" as const,
    surface: "surface:100",
    pid: 1234,
    role: "agent" as const,
    sessionId: "sess-123",
    toolName: "Edit",
    payload: { tool_input: { file_path: "/tmp/x.ts" } },
    timestamp: "2026-04-29T10:00:00.000Z",
  };

  test("正常系: 必須フィールドでパース成功", () => {
    const parsed = PreToolUseMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("正常系: sessionId は optional", () => {
    const { sessionId: _s, ...rest } = base;
    const parsed = PreToolUseMessage.safeParse(rest);
    expect(parsed.success).toBe(true);
  });

  test("正常系: role は master/conductor/agent のいずれか", () => {
    for (const role of ["master", "conductor", "agent"] as const) {
      const parsed = PreToolUseMessage.safeParse({ ...base, role });
      expect(parsed.success).toBe(true);
    }
  });

  test("異常系: toolName 欠落は reject", () => {
    const { toolName: _t, ...rest } = base;
    const parsed = PreToolUseMessage.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  test("異常系: pid 欠落は reject", () => {
    const { pid: _p, ...rest } = base;
    const parsed = PreToolUseMessage.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  test("異常系: type 不一致は reject", () => {
    const parsed = PreToolUseMessage.safeParse({ ...base, type: "POST_TOOL_USE" });
    expect(parsed.success).toBe(false);
  });
});

describe("PostToolUseMessage (T379)", () => {
  const base = {
    type: "POST_TOOL_USE" as const,
    surface: "surface:100",
    pid: 1234,
    role: "agent" as const,
    sessionId: "sess-123",
    toolName: "Edit",
    payload: {
      tool_input: { file_path: "/tmp/x.ts" },
      tool_response: { success: true },
    },
    timestamp: "2026-04-29T10:00:01.000Z",
  };

  test("正常系: 必須フィールドでパース成功", () => {
    const parsed = PostToolUseMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("異常系: toolName 欠落は reject", () => {
    const { toolName: _t, ...rest } = base;
    const parsed = PostToolUseMessage.safeParse(rest);
    expect(parsed.success).toBe(false);
  });
});

describe("PreToolUseDeniedMessage (T379)", () => {
  const base = {
    type: "PRE_TOOL_USE_DENIED" as const,
    surface: "surface:100",
    pid: 1234,
    role: "conductor" as const,
    reason: "cmux send/send-key denied",
    timestamp: "2026-04-29T10:00:02.000Z",
  };

  test("正常系: 必須フィールドでパース成功", () => {
    const parsed = PreToolUseDeniedMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("正常系: reason は optional", () => {
    const { reason: _r, ...rest } = base;
    const parsed = PreToolUseDeniedMessage.safeParse(rest);
    expect(parsed.success).toBe(true);
  });

  test("異常系: type 不一致は reject", () => {
    const parsed = PreToolUseDeniedMessage.safeParse({ ...base, type: "PRE_TOOL_USE" });
    expect(parsed.success).toBe(false);
  });
});

describe("QueueMessage T379 messages are included", () => {
  test("PRE_TOOL_USE は QueueMessage にも含まれる", () => {
    const parsed = QueueMessage.safeParse({
      type: "PRE_TOOL_USE",
      surface: "surface:100",
      pid: 1234,
      role: "agent",
      sessionId: "sess-1",
      toolName: "Read",
      payload: {},
      timestamp: "2026-04-29T10:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  test("POST_TOOL_USE は QueueMessage にも含まれる", () => {
    const parsed = QueueMessage.safeParse({
      type: "POST_TOOL_USE",
      surface: "surface:100",
      pid: 1234,
      role: "agent",
      sessionId: "sess-1",
      toolName: "Read",
      payload: {},
      timestamp: "2026-04-29T10:00:01.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  test("PRE_TOOL_USE_DENIED は QueueMessage にも含まれる", () => {
    const parsed = QueueMessage.safeParse({
      type: "PRE_TOOL_USE_DENIED",
      surface: "surface:100",
      pid: 1234,
      role: "conductor",
      reason: "denied",
      timestamp: "2026-04-29T10:00:02.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});

// --- T407: ConductorRegisteredMessage / AgentSpawnedMessage の sessionId 同梱 ---

describe("ConductorRegisteredMessage sessionId (T407)", () => {
  const base = {
    type: "CONDUCTOR_REGISTERED" as const,
    surface: "surface:200",
    timestamp: "2026-05-01T10:00:00.000Z",
  };

  test("正常系: sessionId なしで parse 可能（後方互換）", () => {
    const parsed = ConductorRegisteredMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("正常系: sessionId 付きで parse 可能（pre-inject UUID）", () => {
    const parsed = ConductorRegisteredMessage.safeParse({
      ...base,
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe("11111111-2222-4333-8444-555555555555");
    }
  });

  test("異常系: sessionId が string でない場合は reject", () => {
    const parsed = ConductorRegisteredMessage.safeParse({
      ...base,
      sessionId: 123,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("AgentSpawnedMessage sessionId (T407)", () => {
  const base = {
    type: "AGENT_SPAWNED" as const,
    conductorSurface: "surface:200",
    surface: "surface:300",
    timestamp: "2026-05-01T10:00:00.000Z",
  };

  test("正常系: sessionId なしで parse 可能（後方互換）", () => {
    const parsed = AgentSpawnedMessage.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("正常系: sessionId 付きで parse 可能（pre-inject UUID）", () => {
    const parsed = AgentSpawnedMessage.safeParse({
      ...base,
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    }
  });

  test("異常系: sessionId が string でない場合は reject", () => {
    const parsed = AgentSpawnedMessage.safeParse({
      ...base,
      sessionId: false,
    });
    expect(parsed.success).toBe(false);
  });
});

// --- T408: MasterRegisteredMessage の sessionId 同梱 ---

describe("MasterRegisteredMessage sessionId (T408)", () => {
  const base = {
    type: "MASTER_REGISTERED" as const,
    surface: "surface:100",
    timestamp: "2026-05-01T10:00:00.000Z",
  };

  test("正常系: sessionId なしで parse 可能（後方互換 / 旧バージョン互換）", () => {
    const parsed = MasterRegisteredMessage.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBeUndefined();
    }
  });

  test("正常系: sessionId 付きで parse 可能（pre-inject UUID）", () => {
    const parsed = MasterRegisteredMessage.safeParse({
      ...base,
      sessionId: "cccccccc-dddd-4eee-8fff-000000000001",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe("cccccccc-dddd-4eee-8fff-000000000001");
    }
  });

  test("異常系: sessionId が string でない場合は reject", () => {
    const parsed = MasterRegisteredMessage.safeParse({
      ...base,
      sessionId: 42,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("MasterStateSchema sessionId (T408)", () => {
  test("正常系: sessionId なしでパース可能（後方互換）", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "idle",
      startedAt: "2026-05-01T09:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBeUndefined();
    }
  });

  test("正常系: sessionId ありでパース可能（pre-inject UUID 永続化）", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "running",
      startedAt: "2026-05-01T09:00:00.000Z",
      sessionId: "cccccccc-dddd-4eee-8fff-000000000002",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe("cccccccc-dddd-4eee-8fff-000000000002");
    }
  });

  test("異常系: sessionId が string でない場合は reject", () => {
    const parsed = MasterStateSchema.safeParse({
      surface: "surface:100",
      status: "idle",
      startedAt: "2026-05-01T09:00:00.000Z",
      sessionId: 0,
    });
    expect(parsed.success).toBe(false);
  });
});

// T410: SessionStartedMessage に loadedPlugins / loadedSkills (nullable optional) が追加された。
//       cohort 比較用 marker。null = unknown (取得失敗)、[] = empty (loaded 0 件)、配列 = loaded。
describe("SessionStartedMessage loadedPlugins / loadedSkills (T410)", () => {
  const base = {
    type: "SESSION_STARTED" as const,
    surface: "surface:100",
    pid: 12345,
    timestamp: "2026-05-01T10:00:00.000Z",
  };

  test("正常系: loadedPlugins / loadedSkills なしで parse 可能（後方互換 / 旧クライアント互換）", () => {
    const parsed = SessionStartedMessage.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadedPlugins).toBeUndefined();
      expect(parsed.data.loadedSkills).toBeUndefined();
    }
  });

  test("正常系: loadedPlugins / loadedSkills が null で parse 可能（取得失敗の unknown 表現）", () => {
    const parsed = SessionStartedMessage.safeParse({
      ...base,
      loadedPlugins: null,
      loadedSkills: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadedPlugins).toBeNull();
      expect(parsed.data.loadedSkills).toBeNull();
    }
  });

  test("正常系: loadedPlugins / loadedSkills が string array で parse 可能", () => {
    const parsed = SessionStartedMessage.safeParse({
      ...base,
      loadedPlugins: ["cmux-team@hummer98-cmux-team", "code-review@claude-plugins-official"],
      loadedSkills: ["plugin:cmux-team", "user:nano-banana", "project:foo"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadedPlugins).toEqual([
        "cmux-team@hummer98-cmux-team",
        "code-review@claude-plugins-official",
      ]);
      expect(parsed.data.loadedSkills).toEqual([
        "plugin:cmux-team",
        "user:nano-banana",
        "project:foo",
      ]);
    }
  });

  test("正常系: loadedPlugins / loadedSkills が空配列 (loaded 0 件) で parse 可能", () => {
    const parsed = SessionStartedMessage.safeParse({
      ...base,
      loadedPlugins: [],
      loadedSkills: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadedPlugins).toEqual([]);
      expect(parsed.data.loadedSkills).toEqual([]);
    }
  });

  test("異常系: loadedPlugins の要素に number が含まれると reject", () => {
    const parsed = SessionStartedMessage.safeParse({
      ...base,
      loadedPlugins: ["valid", 123],
    });
    expect(parsed.success).toBe(false);
  });

  test("異常系: loadedSkills の要素に number が含まれると reject", () => {
    const parsed = SessionStartedMessage.safeParse({
      ...base,
      loadedSkills: [42],
    });
    expect(parsed.success).toBe(false);
  });
});
