import { describe, test, expect } from "bun:test";
import {
  AgentTokenBoundMessage,
  ConductorState,
  MasterStateSchema,
  NotificationMessage,
  QueueMessage,
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
