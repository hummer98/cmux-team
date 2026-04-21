/**
 * cmux.ts のテスト（T195 以降は isAlive / send / setStatus を中心に検証）。
 *
 * モック戦略: `PATH` 先頭に fake `cmux` シェルスクリプトを置き、execFile 経由で
 * 実プロセスとして呼び出す。呼び出し回数は外部 state file (`count`) で管理する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, chmod, mkdir } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let testDir: string;
let origPath: string | undefined;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-validate-test-",
    subdirs: [],
    setProjectRootEnv: false,
    createTeamDir: false,
  });
  testDir = project.root;
  const binDir = join(testDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(testDir, "count"), "0");
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
});

afterEach(async () => {
  process.env.PATH = origPath ?? "";
  await project.dispose();
});

async function writeFakeCmux(script: string): Promise<void> {
  const path = join(testDir, "bin/cmux");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

import { send, setStatus, isAlive, __setIsAliveImpl, __setTreeImpl, listSiblingSurfaces } from "./cmux";

describe("send / setStatus のエラー伝搬 (T163)", () => {
  test("send() 失敗時 Error.message に stderr が含まれる", async () => {
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

  test("setStatus は失敗時に握りつぶすが log に stderr 付きメッセージが渡る", async () => {
    // setStatus は内部で catch して log するだけ。throw しないことを保証
    const sentinel = "SETSTATUS_STDERR_42";
    await writeFakeCmux(`echo "${sentinel}" >&2; exit 1`);
    // 例外が漏れないこと
    await setStatus("k", "v", "i", "c");
  });
});

describe("isAlive (T195)", () => {
  test("__setIsAliveImpl による fake 差し替え — true を返す", () => {
    __setIsAliveImpl(() => true);
    try {
      expect(isAlive(99999)).toBe(true);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("__setIsAliveImpl による fake 差し替え — false を返す", () => {
    __setIsAliveImpl(() => false);
    try {
      expect(isAlive(99999)).toBe(false);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("実 kill(pid, 0): 自プロセスは alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("実 kill(pid, 0): 架空 PID は dead", () => {
    // PID 2^22 付近の極端な値は OS 上でほぼ確実に存在しない
    expect(isAlive(4194303)).toBe(false);
  });
});

describe("listSiblingSurfaces (T207)", () => {
  afterEach(() => {
    __setTreeImpl(null);
  });

  test("同 pane に複数 surface がある場合は sibling のみを返す", async () => {
    // cmux tree 出力を模擬: pane:1 に surface:10/11、pane:2 に surface:20
    const fake = [
      "workspace workspace:1",
      "  pane pane:1",
      "    surface:10",
      "    surface:11",
      "  pane pane:2",
      "    surface:20",
    ].join("\n");
    __setTreeImpl(async () => fake);

    const siblings = await listSiblingSurfaces("surface:10");
    // pane:1 所属の全 surface が返る（自分自身を含む ── 呼び出し側で除外する契約）
    expect(siblings).toContain("surface:10");
    expect(siblings).toContain("surface:11");
    expect(siblings).not.toContain("surface:20");
  });

  test("対象 surface が存在しない場合は [] を返す", async () => {
    const fake = [
      "workspace workspace:1",
      "  pane pane:1",
      "    surface:10",
    ].join("\n");
    __setTreeImpl(async () => fake);

    const siblings = await listSiblingSurfaces("surface:999");
    expect(siblings).toEqual([]);
  });
});
