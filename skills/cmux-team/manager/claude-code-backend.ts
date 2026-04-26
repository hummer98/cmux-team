/**
 * ClaudeCodeBackend — RuntimeBackend の Claude Code CLI アダプタ実装。
 *
 * Issue #30 M3: 既存の hook 配管 / PID watcher / cmux send / /clear / read-screen /
 * proxy ヘッダ注入を 1 ファイルに凝集する。daemon コアは RuntimeBackend interface
 * 経由でのみ runtime 操作を行う。
 *
 * 現状: 骨格実装（M2 interface を満たす stub）。
 * M3 PR-1 でコアロジックを移植する。
 */

import * as cmux from "./cmux";
import { log, formatSurface } from "./logger";
import type {
  RuntimeBackend,
  RuntimeEvent,
  SessionRef,
  PermissionRef,
  SpawnOptions,
  PermissionReply,
} from "./runtime-backend";
import type { QueueMessage } from "./schema";

// ---------------------------------------------------------------------------
// ClaudeCodeBackend 固有の SpawnOptions 拡張
// ---------------------------------------------------------------------------

/**
 * ClaudeCodeBackend.spawn() が受け取るオプション。
 * RuntimeBackend.SpawnOptions を拡張し、Claude Code（cmux）固有のフィールドを追加する。
 * opencode backend では不要なフィールドのため RuntimeBackend interface には含めない。
 */
export interface ClaudeCodeSpawnOptions extends SpawnOptions {
  /** cmux surface ID（Claude Code 固有 — opencode では不要） */
  surface: string;
  /**
   * conductor / master ロール起動コマンド（例: "cmux-team conductor"）。
   * 末尾 `\n` がなければ自動付加する。
   */
  launchCmd: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** surface:NNN と SessionRef の相互変換用 */
function toSessionRef(surface: string): SessionRef {
  return surface as SessionRef;
}

function fromSessionRef(ref: SessionRef): string {
  return ref as string;
}

/** permission_asked イベントで渡す PermissionRef（surface:NNN のまま使用） */
function toPermissionRef(surface: string): PermissionRef {
  return surface as PermissionRef;
}

// ---------------------------------------------------------------------------
// ClaudeCodeBackend
// ---------------------------------------------------------------------------

export class ClaudeCodeBackend implements RuntimeBackend {
  private readonly listeners: Set<(event: RuntimeEvent) => void> = new Set();
  private readonly pidWatchers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private disposed = false;

  /**
   * surface 文字列を SessionRef に変換するヘルパー。
   * conductor.ts の assignTask / resetConductor から surface → SessionRef への変換に使う。
   */
  surfaceToRef(surface: string): SessionRef {
    return toSessionRef(surface);
  }

