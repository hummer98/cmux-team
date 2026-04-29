/**
 * ロギングプロキシ — Anthropic API への透過プロキシ + JSONL トレース
 *
 * Agent の ANTHROPIC_BASE_URL をこのプロキシに向けることで、
 * リクエスト/レスポンスを .team/logs/traces/ に記録する。
 * レスポンスは streaming のまま返し、ログは非同期で書き込む。
 */
import { mkdir, appendFile, readFile } from "fs/promises";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { log } from "./logger";
import { notifyStateChanged } from "./eventBus";
import { QueueMessage, THROTTLE_5H_THRESHOLD } from "./schema";
import type { RateLimitInfo } from "./schema";
import { formatStatusline, type StatuslineInput, type StatuslineState } from "./statusline";
import { persistRateLimit } from "./rate-limit-persistence";
import {
  insertApiUsage,
  insertRateLimitSnapshot,
  type ApiUsageRecord,
} from "./trace-store";
import {
  initTokenDB,
  getTokenByAuthHash,
  getTokenByOrganizationId,
  updateTokenAuth,
  insertToken,
  getLatestUsageSnapshot,
  upsertUsageSnapshot,
} from "./token-store";
import { isTokenPoolEnabled, buildSelectTokenPolicy } from "./config";
import { isThrottled5h, countPoolTokens } from "./pool-throttle";
import type { SelectTokenPolicy } from "./token-store";
import { createHash } from "crypto";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

// ─── tokens.db シングルトン（T320）───────────────────────────────────────────
// 複数プロジェクトが並列実行しても tokens.db は WAL モードで safe。
// proxy は 1 プロセスに 1 インスタンスなのでシングルトンで十分。
let _tokensDb: ReturnType<typeof initTokenDB> | null = null;
function getTokensDB(): ReturnType<typeof initTokenDB> {
  if (!_tokensDb) {
    try {
      _tokensDb = initTokenDB();
    } catch {
      // tokens.db が開けない環境（permission 等）は機能を無効化する
      _tokensDb = null as any;
      return null as any;
    }
  }
  return _tokensDb;
}

/** テスト専用: tokens.db のシングルトンを破棄して次の getTokensDB で再初期化させる。 */
export function __resetTokensDbForTest(): void {
  try {
    _tokensDb?.close?.();
  } catch {
    // close 失敗は無視（既に閉じている可能性）
  }
  _tokensDb = null;
}

/** Authorization header の値全体を sha256 して 12 文字 prefix を返す（T320/A020）。 */
function computeProxyAuthHash(authHeader: string | null): string | null {
  if (!authHeader) return null;
  return createHash("sha256").update(authHeader).digest("hex").slice(0, 12);
}

/**
 * auto-discover 用 handle を生成する。organization_id の先頭 4 文字から始め、
 * 衝突時は 5, 6... と伸長する。
 */
