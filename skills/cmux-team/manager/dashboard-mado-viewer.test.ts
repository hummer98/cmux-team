/**
 * T439: resolveMarkdownViewer の優先順位テスト。
 *
 * 優先順: CMUX_TEAM_MD_VIEWER (env) → mado (which が見つけたとき) → cat
 * `which` 引数を DI で stub に差し替え、`Bun.which` の実環境依存を避ける。
 */
import { afterEach, describe, test, expect } from "bun:test";
import { resolveMarkdownViewer } from "./dashboard";

const ORIG_ENV = process.env.CMUX_TEAM_MD_VIEWER;

afterEach(() => {
  if (ORIG_ENV === undefined) {
    delete process.env.CMUX_TEAM_MD_VIEWER;
  } else {
    process.env.CMUX_TEAM_MD_VIEWER = ORIG_ENV;
  }
});

describe("resolveMarkdownViewer", () => {
  test("env (CMUX_TEAM_MD_VIEWER) が最優先", async () => {
    process.env.CMUX_TEAM_MD_VIEWER = "bat";
    const which = (_cmd: string) => "/path/to/anything";
    const r = await resolveMarkdownViewer(which);
    expect(r).toBe("bat");
  });

  test("env なし、which(mado) が path を返すと mado を選ぶ", async () => {
    delete process.env.CMUX_TEAM_MD_VIEWER;
    const which = (cmd: string) => (cmd === "mado" ? "/opt/homebrew/bin/mado" : null);
    const r = await resolveMarkdownViewer(which);
    expect(r).toBe("mado");
  });

  test("env なし、which(mado) が null を返すと cat に fallback", async () => {
    delete process.env.CMUX_TEAM_MD_VIEWER;
    const which = (_cmd: string) => null;
    const r = await resolveMarkdownViewer(which);
    expect(r).toBe("cat");
  });

  test("env が空文字列のときは env を無視して mado を選ぶ", async () => {
    process.env.CMUX_TEAM_MD_VIEWER = "";
    const which = (cmd: string) => (cmd === "mado" ? "/usr/local/bin/mado" : null);
    const r = await resolveMarkdownViewer(which);
    expect(r).toBe("mado");
  });
});
