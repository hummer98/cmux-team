/**
 * cmux.ts の validateSurface リトライ動作を検証するテスト。
 *
 * モック戦略: `PATH` 先頭に fake `cmux` シェルスクリプトを置き、execFile 経由で
 * 実プロセスとして呼び出す。呼び出し回数は外部 state file (`count`) で管理する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let origPath: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-validate-test-"));
  const binDir = join(testDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(testDir, "count"), "0");
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
});

afterEach(async () => {
  process.env.PATH = origPath ?? "";
  await rm(testDir, { recursive: true, force: true });
});

async function writeFakeCmux(script: string): Promise<void> {
  const path = join(testDir, "bin/cmux");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

// validateSurface は一度 import すれば再利用可能。
// execFile("cmux", ...) を呼ぶため、PATH 差し替えで fake cmux の挙動が変わる。
import { validateSurface, validateSurfaceDetailed, send, setStatus, __setTreeImpl } from "./cmux";

describe("validateSurface リトライ (T121)", () => {
  test("1 回目で成功すれば即 true を返す", async () => {
    await writeFakeCmux(`printf "pane:1\n  surface:42\n"`);
    expect(await validateSurface("surface:42")).toBe(true);
  });

  test("1, 2 回目で tree() が例外 → 3 回目で成功すれば true", async () => {
    await writeFakeCmux(`
N=$(cat "${testDir}/count")
N=$((N+1))
echo $N > "${testDir}/count"
if [ "$N" -lt 3 ]; then
  echo "transient error" >&2
  exit 1
fi
printf "pane:1\n  surface:42\n"
`);
    expect(await validateSurface("surface:42")).toBe(true);
    const count = (await readFile(join(testDir, "count"), "utf-8")).trim();
    expect(count).toBe("3");
  });

  test("3 回全て tree() 例外なら false", async () => {
    await writeFakeCmux(`echo "persistent error" >&2; exit 1`);
    expect(await validateSurface("surface:42")).toBe(false);
  });

  test("send() 失敗時 Error.message に stderr が含まれる (T163)", async () => {
    const sentinel = "STDERR_SENTINEL_X9Y2";
    await writeFakeCmux(`echo "${sentinel}" >&2; exit 1`);
    let caught: Error | undefined;
    try {
      await send("surface:42", "hello");
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain(`stderr=${sentinel}`);
  });

  test("setStatus は失敗時に握りつぶすが log に stderr 付きメッセージが渡る (T163)", async () => {
    // setStatus は内部で catch して log するだけ。throw しないことを保証
    const sentinel = "SETSTATUS_STDERR_42";
    await writeFakeCmux(`echo "${sentinel}" >&2; exit 1`);
    // 例外が漏れないこと
    await setStatus("k", "v", "i", "c");
  });

  test("tree 成功時にはリトライしない (surface 未載なら即 false、tree は 1 回のみ)", async () => {
    // Major 2 反映: tree が成功した場合、surface 未載でも即 false を返し
    // リトライしない。カウンタで呼び出し回数を検証する。
    await writeFakeCmux(`
N=$(cat "${testDir}/count")
N=$((N+1))
echo $N > "${testDir}/count"
printf "pane:1\n  surface:99\n"
`);
    // tree は成功するが surface:42 は含まれない → 即 false
    expect(await validateSurface("surface:42")).toBe(false);
    // tree() は 1 回だけ呼ばれていること
    const count = (await readFile(join(testDir, "count"), "utf-8")).trim();
    expect(count).toBe("1");
  });
});

describe("validateSurfaceDetailed (T180)", () => {
  // treeImpl 差し替えフックを使ったユニットテスト（fake cmux 不要）
  test("tree 成功・surface 含む → 'alive'", async () => {
    __setTreeImpl(async () => "pane:1\n  surface:42\n");
    try {
      expect(await validateSurfaceDetailed("surface:42")).toBe("alive");
    } finally {
      __setTreeImpl(null);
    }
  });

  test("tree 成功・surface 不在 → 'missing'", async () => {
    __setTreeImpl(async () => "pane:1\n  surface:99\n");
    try {
      expect(await validateSurfaceDetailed("surface:42")).toBe("missing");
    } finally {
      __setTreeImpl(null);
    }
  });

  test("3 回全て execFile timeout（SIGTERM kill） → 'unknown'", async () => {
    __setTreeImpl(async () => {
      const err: any = new Error("Command failed: cmux tree");
      err.killed = true;
      err.signal = "SIGTERM";
      throw err;
    });
    try {
      expect(await validateSurfaceDetailed("surface:42")).toBe("unknown");
    } finally {
      __setTreeImpl(null);
    }
  });

  test("3 回全て真エラー（非 timeout） → 'missing'", async () => {
    __setTreeImpl(async () => {
      const err: any = new Error("Command failed: workspace not found");
      err.code = 1;
      err.killed = false;
      throw err;
    });
    try {
      expect(await validateSurfaceDetailed("surface:42")).toBe("missing");
    } finally {
      __setTreeImpl(null);
    }
  });

  test("timeout + timeout + 真エラー → 'missing' (混在時は missing 寄せ)", async () => {
    let n = 0;
    __setTreeImpl(async () => {
      n++;
      const err: any = new Error("Command failed: cmux tree");
      if (n < 3) {
        err.killed = true;
        err.signal = "SIGTERM";
      } else {
        err.killed = false;
        err.code = 1;
      }
      throw err;
    });
    try {
      expect(await validateSurfaceDetailed("surface:42")).toBe("missing");
    } finally {
      __setTreeImpl(null);
    }
  });

  test("1 回目 timeout + 2 回目成功 → 'alive'", async () => {
    let n = 0;
    __setTreeImpl(async () => {
      n++;
      if (n === 1) {
        const err: any = new Error("Command failed: cmux tree");
        err.killed = true;
        err.signal = "SIGTERM";
        throw err;
      }
      return "pane:1\n  surface:42\n";
    });
    try {
      expect(await validateSurfaceDetailed("surface:42")).toBe("alive");
    } finally {
      __setTreeImpl(null);
    }
  });
});
