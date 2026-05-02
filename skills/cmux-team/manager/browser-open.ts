/**
 * T415: ブラウザ起動の cross-platform helper。
 *
 * - macOS=`open`、Linux/その他=`xdg-open` を `Bun.spawn` で起動する
 * - URL が null の場合は `{ ok: false, reason: "no_url" }` を返して no-op
 *
 * `dashboard.tsx` の Metrics タブ `O` キーから呼ばれる。Issues タブの `B` キーは
 * macOS 前提の `Bun.spawn(["open", url])` を直書きしているが、本ヘルパーへの
 * 差し替えは別タスクで提案する形にする（plan.md Step 5b）。
 *
 * テスト容易性のため `spawn` / `platform` を DI 引数で差し替えられる。
 */

export type SpawnFn = (cmd: string[]) => void;

export interface OpenResult {
  ok: boolean;
  /** "no_url" = URL 未取得、それ以外は spawn 失敗時の error.message */
  reason?: string;
  /** 実際に組み立てた argv（テスト用） */
  command?: string[];
}

function defaultSpawn(cmd: string[]): void {
  // stdio を全て ignore に倒すことで Manager TUI の standard stream に
  // ブラウザ側の noise が混ざらないようにする。
  Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
}

/**
 * ブラウザで URL を開く。
 *
 * @param url - dashboard URL。null = 未取得（dashboard-server 未起動）
 * @param opts.spawn - spawn 実装の差し替え（テスト用）
 * @param opts.platform - platform 値の差し替え（テスト用）
 */
export function openDashboardUrlInBrowser(
  url: string | null,
  opts?: { spawn?: SpawnFn; platform?: NodeJS.Platform },
): OpenResult {
  if (!url) return { ok: false, reason: "no_url" };
  const platform = opts?.platform ?? process.platform;
  const bin = platform === "darwin" ? "open" : "xdg-open";
  const argv = [bin, url];
  const spawn = opts?.spawn ?? defaultSpawn;
  try {
    spawn(argv);
    return { ok: true, command: argv };
  } catch (e: any) {
    return {
      ok: false,
      reason: e?.message ?? String(e),
      command: argv,
    };
  }
}
