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
   * 新しいセッションを spawn する。
   *
   * Claude Code CLI の場合、Conductor は既に cmux ペインとして常駐しているため、
   * "spawn" は実質的に「surface に Claude CLI 起動コマンドを送信する」操作になる。
   *
   * NOTE: M3 実装では launchConductor / spawnMaster の中身をここに移植する。
   *       現状 stub は surface を options の workdir から推測していない（未実装）。
   */
  async spawn(options: SpawnOptions): Promise<SessionRef> {
    throw new Error(
      "ClaudeCodeBackend.spawn: not yet implemented — " +
        "surface は外部（daemon.ts）から渡す必要がある。M3 PR-1 で実装。",
    );
  }

  /**
   * 既存セッションにメッセージを送信する（cmux send + send-key return）。
   */
  async send(sessionRef: SessionRef, message: string): Promise<void> {
    if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
    const surface = fromSessionRef(sessionRef);
    await cmux.send(surface, message.endsWith("\n") ? message : `${message}\n`);
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
    // /clear を送信して SESSION_CLEAR hook が返るのを待つ（現状は fire-and-forget）。
    // M3 PR-2 で SESSION_CLEAR → session_reset イベントの発火と組み合わせる。
    await cmux.send(surface, "/clear\n");
    await new Promise((r) => setTimeout(r, 500));
    await cmux.send(surface, prompt.endsWith("\n") ? prompt : `${prompt}\n`);
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
   * PID watcher を起動して、プロセス死亡時に session_ended を emit する。
   * 現状は骨格のみ。M3 PR-2 で spawnMasterPidWatcher / spawnConductorPidWatcher から移植する。
   */
  startPidWatcher(surface: string, pid: number, onDead: () => void): void {
    if (this.pidWatchers.has(surface)) this.stopPidWatcher(surface);
    const interval = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        this.stopPidWatcher(surface);
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
}
