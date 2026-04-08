/**
 * ロギングプロキシ — Anthropic API への透過プロキシ + JSONL トレース
 *
 * Agent の ANTHROPIC_BASE_URL をこのプロキシに向けることで、
 * リクエスト/レスポンスを .team/logs/traces/ に記録する。
 * レスポンスは streaming のまま返し、ログは非同期で書き込む。
 */
import { mkdir, appendFile, readFile } from "fs/promises";
import { join } from "path";
import { initDB, insertTrace } from "./trace-store";
import { log } from "./logger";
import { QueueMessage } from "./schema";
import type { RateLimitInfo } from "./schema";
import type { Database } from "bun:sqlite";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

interface ProxyHandle {
  port: number;
  stop: () => void;
  db: Database;
}

interface TraceEntry {
  timestamp: string;
  conductor_id?: string;
  task_id?: string;
  role?: string;
  method: string;
  path: string;
  status?: number;
  request_bytes: number;
  response_bytes: number;
  duration_ms: number;
}

/** Anthropic レスポンスヘッダーから RateLimitInfo を抽出 */
function extractRateLimit(headers: Headers): RateLimitInfo | null {
  // unified ヘッダーの読み取り
  const unified5hRaw = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const unified7dRaw = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const unified5h = unified5hRaw != null ? parseFloat(unified5hRaw) : null;
  const unified7d = unified7dRaw != null ? parseFloat(unified7dRaw) : null;
  const unified5hReset = headers.get("anthropic-ratelimit-unified-5h-reset") ?? null;
  const unified7dReset = headers.get("anthropic-ratelimit-unified-7d-reset") ?? null;
  const unifiedStatus = headers.get("anthropic-ratelimit-unified-status") ?? null;

  // 従来の TPM ヘッダーの読み取り
  const remaining = headers.get("anthropic-ratelimit-tokens-remaining");
  const limit = headers.get("anthropic-ratelimit-tokens-limit");

  // unified も TPM も両方ない場合は null
  if ((remaining == null || limit == null) && unified5h == null && unified7d == null) return null;

  const tokensRemaining = remaining != null ? parseInt(remaining, 10) : 0;
  const tokensLimit = limit != null ? parseInt(limit, 10) : 0;

  return {
    tokensRemaining: isNaN(tokensRemaining) ? 0 : tokensRemaining,
    tokensLimit: isNaN(tokensLimit) ? 0 : tokensLimit,
    tokensReset: headers.get("anthropic-ratelimit-tokens-reset") ?? "",
    inputTokensRemaining: parseInt(headers.get("anthropic-ratelimit-input-tokens-remaining") ?? "0", 10),
    outputTokensRemaining: parseInt(headers.get("anthropic-ratelimit-output-tokens-remaining") ?? "0", 10),
    unified5hUtilization: unified5h != null && !isNaN(unified5h) ? unified5h : null,
    unified7dUtilization: unified7d != null && !isNaN(unified7d) ? unified7d : null,
    unified5hReset,
    unified7dReset,
    unifiedStatus,
    updatedAt: new Date().toISOString(),
  };
}

