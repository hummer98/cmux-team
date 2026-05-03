/**
 * OpenCodeBackend — RuntimeBackend の opencode アダプタ実装（PoC）。
 *
 * Issue #30 M4: opencode REST API / SSE を使って RuntimeBackend interface を実装する。
 * Claude Code 固有の概念（cmux surface / PID / hook / /clear）は一切使わない。
 *
 * 実装状況:
 *   - spawn / send / kill / onEvent / dispose: 実装済み
 *   - reset: abort + delete + re-create で実装
 *   - reply: permission.updated → postSessionIdPermissionsPermissionId で実装
 *   - env / metadata 注入: PoC スコープ外（TODO）
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { log } from "./logger";
import type {
  RuntimeBackend,
  RuntimeEvent,
  SessionRef,
  PermissionRef,
  SpawnOptions,
  PermissionReply,
  ResetOptions,
} from "./runtime-backend";

// ---------------------------------------------------------------------------
// OpenCodeBackend 固有の SpawnOptions 拡張
// ---------------------------------------------------------------------------

export interface OpenCodeSpawnOptions extends SpawnOptions {
  /** opencode server の base URL（デフォルト: http://localhost:54321）。spawn ごとに上書き可 */
  serverUrl?: string;
}

// ---------------------------------------------------------------------------
// 内部型
// ---------------------------------------------------------------------------

/** PermissionRef のエンコード形式: "sessionId::permissionId" */
const PERM_SEP = "::";

function encodePermRef(sessionId: string, permId: string): PermissionRef {
  return `${sessionId}${PERM_SEP}${permId}` as PermissionRef;
}

function decodePermRef(ref: PermissionRef): { sessionId: string; permId: string } {
  const idx = (ref as string).indexOf(PERM_SEP);
  return {
    sessionId: (ref as string).slice(0, idx),
    permId: (ref as string).slice(idx + PERM_SEP.length),
  };
}

// ---------------------------------------------------------------------------
// OpenCodeBackend
// ---------------------------------------------------------------------------

export class OpenCodeBackend implements RuntimeBackend {
  private readonly client: OpencodeClient;
  private readonly listeners: Set<(event: RuntimeEvent) => void> = new Set();
  private abortController: AbortController | null = null;
  private eventLoopPromise: Promise<void> | null = null;
  private disposed = false;

  /** reset 時に workdir を再利用するためのセッション情報キャッシュ */
  private readonly sessionMeta: Map<string, { workdir: string; role: string }> = new Map();

  constructor(private readonly serverUrl = "http://localhost:54321") {
    this.client = createOpencodeClient({ baseUrl: serverUrl });
    this.startEventLoop();
  }

  // ---------------------------------------------------------------------------
  // RuntimeBackend interface
  // ---------------------------------------------------------------------------

