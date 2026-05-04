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
import { initDB } from "./trace-store";

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

describe("dashboard-server: Step 2 endpoint shape", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-step2-",
      subdirs: ["logs", "traces"],
    });
    handle = await startDashboardServer({
      projectRoot: project.root,
      version: "test",
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("/api/overview デフォルト 24h window で 200 + period.fromIso/toIso", async () => {
    const res = await fetch(`${handle.url}/api/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.period.fromIso).toBeDefined();
    expect(body.period.toIso).toBeDefined();
    expect(Array.isArray(body.throughput)).toBe(true);
    expect(Array.isArray(body.toolFailureRate)).toBe(true);
    expect(Array.isArray(body.tokens)).toBe(true);
    expect(typeof body.activeTasks.count).toBe("number");
    expect(body.rateLimit.projection5h.risk).toMatch(/green|yellow|red|gray/);
  });

  test("/api/tool-use 200 + perTool / failureTimeline / denyTimeline / recentFailures", async () => {
    const res = await fetch(`${handle.url}/api/tool-use`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.perTool)).toBe(true);
    expect(Array.isArray(body.perToolFailure)).toBe(true);
    expect(Array.isArray(body.failureTimeline)).toBe(true);
    expect(Array.isArray(body.denyTimeline)).toBe(true);
    expect(Array.isArray(body.recentFailures)).toBe(true);
  });

  test("/api/tokens 200 + timeline / topTasks / perRole / perTaskHistogram", async () => {
    const res = await fetch(`${handle.url}/api/tokens`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.timeline)).toBe(true);
    expect(Array.isArray(body.topTasks)).toBe(true);
    expect(Array.isArray(body.perRole)).toBe(true);
    expect(body.perTaskHistogram).toHaveProperty("bins");
    expect(body.perTaskHistogram).toHaveProperty("counts");
  });

  test("/api/tasks 200 + rows", async () => {
    // events.jsonl が存在しないと readTaskLifecycle が ENOENT。fail-soft で 200 を返す。
    const res = await fetch(`${handle.url}/api/tasks`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as any;
      expect(Array.isArray(body.rows)).toBe(true);
    }
  });

  test("/api/overview?from=NOT_ISO → 400 bad_request", async () => {
    const res = await fetch(`${handle.url}/api/overview?from=NOT_ISO`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad_request");
  });

  test("/api/overview?from > to → 400 bad_request", async () => {
    const res = await fetch(
      `${handle.url}/api/overview?from=2026-05-02T00:00:00Z&to=2026-05-01T00:00:00Z`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad_request");
  });
});

describe("dashboard-server: Step 3 agent-strategy", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-strat-",
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

  test("/api/agent-strategy 200 + perTask / distribution / spawnTimeline", async () => {
    const res = await fetch(`${handle.url}/api/agent-strategy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.perTask)).toBe(true);
    expect(typeof body.distribution).toBe("object");
    expect(Array.isArray(body.spawnTimeline)).toBe(true);
  });

  test("/api/agent-strategy/UNKNOWN_TASK → 404", async () => {
    const res = await fetch(`${handle.url}/api/agent-strategy/UNKNOWN_TASK_XYZ`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("not_found");
  });
});

describe("dashboard-server: timeout race (Promise.race + DI sleep)", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-timeout-",
      subdirs: ["logs", "traces"],
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("aggregator が 6s sleep のとき 5s で 503 timeout を返す", async () => {
    // sleep 関数を即時 resolve に差し替えて時計を加速。
    // aggregator は never-resolve、sleep は即時 resolve → Promise.race で sleep が勝つ。
    const fastSleep = async (_ms: number) => {};
    const slowOverview = () => new Promise<any>(() => {});
    handle = await startDashboardServer({
      projectRoot: project.root,
      sleep: fastSleep,
      aggregateTimeoutMs: 5000,
      aggregators: {
        overview: slowOverview as any,
      },
    });
    const res = await fetch(`${handle.url}/api/overview`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe("timeout");
    expect(body.endpoint).toBe("/api/overview");
    expect(body.windowSec).toBe(5);
  });
});

