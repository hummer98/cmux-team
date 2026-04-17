import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  persistMasterFile,
  deleteMasterFile,
  listMasterFiles,
  normalizeSurfaceForPath,
} from "./master";
import type { MasterState } from "./schema";

// テスト用の一時ディレクトリ
let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-master-test-"));
  process.env.PROJECT_ROOT = testDir;
  // master ファイルのログ出力用に .team/logs を用意（log ヘルパー要求）
  await mkdir(join(testDir, ".team/logs"), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  delete process.env.PROJECT_ROOT;
});

function buildMaster(surface: string, overrides: Partial<MasterState> = {}): MasterState {
  return {
    surface,
    pid: 12345,
    status: "starting",
    startedAt: "2026-04-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("persistMasterFile / listMasterFiles / deleteMasterFile", () => {
  test("正常系: persist → list で正しく読み出せる", async () => {
    const master = buildMaster("surface:100", { status: "idle" });
    await persistMasterFile(testDir, master);

    const files = await listMasterFiles(testDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.state.surface).toBe("surface:100");
    expect(files[0]!.state.status).toBe("idle");
    expect(files[0]!.state.pid).toBe(12345);
    expect(files[0]!.path).toBe(
      join(testDir, ".team/masters/surface_100.json"),
    );
  });

  test("正常系: 複数 surface を persist → list で全件返す", async () => {
    await persistMasterFile(testDir, buildMaster("surface:100"));
    await persistMasterFile(testDir, buildMaster("surface:200", { pid: 999 }));

    const files = await listMasterFiles(testDir);
    const surfaces = files.map((f) => f.state.surface).sort();
    expect(surfaces).toEqual(["surface:100", "surface:200"]);
  });

  test("空ディレクトリで listMasterFiles は空配列を返す", async () => {
    await mkdir(join(testDir, ".team/masters"), { recursive: true });
    const files = await listMasterFiles(testDir);
    expect(files).toEqual([]);
  });

  test("ディレクトリ不在で listMasterFiles は空配列を返す（throw しない）", async () => {
    // .team/masters を作らずに呼ぶ
    const files = await listMasterFiles(testDir);
    expect(files).toEqual([]);
  });

  test("不正 JSON ファイルがあっても listMasterFiles は他を読み続ける", async () => {
    const dir = join(testDir, ".team/masters");
    await mkdir(dir, { recursive: true });
    // 正常ファイル
    await persistMasterFile(testDir, buildMaster("surface:100"));
    // 壊れた JSON
    await writeFile(join(dir, "surface_999.json"), "{ this is not json");
    // schema 違反（必須 surface 欠落）
    await writeFile(join(dir, "surface_888.json"), JSON.stringify({ pid: 1 }));

    const files = await listMasterFiles(testDir);
    // 壊れた 2 つは skip されるため 1 件のみ
    expect(files).toHaveLength(1);
    expect(files[0]!.state.surface).toBe("surface:100");
  });

  test(".json 以外のファイルは listMasterFiles で無視される", async () => {
    const dir = join(testDir, ".team/masters");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "README.md"), "not a master file");
    await persistMasterFile(testDir, buildMaster("surface:100"));

    const files = await listMasterFiles(testDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.state.surface).toBe("surface:100");
  });

  test("deleteMasterFile は ファイル不在でも throw しない（冪等）", async () => {
    // 事前に .team/masters を作らない
    await deleteMasterFile(testDir, "surface:404");
    // 明示的な assertion なし（throw しなければ成功）

    // ディレクトリを作った後の不在削除も OK
    await mkdir(join(testDir, ".team/masters"), { recursive: true });
    await deleteMasterFile(testDir, "surface:404");
  });

  test("persist → delete → list で削除が反映される", async () => {
    await persistMasterFile(testDir, buildMaster("surface:100"));
    let files = await listMasterFiles(testDir);
    expect(files).toHaveLength(1);

    await deleteMasterFile(testDir, "surface:100");
    files = await listMasterFiles(testDir);
    expect(files).toHaveLength(0);
    expect(
      existsSync(join(testDir, ".team/masters/surface_100.json")),
    ).toBe(false);
  });

  test("同 surface の上書き persist: 後から書いた内容が残る", async () => {
    await persistMasterFile(
      testDir,
      buildMaster("surface:100", { status: "starting", pid: 100 }),
    );
    await persistMasterFile(
      testDir,
      buildMaster("surface:100", { status: "idle", pid: 200 }),
    );

    const files = await listMasterFiles(testDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.state.status).toBe("idle");
    expect(files[0]!.state.pid).toBe(200);
  });

  test("persistMasterFile はランタイム専用フィールド（fallback, pidWatcherInterval）を永続化しない", async () => {
    // T234: fallback / pidWatcherInterval は payload に含まれないこと
    const timer = setInterval(() => {}, 1000);
    try {
      const master: MasterState = {
        ...buildMaster("surface:100"),
        fallback: true,
        pidWatcherInterval: timer,
      };
      await persistMasterFile(testDir, master);

      const raw = await readFile(
        join(testDir, ".team/masters/surface_100.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw);
      expect(parsed.fallback).toBeUndefined();
      expect(parsed.pidWatcherInterval).toBeUndefined();
      // 通常フィールドは残る
      expect(parsed.surface).toBe("surface:100");
    } finally {
      clearInterval(timer);
    }
  });
});

describe("normalizeSurfaceForPath", () => {
  test("コロンを _ に置換する", () => {
    expect(normalizeSurfaceForPath("surface:12")).toBe("surface_12");
  });

  test("英数字 / _ / - はそのまま", () => {
    expect(normalizeSurfaceForPath("surface_abc-123")).toBe("surface_abc-123");
  });

  test("想定外文字も _ に正規化される（防御的動作）", () => {
    expect(normalizeSurfaceForPath("surface:12 test")).toBe("surface_12_test");
    expect(normalizeSurfaceForPath("foo/bar")).toBe("foo_bar");
  });
});
