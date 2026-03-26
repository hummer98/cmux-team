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
  const cacheBase = join(
    home,
    ".claude/plugins/cache/hummer98-cmux-team/cmux-team"
  );

  // plugin キャッシュから最新バージョンを探す
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

  // プロジェクトローカル
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  if (existsSync(join(local, "master.md"))) return local;

  // 手動インストール
  const manual = join(home, ".claude/skills/cmux-team/templates");
  if (existsSync(join(manual, "master.md"))) return manual;

  return null;
}

export async function generateMasterPrompt(
  projectRoot: string
): Promise<void> {
  const templateDir = findTemplateDir();
  if (!templateDir) throw new Error("Template directory not found");

  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const src = join(templateDir, "master.md");
  const dst = join(promptsDir, "master.md");
  await cp(src, dst);
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
  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptFile = join(promptsDir, `${conductorId}.md`);

  if (templateDir && existsSync(join(templateDir, "conductor.md"))) {
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
      .replace(/\{\{TASK_DESCRIPTION\}\}/g, `task ${taskId}`)
      .replace(
        /\{\{OUTPUT_FILE\}\}/g,
        join(projectRoot, outputDir, "summary.md")
      );

    // 完了マーカーを追記
    content += `

## 完了マーカー

タスク完了時、以下を必ず実行すること:
1. 変更をコミット: \`cd ${worktreePath} && git add -A && git commit -m "feat: <タスク概要>"\`
2. 結果サマリー: \`${join(projectRoot, outputDir, "summary.md")}\` に書き出す
3. 完了マーカー: \`touch ${join(projectRoot, outputDir, "done")}\`
`;

    await writeFile(promptFile, content);
  } else {
    // フォールバック: 最小プロンプト
    await writeFile(
      promptFile,
      `# Conductor ロール

あなたは 4層エージェントアーキテクチャの **Conductor** です。
割り当てられた 1 つのタスクを自律的に完了してください。

## タスク

${taskContent}

## 作業ディレクトリ

すべての作業は git worktree \`${worktreePath}\` 内で行う。
\`\`\`bash
cd ${worktreePath}
\`\`\`

## 完了時の処理

1. 変更をコミット: \`cd ${worktreePath} && git add -A && git commit -m "feat: <タスク概要>"\`
2. 結果サマリーを \`${join(projectRoot, outputDir, "summary.md")}\` に書き出す
3. 完了マーカー: \`touch ${join(projectRoot, outputDir, "done")}\`
4. 停止する
`
    );
  }

  return promptFile;
}
