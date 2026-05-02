/**
 * T415: browser-open.ts の DI ベース unit test。
 *
 * `Bun.spawn` グローバルを直接 mock すると bun:test 内で副作用が出やすいため、
 * `openDashboardUrlInBrowser(url, { spawn, platform })` の DI 経路で検証する。
 */
import { describe, test, expect } from "bun:test";
import { openDashboardUrlInBrowser } from "./browser-open";

describe("openDashboardUrlInBrowser (T415)", () => {
  test("url=null → { ok: false, reason: 'no_url' } で spawn は呼ばれない", () => {
    let called = false;
    const r = openDashboardUrlInBrowser(null, {
      spawn: () => {
        called = true;
      },
      platform: "darwin",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_url");
    expect(called).toBe(false);
  });

  test("url='' → { ok: false, reason: 'no_url' }", () => {
    const r = openDashboardUrlInBrowser("", { platform: "darwin" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_url");
  });

  test("darwin → 'open <url>' を spawn", () => {
    const calls: string[][] = [];
    const r = openDashboardUrlInBrowser("http://127.0.0.1:54321", {
      spawn: (cmd) => calls.push(cmd),
      platform: "darwin",
    });
    expect(r.ok).toBe(true);
    expect(r.command).toEqual(["open", "http://127.0.0.1:54321"]);
    expect(calls).toEqual([["open", "http://127.0.0.1:54321"]]);
  });

  test("linux → 'xdg-open <url>' を spawn", () => {
    const calls: string[][] = [];
    const r = openDashboardUrlInBrowser("http://127.0.0.1:8080", {
      spawn: (cmd) => calls.push(cmd),
      platform: "linux",
    });
    expect(r.ok).toBe(true);
    expect(r.command).toEqual(["xdg-open", "http://127.0.0.1:8080"]);
    expect(calls).toEqual([["xdg-open", "http://127.0.0.1:8080"]]);
  });

  test("win32 等の platform → 'xdg-open' フォールバック (Linux と同経路)", () => {
    // T415 仕様: macOS=open、Linux=xdg-open。明示されていない platform は
    // xdg-open にフォールバックする（typically WSL / freebsd 等で動作）。
    const calls: string[][] = [];
    const r = openDashboardUrlInBrowser("http://localhost:1234", {
      spawn: (cmd) => calls.push(cmd),
      platform: "win32",
    });
    expect(r.ok).toBe(true);
    expect(r.command).toEqual(["xdg-open", "http://localhost:1234"]);
    expect(calls).toEqual([["xdg-open", "http://localhost:1234"]]);
  });

  test("spawn 例外時 → { ok: false, reason } を返す", () => {
    const r = openDashboardUrlInBrowser("http://127.0.0.1:54321", {
      spawn: () => {
        throw new Error("ENOENT: open not found");
      },
      platform: "darwin",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ENOENT");
    // 失敗時も argv は返す（呼び出し側の log に使える）
    expect(r.command).toEqual(["open", "http://127.0.0.1:54321"]);
  });
});
