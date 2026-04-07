/**
 * テンプレート検索・変数展開
 */
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, cp } from "fs/promises";
import { join, dirname } from "path";
import { log } from "./logger";

export function findTemplateDir(): string | null {
  // 1. daemon 自身からの相対パス（manager/ の兄弟 templates/）
  //    manager/template.ts → ../templates/
  const fromSelf = join(dirname(import.meta.path), "../templates");
  if (existsSync(join(fromSelf, "master.md"))) return fromSelf;

  // 2. プロジェクトローカル
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  if (existsSync(join(local, "master.md"))) return local;

  return null;
}

export async function generateMasterPrompt(
  projectRoot: string
): Promise<void> {
  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });
  const dst = join(promptsDir, "master.md");

  const templateDir = findTemplateDir();
  if (!templateDir) {
    throw new Error(
      "Template directory not found. npm install -g cmux-team を実行してください"
    );
  }

  await cp(join(templateDir, "master.md"), dst);
  await log("master_prompt_generated", `path=${dst}`);
}

export async function generateConductorRolePrompt(
  projectRoot: string
): Promise<string> {
  const templateDir = findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-role.md"))) {
    throw new Error(
      "Conductor role template not found. npm install -g cmux-team を実行してください"
    );
  }

  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptFile = join(promptsDir, "conductor-role.md");

  let content = await readFile(join(templateDir, "conductor-role.md"), "utf-8");
  content = content.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot);

  await writeFile(promptFile, content);
  await log("conductor_role_prompt_generated", `path=${promptFile}`);
  return promptFile;
}

export async function generateConductorTaskPrompt(
  projectRoot: string,
  taskRunId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
  baseBranch?: string,
  taskDir?: string
): Promise<string> {
  const templateDir = findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-task.md"))) {
    throw new Error(
      "Conductor task template not found. npm install -g cmux-team を実行してください"
    );
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

  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, taskRunId)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || "main（デフォルト）");

  await writeFile(promptFile, content);
  await log("conductor_task_prompt_generated", `taskRunId=${taskRunId} path=${promptFile}`);
  return promptFile;
}