  /**
   * 新しいセッションを spawn する。
   *
   * Claude Code CLI の場合、Conductor は既に cmux ペインとして常駐しているため、
   * "spawn" は実質的に「surface に Claude CLI 起動コマンドを送信する」操作になる。
   *
   * ClaudeCodeSpawnOptions を受け取り:
   *   1. env が指定されていればシェルに `export KEY=VAL ...` を送信（500ms wait）
   *   2. launchCmd を送信（末尾 `\n` 自動付加）
   */
  async spawn(options: ClaudeCodeSpawnOptions): Promise<SessionRef> {
    if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
    const { surface, launchCmd, env } = options;
    // 1. 環境変数をシェルに焼き付け
    if (env && Object.keys(env).length > 0) {
      const envStr = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      await cmux.send(surface, `export ${envStr}\n`);
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    // 2. CLI を起動（シェルへのコマンド送信。TUI 経路の send/reset と異なり \n で execute する）
    const cmd = launchCmd.endsWith("\n") ? launchCmd : `${launchCmd}\n`;
    await cmux.send(surface, cmd);
    return toSessionRef(surface);
  }

  /**
   * リクエストメタデータを設定する。
   * Claude Code backend では ANTHROPIC_CUSTOM_HEADERS 経由で注入するため no-op。
   * opencode backend では provider.options.headers に注入する想定。
   */
  setRequestMetadata(_metadata: Record<string, string>): void {
    // no-op: Claude Code では proxy / ANTHROPIC_CUSTOM_HEADERS 経由で処理される
  }

  /**
   * 既存セッションにメッセージを送信する（cmux send + send-key return）。
   *
   * Claude Code TUI への入力は `cmux send` の raw text の後に `cmux send-key return`
   * で確定する必要がある（長文プロンプトは末尾 `\n` だけでは確定されない）。
   * 末尾 `\n` は剥がして送る — 確定は send-key return が担う。
   */
  async send(sessionRef: SessionRef, message: string): Promise<void> {
    if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
    const surface = fromSessionRef(sessionRef);
    const body = message.endsWith("\n") ? message.slice(0, -1) : message;
    await cmux.send(surface, body);
    await cmux.sendKey(surface, "return");
  }

  /**
   * セッションをリセットする（/clear 送信 + 新プロンプト投入）。
   * Claude Code では session を destroy できないため、/clear でコンテキストをクリアし
   * 新しいプロンプトを送信することでリセットとみなす。
   * 返り値は同一 sessionRef（surface は変わらない）。
   */
  async reset(sessionRef: SessionRef, prompt: string): Promise<SessionRef> {
    if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
    const surface = fromSessionRef(sessionRef);
    // /clear → enter で確定、500ms 待って TUI のクリアを待ってから新プロンプトを投入する。
    // M3 PR-2 で SESSION_CLEAR → session_reset イベントの発火と組み合わせる。
    await cmux.send(surface, "/clear");
    await cmux.sendKey(surface, "return");
    await new Promise((r) => setTimeout(r, 500));
    const body = prompt.endsWith("\n") ? prompt.slice(0, -1) : prompt;
    await cmux.send(surface, body);
    await cmux.sendKey(surface, "return");
    return sessionRef; // surface は変わらない
  }

  /**
   * セッションを強制終了する（cmux close-surface）。
   * idempotent — 既に閉じている場合はエラーを無視する。
   */
  async kill(sessionRef: SessionRef): Promise<void> {
    if (this.disposed) return;
    const surface = fromSessionRef(sessionRef);
    this.stopPidWatcher(surface);
    try {
      await cmux.closeSurface(surface);
    } catch {
      // 既に閉じている場合は無視（idempotent）
    }
  }

  /**
   * パーミッション要求に応答する（cmux read-screen で確認 → send-key return で承認）。
   *
   * NOTE: M3 PR-1 で read-screen による Trust 確認自動承認ロジックを移植する。
   *       現状は "once" のみ send-key return で承認、"deny" / "always" は未実装。
   */
  async reply(permissionRef: PermissionRef, response: PermissionReply): Promise<void> {
    if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
    const surface = fromSessionRef(permissionRef as unknown as SessionRef);
    if (response === "once" || response === "always") {
      await cmux.sendKey(surface, "return");
    } else {
      // deny: Ctrl+C で拒否
      await cmux.sendKey(surface, "q");
    }
  }

  /**
   * 正規化イベントのコールバックを登録する。
   * Claude Code アダプタでは hook push（SESSION_* / NOTIFICATION）をキューから受け取り、
   * 正規化イベントに変換して emit する。
   * この変換ロジックは M3 PR-2 で daemon.ts の handleMessage から移植する。
   */
  onEvent(callback: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** 正規化イベントをリスナーに配信する（daemon.ts からの呼び出し用。M3 PR-2 で削除予定）。 */
  emitEvent(event: RuntimeEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (e: any) {
        log("error", `ClaudeCodeBackend.emitEvent listener threw: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * backend を閉じる。
   * 全 PID watcher を停止する。proxy の停止は呼び出し元（daemon.ts）が行う。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [surface] of Array.from(this.pidWatchers)) {
      this.stopPidWatcher(surface);
    }
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // PID watcher helpers（M3 PR-2 で spawnPidWatcher から移植）
  // ---------------------------------------------------------------------------

  /**
   * PID watcher を起動して、プロセス死亡時に `session_ended` イベントを emit し
   * onDead コールバックを呼ぶ。
   * 1 秒間隔で `process.kill(pid, 0)` を試み、ESRCH/EPERM で死亡を検知する。
   * 同一 surface の watcher が既に起動中なら事前に停止してから再登録する（冪等）。
   */
  startPidWatcher(surface: string, pid: number, onDead: () => void): void {
    if (this.pidWatchers.has(surface)) this.stopPidWatcher(surface);
    const interval = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        this.stopPidWatcher(surface);
        // session_ended イベントを emit して daemon コアに通知
        this.emitEvent({
          type: "session_ended",
          sessionRef: toSessionRef(surface),
          reason: "aborted",
        });
        onDead();
      }
    }, 1000);
    this.pidWatchers.set(surface, interval);
  }

  stopPidWatcher(surface: string): void {
    const interval = this.pidWatchers.get(surface);
    if (interval) {
      clearInterval(interval);
      this.pidWatchers.delete(surface);
    }
  }

  // ---------------------------------------------------------------------------
  // Hook signal → 正規化イベント変換（M3-b Phase 1）
  // ---------------------------------------------------------------------------

  /**
   * Claude Code の hook signal（SESSION_* / NOTIFICATION）を受け取り、
   * 正規化 RuntimeEvent に変換して emit する。
   *
   * daemon.ts の handleMessage 入口で呼ぶことで、hook signal が来るたびに
   * backend.onEvent リスナーにも届く。SESSION_* の state 遷移ロジックは
   * 引き続き handleMessage 内で処理される（M3-b Phase 2 で移植予定）。
   *
   * 変換ルール:
   *   SESSION_STARTED  → session_started
   *   SESSION_IDLE     → session_idle
   *   SESSION_STOP     → session_idle  （SESSION_IDLE に合流）
   *   SESSION_ACTIVE   → session_started
   *   SESSION_CLEAR    → session_reset
   *   SESSION_ENDED    → session_ended
   *   SESSION_ASK      → session_ask
   *   NOTIFICATION     → permission_asked
   *   その他            → 変換しない（emit しない）
   */
  acceptHookSignal(msg: QueueMessage): void {
    if (this.disposed) return;
    const surface = ("surface" in msg && typeof msg.surface === "string") ? msg.surface : undefined;
    if (!surface) return;
    const ref = toSessionRef(surface);

    let event: RuntimeEvent | null = null;
    switch (msg.type) {
      case "SESSION_STARTED":
      case "SESSION_ACTIVE":
        event = { type: "session_started", sessionRef: ref };
        break;
      case "SESSION_IDLE":
      case "SESSION_STOP":
        event = { type: "session_idle", sessionRef: ref };
        break;
      case "SESSION_CLEAR":
        event = { type: "session_reset", sessionRef: ref };
        break;
      case "SESSION_ENDED":
        event = { type: "session_ended", sessionRef: ref, reason: "completed" };
        break;
      case "SESSION_ASK": {
        const q = ("question" in msg && typeof msg.question === "string") ? msg.question : undefined;
        event = { type: "session_ask", sessionRef: ref, question: q };
        break;
      }
      case "NOTIFICATION": {
        const title = ("message" in msg && typeof msg.message === "string") ? msg.message : "permission_request";
        const permRef = toPermissionRef(surface);
        event = { type: "permission_asked", sessionRef: ref, permissionRef: permRef, title };
        break;
      }
    }
    if (event) this.emitEvent(event);
  }
}
