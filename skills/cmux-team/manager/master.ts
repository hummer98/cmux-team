/**
 * Master surface の作成・管理
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import * as cmux from "./cmux";
import { log, formatSurface } from "./logger";

export interface MasterState {
  surface: string;
}

export async function spawnMaster(
  projectRoot: string,
  daemonSurface?: string
): Promise<MasterState | null> {
  try {
    // ペイン作成（daemon surface を右に split）
    const surface = await cmux.newSplit("right", daemonSurface ? { surface: daemonSurface } : undefined);

    // cmux-team spawn-master ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(
      surface,
      `cmux-team spawn-master\n`
    );

    // タブ名設定
    const num = surface.replace("surface:", "");
    await cmux.renameTab(surface, `[${num}] Master`);

    // マーカーファイル書き込み（restart 時の発見用）
    const markerPath = join(projectRoot, ".team/master.surface");
    await writeFile(markerPath, surface);

    await log("master_spawned", formatSurface(surface, "U"));
    return { surface };
  } catch (e: any) {
    await log("error", `Master spawn failed: ${e.message}`);
    return null;
  }
}

/**
 * Master の生存確認（T195: PID ベース）。
 *
 * `.team/team.json` から `master.pid` を読み、`cmux.isAlive(pid)` で確認する。
 * - pid が無い / team.json が読めない / dead → false
 * - alive → true
 */
export async function isMasterAlive(projectRoot: string): Promise<boolean> {
  try {
    const teamJsonPath = join(projectRoot, ".team/team.json");
    const raw = await readFile(teamJsonPath, "utf-8");
    const teamJson = JSON.parse(raw);
    const pid = teamJson?.master?.pid;
    if (typeof pid !== "number") return false;
    return cmux.isAlive(pid);
  } catch {
    return false;
  }
}
