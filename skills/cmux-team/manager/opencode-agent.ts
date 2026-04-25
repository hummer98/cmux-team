/**
 * opencode Agent の spawn / kill ヘルパー（CLI 用・SSE ループなし）。Issue #37
 *
 * cmdSpawnAgent / cmdKillAgent から呼ばれる短命な CLI 用。
 * OpenCodeBackend（daemon 常駐用）とは異なり、REST 呼び出しのみ行う。
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import { spawn, type ChildProcess } from "child_process";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Surface 命名規約
// ---------------------------------------------------------------------------

/** opencode Agent の surface プレフィックス */
export const OC_SURFACE_PREFIX = "oc:";

/** sessionRef から opencode Agent 用 surface ID を作る */
export function makeOcSurface(sessionRef: string): string {
  return `${OC_SURFACE_PREFIX}${sessionRef}`;
}

/**
 * surface が opencode Agent のものかを判定し、sessionRef を返す。
 * opencode Agent でない場合は null。
 */
export function parseOcSurface(surface: string): string | null {
  if (!surface.startsWith(OC_SURFACE_PREFIX)) return null;
  return surface.slice(OC_SURFACE_PREFIX.length);
}

// ---------------------------------------------------------------------------
// spawn / kill
// ---------------------------------------------------------------------------

export interface SpawnOpenCodeAgentOptions {
  role: string;
  /** 初回プロンプトのテキスト */
  prompt: string;
  workdir: string;
  model: string;
}

export interface SpawnOpenCodeAgentResult {
  sessionRef: string;
  /** daemon に登録する surface ID（"oc:${sessionRef}"） */
  surface: string;
}

/**
 * opencode server に新しい session を作成して初回プロンプトを送信する。
 * cmdSpawnAgent から呼ばれる（SSE ループは張らない）。
 */
export async function spawnOpenCodeAgent(
  serverUrl: string,
  opts: SpawnOpenCodeAgentOptions,
): Promise<SpawnOpenCodeAgentResult> {
  const client = createOpencodeClient({ baseUrl: serverUrl });

  const res = await client.session.create({
    body: { title: opts.role },
    query: { directory: opts.workdir },
  });
  const session = res.data;
  if (!session?.id) {
    throw new Error("opencode session.create returned no session id");
  }
  const sessionRef = session.id;

  // model は "providerID/modelID" 形式（例: "openrouter/anthropic/claude-haiku-4.5"）
  // promptAsync の model フィールドに分解して渡す。
  const slashIdx = opts.model.indexOf("/");
  const modelBody: { model?: { providerID: string; modelID: string } } =
    slashIdx > 0
      ? { model: { providerID: opts.model.slice(0, slashIdx), modelID: opts.model.slice(slashIdx + 1) } }
      : {};

  await client.session.promptAsync({
    path: { id: sessionRef },
    body: { parts: [{ type: "text", text: opts.prompt }], ...modelBody },
  });

  await log(
    "oc_agent_spawned",
    `sessionRef=${sessionRef} role=${opts.role} workdir=${opts.workdir} model=${opts.model}`,
  );
  return { sessionRef, surface: makeOcSurface(sessionRef) };
}

/**
 * opencode session を abort する（idempotent）。
 * cmdKillAgent から呼ばれる。
 */
export async function killOpenCodeAgent(serverUrl: string, sessionRef: string): Promise<void> {
  const client = createOpencodeClient({ baseUrl: serverUrl });
  try {
    await client.session.abort({ path: { id: sessionRef } });
    await log("oc_agent_killed", `sessionRef=${sessionRef}`);
  } catch (e: any) {
    // 既に終了済みなら無視
    await log("oc_agent_kill_noop", `sessionRef=${sessionRef} reason=${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------
// opencode server lifecycle（M2）
// ---------------------------------------------------------------------------

/**
 * `opencode serve` を子プロセスとして起動する。
 * cmdStart から呼ばれ、返り値を DaemonState.openCodeServerProcess に保持する。
 * serverUrl から port を抽出して --port に渡す。
 */
export function startOpenCodeServer(serverUrl: string): ChildProcess {
  let port = 54321;
  try {
    port = new URL(serverUrl).port ? parseInt(new URL(serverUrl).port, 10) : 54321;
  } catch {}

  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: "ignore",
    detached: false,
  });

  proc.on("error", (e) => {
    log("error", `opencode server process error: ${e.message}`).catch(() => {});
  });
  proc.on("exit", (code, signal) => {
    log("oc_server_exit", `code=${code ?? "null"} signal=${signal ?? "null"}`).catch(() => {});
  });

  log("oc_server_started", `port=${port} pid=${proc.pid}`).catch(() => {});
  return proc;
}

/**
 * opencode server 子プロセスを停止する。
 * stopDaemon / cmdStart のシャットダウンフックから呼ばれる。
 */
export function stopOpenCodeServer(proc: ChildProcess): void {
  if (!proc.killed) {
    proc.kill("SIGTERM");
    log("oc_server_stopped", `pid=${proc.pid}`).catch(() => {});
  }
}
