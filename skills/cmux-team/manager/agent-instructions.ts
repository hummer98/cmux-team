/**
 * プロジェクト固有の追加指示 (agent instructions overlay) — T247 / T342。
 *
 * 各 overlay 対応ロールに対して、プロジェクトルート直下の
 * `.team/agent-instructions/<role>.md` に overlay 本文を置いておくと、
 * - Agent 8 ロール: `cmux-team spawn-agent` 実行時に prompt-file 中の
 *   `{{PROJECT_INSTRUCTIONS}}` プレースホルダが overlay 本文で置換される
 * - Master / Conductor (T342): `generateMasterPrompt` / `generateConductorRolePrompt`
 *   が `.team/prompts/master.md` / `.team/prompts/conductor-role.md` 生成時に
 *   テンプレ冒頭の `{{PROJECT_INSTRUCTIONS}}` を overlay 本文で置換する
 *
 * overlay が無い場合はいずれも空文字に置換される。
 *
 * このモジュールは以下の単一責務を持つ：
 * - overlay ファイルの path 解決 (agentInstructionsPath)
 * - 読み書き / 削除 / 一覧 (read/write/delete/listProjectInstructions)
 * - overlay 本文を i18n 対応の見出し付きブロックに整形
 *   (formatProjectInstructionsBlock)
 *
 * `{{PROJECT_INSTRUCTIONS}}` の実際の展開処理 (expandProjectInstructions) は
 * template.ts に置く（C1 — single source of truth）。
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir, unlink, stat } from "fs/promises";
import { join } from "path";
import type { OverlayRole } from "./schema";
import { OVERLAY_ROLES } from "./schema";
import type { Locale } from "./i18n";
import { tFor } from "./i18n";

/** overlay ファイルを置くディレクトリ（PROJECT_ROOT からの相対パス） */
export const AGENT_INSTRUCTIONS_DIR_REL = ".team/agent-instructions";

/** overlay 本文の最大サイズ（バイト）。超過すると write 時にエラー */
export const AGENT_INSTRUCTIONS_MAX_BYTES = 100 * 1024;

/**
 * overlay ファイルのフルパス。存在確認はしない。
 */
export function agentInstructionsPath(projectRoot: string, role: OverlayRole): string {
  return join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, `${role}.md`);
}

/**
 * overlay を読み取る。存在しなければ null を返す。
 */
export async function readProjectInstructions(
  projectRoot: string,
  role: OverlayRole,
): Promise<string | null> {
  const path = agentInstructionsPath(projectRoot, role);
  if (!existsSync(path)) return null;
  return await readFile(path, "utf-8");
}

/**
 * overlay を書き込む。
 * - ディレクトリが無ければ作成する
 * - body が `AGENT_INSTRUCTIONS_MAX_BYTES` を超えるとエラー
 * - 末尾改行を保証する（書き込み時に 1 つだけになるよう正規化）
 */
export async function writeProjectInstructions(
  projectRoot: string,
  role: OverlayRole,
  body: string,
): Promise<void> {
  const bytes = Buffer.byteLength(body, "utf-8");
  if (bytes > AGENT_INSTRUCTIONS_MAX_BYTES) {
    throw new Error(
      `overlay exceeds ${AGENT_INSTRUCTIONS_MAX_BYTES} bytes limit (got ${bytes} bytes)`,
    );
  }
  const dir = join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL);
  await mkdir(dir, { recursive: true });
  const path = agentInstructionsPath(projectRoot, role);
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  await writeFile(path, normalized, "utf-8");
}

/**
 * overlay を削除する。存在しなかった場合は false を返す（エラーにしない）。
 */
export async function deleteProjectInstructions(
  projectRoot: string,
  role: OverlayRole,
): Promise<boolean> {
  const path = agentInstructionsPath(projectRoot, role);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}

/**
 * 全ロールについて overlay の有無とサイズを返す。`OVERLAY_ROLES` 順
 * （Agent 8 ロール → master → conductor）。
 */
export async function listProjectInstructions(
  projectRoot: string,
): Promise<Array<{ role: OverlayRole; exists: boolean; size: number }>> {
  const items: Array<{ role: OverlayRole; exists: boolean; size: number }> = [];
  for (const role of OVERLAY_ROLES) {
    const path = agentInstructionsPath(projectRoot, role);
    if (existsSync(path)) {
      const s = await stat(path);
      items.push({ role, exists: true, size: s.size });
    } else {
      items.push({ role, exists: false, size: 0 });
    }
  }
  return items;
}

/**
 * overlay 本文を `{{PROJECT_INSTRUCTIONS}}` 置換用のブロックに整形する。
 *
 * - body が null / 空 → 空文字を返す（mode=empty のケース）
 * - body があれば、locale 別の見出しを付けたブロック `\n<heading>\n\n<body>\n` を返す
 *   （先頭 `\n` は expandProjectInstructions 側の単独行 regex 置換で
 *   前行との空行 1 つを保持するための意図的な 1 文字）
 *
 * R1 (M6) 方針 (案 A): expandProjectInstructions は置換文字列に余計な `\n` を
 * 付けないため、この関数の戻り値が最終的な置換文字列そのものになる。
 */
export function formatProjectInstructionsBlock(body: string | null, locale: Locale): string {
  if (body === null || body === "") return "";
  const heading = `## ${tFor(locale, "project_instructions_heading")}`;
  return `\n${heading}\n\n${body.trimEnd()}\n`;
}
