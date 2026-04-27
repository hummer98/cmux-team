/**
 * T354 (F5): proxy.ts が `extractRateLimit` 直後に rate_limit_snapshots へ
 * 1 リクエスト 1 行 INSERT することを検証する smoke test。
 *
 * proxy 起動 → upstream モックに対して 1 リクエストを送る → DB の行数 = 1 を確認。
 * streaming レスポンスと非 streaming レスポンスの両方をカバーする。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { start as startProxy } from "./proxy";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  unified_5h_utilization REAL,
  unified_5h_reset TEXT,
  unified_7d_utilization REAL,
  unified_7d_reset TEXT
);
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT,
  role TEXT,
  surface TEXT,
  conductor_id TEXT,
  model TEXT,
  request_id TEXT,
  status_code INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  stop_reason TEXT,
  duration_ms INTEGER,
  ratelimit_tokens_remaining INTEGER,
  ratelimit_tokens_limit INTEGER,
  ratelimit_tokens_reset TEXT,
  ratelimit_input_tokens_remaining INTEGER,
  ratelimit_input_tokens_limit INTEGER,
  ratelimit_input_tokens_reset TEXT,
  ratelimit_output_tokens_remaining INTEGER,
  ratelimit_output_tokens_limit INTEGER,
  ratelimit_output_tokens_reset TEXT,
  ratelimit_requests_remaining INTEGER,
  ratelimit_requests_limit INTEGER,
  ratelimit_requests_reset TEXT,
  error TEXT
);
`;

const FIVE_HOURS_LATER = String(Math.floor(Date.now() / 1000) + 5 * 3600);

function setupUpstream(opts: {
  streaming: boolean;
  hasUtilization: boolean;
}): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch: (req: Request) => {
      const headers = new Headers({ "anthropic-organization-id": "org-1234" });
      if (opts.hasUtilization) {
        headers.set("anthropic-ratelimit-unified-5h-utilization", "0.42");
        headers.set("anthropic-ratelimit-unified-5h-reset", FIVE_HOURS_LATER);
        headers.set("anthropic-ratelimit-unified-7d-utilization", "0.10");
        headers.set("anthropic-ratelimit-unified-7d-reset", FIVE_HOURS_LATER);
      }
      if (opts.streaming) {
        headers.set("content-type", "text/event-stream");
        const body =
          'event: message_start\ndata: {"message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5}}}\n\n' +
          'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n' +
          "event: message_stop\ndata: {}\n\n";
        return new Response(body, { status: 200, headers });
      }
      headers.set("content-type", "application/json");
      return new Response(
        JSON.stringify({
          id: "msg_1",
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers },
      );
    },
  });
  return { server, url: `http://localhost:${server.port}` };
}

describe("proxy → rate_limit_snapshots INSERT (T354 F5)", () => {
  let projectRoot: string;
  let db: Database;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "cmux-proxy-snapshot-"));
    db = new Database(":memory:");
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("非 streaming レスポンス + utilization あり → 1 行 INSERT", async () => {
    const upstream = setupUpstream({ streaming: false, hasUtilization: true });
    const origUpstreamUrl = process.env.ANTHROPIC_API_URL;
    process.env.ANTHROPIC_API_URL = upstream.url;
    try {
      const proxy = await startProxy(projectRoot, { db });
      try {
        const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-cmux-role": "agent" },
          body: JSON.stringify({ model: "claude-sonnet-4-5" }),
        });
        await res.text();
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM rate_limit_snapshots")
          .get() as { c: number };
        expect(row.c).toBe(1);
        const snap = db
          .prepare(
            "SELECT unified_5h_utilization AS u5, unified_7d_utilization AS u7 FROM rate_limit_snapshots LIMIT 1",
          )
          .get() as { u5: number; u7: number };
        expect(snap.u5).toBeCloseTo(0.42, 5);
        expect(snap.u7).toBeCloseTo(0.1, 5);
      } finally {
        proxy.stop();
      }
    } finally {
      if (origUpstreamUrl === undefined) {
        delete process.env.ANTHROPIC_API_URL;
      } else {
        process.env.ANTHROPIC_API_URL = origUpstreamUrl;
      }
      upstream.server.stop();
    }
  });

  test("streaming レスポンス + utilization あり → 1 行 INSERT", async () => {
    const upstream = setupUpstream({ streaming: true, hasUtilization: true });
    const origUpstreamUrl = process.env.ANTHROPIC_API_URL;
    process.env.ANTHROPIC_API_URL = upstream.url;
    try {
      const proxy = await startProxy(projectRoot, { db });
      try {
        const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-cmux-role": "agent" },
          body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true }),
        });
        // SSE は drain されるまで待つ
        await res.text();
        // stream の drain が非同期なので少し待つ
        await new Promise((r) => setTimeout(r, 100));
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM rate_limit_snapshots")
          .get() as { c: number };
        expect(row.c).toBe(1);
      } finally {
        proxy.stop();
      }
    } finally {
      if (origUpstreamUrl === undefined) {
        delete process.env.ANTHROPIC_API_URL;
      } else {
        process.env.ANTHROPIC_API_URL = origUpstreamUrl;
      }
      upstream.server.stop();
    }
  });

  test("utilization 両方 null のレスポンス → INSERT しない", async () => {
    const upstream = setupUpstream({ streaming: false, hasUtilization: false });
    const origUpstreamUrl = process.env.ANTHROPIC_API_URL;
    process.env.ANTHROPIC_API_URL = upstream.url;
    try {
      const proxy = await startProxy(projectRoot, { db });
      try {
        const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-5" }),
        });
        await res.text();
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM rate_limit_snapshots")
          .get() as { c: number };
        expect(row.c).toBe(0);
      } finally {
        proxy.stop();
      }
    } finally {
      if (origUpstreamUrl === undefined) {
        delete process.env.ANTHROPIC_API_URL;
      } else {
        process.env.ANTHROPIC_API_URL = origUpstreamUrl;
      }
      upstream.server.stop();
    }
  });

  test("opts.db 未指定 → INSERT skip（既存テスト互換）", async () => {
    const upstream = setupUpstream({ streaming: false, hasUtilization: true });
    const origUpstreamUrl = process.env.ANTHROPIC_API_URL;
    process.env.ANTHROPIC_API_URL = upstream.url;
    try {
      const proxy = await startProxy(projectRoot);
      try {
        const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-5" }),
        });
        await res.text();
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM rate_limit_snapshots")
          .get() as { c: number };
        // db を渡していないので何も書き込まれない
        expect(row.c).toBe(0);
      } finally {
        proxy.stop();
      }
    } finally {
      if (origUpstreamUrl === undefined) {
        delete process.env.ANTHROPIC_API_URL;
      } else {
        process.env.ANTHROPIC_API_URL = origUpstreamUrl;
      }
      upstream.server.stop();
    }
  });
});
