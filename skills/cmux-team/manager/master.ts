/**
 * Master surface の作成・管理
 */
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import * as cmux from "./cmux";
import { log, formatSurface } from "./logger";
import type { MasterState } from "./schema";
import { MasterStateSchema } from "./schema";

/**
 * surface 名をファイルパス用に正規化する（T229）。
 * `surface:12` → `surface_12`。`.team/masters/<normalized>.json` のファイル名に使う。
 * daemon.ts の同名関数と同じ意味を持つが、循環 import を避けるため master.ts にも定義する。
 */
export function normalizeSurfaceForPath(surface: string): string {
  return surface.replaceAll(":", "_");
}

/**
 * `.team/masters/<normalized>.json` のファイルパスを返す（T229）。
 */
function masterFilePath(projectRoot: string, surface: string): string {
  return join(projectRoot, ".team/masters", `${normalizeSurfaceForPath(surface)}.json`);
}

/**
 * Master 状態を `.team/masters/<normalized>.json` に永続化する（T229）。
 * MasterStateSchema に載らないランタイム専用フィールド（pidWatcherInterval）は除外する。
 */
export async function persistMasterFile(
  projectRoot: string,
  master: MasterState,
): Promise<void> {
  const dir = join(projectRoot, ".team/masters");
  await mkdir(dir, { recursive: true });
  const payload = {
    surface: master.surface,
    pid: master.pid,
    status: master.status,
    startedAt: master.startedAt,
    disconnectedAt: master.disconnectedAt,
    prompt: master.prompt,
  };
  // 書き込み前に schema で検証（破損データの早期検出）
  MasterStateSchema.parse(payload);
  const path = masterFilePath(projectRoot, master.surface);
  await writeFile(path, JSON.stringify(payload, null, 2));
}

/**
 * `.team/masters/<normalized>.json` を削除する（T229）。存在しない場合は無視。
 */
export async function deleteMasterFile(
  projectRoot: string,
  surface: string,
): Promise<void> {
  const path = masterFilePath(projectRoot, surface);
  try {
    await unlink(path);
  } catch {
    // 冪等: 存在しなくても問題ない
  }
}

/**
 * `.team/masters/` 配下の Master ファイル一覧を返す（T229）。
 * ディレクトリが無い / 読めない場合は空配列。
 */
export async function listMasterFiles(
  projectRoot: string,
): Promise<{ path: string; state: MasterState }[]> {
  const dir = join(projectRoot, ".team/masters");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const results: { path: string; state: MasterState }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = MasterStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        await log("master_file_invalid", `path=${path} err=${parsed.error.message}`);
        continue;
      }
      results.push({ path, state: parsed.data });
    } catch (e: any) {
      await log("master_file_read_failed", `path=${path} err=${e?.message ?? e}`);
    }
  }
  return results;
}

/**
 * Master ペインを spawn する（T230 で self-register 経路に整理）。
 *
 * 責務は「pane を立てて `cmux-team spawn-master` を送るだけ」。state 更新や永続化は
 * 行わない。pane 内で起動した `cmdLaunchMaster` が `registerSelfAsMaster(surface)` で
 * `MASTER_REGISTERED` を POST し、daemon 側 handler が `state.masters.set` +
 * `persistMasterFile` を行う（D3 — boot 時復元以外の state mutation は handler 経由に統一）。
 */
export async function spawnMaster(
  daemonSurface?: string,
): Promise<{ surface: string } | null> {
  try {
    // ペイン作成（daemon surface を右に split）
    const surface = await cmux.newSplit(
      "right",
      daemonSurface ? { surface: daemonSurface } : undefined,
    );

    // cmux-team spawn-master ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(surface, `cmux-team spawn-master\n`);

    // タブ名設定
    const num = surface.replace("surface:", "");
    await cmux.renameTab(surface, `[${num}] Master`);

    await log("master_spawned", formatSurface(surface, "U"));
    return { surface };
  } catch (e: any) {
    await log("error", `Master spawn failed: ${e.message}`);
    return null;
  }
}
