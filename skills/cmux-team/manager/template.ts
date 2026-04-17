/**
 * テンプレート検索・変数展開
 */
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, cp } from "fs/promises";
import { join, dirname } from "path";
import { log } from "./logger";
// R3 (m9): locale は i18n.ts から module-top で import し、
// `expandProjectInstructions` 内で `formatProjectInstructionsBlock(body, locale)` に渡す。
import { locale, t } from "./i18n";
import { normalizeAgentRole } from "./schema";
import {
  readProjectInstructions,
  formatProjectInstructionsBlock,
} from "./agent-instructions";

/** base ディレクトリからロケール付きテンプレートディレクトリを解決する */
function resolveLocalizedDir(base: string): string | null {
  const localized = join(base, locale);
  if (existsSync(join(localized, "master.md"))) return localized;
  // フォールバック: en
  const fallback = join(base, "en");
  if (existsSync(join(fallback, "master.md"))) return fallback;
  return null;
}

export async function findTemplateDir(): Promise<string | null> {
  // 1. プロジェクトローカル（dev リポジトリを最優先）
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  const resolved1 = resolveLocalizedDir(local);
  if (resolved1) {
    await log("template_dir_resolved", `path=${resolved1} source=project_local`);
    return resolved1;
  }

  // 2. daemon 自身からの相対パス（installed package のフォールバック）
  //    manager/template.ts → ../templates/
  const fromSelf = join(dirname(import.meta.path), "../templates");
  const resolved2 = resolveLocalizedDir(fromSelf);
  if (resolved2) {
    await log("template_dir_resolved", `path=${resolved2} source=installed`);
    return resolved2;
  }

  return null;
}

export async function generateMasterPrompt(
  projectRoot: string
): Promise<void> {
  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });
  const dst = join(promptsDir, "master.md");

  const templateDir = await findTemplateDir();
  if (!templateDir) {
    throw new Error(t("template_dir_not_found"));
  }

  await cp(join(templateDir, "master.md"), dst);
  await log("master_prompt_generated", `path=${dst}`);
}

export async function generateConductorRolePrompt(
  projectRoot: string,
  mainBranch: string
): Promise<string> {
  const templateDir = await findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-role.md"))) {
    throw new Error(t("conductor_role_template_not_found"));
  }

  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptFile = join(promptsDir, "conductor-role.md");

  let content = await readFile(join(templateDir, "conductor-role.md"), "utf-8");
  content = content
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{MAIN_BRANCH\}\}/g, mainBranch);

  await writeFile(promptFile, content);
  await log("conductor_role_prompt_generated", `path=${promptFile}`);
  return promptFile;
}

/**
 * `{{PROJECT_INSTRUCTIONS}}` プレースホルダを overlay で展開する。
 *
 * R1 (M6) 方針: 置換文字列に余計な `\n` を付けない（formatProjectInstructionsBlock
 * が返す `\n<heading>\n\n<body>\n` の先頭 `\n` だけで前行との空行 1 つを保つ）。
 *
 * 返り値の mode:
 * - `noop`: 入力 content にプレースホルダが無い（content を変更せず返す）
 * - `unknown-role`: role が AgentRole に属さない → プレースホルダを `""` で置換
 * - `empty`: overlay ファイルが無い / 空 → プレースホルダを `""` で置換
 * - `applied`: overlay を block に整形して置換
 */
export async function expandProjectInstructions(
  projectRoot: string,
  roleRaw: string,
  content: string,
): Promise<{
  expanded: string;
  mode: "noop" | "unknown-role" | "empty" | "applied";
}> {
  if (!content.includes("{{PROJECT_INSTRUCTIONS}}")) {
    return { expanded: content, mode: "noop" };
  }

  const role = normalizeAgentRole(roleRaw);
  let block = "";
  let mode: "unknown-role" | "empty" | "applied";

  if (!role) {
    mode = "unknown-role";
  } else {
    const body = await readProjectInstructions(projectRoot, role);
    if (body === null || body === "") {
      mode = "empty";
    } else {
      block = formatProjectInstructionsBlock(body, locale);
      mode = "applied";
    }
  }

  // 前後の `\n` を含めて置換することで、プレースホルダが単独行にある
  // 標準ケースで `\n\n\n+` が発生しないようにする。
  const lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/;
  let expanded: string;
  if (lineRe.test(content)) {
    expanded = content.replace(lineRe, block === "" ? "" : block);
  } else {
    // フォールバック: 単独行ではない（先頭/末尾/同一行内）— 単純置換する
    expanded = content.replaceAll("{{PROJECT_INSTRUCTIONS}}", block);
  }

  return { expanded, mode };
}

export async function generateConductorTaskPrompt(
  projectRoot: string,
  taskRunId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
  baseBranch?: string,
  taskDir?: string,
  mainBranch?: string
): Promise<string> {
  const templateDir = await findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-task.md"))) {
    throw new Error(t("conductor_task_template_not_found"));
  }

  let promptFile: string;
  if (taskDir) {
    // 新形式: タスクフォルダ内の runs/ に出力
    const runDir = join(taskDir, "runs", taskRunId);
    await mkdir(runDir, { recursive: true });
    promptFile = join(runDir, "conductor-prompt.md");
  } else {
    // 旧形式: .team/prompts/ に出力
    const promptsDir = join(projectRoot, ".team/prompts");
    await mkdir(promptsDir, { recursive: true });
    promptFile = join(promptsDir, `${taskRunId}.md`);
  }

  let content = await readFile(join(templateDir, "conductor-task.md"), "utf-8");

  // T213: 呼び出し側は state.mainBranch を渡す想定。未指定時は "main" にフォールバック
  const resolvedMainBranch = mainBranch ?? "main";

  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, taskRunId)
    .replace(/\{\{MAIN_BRANCH\}\}/g, resolvedMainBranch)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || resolvedMainBranch);

  await writeFile(promptFile, content);
  await log("conductor_task_prompt_generated", `taskRunId=${taskRunId} path=${promptFile}`);
  return promptFile;
}