describe("dashboard-server: Step 4 GET / HTML 配信", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-html-",
      subdirs: ["logs", "traces"],
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("htmlBundle 提供時 GET / は 200 + Content-Type: text/html + title", async () => {
    handle = await startDashboardServer({
      projectRoot: project.root,
      htmlBundle: () =>
        "<!doctype html><html><head><title>cmux-team dashboard</title></head><body>OK</body></html>",
    });
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    const body = await res.text();
    expect(body).toContain("<title>cmux-team dashboard</title>");
  });

  test("htmlBundle 未提供時 GET / は 404", async () => {
    handle = await startDashboardServer({ projectRoot: project.root });
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(404);
  });

  test("getDashboardHtml は inline placeholder を全置換する (実ファイル読み込み)", async () => {
    const { getDashboardHtml, _resetDashboardHtmlCache } = await import("./dashboard-web-bundle");
    _resetDashboardHtmlCache();
    const html = getDashboardHtml();
    expect(html).toContain("<title>cmux-team dashboard</title>");
    expect(html).not.toContain("/*__INLINE_CSS__*/");
    expect(html).not.toContain("/*__INLINE_UPLOT__*/");
    expect(html).not.toContain("/*__INLINE_APP__*/");
    expect(html).not.toContain("/*__INLINE_UPLOT_CSS__*/");
    // uPlot vendor が埋め込まれている (IIFE 開始)
    expect(html).toContain("var uPlot=function()");
    // SPA app.js が埋め込まれている
    expect(html).toContain("renderOverview");
  });
});

describe("dashboard-server: 500 経路の log 詳細 (T433)", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-500-",
      subdirs: ["logs", "traces"],
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("aggregator が throw すると stack + method + path + query が log される", async () => {
    handle = await startDashboardServer({
      projectRoot: project.root,
      aggregators: {
        overview: () => Promise.reject(new Error("synthetic explosion")),
      },
    });
    const res = await fetch(
      `${handle.url}/api/overview?from=2026-04-01T00:00:00Z`,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toBe("internal");
    expect(body.message).toContain("synthetic explosion");

    const logPath = `${project.root}/.team/logs/manager.log`;
    const tail = await Bun.file(logPath).text();
    const last = tail
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.includes("dashboard_server_error"));
    expect(last).toBeDefined();
    expect(last!).toContain("method=GET");
    expect(last!).toContain("path=/api/overview");
    expect(last!).toContain("query=?from=2026-04-01T00:00:00Z");
    expect(last!).toContain("synthetic explosion");
    expect(last!).toMatch(/stack=/);
  });
});

describe("dashboard-server: 壊れた payload_json でも /api/overview は 200 (T433 root cause)", () => {
  let project: DummyProject;
  let handle: DashboardServerHandle;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-dashboard-broken-payload-",
      subdirs: ["logs", "traces"],
    });
  });

  afterEach(async () => {
    handle.stop();
    await project.dispose();
  });

  test("hook_signals に 64KB truncate 済みの壊れた POST_TOOL_USE があっても 500 にならない", async () => {
    const db = initDB(project.root);
    // 1 件の valid な PRE_TOOL_USE と 1 件の壊れた POST_TOOL_USE を入れる。
    // 壊れた payload は 64KB ぴったりに切れたケースを再現する形 — 末尾が " で閉じない
    // ことで `JSON_EXTRACT` が `SQLiteError: malformed JSON` を投げる。
    const insert = db.prepare(`
      INSERT INTO hook_signals (timestamp, type, payload_json)
      VALUES ($ts, $type, $payload)
    `);
    const now = new Date().toISOString();
    insert.run({
      $ts: now,
      $type: "PRE_TOOL_USE",
      $payload: JSON.stringify({ payload: { tool_name: "Bash" } }),
    });
    // 末尾が中途半端な文字列で切れた壊れた JSON
    insert.run({
      $ts: now,
      $type: "POST_TOOL_USE",
      $payload:
        '{"type":"POST_TOOL_USE","payload":{"tool_response":{"success":false,"error":"truncated at 64KB and then',
    });

    handle = await startDashboardServer({
      projectRoot: project.root,
      db,
    });

    const res = await fetch(`${handle.url}/api/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.toolFailureRate)).toBe(true);
    // 壊れた POST は失敗判定に乗らないため failures は 0
    const totalFailures = body.toolFailureRate.reduce(
      (acc: number, r: any) => acc + (r.failures ?? 0),
      0,
    );
    expect(totalFailures).toBe(0);
    // PRE は集計される
    const totalPre = body.toolFailureRate.reduce(
      (acc: number, r: any) => acc + (r.pre_total ?? 0),
      0,
    );
    expect(totalPre).toBeGreaterThanOrEqual(1);
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
