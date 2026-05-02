/**
 * cleanup.ts のテスト — 旧 Conductor 発見マーカーファイルの掃除 (T417)
 *
 * `.team/conductors/conductor.surface:NNN` 空ファイル(廃止済み marker file 機構の残骸)を
 * unlink する関数の単体テスト。directory ガードと regex の絞り込みにより
 * 現役の `surface_NNN/agent-done/` 構造には触れないことを担保する。
 */
import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cleanupLegacyConductorMarkers } from "./cleanup";

describe("cleanupLegacyConductorMarkers (T417)", () => {
  test("conductor.surface:NNN 形式の直下ファイルを unlink する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t417-"));
    try {
      const conductors = join(dir, ".team/conductors");
      await mkdir(conductors, { recursive: true });
      await writeFile(join(conductors, "conductor.surface:211"), "");
      await writeFile(join(conductors, "conductor.surface:212"), "");
      await mkdir(join(conductors, "surface_42/agent-done"), { recursive: true });
      await writeFile(
        join(conductors, "surface_42/agent-done/surface_99.done"),
        "status=completed\n",
      );

      const removed = await cleanupLegacyConductorMarkers(dir);

      expect(removed).toEqual(
        expect.arrayContaining(["conductor.surface:211", "conductor.surface:212"]),
      );
      expect(removed).toHaveLength(2);
      expect(existsSync(join(conductors, "conductor.surface:211"))).toBe(false);
      expect(existsSync(join(conductors, "conductor.surface:212"))).toBe(false);
      // 現役 surface_NNN/ には触れない
      expect(existsSync(join(conductors, "surface_42/agent-done/surface_99.done"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("非空ファイルでも形式が一致すれば unlink する(防御的)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t417-"));
    try {
      const conductors = join(dir, ".team/conductors");
      await mkdir(conductors, { recursive: true });
      await writeFile(join(conductors, "conductor.surface:300"), "stale data");

      const removed = await cleanupLegacyConductorMarkers(dir);

      expect(removed).toEqual(["conductor.surface:300"]);
      expect(existsSync(join(conductors, "conductor.surface:300"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(".team/conductors/ が無い場合でも throw しない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t417-"));
    try {
      await expect(cleanupLegacyConductorMarkers(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("その他の名前のファイル / ディレクトリには触れない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t417-"));
    try {
      const conductors = join(dir, ".team/conductors");
      await mkdir(conductors, { recursive: true });
      await writeFile(join(conductors, "README.txt"), "keep me");
      await mkdir(join(conductors, "surface_5"), { recursive: true });

      const removed = await cleanupLegacyConductorMarkers(dir);

      expect(removed).toEqual([]);
      expect(existsSync(join(conductors, "README.txt"))).toBe(true);
      expect(existsSync(join(conductors, "surface_5"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
