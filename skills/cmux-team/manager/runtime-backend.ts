/**
 * RuntimeBackend — runtime-agnostic interface for session lifecycle control.
 *
 * Issue #30 M2: opencode API 形式ベースで定義。
 * Claude Code 固有の概念（/clear / SESSION_* / PID / ANTHROPIC_BASE_URL 等）は
 * この interface に出現しない。
 */

// ---------------------------------------------------------------------------
// Opaque reference types
// ---------------------------------------------------------------------------

/** runtime が発行するセッション識別子（実装は sessionId / surface:NNN / 任意文字列） */
export type SessionRef = string & { readonly __brand: "SessionRef" };

/** runtime が発行するパーミッション識別子 */
export type PermissionRef = string & { readonly __brand: "PermissionRef" };

// ---------------------------------------------------------------------------
// Normalized event alphabet
// ---------------------------------------------------------------------------

/**
 * 全 backend から daemon コアに届く正規化済みイベント。
 *
 * Claude Code hook ↔ opencode SSE の対応:
 *   SESSION_STARTED    → session_started   ← session.status(running) / SESSION_STARTED hook
 *   SESSION_IDLE       → session_idle      ← session.idle           / SESSION_IDLE hook
 *   SESSION_CLEAR      → session_reset     ← session delete+create  / SESSION_CLEAR hook
 *   SESSION_ENDED      → session_ended     ← session.status(stopped)/ SESSION_ENDED hook
 *   NOTIFICATION       → permission_asked  ← permission.updated     / NOTIFICATION hook
 */
export type RuntimeEvent =
  | SessionStartedEvent
  | SessionIdleEvent
  | SessionResetEvent
  | SessionEndedEvent
  | PermissionAskedEvent;

export interface SessionStartedEvent {
  type: "session_started";
  sessionRef: SessionRef;
}

export interface SessionIdleEvent {
  type: "session_idle";
  sessionRef: SessionRef;
}

/** セッションがリセット（コンテキストクリア）されたことを示す */
export interface SessionResetEvent {
  type: "session_reset";
  sessionRef: SessionRef;
  /** リセット後の新しい sessionRef（backend が session を再作成した場合） */
  newSessionRef?: SessionRef;
}

export interface SessionEndedEvent {
  type: "session_ended";
  sessionRef: SessionRef;
  /** 終了理由（任意）— backend は提供できる範囲で埋める */
  reason?: "completed" | "aborted" | "error" | "killed";
}

export interface PermissionAskedEvent {
  type: "permission_asked";
  sessionRef: SessionRef;
  permissionRef: PermissionRef;
  /** パーミッション要求のタイトル（UI 表示用） */
  title: string;
  /** 追加説明（任意） */
  description?: string;
}

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

export type SessionRole = "master" | "conductor" | "agent";

export interface SpawnOptions {
  role: SessionRole;
  /** 初回プロンプト（システムプロンプトではなくユーザーターンの最初のメッセージ） */
  prompt: string;
  /** セッションの作業ディレクトリ */
  workdir: string;
  /** セッションに注入する環境変数 */
  env?: Record<string, string>;
  /**
   * リクエストメタデータ（x-cmux-task-id / x-cmux-role 等）。
   * backend は可能な範囲で API リクエストヘッダに注入する。
   * 注入手段は backend 実装に委ねる（proxy / provider.options.headers 等）。
   */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Permission reply
// ---------------------------------------------------------------------------

export type PermissionReply =
  | "once"    // 今回だけ許可
  | "always"  // 常に許可（session 内）
  | "deny";   // 拒否

// ---------------------------------------------------------------------------
// RuntimeBackend interface
// ---------------------------------------------------------------------------

export interface RuntimeBackend {
  /**
   * 新しいセッションを作成してプロンプトを送信する。
   * 返り値は以降の操作で使う SessionRef。
   */
  spawn(options: SpawnOptions): Promise<SessionRef>;

  /**
   * 既存のセッションにメッセージを送信する。
   * セッションが存在しない場合は throw する。
   */
  send(sessionRef: SessionRef, message: string): Promise<void>;

  /**
   * セッションをリセットする（コンテキストクリア + 新プロンプト投入）。
   * backend によっては既存 session を abort して新規 session を作成する。
   * 返り値は（変わった場合の）新しい SessionRef。
   */
  reset(sessionRef: SessionRef, prompt: string): Promise<SessionRef>;

  /**
   * セッションを強制終了する。
   * 完了済みセッションに対して呼んでも throw しない（idempotent）。
   */
  kill(sessionRef: SessionRef): Promise<void>;

  /**
   * パーミッション要求に応答する。
   * PermissionRef は permission_asked イベントから取得する。
   */
  reply(permissionRef: PermissionRef, response: PermissionReply): Promise<void>;

  /**
   * 正規化イベントのコールバックを登録する。
   * 返り値の関数を呼ぶと購読を解除する。
   */
  onEvent(callback: (event: RuntimeEvent) => void): () => void;

  /**
   * backend を閉じてリソースを解放する。
   * イベントストリーム・プロキシ・接続プールなどを終了する。
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Leak-prohibition checklist（コンパイル時に確認できない制約の文書）
// ---------------------------------------------------------------------------
//
// この interface に以下の概念を**含めてはならない**（leak 禁止リスト）:
//   - `/clear`                  → reset() で表現
//   - SESSION_STARTED 等の hook 型文字列  → session_started 等の正規化イベントで表現
//   - ANTHROPIC_BASE_URL        → metadata / env で隠蔽（proxy URL は backend 実装の内部）
//   - hook matcher regex        → backend 実装の内部
//   - PID / process.kill        → SessionRef で隠蔽
//   - cmux surface ID           → SessionRef で隠蔽
//   - Bun.spawn / child_process → backend 実装の内部
//   - ANTHROPIC_CUSTOM_HEADERS  → metadata で表現
