/**
 * Claude Code が Anthropic API に送信するヘッダー・ボディのメタデータを調査するダンプ用プロキシ
 *
 * 使い方:
 *   1. bun run .team/debug/dump-proxy.ts
 *   2. 別ターミナルで: ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude "hello"
 *   3. .team/debug/dump.jsonl を確認
 */
import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

const UPSTREAM = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com";
const PORT = 9999;
const DUMP_FILE = join(dirname(new URL(import.meta.url).pathname), "dump.jsonl");

await mkdir(dirname(DUMP_FILE), { recursive: true });

console.log(`🔍 Dump proxy starting on port ${PORT}`);
console.log(`   Upstream: ${UPSTREAM}`);
console.log(`   Dump file: ${DUMP_FILE}`);
console.log(`\n   使い方: ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude "hello"\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const targetUrl = `${UPSTREAM}${url.pathname}${url.search}`;

    // リクエストボディを読み取り
    const reqBody = req.body ? await req.arrayBuffer() : null;
    let parsedBody: any = null;
    try {
      if (reqBody) {
        parsedBody = JSON.parse(new TextDecoder().decode(reqBody));
      }
    } catch {}

    // ヘッダーをダンプ
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      // API キーは伏せる
      if (key === "x-api-key" || key === "authorization") {
        headers[key] = value.substring(0, 10) + "...[REDACTED]";
      } else {
        headers[key] = value;
      }
    });

    // ボディのメタデータ部分をダンプ（messages 本文は大きいので構造だけ）
    const bodyDump: any = {};
    if (parsedBody) {
      for (const [key, value] of Object.entries(parsedBody)) {
        if (key === "messages") {
          // messages は件数とロールだけ
          bodyDump.messages = (value as any[]).map((m: any) => ({
            role: m.role,
            content_type: typeof m.content,
            content_length: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length,
          }));
        } else if (key === "system") {
          // system は長さだけ
          bodyDump.system = typeof value === "string"
            ? { type: "string", length: value.length }
            : { type: typeof value, length: JSON.stringify(value).length };
        } else if (key === "tools") {
          // tools は名前だけ
          bodyDump.tools = (value as any[]).map((t: any) => t.name || t.type || "unknown");
        } else {
          // その他はそのまま記録
          bodyDump[key] = value;
        }
      }
    }

    const dumpEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      headers,
      body: bodyDump,
    };

    // コンソールに表示
    console.log("\n" + "=".repeat(80));
    console.log(JSON.stringify(dumpEntry, null, 2));

    // ファイルに記録
    await appendFile(DUMP_FILE, JSON.stringify(dumpEntry) + "\n");

    // 上流に転送
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.delete("host");
    fwdHeaders.delete("accept-encoding");

    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: reqBody,
    });

    const resHeaders = new Headers(upstreamRes.headers);
    resHeaders.delete("content-encoding");
    resHeaders.delete("content-length");

    // レスポンスはそのまま返す
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  },
});

console.log(`✅ Listening on http://127.0.0.1:${server.port}`);
