/**
 * T423 S1: daemon reload (TUI 'r' 起動経路) を `spawn + unref + 親即時 exit` に置換する helper。
 *
 * 旧実装 (`main.ts:931-945`) は `execFileSync("bun", ...)` で子 daemon が終了
 * するまで親をブロックしていた。子 daemon でさらに 'r' が押されると親も子も
 * `execFileSync` で待機 → reload chain で `bun` ランタイム (1.2GB RSS) が累積
 * → 24h で 27GB 浪費という事故を発生させていた。
 *
 * 本 helper は:
 *   1. 親が pidfile を release し
 *   2. `spawn(... { detached: true, stdio: "inherit" })` で子を起動
 *   3. `child.unref()` で event loop の参照を切り
 *   4. 親自身は `process.exit(0)` で即座に解放
 * という流れで、親のリソースを保持せずに reload する。
 *
 * direnv 注記: `env: process.env` で親の direnv ロード済み環境変数を継承する。
 * reload 経路では direnv の再 allow check は走らないが、`cmdStart` 内の
 * `checkDirenvAllowed` は子側で再度実行されるため、direnv 制約に違反する状態で
 * reload しても子側で fail-stop する。
 */
import { spawn as realSpawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { releasePidFile as realReleasePidFile } from "./pidfile";
import { log as realLog } from "./logger";

export interface PerformDaemonReloadOptions {
  pidFilePath: string;
  latestMainTs: string;
  // DI（テスト用）
  spawnImpl?: typeof realSpawn;
  releaseImpl?: (path: string) => Promise<void>;
  exitImpl?: (code: number) => void;
  logImpl?: (event: string, detail: string) => Promise<void>;
}

export async function performDaemonReload(
  opts: PerformDaemonReloadOptions,
): Promise<void> {
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  const releaseImpl = opts.releaseImpl ?? realReleasePidFile;
  const exitImpl = opts.exitImpl ?? ((code: number) => process.exit(code));
  const logImpl = opts.logImpl ?? realLog;

  // 子 daemon が acquire できるよう親は spawn より前に pidfile を release する。
  // releasePidFile は ENOENT を握り潰し、それ以外も `await log(...)` で吸収して return する
  // 設計のため throw しない契約（pidfile.ts:141-148）。本 helper はこの invariant に依存。
  await releaseImpl(opts.pidFilePath);

  // findLatestMainTs は通常絶対パスを返す（npm prefix / process.cwd() / argv[1]）が、
  // spawn が cwd 依存になるのを防ぐため念のため resolve() で正規化する。
  const absoluteMainTs = resolve(opts.latestMainTs);

  // detached: true で別プロセスグループにする。stdio: "inherit" で親の TTY を子に dup。
  // IPC channel は無いので disconnect() は no-op になる → 呼ばない。
  const child: ChildProcess = spawnImpl(
    "bun",
    ["run", absoluteMainTs, "start"],
    {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
      detached: true,
    },
  );

  // child.pid は spawn が ENOENT 等で失敗した直後に undefined になり得る。
  // defensive に "unknown" を入れてログを残す。
  const childPid = child.pid ?? "unknown";
  // spawn 直後・親 exit 前にログを flush して TTY ハンドオーバー前にログを残す。
  await logImpl(
    "daemon_reload_spawned",
    `child_pid=${childPid} latestMainTs=${absoluteMainTs}`,
  );

  // 親の event loop 参照を切る → 子が detached で生き続けても親はすぐ exit できる。
  child.unref();

  exitImpl(0);
}
