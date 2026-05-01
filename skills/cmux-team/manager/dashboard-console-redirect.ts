import { warn as logWarn, error as logError } from "./logger";

/**
 * dashboard 起動時に呼ばれ、`console.warn` / `console.error` を
 * `.team/logs/manager.log` への append にすり替える。
 *
 * 目的: Rezi/Ink TUI 描画中に依存コードが console.warn/error すると、
 * その出力が stderr 経由で TUI 描画バッファを貫通してペイン上に残骸が残る。
 * dashboard モード中は stderr に書かず manager.log に流す。
 *
 * すり替え解除は不要 — dashboard プロセスは exit 時に消えるため。
 * テストからは返り値の `restore()` を呼んで原状復帰できる。
 */
export function installDashboardConsoleRedirect(): { restore: () => void } {
  const origWarn = console.warn;
  const origError = console.error;

  console.warn = (...args: unknown[]) => {
    void logWarn("console_warn", formatArgs(args));
  };
  console.error = (...args: unknown[]) => {
    void logError("console_error", formatArgs(args));
  };

  return {
    restore: () => {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}
