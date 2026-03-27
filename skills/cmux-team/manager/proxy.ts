/**
 * ロギングプロキシ — Anthropic API への透過プロキシ + JSONL トレース
 *
 * Agent の ANTHROPIC_BASE_URL をこのプロキシに向けることで、
 * リクエスト/レスポンスを .team/logs/traces/ に記録する。
 * レスポンスは streaming のまま返し、ログは非同期で書き込む。
 */
import { mkdir, appendFile } from "fs/promises";
import { join } from "path";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

interface ProxyHandle {
  port: number;
  stop: () => void;
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

export async function start(
  projectRoot: string,
  opts?: { conductorId?: string; taskId?: string; role?: string }
): Promise<ProxyHandle> {
  const upstream = process.env.ANTHROPIC_API_URL || DEFAULT_UPSTREAM;
  const tracesDir = join(projectRoot, ".team/logs/traces");
  await mkdir(tracesDir, { recursive: true });

  const traceFile = join(tracesDir, "api-trace.jsonl");

  const server = Bun.serve({
    port: 0, // OS が空きポートを割り当て
    async fetch(req) {
      const url = new URL(req.url);
      const targetUrl = `${upstream}${url.pathname}${url.search}`;
      const startTime = Date.now();

      // リクエストボディを読み取り（転送用 + サイズ計測用）
      const reqBody = req.body ? await req.arrayBuffer() : null;
      const requestBytes = reqBody?.byteLength ?? 0;

      // 上流に転送
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers,
        body: reqBody,
      });

      // レスポンスが streaming かどうかを判定
      const contentType = upstreamRes.headers.get("content-type") || "";
      const isStreaming = contentType.includes("text/event-stream");

      if (isStreaming && upstreamRes.body) {
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
          conductorId: opts?.conductorId,
          taskId: opts?.taskId,
          role: opts?.role,
        });

        return new Response(clientStream, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: upstreamRes.headers,
        });
      }

      // 非 streaming: ボディ全体を取得してログ
      const resBody = await upstreamRes.arrayBuffer();
      const duration = Date.now() - startTime;

      const entry: TraceEntry = {
        timestamp: new Date().toISOString(),
        conductor_id: opts?.conductorId,
        task_id: opts?.taskId,
        role: opts?.role,
        method: req.method,
        path: url.pathname,
        status: upstreamRes.status,
        request_bytes: requestBytes,
        response_bytes: resBody.byteLength,
        duration_ms: duration,
      };

      // 非同期でログ書き込み
      appendFile(traceFile, JSON.stringify(entry) + "\n").catch(() => {});

      return new Response(resBody, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: upstreamRes.headers,
      });
    },
  });

  return {
    port: server.port,
    stop: () => server.stop(),
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
    conductorId?: string;
    taskId?: string;
    role?: string;
  }
): Promise<void> {
  let responseBytes = 0;
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
    }
  } catch {
    // stream エラーは無視（クライアント切断等）
  }

  const entry: TraceEntry = {
    timestamp: new Date().toISOString(),
    conductor_id: ctx.conductorId,
    task_id: ctx.taskId,
    role: ctx.role,
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    request_bytes: ctx.requestBytes,
    response_bytes: responseBytes,
    duration_ms: Date.now() - ctx.startTime,
  };

  appendFile(ctx.tracesDir, JSON.stringify(entry) + "\n").catch(() => {});
}
