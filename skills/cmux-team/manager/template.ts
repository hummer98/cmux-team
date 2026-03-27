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

export async function generateConductorPrompt(
  projectRoot: string,
  conductorId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string
): Promise<string> {
  const templateDir = findTemplateDir();
  if (!templateDir || !existsSync(join(templateDir, "conductor.md"))) {
    throw new Error(
      "Conductor template not found. リカバリー:\n" +
      "  1. plugin reinstall: /plugin install cmux-team@hummer98-cmux-team\n" +
      "  2. 手動: ./install.sh"
    );
  }

  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptFile = join(promptsDir, `${conductorId}.md`);

  {
    let content = await readFile(join(templateDir, "conductor.md"), "utf-8");

    // {{COMMON_HEADER}} を展開（Conductor は使わないので削除）
    content = content.replace(/\{\{COMMON_HEADER\}\}\n?/, "");

    // タスク読み込み指示を実際のタスク内容で置換
    content = content.replace(
      /`.team\/tasks\/\{\{ROLE_ID\}\}.md` を読んでタスク内容を確認してください。/,
      taskContent
    );

    // テンプレート変数を置換
    content = content
      .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
      .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
      .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
      .replace(/\{\{ROLE_ID\}\}/g, conductorId)
      .replace(/\{\{CONDUCTOR_ID\}\}/g, conductorId)
      .replace(/\{\{TASK_DESCRIPTION\}\}/g, `task ${taskId}`)
      .replace(
        /\{\{OUTPUT_FILE\}\}/g,
        join(projectRoot, outputDir, "summary.md")
      );

    // 完了マーカーを追記（daemon が完了検出に使用）
    content += `

## 完了マーカー（daemon 検出用）

上記「完了時の処理」を全て実行した後、最後に:
\`\`\`bash
touch ${join(projectRoot, outputDir, "done")}
\`\`\`
`;

    await writeFile(promptFile, content);
  }

  return promptFile;
}
