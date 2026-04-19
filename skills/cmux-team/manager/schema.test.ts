import { describe, test, expect } from "bun:test";
import { NotificationMessage, QueueMessage } from "./schema";

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
});
