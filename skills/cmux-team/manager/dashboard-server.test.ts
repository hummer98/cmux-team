/**
 * T414: dashboard-server.ts のユニットテスト。
 *
 * Step 1: /api/health の routing / response shape / 127.0.0.1 listen / CSP header。
 * 後続 Step でこのファイルに endpoint テストを追加する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startDashboardServer,
  parsePeriodQuery,
  type DashboardServerHandle,
} from "./dashboard-server";
import { createDummyProject, type DummyProject } from "./test-project";

describe("dashboard-server: Step 1 /api/health", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-server-",
      subdirs: ["logs", "traces"],
    });
    handle = await startDashboardServer({
      projectRoot: project.root,
      version: "test-1.0.0",
      getState: () => ({ proxyPort: 4242 }),
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("/api/health は 200 + HealthResponse shape を返す", async () => {
    const res = await fetch(`${handle.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.version).toBe("test-1.0.0");
    expect(body.projectRoot).toBe(project.root);
    expect(body.serverPort).toBe(handle.port);
    expect(body.proxyPort).toBe(4242);
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.uptimeSec).toBe("number");
  });

  test("response header に CSP 4 directive を含む", async () => {
    const res = await fetch(`${handle.url}/api/health`);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  test("Cache-Control: no-store が付与される", async () => {
    const res = await fetch(`${handle.url}/api/health`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("不明な endpoint は 404 + error: not_found", async () => {
    const res = await fetch(`${handle.url}/api/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("not_found");
  });

  test("getState 未提供時の /api/health は proxyPort=null", async () => {
    handle.stop();
    handle = await startDashboardServer({
      projectRoot: project.root,
      version: "x",
    });
    const res = await fetch(`${handle.url}/api/health`);
    const body = (await res.json()) as any;
    expect(body.proxyPort).toBeNull();
  });
});

describe("dashboard-server: 127.0.0.1 listen のみ受け付ける", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-listen-",
      subdirs: ["logs", "traces"],
    });
    handle = await startDashboardServer({
      projectRoot: project.root,
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("127.0.0.1 では fetch 成功", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    expect(res.status).toBe(200);
  });

  test("URL は 127.0.0.1 で公開される（外部 interface には bind しない）", () => {
    // Bun.serve({ hostname: "127.0.0.1" }) を確実に通すための smoke test。
    // 厳密な「他 interface bind 不可」検証は OS 依存（macOS では 0.0.0.0 fetch が
    // 127.0.0.1 へ routing される）のため、URL string で代替検証する。plan §8.2 の
    // 「環境差吸収のため try/skip 可」条項に沿う。
    expect(handle.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

describe("dashboard-server: parsePeriodQuery", () => {
  const fixedNow = Date.parse("2026-05-02T12:00:00.000Z");
  const now = () => fixedNow;

  test("from / to 未指定 → 24h window", () => {
    const url = new URL("http://x/api/overview");
    const p = parsePeriodQuery(url, now);
    expect(p.toIso).toBe("2026-05-02T12:00:00.000Z");
    expect(p.fromIso).toBe("2026-05-01T12:00:00.000Z");
  });

  test("from / to 指定 → そのまま使う", () => {
    const url = new URL(
      "http://x/api/overview?from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z",
    );
    const p = parsePeriodQuery(url, now);
    expect(p.fromIso).toBe("2026-05-01T00:00:00.000Z");
    expect(p.toIso).toBe("2026-05-02T00:00:00.000Z");
  });

  test("from が ISO 8601 として parse 不能 → throw", () => {
    const url = new URL("http://x/api/overview?from=NOT_ISO");
    expect(() => parsePeriodQuery(url, now)).toThrow();
  });

  test("from > to → throw", () => {
    const url = new URL(
      "http://x/api/overview?from=2026-05-02T00:00:00Z&to=2026-05-01T00:00:00Z",
    );
    expect(() => parsePeriodQuery(url, now)).toThrow();
  });
});
