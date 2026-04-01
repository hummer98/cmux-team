/**
 * Master surface の作成・管理
 */
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

    if (!(await cmux.validateSurface(surface))) {
      await log("error", `Master surface ${surface} validation failed`);
      return null;
    }

    // cmux-team launch-master ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(
      surface,
      `cmux-team launch-master\n`
    );

    // タブ名設定
    const num = surface.replace("surface:", "");
    await cmux.renameTab(surface, `[${num}] Master`);

    await log("master_spawned", `surface=${surface}`);
    return { surface };
  } catch (e: any) {
    await log("error", `Master spawn failed: ${e.message}`);
    return null;
  }
}

export async function isMasterAlive(surface: string): Promise<boolean> {
  return cmux.validateSurface(surface);
}
