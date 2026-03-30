/**
 * OTEL レシーバー — Claude Code が OTLP で送信するデータをダンプする
 *
 * 使い方:
 *   bun run .team/debug/otel-receiver.ts
 *   別ターミナルで OTEL 環境変数を設定して Claude Code を起動
 */
import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

const PORT = 4318; // OTLP HTTP のデフォルトポート
const DUMP_FILE = join(dirname(new URL(import.meta.url).pathname), "otel-dump.jsonl");

await mkdir(dirname(DUMP_FILE), { recursive: true });

console.log(`🔍 OTEL Receiver starting on port ${PORT}`);
console.log(`   Dump file: ${DUMP_FILE}`);
console.log(`\n   全エンドポイントをキャプチャします\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.body ? await req.arrayBuffer() : null;

    let parsedBody: any = null;
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("json") && body) {
      try {
        parsedBody = JSON.parse(new TextDecoder().decode(body));
      } catch {}
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const entry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      content_type: contentType,
      headers,
      body_size: body?.byteLength ?? 0,
      body: parsedBody,
      body_is_binary: !parsedBody && (body?.byteLength ?? 0) > 0,
    };

    // コンソールに表示
    console.log("\n" + "=".repeat(80));
    console.log(`${req.method} ${url.pathname} (${contentType}, ${body?.byteLength ?? 0} bytes)`);
    if (parsedBody) {
      // OTEL のデータ構造を読みやすく表示
      if (parsedBody.resourceMetrics) {
        console.log("📊 METRICS:");
        for (const rm of parsedBody.resourceMetrics) {
          console.log("  Resource attributes:", JSON.stringify(rm.resource?.attributes, null, 2));
          for (const sm of rm.scopeMetrics || []) {
            for (const m of sm.metrics || []) {
              console.log(`  - ${m.name}: ${JSON.stringify(m.sum?.dataPoints || m.histogram?.dataPoints || m.gauge?.dataPoints, null, 2)?.substring(0, 200)}`);
            }
          }
        }
      } else if (parsedBody.resourceLogs) {
        console.log("📝 LOGS:");
        for (const rl of parsedBody.resourceLogs) {
          console.log("  Resource attributes:", JSON.stringify(rl.resource?.attributes, null, 2));
          for (const sl of rl.scopeLogs || []) {
            for (const lr of sl.logRecords || []) {
              const eventName = lr.attributes?.find((a: any) => a.key === "event.name")?.value?.stringValue;
              console.log(`  - Event: ${eventName || "unknown"}`);
              console.log(`    Attributes:`, JSON.stringify(lr.attributes?.map((a: any) => `${a.key}=${JSON.stringify(a.value)}`), null, 2)?.substring(0, 500));
              if (lr.body) {
                console.log(`    Body:`, JSON.stringify(lr.body)?.substring(0, 300));
              }
            }
          }
        }
      } else if (parsedBody.resourceSpans) {
        console.log("🔗 TRACES:");
        console.log(JSON.stringify(parsedBody, null, 2).substring(0, 1000));
      } else {
        console.log(JSON.stringify(parsedBody, null, 2).substring(0, 1000));
      }
    } else if (body && body.byteLength > 0) {
      console.log(`  [Binary data: ${body.byteLength} bytes - likely protobuf]`);
      // protobuf の場合はバイナリのまま記録
    }

    // ファイルに記録
    await appendFile(DUMP_FILE, JSON.stringify(entry) + "\n");

    // OTLP の正常応答
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`✅ Listening on http://127.0.0.1:${server.port}`);
console.log(`   Traces:  POST /v1/traces`);
console.log(`   Metrics: POST /v1/metrics`);
console.log(`   Logs:    POST /v1/logs`);
