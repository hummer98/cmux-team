/**
 * cmux-team start の前提条件チェック
 *
 * daemon / Master / Conductor を spawn する前に、環境が最低限揃っているかを検証する。
 * 個々の検証は try/catch で失敗を issue として積み上げ、途中で throw しない。
 * 全検証を必ず走り切るため、複数の不備を一度に提示できる。
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";

const execFile = promisify(execFileCb);

export interface PreflightIssue {
  key: "not_git_repo" | "claude_not_found" | "bun_not_found" | "team_dir_not_writable";
  message: string; // 1 行見出し（日本語）
  hint: string; // 解決方法（複数行可）
  context?: string; // 付加情報（例: カレントディレクトリパス）
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

async function checkGitRepo(projectRoot: string): Promise<PreflightIssue | null> {
  try {
    await execFile("git", ["rev-parse", "--git-dir"], { cwd: projectRoot });
    return null;
  } catch {
    return {
      key: "not_git_repo",
      message: "git リポジトリではありません",
      context: projectRoot,
      hint:
        "解決方法:\n" +
        `  cd ${projectRoot}\n` +
        "  git init\n" +
        '  git add -A && git commit -m "Initial commit"',
    };
  }
}

function checkClaude(): PreflightIssue | null {
  // Bun.which は bun runtime の PATH 参照を使う（外部プロセス起動なし）
  if (Bun.which("claude")) return null;
  return {
    key: "claude_not_found",
    message: "claude バイナリが見つかりません",
    hint:
      "解決方法:\n" +
      "  https://docs.claude.com/en/docs/claude-code/overview を参照して\n" +
      "  Claude Code をインストールしてください",
  };
}

function checkBun(): PreflightIssue | null {
  if (Bun.which("bun")) return null;
  return {
    key: "bun_not_found",
    message: "bun バイナリが見つかりません",
    hint:
      "解決方法:\n" +
      "  curl -fsSL https://bun.sh/install | bash\n" +
      "  またはご使用のパッケージマネージャで bun をインストールしてください",
  };
}

async function checkWritable(projectRoot: string): Promise<PreflightIssue | null> {
  // .team/ は触らない（initInfra に完全委譲）
  // projectRoot 直下にドットプレフィックスのテストファイルを作って消す
  const probe = join(projectRoot, ".cmux-team-preflight-test");
  try {
    await writeFile(probe, "preflight\n");
    try {
      await unlink(probe);
    } catch {
      // 書き込めたのに削除できない特殊ケース — 検証としては成功扱い
    }
    return null;
  } catch (e: any) {
    // クリーンアップ保証（万一 writeFile 途中で失敗してファイルが残った場合）
    try {
      await unlink(probe);
    } catch {}
    return {
      key: "team_dir_not_writable",
      message: "プロジェクトディレクトリに書き込みできません",
      context: projectRoot,
      hint:
        "解決方法:\n" +
        `  ${projectRoot} のパーミッションを確認してください\n` +
        `  chmod u+w ${projectRoot}`,
    };
  }
}

/**
 * cmux-team start に必要な前提を検証する。
 * issues が 1 件でもあれば ok=false を返す。
 * プロセスの終了はしない（呼び出し側の責務）。
 */
export async function runPreflight(projectRoot: string): Promise<PreflightResult> {
  const issues: PreflightIssue[] = [];

  const gitIssue = await checkGitRepo(projectRoot);
  if (gitIssue) issues.push(gitIssue);

  const claudeIssue = checkClaude();
  if (claudeIssue) issues.push(claudeIssue);

  const bunIssue = checkBun();
  if (bunIssue) issues.push(bunIssue);

  const writeIssue = await checkWritable(projectRoot);
  if (writeIssue) issues.push(writeIssue);

  return { ok: issues.length === 0, issues };
}

/**
 * PreflightResult を整形して console.error に出力する。
 * ok=true の場合は何もしない。
 */
export function printPreflightIssues(result: PreflightResult): void {
  if (result.ok) return;

  console.error("❌ cmux-team start: 前提チェックに失敗しました");
  console.error("");

  for (const issue of result.issues) {
    console.error(`  ✗ ${issue.message}`);
    if (issue.context) {
      console.error(`    ${issue.context}`);
    }
    console.error("");
    // hint は複数行。各行をインデントして出力
    for (const line of issue.hint.split("\n")) {
      console.error(`    ${line}`);
    }
    console.error("");
  }
}