export async function start(
  projectRoot: string,
  opts?: { conductorSurface?: string; taskId?: string; role?: string; getState?: () => any; onMessage?: (msg: QueueMessage) => Promise<void> }
): Promise<ProxyHandle> {
  const upstream = process.env.ANTHROPIC_API_URL || DEFAULT_UPSTREAM;
  const tracesDir = join(projectRoot, ".team/logs/traces");
  await mkdir(tracesDir, { recursive: true });

  const traceFile = join(tracesDir, "api-trace.jsonl");

  // SQLite トレースストア + bodies ディレクトリ
  const bodiesDir = join(projectRoot, ".team/logs/traces/bodies");
  await mkdir(bodiesDir, { recursive: true });
  const db = initDB(projectRoot);

  // 前回ポートの読み取り（daemon リロード時に同じポートを再利用）
  let preferredPort = 0;
  try {
    const saved = await readFile(join(projectRoot, ".team/proxy-port"), "utf-8");
    const parsed = parseInt(saved.trim(), 10);
    if (parsed > 0) preferredPort = parsed;
  } catch {
    // ファイルなし（初回起動）→ ランダムポート
  }

  const fetchHandler = async (req: Request) => {
    try {
      return await fetchHandlerInner(req);
    } catch (e: any) {
      log("proxy_request_error", `${req.method} ${req.url} ${e.message}`).catch(() => {});
      return new Response(JSON.stringify({ type: "error", error: { type: "proxy_error", message: e.message } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  const fetchHandlerInner = async (req: Request) => {
      const url = new URL(req.url);

      // デバッグエンドポイント
      if (req.method === "GET") {
        const jsonHeaders = { "Content-Type": "application/json" };

        if (url.pathname === "/state") {
          if (!opts?.getState) return new Response("Not Found", { status: 404 });
          const state = opts.getState();
          const serialized = {
            ...state,
            conductors: Object.fromEntries(state.conductors),
            lastUpdate: state.lastUpdate instanceof Date ? state.lastUpdate.toISOString() : state.lastUpdate,
          };
          return new Response(JSON.stringify({ ...serialized, masterPrompt: state.masterPrompt }), { headers: jsonHeaders });
        }

        if (url.pathname === "/tasks") {
          if (!opts?.getState) return new Response("Not Found", { status: 404 });
          const state = opts.getState();
          return new Response(JSON.stringify(state.taskList), { headers: jsonHeaders });
        }

        if (url.pathname === "/conductors") {
          if (!opts?.getState) return new Response("Not Found", { status: 404 });
          const state = opts.getState();
          return new Response(JSON.stringify(Object.fromEntries(state.conductors)), { headers: jsonHeaders });
        }
      }

      // Master 状態更新エンドポイント
      if (req.method === "POST" && url.pathname === "/master-state") {
        if (!opts?.getState) return new Response("Not Found", { status: 404 });
        try {
          const body = await req.json() as { status?: string; prompt?: string };
          const state = opts.getState();
          if (body.status === "busy") {
            state.masterStatus = "running";
          } else if (body.status === "idle") {
            state.masterStatus = "idle";
            state.masterPrompt = undefined;
          }
          if (body.prompt != null) {
            state.masterPrompt = body.prompt.slice(0, 80);
          }
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        } catch {
          return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }

      // メッセージ受信エンドポイント（ファイルベース IPC の代替）
      if (req.method === "POST" && url.pathname === "/api/messages") {
        if (!opts?.onMessage) {
          return new Response(JSON.stringify({ error: "no handler" }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        try {
          const body = await req.json();
          const msg = QueueMessage.parse(body);
          await opts.onMessage(msg);
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        } catch {
          return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }

      const targetUrl = `${upstream}${url.pathname}${url.search}`;
      const startTime = Date.now();

      // リクエストヘッダーからメタデータを動的抽出（opts はフォールバック）
      const taskId = req.headers.get("x-cmux-task-id") || opts?.taskId;
      const conductorSurface = req.headers.get("x-cmux-conductor-id") || opts?.conductorSurface;
      const role = req.headers.get("x-cmux-role") || opts?.role;
      const sessionId = req.headers.get("x-claude-code-session-id") || undefined;

      // Agent の sessionId を daemon state に反映
      if (sessionId && conductorSurface && opts?.getState) {
        const st = opts.getState();
        const conductors: Map<string, any> | undefined = st.conductors;
        if (conductors) {
          // conductorSurface または taskRunId で Conductor を検索（daemon.ts の findConductor と同じロジック）
          let conductor = conductors.get(conductorSurface);
          if (!conductor) {
            for (const c of conductors.values()) {
              if (c.taskRunId === conductorSurface) { conductor = c; break; }
            }
          }
          if (conductor?.agents) {
            const agent = role
              ? conductor.agents.find((a: any) => a.role === role)
              : conductor.agents[0];
            if (agent && !agent.sessionId) {
              agent.sessionId = sessionId;
            }
          }
        }
      }

      // リクエストボディを読み取り（転送用 + サイズ計測用）
      const reqBody = req.body ? await req.arrayBuffer() : null;
      const requestBytes = reqBody?.byteLength ?? 0;

      // リクエスト本文を bodies/ に保存
      const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let reqBodyPath: string | undefined;
      if (reqBody && requestBytes > 0) {
        reqBodyPath = join(bodiesDir, `${traceId}-req.json`);
        Bun.write(reqBodyPath, reqBody).catch(() => {});
      }

      // Host ヘッダーを除外して転送（そのまま渡すと Bun が
      // Host の値を接続先に使い、プロキシ自身に接続してしまう）
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.delete("host");
      fwdHeaders.delete("accept-encoding");

      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: reqBody,
      });

      // Bun の fetch は自動解凍するので Content-Encoding / Content-Length を除去
      const resHeaders = new Headers(upstreamRes.headers);
      resHeaders.delete("content-encoding");
      resHeaders.delete("content-length");

      // レスポンスが streaming かどうかを判定
      const contentType = upstreamRes.headers.get("content-type") || "";
      const isStreaming = contentType.includes("text/event-stream");

      if (isStreaming && upstreamRes.body) {
        // レート制限ヘッダーを DaemonState に反映
        if (opts?.getState) {
          const rl = extractRateLimit(upstreamRes.headers);
          if (rl) opts.getState().rateLimit = rl;
        }

        // streaming: tee して片方をログに使う
        const [clientStream, logStream] = upstreamRes.body.tee();

        // 非同期でログ書き込み（レスポンスはブロックしない）
        drainAndLog(logStream, {
          tracesDir: traceFile,
          method: req.method,
          path: url.pathname,
          status: upstreamRes.status,
          requestBytes,
          startTime,
          conductorSurface,
          taskId,
          role,
          db,
          bodiesDir,
          traceId,
          sessionId,
          reqBodyPath,
        }).catch((e: any) =>
          log("error", `drainAndLog failed: ${e.message}`).catch(() => {})
        );

        return new Response(clientStream, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: resHeaders,
        });
      }

      // 非 streaming: ボディ全体を取得してログ
      const resBody = await upstreamRes.arrayBuffer();
      const duration = Date.now() - startTime;

      // レート制限ヘッダーを DaemonState に反映
      if (opts?.getState) {
        const rl = extractRateLimit(upstreamRes.headers);
        if (rl) opts.getState().rateLimit = rl;
      }

      const entry: TraceEntry = {
        timestamp: new Date().toISOString(),
        conductor_id: conductorSurface,
        task_id: taskId,
        role,
        method: req.method,
        path: url.pathname,
        status: upstreamRes.status,
        request_bytes: requestBytes,
        response_bytes: resBody.byteLength,
        duration_ms: duration,
      };

      // 非同期でログ書き込み（JSONL）
      appendFile(traceFile, JSON.stringify(entry) + "\n").catch(() => {});

      // レスポンス本文を bodies/ に保存 + SQLite 記録
      let resBodyPath: string | undefined;
      if (resBody.byteLength > 0) {
        resBodyPath = join(bodiesDir, `${traceId}-res.json`);
        Bun.write(resBodyPath, resBody).catch(() => {});
      }
      try {
        insertTrace(db, {
          timestamp: new Date().toISOString(),
          task_id: taskId,
          conductor_id: conductorSurface,
          role,
          session_id: sessionId,
          method: req.method,
          path: url.pathname,
          status: upstreamRes.status,
          request_bytes: requestBytes,
          response_bytes: resBody.byteLength,
          duration_ms: duration,
          request_body_path: reqBodyPath,
          response_body_path: resBodyPath,
        });
      } catch (e: any) {
        log("error", `insertTrace failed: ${e.message}`).catch(() => {});
      }

      return new Response(resBody, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders,
      });
  };  // fetchHandlerInner end

  // 前回ポートで起動を試み、失敗時はランダムポートにフォールバック
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port: preferredPort, fetch: fetchHandler, development: false, error(e) { log("proxy_server_error", e.message).catch(() => {}); return new Response("Internal Server Error", { status: 500 }); } });
  } catch (e: any) {
    if (preferredPort !== 0) {
      await log("proxy_port_fallback", `preferred=${preferredPort} error=${e.message}`);
      server = Bun.serve({ port: 0, fetch: fetchHandler, development: false, error(e) { log("proxy_server_error", e.message).catch(() => {}); return new Response("Internal Server Error", { status: 500 }); } });
    } else {
      throw new Error("Failed to start proxy");
    }
  }

  return {
    port: server.port!,
    stop: () => { server.stop(); db.close(); },
    db,
  };
}

/** streaming レスポンスを drain してバイト数をログに記録 */
async function drainAndLog(
  stream: ReadableStream<Uint8Array>,
  ctx: {
    tracesDir: string;
    method: string;
    path: string;
    status: number;
    requestBytes: number;
    startTime: number;
    conductorSurface?: string;
    taskId?: string;
    role?: string;
    db: Database;
    bodiesDir: string;
    traceId: string;
    sessionId?: string;
    reqBodyPath?: string;
  }
): Promise<void> {
  let responseBytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      chunks.push(value);
    }
  } catch (e: any) {
    // クライアント切断等は無視するが、予期しないエラーは記録
    if (!e.message?.includes("closed") && !e.message?.includes("aborted")) {
      log("proxy_stream_error", e.message).catch(() => {});
    }
  } finally {
    reader.releaseLock();
  }

  const duration = Date.now() - ctx.startTime;

  const entry: TraceEntry = {
    timestamp: new Date().toISOString(),
    conductor_id: ctx.conductorSurface,
    task_id: ctx.taskId,
    role: ctx.role,
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    request_bytes: ctx.requestBytes,
    response_bytes: responseBytes,
    duration_ms: duration,
  };

  // JSONL ログ（既存）
  appendFile(ctx.tracesDir, JSON.stringify(entry) + "\n").catch(() => {});

  // レスポンス本文を bodies/ に保存
  let resBodyPath: string | undefined;
  if (responseBytes > 0) {
    resBodyPath = join(ctx.bodiesDir, `${ctx.traceId}-res.json`);
    const merged = new Uint8Array(responseBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    Bun.write(resBodyPath, merged).catch(() => {});
  }

  // SQLite 記録
  try {
    insertTrace(ctx.db, {
      timestamp: new Date().toISOString(),
      task_id: ctx.taskId,
      conductor_id: ctx.conductorSurface,
      role: ctx.role,
      session_id: ctx.sessionId,
      method: ctx.method,
      path: ctx.path,
      status: ctx.status,
      request_bytes: ctx.requestBytes,
      response_bytes: responseBytes,
      duration_ms: duration,
      request_body_path: ctx.reqBodyPath,
      response_body_path: resBodyPath,
    });
  } catch (e: any) {
    log("error", `insertTrace (streaming) failed: ${e.message}`).catch(() => {});
  }
}