function genAutoDiscoverHandle(
  db: ReturnType<typeof initTokenDB>,
  orgId: string,
): string {
  for (let len = 4; len <= orgId.length; len++) {
    const candidate = `@${orgId.slice(0, len)}`;
    const existing = db.prepare("SELECT id FROM tokens WHERE handle = ?").get(candidate);
    if (!existing) return candidate;
  }
  return `@${orgId.slice(0, 8)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Anthropic レスポンス 1 件につき tokens.db を更新する（T320 / T384）。
 * - auth_hash が既知 (`getTokenByAuthHash`): utilization 変化時のみ throttled UPSERT
 * - auth_hash 未知 + organization_id 既知 (`getTokenByOrganizationId`):
 *     auto-rotate（既存 token の auth_hash を UPDATE してから UPSERT 経路に合流）。
 *     OAuth refresh で auth_hash が乖離した token の usage_snapshots 更新を再開させる（T384）。
 *     `tokenPoolEnabled` には依存しない（手動 add の正規 token も rotate 対象）。
 * - auth_hash も organization_id も未知 + tokenPoolEnabled=true:
 *     auto-discover INSERT（selectable=0）
 * - tokenPoolEnabled=false かつ未知 token: skip
 *
 * T323: 既知 token ヒット時（rotate 経路含む）に role が `master` / `conductor` の場合、
 *   `getState().masters.get(surface)?.tokenHandle` / `findConductor(state, surface)?.tokenHandle`
 *   を tok.handle で書き戻す（変更時のみ notifyStateChanged）。
 *   `role === "agent"` は spawn-agent 経路で AGENT_TOKEN_BOUND が確定するためここでは触らない。
 *   surface / role が空 / 未知の場合は handle 反映を skip（safety guard）。
 *
 * masking: ログ上の auth_hash は prefix 6 文字、organization_id は prefix 8 文字（T384）。
 *   DB 内の auth_hash は `computeProxyAuthHash` の戻り値である 12 文字フルを保持する。
 *
 * エラーは全て fire-and-forget（既存 traces.db 書き込みに影響させない）。
 */
function updateTokensDB(
  authHash: string | null,
  rl: RateLimitInfo | null,
  organizationId: string | null,
  surface: string | null,
  role: string | null,
  opts: { tokenPoolEnabled: boolean; getState?: () => any },
): void {
  if (!authHash) return;
  const db = getTokensDB();
  if (!db) return;
  if (!rl) return;

  const { tokenPoolEnabled, getState } = opts;

  try {
    // ── Phase 1: auth_hash で検索 ──
    let tok = getTokenByAuthHash(db, authHash);

    // ── Phase 2: auto-rotate（auth_hash mismatch だが organization_id 一致）──
    // OAuth refresh で auth_hash が乖離した既存 token を自動修復する（T384）。
    // tokenPoolEnabled には依存しない: pool OFF の手動運用でも rotate されないと
    // usage_snapshots の更新が永久に止まるため。
    if (!tok && organizationId) {
      const byOrg = getTokenByOrganizationId(db, organizationId);
      if (byOrg) {
        const oldAuthHash = byOrg.auth_hash;
        updateTokenAuth(db, byOrg.id, authHash);
        // 後続 UPSERT で参照する byOrg を新 auth_hash に差し替えて Phase 3 に流す
        tok = { ...byOrg, auth_hash: authHash };
        // ログ上は auth_hash 6 文字 / organization_id 8 文字に丸める
        log(
          "token_auto_rotated",
          `handle=${tok.handle} old_auth=${oldAuthHash.slice(0, 6)} ` +
            `new_auth=${authHash.slice(0, 6)} org=${organizationId.slice(0, 8)}`,
        ).catch(() => {});
      }
    }

    // ── Phase 3: tok があれば UPSERT 経路（既存 + auto-rotate 直後の合流点）──
    if (tok) {
      // throttle: 変化があるときのみ UPSERT
      const prev = getLatestUsageSnapshot(db, tok.id);
      const u5h = rl.unified5hUtilization;
      const u7d = rl.unified7dUtilization;
      const changed =
        prev == null ||
        (u5h != null && prev.util_5h != null && Math.abs(u5h - prev.util_5h) >= 0.01) ||
        (u7d != null && prev.util_7d != null && Math.abs(u7d - prev.util_7d) >= 0.01) ||
        (u5h != null && prev.util_5h == null) ||
        (u7d != null && prev.util_7d == null) ||
        rl.unified5hReset !== prev.reset_5h_at ||
        rl.unified7dReset !== prev.reset_7d_at ||
        (rl.unifiedStatus ?? null) !== prev.unified_status;

      if (changed) {
        upsertUsageSnapshot(db, {
          token_id: tok.id,
          util_5h: u5h,
          util_7d: u7d,
          reset_5h_at: rl.unified5hReset,
          reset_7d_at: rl.unified7dReset,
          unified_status: rl.unifiedStatus ?? null,
        });
      }

      // T323: surface ↔ tokenHandle 反映（master/conductor のみ。agent は AGENT_TOKEN_BOUND 経路）。
      // T384: auto-rotate 経路でも呼ぶ（rotate 後は新 auth_hash でヒットした token と同じ扱い）。
      if (surface && role && getState) {
        try {
          maybeApplyTokenHandle(getState(), surface, role, tok.handle);
        } catch (e: any) {
          log(
            "token_handle_apply_failed",
            `surface=${surface} role=${role} err=${e?.message ?? e}`,
          ).catch(() => {});
        }
      }
    } else if (organizationId) {
      // ── Phase 4: 真の新規 token（auth_hash も organization_id も未知）──
      if (!tokenPoolEnabled) {
        // T341: pool 機能 OFF では auto-discover INSERT を skip。
        // 既知 token の usage_snapshots UPSERT / auto-rotate は影響しない（上の分岐内で完結）。
        return;
      }
      // auto-discover: 未知アカウントを selectable=0 で登録
      const handle = genAutoDiscoverHandle(db, organizationId);
      insertToken(db, {
        handle,
        organization_id: organizationId,
        auth_hash: authHash,
        plan: "unknown",
        plan_ratio: null,
        tags: ["auto"],
        credential_source: "auto-discover",
        selectable: false,
      });
      log("token_auto_discovered", `handle=${handle} org=${organizationId.slice(0, 8)}`).catch(() => {});
    }
  } catch (e: any) {
    log("token_db_update_failed", `auth_hash=${authHash} err=${e?.message ?? e}`).catch(() => {});
  }
}

/**
 * T323: master/conductor の `tokenHandle` を proxy が観測した値で書き戻す。
 * 変更時のみ `notifyStateChanged("proxy:token-handle-resolved")` を発火する。
 * agent role は spawn-agent 経路で確定するためここでは何もしない。
 */
function maybeApplyTokenHandle(
  state: any,
  surface: string,
  role: string,
  handle: string,
): void {
  if (role === "master") {
    const m = state.masters?.get?.(surface);
    if (m && m.tokenHandle !== handle) {
      m.tokenHandle = handle;
      notifyStateChanged("proxy:token-handle-resolved");
    }
    return;
  }
  if (role === "conductor") {
    // findConductor は daemon.ts に export されている（循環参照を避けるため動的 import 不要）
    // proxy.ts は daemon.ts から呼ばれる構造なので state を直接探索する
    let target: any = null;
    if (state.conductors instanceof Map) {
      target = state.conductors.get(surface);
    } else if (state.conductors && typeof state.conductors === "object") {
      target = state.conductors[surface];
    }
    if (target && target.tokenHandle !== handle) {
      target.tokenHandle = handle;
      notifyStateChanged("proxy:token-handle-resolved");
    }
    return;
  }
  // role === "agent" or unknown role: 何もしない
}

// epoch 秒（10桁数値）または ISO 8601 文字列を受けて unix epoch 秒に正規化
// daemon.ts:1244-1245 / dashboard.tsx:189-195 と同じロジック — 別タスク（#175 等）で整理予定
function toEpochSec(raw: string | null): number | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (!isNaN(asNum) && asNum > 1e9) return Math.floor(asNum);
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}

// dashboard.tsx / daemon.ts からコピー — 別タスク（#175 等）で整理予定
function formatResetRemaining(resetIso: string | null): string {
  if (!resetIso) return "";
  const asNum = Number(resetIso);
  const resetMs = !isNaN(asNum) && asNum > 1e9 ? asNum * 1000 : new Date(resetIso).getTime();
  if (isNaN(resetMs)) return "";
  const sec = Math.floor((resetMs - Date.now()) / 1000);
  if (sec <= 0) return "0m";
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

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

/**
 * T305: api_usage 列用の rate limit / request_id ヘッダーを抽出する。
 * 既存 extractRateLimit は RateLimitInfo 専用（unified/TPM）なので用途が異なる。
 * 数値列は NaN を NULL に倒す。
 */
function extractRateLimitForApiUsage(headers: Headers): Pick<
  ApiUsageRecord,
  | "request_id"
  | "ratelimit_tokens_remaining"
  | "ratelimit_tokens_limit"
  | "ratelimit_tokens_reset"
  | "ratelimit_input_tokens_remaining"
  | "ratelimit_input_tokens_limit"
  | "ratelimit_input_tokens_reset"
  | "ratelimit_output_tokens_remaining"
  | "ratelimit_output_tokens_limit"
  | "ratelimit_output_tokens_reset"
  | "ratelimit_requests_remaining"
  | "ratelimit_requests_limit"
  | "ratelimit_requests_reset"
> {
  const intOrNull = (name: string): number | null => {
    const v = headers.get(name);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  const strOrNull = (name: string): string | null => headers.get(name) ?? null;

  return {
    request_id: strOrNull("anthropic-request-id"),
    ratelimit_tokens_remaining: intOrNull("anthropic-ratelimit-tokens-remaining"),
    ratelimit_tokens_limit: intOrNull("anthropic-ratelimit-tokens-limit"),
    ratelimit_tokens_reset: strOrNull("anthropic-ratelimit-tokens-reset"),
    ratelimit_input_tokens_remaining: intOrNull("anthropic-ratelimit-input-tokens-remaining"),
    ratelimit_input_tokens_limit: intOrNull("anthropic-ratelimit-input-tokens-limit"),
    ratelimit_input_tokens_reset: strOrNull("anthropic-ratelimit-input-tokens-reset"),
    ratelimit_output_tokens_remaining: intOrNull("anthropic-ratelimit-output-tokens-remaining"),
    ratelimit_output_tokens_limit: intOrNull("anthropic-ratelimit-output-tokens-limit"),
    ratelimit_output_tokens_reset: strOrNull("anthropic-ratelimit-output-tokens-reset"),
    ratelimit_requests_remaining: intOrNull("anthropic-ratelimit-requests-remaining"),
    ratelimit_requests_limit: intOrNull("anthropic-ratelimit-requests-limit"),
    ratelimit_requests_reset: strOrNull("anthropic-ratelimit-requests-reset"),
  };
}

/**
 * T305: insertApiUsage を try/catch で囲む thin wrapper。
 * WAL ディスクフル等で DB 書き込みが throw してもレスポンス転送を止めない。
 */
function safeInsertApiUsage(db: Database, record: ApiUsageRecord): void {
  try {
    insertApiUsage(db, record);
  } catch (e: any) {
    log(
      "api_usage_insert_failed",
      `${e?.message ?? "unknown"} task_id=${record.task_id ?? "-"} status=${record.status_code ?? "-"}`,
    ).catch(() => {});
  }
}

/**
 * T354: rate_limit_snapshots に 1 行 INSERT する。
 * - opts.db が無ければ skip
 * - rl が null、または 5h/7d util が両方 null なら skip（OAuth 未対応経路で空行を量産しない）
 * - 例外は握りつぶしてレスポンス転送を止めない
 */
function maybeInsertRateLimitSnapshot(
  db: Database | undefined,
  rl: RateLimitInfo | null,
): void {
  if (!db || !rl) return;
  if (rl.unified5hUtilization == null && rl.unified7dUtilization == null) return;
  try {
    insertRateLimitSnapshot(db, {
      timestamp: new Date().toISOString(),
      unified_5h_utilization: rl.unified5hUtilization,
      unified_5h_reset: rl.unified5hReset,
      unified_7d_utilization: rl.unified7dUtilization,
      unified_7d_reset: rl.unified7dReset,
    });
  } catch (e: any) {
    log(
      "rate_limit_snapshot_insert_failed",
      `${e?.message ?? "unknown"}`,
    ).catch(() => {});
  }
}

export async function start(
  projectRoot: string,
  opts?: {
    conductorSurface?: string;
    taskId?: string;
    role?: string;
    getState?: () => any;
    onMessage?: (msg: QueueMessage) => Promise<void>;
    /** T305: api_usage 書き込み先。未指定時は INSERT を skip（既存テスト互換）。 */
    db?: Database;
  }
): Promise<ProxyHandle> {
  const upstream = process.env.ANTHROPIC_API_URL || DEFAULT_UPSTREAM;
  const tracesDir = join(projectRoot, ".team/logs/traces");
  await mkdir(tracesDir, { recursive: true });

  const traceFile = join(tracesDir, "api-trace.jsonl");

  // T341: token pool 機能の有効/無効を proxy 起動時に 1 度だけ評価して
  // クロージャに束縛する。リクエスト毎の I/O を避ける目的。設定変更は
  // daemon 再起動を伴う前提で運用するため、proxy プロセス生存期間で固定する。
  const tokenPoolDecision = await isTokenPoolEnabled(projectRoot);
  const tokenPoolEnabled = tokenPoolDecision.enabled;
  log("proxy_token_pool_resolved", `enabled=${tokenPoolEnabled} source=${tokenPoolDecision.source}`).catch(() => {});

  // T367: pool-aware throttle 判定用の policy を proxy 起動時にクロージャ束縛する。
  // /rate-limit ハンドラから呼ぶ canSelectAnyToken に渡す。pool OFF / 構築失敗時は null。
  let cachedPoolPolicy: SelectTokenPolicy | null = null;
  if (tokenPoolEnabled) {
    try {
      cachedPoolPolicy = await buildSelectTokenPolicy(projectRoot);
    } catch (e: any) {
      log("proxy_pool_policy_failed", `err=${e?.message ?? e}`).catch(() => {});
    }
  }

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
            // T229: 複数 Master を配列化してシリアライズ（Map は JSON 不可）
            masters: [...(state.masters?.values() ?? [])].map((m) => ({
              surface: m.surface,
              status: m.status,
              pid: m.pid,
              startedAt: m.startedAt,
              disconnectedAt: m.disconnectedAt,
              prompt: m.prompt,
            })),
            lastUpdate: state.lastUpdate instanceof Date ? state.lastUpdate.toISOString() : state.lastUpdate,
          };
          return new Response(JSON.stringify(serialized), { headers: jsonHeaders });
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

        if (url.pathname === "/rate-limit") {
          if (!opts?.getState) {
            // 独立 proxy モード（daemon 外）: 安全側で throttled=false を返す
            return new Response(JSON.stringify({
              throttled: false,
              threshold: THROTTLE_5H_THRESHOLD,
              unified5hUtilization: null,
              unified5hReset: null,
              unified7dUtilization: null,
              unified7dReset: null,
              unifiedStatus: null,
              resetRemaining: null,
              pool: null,
            }), { headers: jsonHeaders });
          }
          const state = opts.getState();
          const rl = state.rateLimit;
          // T367: pool-aware throttle 判定。pool 有効時は canSelectAnyToken の真偽が真実、
          // pool 無効時は従来挙動（unified5hUtilization >= THROTTLE_5H_THRESHOLD）を完全保持。
          const db = tokenPoolEnabled ? getTokensDB() : null;
          const throttled = isThrottled5h(db, rl, {
            running: !!state.running,
            bootReady: state.bootPhase === "ready",
            policy: cachedPoolPolicy ?? undefined,
          });
          const poolInfo =
            db !== null && cachedPoolPolicy !== null ? countPoolTokens(db, cachedPoolPolicy) : null;
          const rawReset5h = rl?.unified5hReset ?? null;
          const rawReset7d = rl?.unified7dReset ?? null;
          const remaining = formatResetRemaining(rawReset5h);
          const resetRemaining = (!remaining || remaining === "0m" || remaining === "<1m") ? null : remaining;
          return new Response(JSON.stringify({
            throttled,
            threshold: THROTTLE_5H_THRESHOLD,
            unified5hUtilization: rl?.unified5hUtilization ?? null,
            unified5hReset: toEpochSec(rawReset5h),
            unified7dUtilization: rl?.unified7dUtilization ?? null,
            unified7dReset: toEpochSec(rawReset7d),
            unifiedStatus: rl?.unifiedStatus ?? null,
            resetRemaining,
            pool: poolInfo,
          }), { headers: jsonHeaders });
        }
      }

      // statusline 描画エンドポイント (T211)
      // bash 版 `statusline.sh` の代替。wrapper が Claude Code の
      // statusline JSON (stdin) をそのまま POST し、surface ヘッダーから
      // role を解決して 1 行テキストを返す。
      if (req.method === "POST" && url.pathname === "/statusline") {
        const textHeaders = { "Content-Type": "text/plain; charset=utf-8" };
        const surface = req.headers.get("x-cmux-surface") ?? "";
        if (!surface) {
          return new Response(JSON.stringify({ error: "surface required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (!opts?.getState) {
          return new Response(JSON.stringify({ error: "state unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        const nfRaw = req.headers.get("x-cmux-nerd-font");
        const nerdFont = nfRaw == null ? true : !(nfRaw === "0" || nfRaw.toLowerCase() === "false");
        const colorRaw = req.headers.get("x-cmux-statusline-color");
        const color = colorRaw != null && (colorRaw === "1" || colorRaw.toLowerCase() === "true");

        let input: StatuslineInput = {};
        try {
          const raw = await req.text();
          if (raw) input = JSON.parse(raw) as StatuslineInput;
        } catch {
          // 壊れた JSON は空 input として扱う（描画は続行）
          input = {};
        }

        const rawState = opts.getState();
        // T229: daemon の state.masters は Map。statusline は Array を要求するので変換。
        const state: StatuslineState = {
          ...rawState,
          masters: [...(rawState.masters?.values() ?? [])].map((m) => ({
            surface: m.surface,
            status: m.status,
            pid: m.pid,
          })),
        };
        const body = formatStatusline(input, state, { surface, nerdFont, color });
        return new Response(body, { status: 200, headers: textHeaders });
      }

      // Master 状態更新エンドポイント
      // T175: master-hook-busy.py / master-hook-stop.py から POST される。
      // state 書き換え後に notifyStateChanged で TUI 即時 refresh をトリガし、
      // 受信内容を manager.log に 1 行残して動作検証可能にする。
      if (req.method === "POST" && url.pathname === "/master-state") {
        if (!opts?.getState) return new Response("Not Found", { status: 404 });
        try {
          const body = await req.json() as { status?: string; prompt?: string; surface?: string };
          const state = opts.getState();
          // T229: surface を body で指定。未指定 & 単一 Master なら auto-resolve。
          // 複数 Master で未指定なら曖昧としてログに残して何もしない。
          let targetSurface: string | undefined = body.surface;
          if (!targetSurface) {
            const surfaces = [...state.masters.keys()];
            if (surfaces.length === 1) {
              targetSurface = surfaces[0];
            } else if (surfaces.length > 1) {
              log(
                "master_state_surface_ambiguous",
                `masters=${surfaces.length} status=${body.status ?? "?"}`
              ).catch(() => {});
              return new Response(
                JSON.stringify({ error: "surface required when multiple masters" }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            } else {
              return new Response(
                JSON.stringify({ error: "no masters" }),
                { status: 404, headers: { "Content-Type": "application/json" } },
              );
            }
          }
          const master = state.masters.get(targetSurface!);
          if (!master) {
            log(
              "master_state_surface_unknown",
              `surface=${targetSurface} status=${body.status ?? "?"}`
            ).catch(() => {});
            return new Response(
              JSON.stringify({ error: "unknown master surface" }),
              { status: 404, headers: { "Content-Type": "application/json" } },
            );
          }
          if (body.status === "busy") {
            master.status = "running";
          } else if (body.status === "idle") {
            master.status = "idle";
            master.prompt = undefined;
          }
          if (body.prompt != null) {
            master.prompt = body.prompt.slice(0, 80);
          }
          const promptTrim = (body.prompt ?? "").slice(0, 40).replace(/\s+/g, " ");
          log(
            "master_state",
            `surface=${targetSurface} status=${body.status ?? "?"} prompt=${promptTrim}`
          ).catch(() => {});
          if (body.status === "busy") {
            notifyStateChanged("proxy.ts:/master-state:busy");
          } else if (body.status === "idle") {
            notifyStateChanged("proxy.ts:/master-state:idle");
          } else if (body.prompt != null) {
            notifyStateChanged("proxy.ts:/master-state:prompt");
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
      // T323: x-cmux-surface ヘッダー優先（master/conductor/agent の per-surface 識別）。
      // x-cmux-conductor-id は legacy fallback として残す（旧 daemon / 旧 settings.json 経路）。
      const conductorSurface =
        req.headers.get("x-cmux-surface")
        || req.headers.get("x-cmux-conductor-id")
        || opts?.conductorSurface;
      const role = req.headers.get("x-cmux-role") || opts?.role;

      // リクエストボディを読み取り（転送用 + サイズ計測用）
      const reqBody = req.body ? await req.arrayBuffer() : null;
      const requestBytes = reqBody?.byteLength ?? 0;

      // T320: auth_hash を算出（Authorization header 全体を sha256）
      const authHash = computeProxyAuthHash(req.headers.get("authorization"));

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
        // T354: extractRateLimit を 1 度だけ呼び出し、DaemonState 反映 / snapshot INSERT /
        // tokens.db 更新で同じ rlStreaming を使い回す（design-review F5）。
        const rlStreaming = extractRateLimit(upstreamRes.headers);

        // レート制限ヘッダーを DaemonState に反映
        if (opts?.getState && rlStreaming) {
          opts.getState().rateLimit = rlStreaming;
          // 再起動時の stale 判定に使うため `.team/rate-limit.json` へ非同期永続化
          persistRateLimit(projectRoot, rlStreaming).catch((e: any) =>
            log("rate_limit_persist_failed", e.message).catch(() => {})
          );
        }

        // T354: rate_limit_snapshots に 1 行 INSERT（streaming path）。
        maybeInsertRateLimitSnapshot(opts?.db, rlStreaming);

        // T320/T323: tokens.db を fire-and-forget で更新（streaming path）。
        // surface / role / getState を渡して master/conductor の tokenHandle を反映する。
        // T341: tokenPoolEnabled で auto-discover INSERT を gate する。
        updateTokensDB(
          authHash,
          rlStreaming,
          upstreamRes.headers.get("anthropic-organization-id"),
          conductorSurface ?? null,
          role ?? null,
          { tokenPoolEnabled, getState: opts?.getState },
        );

        // streaming: tee して片方をログに使う
        const [clientStream, logStream] = upstreamRes.body.tee();

        // T305: api_usage 用に /v1/messages 完全一致を判定し、db と rate limit ヘッダーを
        // drainAndRecord に渡す。それ以外（JSONL / バイト数計測）は従来通り全 endpoint で行う。
        const isMessagesEndpoint =
          !!opts?.db && url.pathname === "/v1/messages";
        const { request_id: headerRequestId, ...rateLimits } = isMessagesEndpoint
          ? extractRateLimitForApiUsage(upstreamRes.headers)
          : { request_id: null as string | null };
        const apiUsageCtx = isMessagesEndpoint
          ? {
              db: opts!.db!,
              headerRequestId: headerRequestId ?? null,
              rateLimits: rateLimits as Omit<
                ReturnType<typeof extractRateLimitForApiUsage>,
                "request_id"
              >,
            }
          : null;

        // 非同期でログ書き込み（レスポンスはブロックしない）
        drainAndRecord(logStream, {
          tracesDir: traceFile,
          method: req.method,
          path: url.pathname,
          status: upstreamRes.status,
          requestBytes,
          startTime,
          conductorSurface,
          taskId,
          role,
          apiUsage: apiUsageCtx,
        }).catch((e: any) =>
          log("error", `drainAndRecord failed: ${e.message}`).catch(() => {})
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

      // T354: extractRateLimit を 1 度だけ呼び出し、3 経路で同じ rlNonStreaming を使い回す。
      const rlNonStreaming = extractRateLimit(upstreamRes.headers);

      // レート制限ヘッダーを DaemonState に反映
      if (opts?.getState && rlNonStreaming) {
        opts.getState().rateLimit = rlNonStreaming;
        persistRateLimit(projectRoot, rlNonStreaming).catch((e: any) =>
          log("rate_limit_persist_failed", e.message).catch(() => {})
        );
      }

      // T354: rate_limit_snapshots に 1 行 INSERT（非 streaming path）。
      maybeInsertRateLimitSnapshot(opts?.db, rlNonStreaming);

      // T320/T323: tokens.db を fire-and-forget で更新（非 streaming path）。
      // T341: tokenPoolEnabled で auto-discover INSERT を gate する。
      updateTokensDB(
        authHash,
        rlNonStreaming,
        upstreamRes.headers.get("anthropic-organization-id"),
        conductorSurface ?? null,
        role ?? null,
        { tokenPoolEnabled, getState: opts?.getState },
      );

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

      // T305: /v1/messages 完全一致の非 streaming レスポンスは api_usage にも INSERT。
      // JSONL と並存。db 未指定時は skip（既存テスト互換）。
      if (opts?.db && url.pathname === "/v1/messages") {
        const { request_id: headerRequestId, ...rateLimits } =
          extractRateLimitForApiUsage(upstreamRes.headers);
        let model: string | null = null;
        let requestId: string | null = headerRequestId ?? null;
        let inputTokens: number | null = null;
        let outputTokens: number | null = null;
        let cacheCreationInputTokens: number | null = null;
        let cacheReadInputTokens: number | null = null;
        let stopReason: string | null = null;
        let errorType: string | null = null;

        const parsedOk = upstreamRes.ok;
        try {
          const text = new TextDecoder().decode(resBody);
          const json = text ? JSON.parse(text) : null;
          if (json && typeof json === "object") {
            if (parsedOk) {
              // 成功レスポンス: ルートに model / stop_reason / usage
              model = typeof json.model === "string" ? json.model : null;
              requestId = typeof json.id === "string" ? json.id : requestId;
              stopReason =
                typeof json.stop_reason === "string" ? json.stop_reason : null;
              const usage = json.usage;
              if (usage && typeof usage === "object") {
                inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
                outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
                cacheCreationInputTokens =
                  typeof usage.cache_creation_input_tokens === "number"
                    ? usage.cache_creation_input_tokens
                    : null;
                cacheReadInputTokens =
                  typeof usage.cache_read_input_tokens === "number"
                    ? usage.cache_read_input_tokens
                    : null;
              }
            } else {
              // エラーレスポンス: error.type を拾う
              const err = json.error;
              if (err && typeof err === "object" && typeof err.type === "string") {
                errorType = err.type;
              }
            }
          }
        } catch {
          if (!parsedOk) {
            errorType = `http_${upstreamRes.status}`;
          } else {
            errorType = "parse_failed";
          }
        }
        if (!parsedOk && !errorType) {
          errorType = `http_${upstreamRes.status}`;
        }

        safeInsertApiUsage(opts.db, {
          timestamp: new Date().toISOString(),
          task_id: taskId ?? null,
          role: role ?? null,
          surface: conductorSurface ?? null,
          conductor_id: conductorSurface ?? null,
          model,
          request_id: requestId,
          status_code: upstreamRes.status,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
          cache_read_input_tokens: cacheReadInputTokens,
          stop_reason: stopReason,
          duration_ms: duration,
          ...rateLimits,
          error: errorType,
        });
      }

      return new Response(resBody, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders,
      });
  };  // fetchHandlerInner end

  // 前回ポートで起動を試み、失敗時はランダムポートにフォールバック
  // idleTimeout: Bun.serve のデフォルト 10s では Claude API の長時間 SSE ストリーム
  // (Implementer の拡張思考など) が途中で切れるため、最大値 255s まで延長する。
  // 個別に更に長い timeout が必要な場合は server.timeout(req, sec) で上書き可能。
  const IDLE_TIMEOUT_SEC = 255;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port: preferredPort, fetch: fetchHandler, idleTimeout: IDLE_TIMEOUT_SEC, development: false, error(e) { log("proxy_server_error", e.message).catch(() => {}); return new Response("Internal Server Error", { status: 500 }); } });
  } catch (e: any) {
    if (preferredPort !== 0) {
      await log("proxy_port_fallback", `preferred=${preferredPort} error=${e.message}`);
      server = Bun.serve({ port: 0, fetch: fetchHandler, idleTimeout: IDLE_TIMEOUT_SEC, development: false, error(e) { log("proxy_server_error", e.message).catch(() => {}); return new Response("Internal Server Error", { status: 500 }); } });
    } else {
      throw new Error("Failed to start proxy");
    }
  }

  return {
    port: server.port!,
    stop: () => { server.stop(); },
  };
}

/**
 * T305: streaming レスポンスを drain し、バイト数（JSONL）と
 * /v1/messages の SSE usage（api_usage テーブル）を記録する。
 *
 * SSE パーサ方針:
 * - TextDecoder({ stream: true }) で chunk をデコード。終端で decoder.decode() を呼んで flush
 * - 内部バッファに append → \n で split → 完全行のみ処理 → 最後の不完全行はバッファに残す
 * - 各行は line.replace(/\r$/, "") で末尾 \r を剥がす
 * - ストリーム終端で残った不完全行は破棄（SSE は \n\n 区切りで event/data ペアが途切れたら不正）
 * - event: <name> を見たら pendingEvent にセット、次の data: 行を pendingEvent で分岐して parse
 * - 関心イベント: message_start / message_delta / message_stop / error のみ JSON.parse
 * - 他のイベント（content_block_delta 等）は parse しない（性能確保）
 */
async function drainAndRecord(
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
    apiUsage: {
      db: Database;
      headerRequestId: string | null;
      rateLimits: Omit<
        ReturnType<typeof extractRateLimitForApiUsage>,
        "request_id"
      >;
    } | null;
  }
): Promise<void> {
  let responseBytes = 0;
  const reader = stream.getReader();

  // SSE parser state (apiUsage !== null のときのみ更新される)
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let pendingEvent: string | null = null;
  let model: string | null = null;
  let sseRequestId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheCreationInputTokens: number | null = null;
  let cacheReadInputTokens: number | null = null;
  let stopReason: string | null = null;
  let sseError: string | null = null;
  let streamAborted = false;

  const INTERESTING_EVENTS = new Set([
    "message_start",
    "message_delta",
    "message_stop",
    "error",
  ]);

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      // 空行は event/data ペアの区切り。pendingEvent は data 行到達時にクリアするが、
      // 念のためここでもクリアする（`event:` 単独行 + 空行のケース）。
      pendingEvent = null;
      return;
    }
    if (line.startsWith("event: ")) {
      const name = line.slice(7).trim();
      pendingEvent = INTERESTING_EVENTS.has(name) ? name : null;
      return;
    }
    if (line.startsWith("data: ")) {
      if (!pendingEvent) {
        // 関心外の event は parse しない（content_block_delta 等）
        return;
      }
      const jsonText = line.slice(6);
      const currentEvent = pendingEvent;
      pendingEvent = null;
      try {
        const obj = JSON.parse(jsonText) as any;
        if (currentEvent === "message_start") {
          const msg = obj?.message;
          if (msg && typeof msg === "object") {
            if (typeof msg.model === "string") model = msg.model;
            if (typeof msg.id === "string") sseRequestId = msg.id;
            const usage = msg.usage;
            if (usage && typeof usage === "object") {
              if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
              if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
              if (typeof usage.cache_creation_input_tokens === "number") {
                cacheCreationInputTokens = usage.cache_creation_input_tokens;
              }
              if (typeof usage.cache_read_input_tokens === "number") {
                cacheReadInputTokens = usage.cache_read_input_tokens;
              }
            }
          }
        } else if (currentEvent === "message_delta") {
          // output_tokens は累積値。複数回発火を想定し毎回上書き
          const usage = obj?.usage;
          if (usage && typeof usage === "object" && typeof usage.output_tokens === "number") {
            outputTokens = usage.output_tokens;
          }
          const delta = obj?.delta;
          if (delta && typeof delta === "object" && typeof delta.stop_reason === "string") {
            stopReason = delta.stop_reason;
          }
        } else if (currentEvent === "error") {
          const err = obj?.error;
          if (err && typeof err === "object" && typeof err.type === "string") {
            sseError = err.type;
          }
        }
        // message_stop は parse するだけで特に状態更新なし（終端シグナル）
      } catch {
        // 不正 JSON — 次行以降で拾えるので継続
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (ctx.apiUsage) {
        buffer += decoder.decode(value, { stream: true });
        let nlIdx = buffer.indexOf("\n");
        while (nlIdx !== -1) {
          const line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);
          processLine(line);
          nlIdx = buffer.indexOf("\n");
        }
      }
    }
    if (ctx.apiUsage) {
      // ストリーム終端で decoder を flush（マルチバイト境界の残骸回収）
      const tail = decoder.decode();
      if (tail) buffer += tail;
      // 終端到達時の不完全行（\n 未到達）は破棄する
    }
  } catch (e: any) {
    // クライアント切断等は無視するが、予期しないエラーは記録
    if (!e.message?.includes("closed") && !e.message?.includes("aborted")) {
      log("proxy_stream_error", e.message).catch(() => {});
    }
    streamAborted = true;
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

  // JSONL ログ
  appendFile(ctx.tracesDir, JSON.stringify(entry) + "\n").catch(() => {});

  // T305: api_usage に SSE 集約結果 + ヘッダー情報で 1 回 INSERT
  if (ctx.apiUsage) {
    let errorValue: string | null = sseError;
    if (!errorValue && streamAborted) {
      errorValue = "stream_aborted";
    }
    if (!errorValue && ctx.status >= 400) {
      errorValue = `http_${ctx.status}`;
    }
    safeInsertApiUsage(ctx.apiUsage.db, {
      timestamp: new Date().toISOString(),
      task_id: ctx.taskId ?? null,
      role: ctx.role ?? null,
      surface: ctx.conductorSurface ?? null,
      conductor_id: ctx.conductorSurface ?? null,
      model,
      // request_id: ヘッダー優先、なければ SSE message_start
      request_id: ctx.apiUsage.headerRequestId ?? sseRequestId,
      status_code: ctx.status,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      stop_reason: stopReason,
      duration_ms: duration,
      ...ctx.apiUsage.rateLimits,
      error: errorValue,
    });
  }
}
