/**
 * Master surface の作成・管理
 */
import { writeFile } from "fs/promises";
import { join } from "path";
import * as cmux from "./cmux";
import { log } from "./logger";

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

    const workspace = await cmux.getCallerWorkspace();
    if (!(await cmux.validateSurface(surface, workspace))) {
      await log("error", `Master surface ${surface} validation failed`);
      return null;
    }

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

    await log("master_spawned", `surface=${surface}`);
    return { surface };
  } catch (e: any) {
    await log("error", `Master spawn failed: ${e.message}`);
    return null;
  }
}

export async function isMasterAlive(surface: string, workspace?: string): Promise<boolean> {
  return cmux.validateSurface(surface, workspace);
}
