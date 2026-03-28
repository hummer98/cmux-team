/**
 * テンプレート検索・変数展開
 */
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, cp } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

export function findTemplateDir(): string | null {
  const home = homedir();

  // 1. daemon 自身からの相対パス（manager/ の兄弟 templates/）
  //    manager/template.ts → ../templates/
  const fromSelf = join(dirname(import.meta.path), "../templates");
  if (existsSync(join(fromSelf, "master.md"))) return fromSelf;

  // 2. plugin キャッシュから最新バージョンを探す
  const cacheBase = join(
    home,
    ".claude/plugins/cache/hummer98-cmux-team/cmux-team"
  );
  try {
    const { stdout } = require("child_process").execFileSync("ls", [
      "-d",
      join(cacheBase, "*/skills/cmux-team/templates"),
    ]);
    const dirs = stdout.toString().trim().split("\n").filter(Boolean).sort();
    if (dirs.length > 0) {
      const latest = dirs[dirs.length - 1];
      if (existsSync(join(latest, "master.md"))) return latest;
    }
  } catch {
    // キャッシュなし
  }

  // 3. プロジェクトローカル
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  if (existsSync(join(local, "master.md"))) return local;

  // 4. 手動インストール
  const manual = join(home, ".claude/skills/cmux-team/templates");
  if (existsSync(join(manual, "master.md"))) return manual;

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
      "Template directory not found. リカバリー:\n" +
      "  1. plugin reinstall: /plugin install cmux-team@hummer98-cmux-team\n" +
      "  2. 手動: ./install.sh\n" +
      "  3. 開発: skills/cmux-team/templates/ が存在するディレクトリで実行"
    );
  }

  await cp(join(templateDir, "master.md"), dst);
}

export async function generateConductorRolePrompt(
  projectRoot: string
): Promise<string> {
  const templateDir = findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-role.md"))) {
    throw new Error(
      "Conductor role template not found. リカバリー:\n" +
      "  1. plugin reinstall: /plugin install cmux-team@hummer98-cmux-team\n" +
      "  2. 手動: ./install.sh"
    );
  }

  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptFile = join(promptsDir, "conductor-role.md");

  let content = await readFile(join(templateDir, "conductor-role.md"), "utf-8");
  content = content.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot);

  await writeFile(promptFile, content);
  return promptFile;
}

export async function generateConductorTaskPrompt(
  projectRoot: string,
  conductorId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string
): Promise<string> {
  const templateDir = findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor-task.md"))) {
    throw new Error(
      "Conductor task template not found. リカバリー:\n" +
      "  1. plugin reinstall: /plugin install cmux-team@hummer98-cmux-team\n" +
      "  2. 手動: ./install.sh"
    );
  }

  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptFile = join(promptsDir, `${conductorId}.md`);

  let content = await readFile(join(templateDir, "conductor-task.md"), "utf-8");

  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, conductorId);

  await writeFile(promptFile, content);
  return promptFile;
}
