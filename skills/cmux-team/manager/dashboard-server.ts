/**
 * T414: Web ダッシュボード — Manager daemon 同居 HTTP server
 *
 * Bun.serve({ hostname: "127.0.0.1", port: 0 }) で内部 SPA を配信する。
 * 集計は trace-store.ts / metrics-aggregate.ts / agent-strategy.ts の SSOT に委譲し、
 * 本ファイルは routing / period query parsing / response shape 整形 / timeout race のみ担う。
 *
 * 設計判断（plan §2.1 §5.1 §10）:
 *  - dashboard 側で常に自前 initDB(projectRoot)（B 案）。proxy 再利用パスでも本プロセスで開く
 *  - shutdown では呼び出し側が stop() を呼ばない（process.exit に委ねる）。テスト経路でのみ stop()
 *  - 集計は endpoint ハンドラ層で Promise.race([work, sleep(5000)])、TIMEOUT で 503
 *  - DI: aggregators / sleep / now を引数で差し替え可能（テストで sleep 関数を差し替える）
 */
import { Database } from "bun:sqlite";
import { initDB } from "./trace-store";
import { log } from "./logger";

export interface DashboardServerHandle {
  /** listen 中のポート番号（ephemeral） */
  port: number;
  /** http://127.0.0.1:<port> 形式の URL */
  url: string;
  /** server を停止する。本番 lifecycle では呼ばないが、テストで Bun ランナーをハングさせない用途 */
  stop: () => void;
}

export interface DashboardSleeper {
  (ms: number): Promise<void>;
}

export interface DashboardServerOptions {
  /** プロジェクトルート絶対パス */
  projectRoot: string;
  /** 任意: バージョン文字列。未指定なら "unknown" */
  version?: string;
  /** 任意: DaemonState を返す getter。/api/health 等で参照 */
  getState?: () => unknown;
  /** 任意: 現在時刻 ms（テスト用に固定したい場合）。default Date.now */
  now?: () => number;
  /** 任意: SQLite DB ハンドル。指定があれば initDB を呼ばずに使う（テスト用） */
  db?: Database;
  /** 任意: timeout race 用 sleep 関数。テストで 6s sleep に差し替える */
  sleep?: DashboardSleeper;
  /** 任意: 集計タイムアウト閾値 ms。default 5000 */
  aggregateTimeoutMs?: number;
}

/**
 * 全 endpoint のレスポンスに付与する CSP header。
 * inline `<style>` / `<script>` を許可するため style-src / script-src に 'unsafe-inline' を含める。
 */
const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'";

const DEFAULT_TIMEOUT_MS = 5000;

const TIMEOUT_SENTINEL = Symbol("dashboard-server.timeout");

const defaultSleep: DashboardSleeper = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP_HEADER,
  };
  // 呼び出し側 init.headers を優先せず常に CSP を上書きする（leak 防止）
  return new Response(JSON.stringify(body), { status: init.status, headers });
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
  endpoint?: string;
  windowSec?: number;
}

function errorResponse(status: number, body: ApiErrorResponse): Response {
  return jsonResponse(body, { status });
}

export interface PeriodQuery {
  fromIso: string;
  toIso: string;
}

/**
 * `?from` `?to` を parse する。未指定なら 24h window を default として返す。
 * parse 失敗 / from > to のときは Error を投げる（呼び出し側で 400 にする）。
 */
export function parsePeriodQuery(
  url: URL,
  now: () => number = Date.now,
): PeriodQuery {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const nowMs = now();
  const defaultFromMs = nowMs - 24 * 60 * 60 * 1000;

  const fromMs = fromRaw === null ? defaultFromMs : Date.parse(fromRaw);
  const toMs = toRaw === null ? nowMs : Date.parse(toRaw);
  if (Number.isNaN(fromMs)) {
    throw new RangeError(`bad_from: ${fromRaw}`);
  }
  if (Number.isNaN(toMs)) {
    throw new RangeError(`bad_to: ${toRaw}`);
  }
  if (fromMs > toMs) {
    throw new RangeError(`from_after_to: from=${new Date(fromMs).toISOString()} to=${new Date(toMs).toISOString()}`);
  }
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  };
}

/**
 * 集計呼び出しを 5s で打ち切る race ヘルパー。
 * timeout した場合は 503 用の sentinel を返す。集計は background で完走するが GC に任せる
 * （詳細は plan §10 の AbortSignal を threading しない理由を参照）。
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  sleep: DashboardSleeper,
): Promise<T | symbol> {
  const timer: Promise<symbol> = sleep(timeoutMs).then(() => TIMEOUT_SENTINEL);
  return Promise.race<T | symbol>([work, timer]);
}

interface HealthResponse {
  ok: true;
  version: string;
  projectRoot: string;
  startedAt: string;
  uptimeSec: number;
  proxyPort: number | null;
  serverPort: number;
  schemaVersion: 1;
}

export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const projectRoot = opts.projectRoot;
  const version = opts.version ?? "unknown";
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.aggregateTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const db = opts.db ?? initDB(projectRoot);

  const startedAtMs = now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const handlers = {
    health: (serverPort: number): HealthResponse => {
      const state = opts.getState?.() as { proxyPort?: number | null } | undefined;
      const proxyPort = state?.proxyPort ?? null;
      return {
        ok: true,
        version,
        projectRoot,
        startedAt: startedAtIso,
        uptimeSec: Math.floor((now() - startedAtMs) / 1000),
        proxyPort,
        serverPort,
        schemaVersion: 1,
      };
    },
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method !== "GET") {
      return errorResponse(404, { error: "not_found" });
    }

    if (pathname === "/api/health") {
      return jsonResponse(handlers.health(server.port!));
    }

    return errorResponse(404, { error: "not_found", endpoint: pathname });
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        try {
          return await fetchHandler(req);
        } catch (e: any) {
          await log(
            "dashboard_server_error",
            `${req.method} ${req.url} ${e?.message ?? e}`,
          );
          return errorResponse(500, {
            error: "internal",
            message: e?.message ?? String(e),
          });
        }
      },
      development: false,
    });
  } catch (e: any) {
    throw new Error(`dashboard server bind failed: ${e?.message ?? e}`);
  }

  const port = server.port!;
  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    stop: () => {
      try {
        server.stop();
      } catch {
        // 二重 stop は無害
      }
      // dashboard 自身が initDB で開いた DB ハンドルを閉じる（テスト経路用）
      if (opts.db === undefined) {
        try {
          db.close();
        } catch {
          // 既に閉じている場合は無視
        }
      }
    },
  };
}

/** plan §10 の Promise.race race ヘルパーを後続 Step で使うため公開する */
export const _internal = {
  TIMEOUT_SENTINEL,
  withTimeout,
  CSP_HEADER,
  jsonResponse,
  errorResponse,
};
