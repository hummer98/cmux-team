/**
 * T392: Master セクションの error 表示 + 既存挙動の回帰テスト。
 *
 * - dashboard.tsx の `buildMasterSection` を直接呼び、
 *   running / idle / disconnected / error の各 status を確認する。
 * - JSON.stringify した output 文字列に対して toContain で要素検証する。
 */
import { describe, test, expect } from "bun:test";
import { buildMasterSection } from "./dashboard";
import type { DaemonState } from "./daemon";
import type { MasterState } from "./schema";
import { rgb } from "@rezi-ui/core";

const RED_VALUE = rgb(180, 40, 40);
const YELLOW_VALUE = rgb(200, 160, 0);
const GREEN_VALUE = rgb(0, 160, 0);

function makeStateWithMaster(master: MasterState): DaemonState {
  const masters = new Map<string, MasterState>();
  masters.set(master.surface, master);
  return { masters } as unknown as DaemonState;
}

function countFg(json: string, value: number): number {
  const needle = `"fg":${value}`;
  let count = 0;
  let idx = 0;
  while ((idx = json.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

describe("buildMasterSection: idle / running / disconnected (回帰)", () => {
  test("idle: ● + GREEN + surface ラベル", () => {
    const m: MasterState = {
      surface: "surface:100",
      status: "idle",
      startedAt: new Date().toISOString(),
    };
    const node = buildMasterSection(makeStateWithMaster(m));
    const json = JSON.stringify(node);
    expect(json).toContain("●");
    expect(json).toContain("[100]");
    expect(countFg(json, GREEN_VALUE)).toBeGreaterThanOrEqual(1);
  });

  test("running: spinner + YELLOW + prompt があれば dim で表示", () => {
    const m: MasterState = {
      surface: "surface:100",
      status: "running",
      startedAt: new Date().toISOString(),
      prompt: "writing code",
    };
    const node = buildMasterSection(makeStateWithMaster(m));
    const json = JSON.stringify(node);
    expect(json).toContain("[100]");
    expect(json).toContain("writing code");
    expect(countFg(json, YELLOW_VALUE)).toBeGreaterThanOrEqual(1);
  });

  test("disconnected: ⚠ + YELLOW + 'disconnected' ラベル", () => {
    const m: MasterState = {
      surface: "surface:100",
      status: "disconnected",
      startedAt: new Date().toISOString(),
    };
    const node = buildMasterSection(makeStateWithMaster(m));
    const json = JSON.stringify(node);
    expect(json).toContain("⚠");
    expect(json).toContain("disconnected");
    expect(countFg(json, YELLOW_VALUE)).toBeGreaterThanOrEqual(2);
  });
});

describe("buildMasterSection: error 表示 (T392)", () => {
  test("status='error' + kind=rate_limit で ⏳ + RED + truncated message", () => {
    const m: MasterState = {
      surface: "surface:100",
      status: "error",
      startedAt: new Date().toISOString(),
      lastApiError: {
        kind: "rate_limit",
        message: "API Error: Server is temporarily limiting requests",
        at: "2026-04-30T12:00:00.000Z",
      },
    };
    const node = buildMasterSection(makeStateWithMaster(m));
    const json = JSON.stringify(node);
    expect(json).toContain("⏳");
    expect(json).toContain("[100]");
    expect(json).toContain("API Error: Server is temporarily limiting requests");
    expect(countFg(json, RED_VALUE)).toBeGreaterThanOrEqual(1);
  });

  test("status='error' + 未知 kind で ⚠ fallback", () => {
    const m: MasterState = {
      surface: "surface:100",
      status: "error",
      startedAt: new Date().toISOString(),
      lastApiError: { kind: "unknown_future_kind", at: "2026-04-30T12:00:00.000Z" },
    };
    const node = buildMasterSection(makeStateWithMaster(m));
    const json = JSON.stringify(node);
    expect(json).toContain("⚠");
    expect(countFg(json, RED_VALUE)).toBeGreaterThanOrEqual(1);
  });

  test("80 字超 message は 77+'...' に truncate される", () => {
    const long = "x".repeat(120);
    const m: MasterState = {
      surface: "surface:100",
      status: "error",
      startedAt: new Date().toISOString(),
      lastApiError: { kind: "rate_limit", message: long, at: "2026-04-30T12:00:00.000Z" },
    };
    const node = buildMasterSection(makeStateWithMaster(m));
    const json = JSON.stringify(node);
    const truncated = "x".repeat(77) + "...";
    expect(json).toContain(truncated);
    expect(json.includes("x".repeat(120))).toBe(false);
  });
});
