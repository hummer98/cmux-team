/**
 * 旧 Conductor 発見マーカーファイル群の掃除ユーティリティ (T417)。
 *
 * 0e650e7 (2026-04-03) で導入し 0f8369a (同日) で廃止された marker file 機構の残骸
 * (`.team/conductors/conductor.surface:NNN` 空ファイル) を起動時に unlink する。
 * v3.15.0 / v3.19.0 のリリース commit でこれらが git にコミットされ、worktree
 * checkout のたびに復元される問題への one-shot cleanup。
 *
 * 現行の writeAgentDone / await-agent は `.team/conductors/<surface_NNN>/agent-done/...`
 * のサブディレクトリ構造を使うため、`!isFile()` ガードと regex 絞り込みにより
 * 現役データには触れない。
 */

import { existsSync } from "fs";
import { readdir, unlink } from "fs/promises";
import type { Dirent } from "fs";
import { join } from "path";

const LEGACY_MARKER_PATTERN = /^conductor\.surface:/;

export async function cleanupLegacyConductorMarkers(projectRoot: string): Promise<string[]> {
  const dir = join(projectRoot, ".team/conductors");
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!LEGACY_MARKER_PATTERN.test(ent.name)) continue;
    try {
      await unlink(join(dir, ent.name));
      removed.push(ent.name);
    } catch {
      // best-effort: race / permission 等で失敗しても daemon 起動は止めない
    }
  }
  return removed;
}