  /**
   * 新しい opencode セッションを作成して初回プロンプトを送信する。
   * workdir を directory として opencode に渡す。
   */
  async spawn(options: SpawnOptions): Promise<SessionRef> {
    if (this.disposed) throw new Error("OpenCodeBackend: already disposed");
    const { role, prompt, workdir } = options;

    const res = await this.client.session.create({
      body: { title: role },
      query: { directory: workdir },
    });
    const session = res.data;
    if (!session) throw new Error("OpenCodeBackend: session.create returned no data");

    const sessionId = session.id;
    this.sessionMeta.set(sessionId, { workdir, role });

    // 初回プロンプトを送信
    await this.client.session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: prompt }] },
    });

    log("opencode_session_spawned", `id=${sessionId} role=${role} workdir=${workdir}`);
    return sessionId as SessionRef;
  }

  /**
   * 既存セッションにメッセージを送信する。
   */
  async send(sessionRef: SessionRef, message: string): Promise<void> {
    if (this.disposed) throw new Error("OpenCodeBackend: already disposed");
    await this.client.session.promptAsync({
      path: { id: sessionRef as string },
      body: { parts: [{ type: "text", text: message }] },
    });
  }

  /**
   * セッションをリセットする（T421: abort + delete → 新セッション作成）。
   * workdir は spawn 時のキャッシュから復元する。
   * `opts.launchCmd` は opencode の context では使わない（spawn で session API を叩くため）。
   * `opts.pid` は opencode では PID を持たないため無視。
   * 返り値は新しい sessionRef。
   */
  async reset(sessionRef: SessionRef, _opts: ResetOptions): Promise<SessionRef> {
    if (this.disposed) throw new Error("OpenCodeBackend: already disposed");
    const id = sessionRef as string;
    const meta = this.sessionMeta.get(id) ?? { workdir: ".", role: "agent" };

    try { await this.client.session.abort({ path: { id } }); } catch { /* 終了済みなら無視 */ }
    try { await this.client.session.delete({ path: { id } }); } catch { /* 削除済みなら無視 */ }
    this.sessionMeta.delete(id);

    // 新しいセッションを作成。opencode は session.create + chat send で完結するため、
    // T421 の launchCmd（spawn-conductor シェルコマンド）はここでは無視する。プロンプトは
    // PoC スコープ外（TODO）として空文字で spawn する。
    const newRef = await this.spawn({ role: meta.role as "master" | "conductor" | "agent", prompt: "", workdir: meta.workdir });
    log("opencode_session_reset", `old=${id} new=${newRef}`);
    return newRef;
  }

  /**
   * セッションを強制終了する（abort のみ、idempotent）。
   * opencode ではセッションを delete せず abort のみ行う。
   */
  async kill(sessionRef: SessionRef): Promise<void> {
    if (this.disposed) return;
    const id = sessionRef as string;
    this.sessionMeta.delete(id);
    try {
      await this.client.session.abort({ path: { id } });
    } catch {
      // 既に終了済みなら無視（idempotent）
    }
  }

  /**
   * パーミッション要求に応答する。
   * PermissionRef は "sessionId::permissionId" 形式でエンコードされている。
   */
  async reply(permissionRef: PermissionRef, response: PermissionReply): Promise<void> {
    if (this.disposed) throw new Error("OpenCodeBackend: already disposed");
    const { sessionId, permId } = decodePermRef(permissionRef);
    // opencode API: "once" | "always" | "reject"（RuntimeBackend の "deny" → "reject" に変換）
    const apiResponse = response === "deny" ? "reject" : response;
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permId },
      body: { response: apiResponse as "once" | "always" | "reject" },
    });
  }

  /**
   * 正規化イベントのコールバックを登録する。
   */
  onEvent(callback: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * backend を閉じる。SSE ストリームを abort してリソースを解放する。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    try { await this.eventLoopPromise; } catch { /* abort による rejection は無視 */ }
    this.listeners.clear();
    this.sessionMeta.clear();
  }

  // ---------------------------------------------------------------------------
  // SSE イベントループ
  // ---------------------------------------------------------------------------

  /**
   * opencode SSE ストリームを購読し、正規化 RuntimeEvent に変換して emit する。
   * dispose() が呼ばれるまでループを維持する。
   */
  private startEventLoop(): void {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.eventLoopPromise = (async () => {
      try {
        const result = await this.client.event.subscribe({ signal });
        for await (const raw of result.stream) {
          if (this.disposed) break;
          this.handleRawEvent(raw);
        }
      } catch (e: any) {
        if (!this.disposed) {
          log("error", `opencode_event_loop error: ${e?.message ?? e}`);
        }
      }
    })();
  }

  /**
   * opencode SSE イベントを正規化 RuntimeEvent に変換して emit する。
   *
   * 変換ルール:
   *   session.idle      → session_idle
   *   session.status(idle)  → session_idle
   *   session.status(busy)  → session_started
   *   permission.updated    → permission_asked
   *   session.deleted       → session_ended（reason: completed）
   *   session.error         → session_ended（reason: error）
   */
  private handleRawEvent(raw: unknown): void {
    const ev = raw as { type: string; properties?: Record<string, unknown> };
    if (!ev || typeof ev.type !== "string") return;

    const props = ev.properties ?? {};

    switch (ev.type) {
      case "session.idle": {
        const sessionID = props["sessionID"] as string | undefined;
        if (sessionID) {
          this.emitEvent({ type: "session_idle", sessionRef: sessionID as SessionRef });
        }
        break;
      }

      case "session.status": {
        const sessionID = props["sessionID"] as string | undefined;
        const status = props["status"] as { type: string } | undefined;
        if (!sessionID || !status) break;
        if (status.type === "idle") {
          this.emitEvent({ type: "session_idle", sessionRef: sessionID as SessionRef });
        } else if (status.type === "busy") {
          this.emitEvent({ type: "session_started", sessionRef: sessionID as SessionRef });
        }
        break;
      }

      case "permission.updated": {
        // properties は Permission 型: { id, type, sessionID, title, ... }
        const perm = props as { id: string; sessionID: string; title: string; metadata?: unknown };
        if (perm.sessionID && perm.id) {
          this.emitEvent({
            type: "permission_asked",
            sessionRef: perm.sessionID as SessionRef,
            permissionRef: encodePermRef(perm.sessionID, perm.id),
            title: perm.title ?? "permission_request",
          });
        }
        break;
      }

      case "session.deleted": {
        const info = props["info"] as { id: string } | undefined;
        if (info?.id) {
          this.emitEvent({ type: "session_ended", sessionRef: info.id as SessionRef, reason: "completed" });
        }
        break;
      }

      case "session.error": {
        const sessionID = props["sessionID"] as string | undefined;
        if (sessionID) {
          this.emitEvent({ type: "session_ended", sessionRef: sessionID as SessionRef, reason: "error" });
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ヘルパー
  // ---------------------------------------------------------------------------

  private emitEvent(event: RuntimeEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (e: any) {
        log("error", `OpenCodeBackend.emitEvent listener threw: ${e?.message ?? e}`);
      }
    }
  }
}
