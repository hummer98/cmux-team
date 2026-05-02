/**
 * テンプレート検索・変数展開
 */
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { log } from "./logger";
// R3 (m9): locale は i18n.ts から module-top で import し、
// `expandProjectInstructions` 内で `formatProjectInstructionsBlock(body, locale)` に渡す。
import { locale, t } from "./i18n";
import { normalizeOverlayRole } from "./schema";
import {
  readProjectInstructions,
  formatProjectInstructionsBlock,
  formatProjectCommonInstructionsBlock,
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

  // T342 / T413: master テンプレ冒頭の `{{PROJECT_INSTRUCTIONS}}` と
  // `{{PROJECT_COMMON_INSTRUCTIONS}}` を overlay 展開する。
  // best-effort write — ランタイムプロンプトは再生成可能（cmux-team start）。
  const raw = await readFile(join(templateDir, "master.md"), "utf-8");
  const { expanded, commonMode, roleMode } = await expandPromptOverlays(
    projectRoot,
    "master",
    raw,
  );
  await writeFile(dst, expanded);
  await log(
    "master_prompt_generated",
    `path=${dst} expand_mode=common:${commonMode}/role:${roleMode}`,
  );
}

export async function generateConductorRolePrompt(
  projectRoot: string,
  mainBranch: string
): Promise<string> {
  // T253: mainBranch は required。空文字なら fail-stop（silent failure 防止）
  if (!mainBranch.trim()) {
    throw new Error(
      "generateConductorRolePrompt: mainBranch must be a non-empty string " +
        "(T253: fail-stop when mainBranch is unresolved)",
    );
  }
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

  // T342 / T413: 冒頭の単独行 `{{PROJECT_INSTRUCTIONS}}` と `{{PROJECT_COMMON_INSTRUCTIONS}}`
  // を overlay 展開する。expandProjectInstructions 内の lineRe は最初のマッチ 1 件のみ
  // 置換するため、heredoc サンプル内の literal placeholder は保護される。
  // expandPromptOverlays は role → common の順で適用し、common body 内の literal
  // `{{PROJECT_INSTRUCTIONS}}` が誤置換されないようにする（plan §3 判断 3）。
  const { expanded, commonMode, roleMode } = await expandPromptOverlays(
    projectRoot,
    "conductor",
    content,
  );
  await writeFile(promptFile, expanded);
  await log(
    "conductor_role_prompt_generated",
    `path=${promptFile} expand_mode=common:${commonMode}/role:${roleMode}`,
  );
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
 * - `unknown-role`: role が OverlayRole に属さない → プレースホルダを `""` で置換
 * - `empty`: overlay ファイルが無い / 空 → プレースホルダを `""` で置換
 * - `applied`: overlay を block に整形して置換
 *
 * T342: role は `OverlayRole`（Agent 8 ロール + master + conductor）を受け付ける。
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

  const role = normalizeOverlayRole(roleRaw);
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

/**
 * `{{PROJECT_COMMON_INSTRUCTIONS}}` プレースホルダを `_common.md` overlay で展開する（T413）。
 *
 * `expandProjectInstructions` の対称実装。違いは:
 * - placeholder 名: `{{PROJECT_COMMON_INSTRUCTIONS}}`
 * - 読み込み元: `.team/agent-instructions/_common.md`（`OverlayRole === "common"`）
 * - role 概念が無いため `unknown-role` mode は存在しない
 *
 * 返り値の mode:
 * - `noop`: 入力 content にプレースホルダが無い（content を変更せず返す）
 * - `empty`: overlay ファイルが無い / 空 → プレースホルダを `""` で置換
 * - `applied`: overlay を block に整形して置換
 */
export async function expandProjectCommonInstructions(
  projectRoot: string,
  content: string,
): Promise<{
  expanded: string;
  mode: "noop" | "empty" | "applied";
}> {
  if (!content.includes("{{PROJECT_COMMON_INSTRUCTIONS}}")) {
    return { expanded: content, mode: "noop" };
  }

  const body = await readProjectInstructions(projectRoot, "common");
  let block = "";
  let mode: "empty" | "applied";
  if (body === null || body === "") {
    mode = "empty";
  } else {
    block = formatProjectCommonInstructionsBlock(body, locale);
    mode = "applied";
  }

  const lineRe = /\n\{\{PROJECT_COMMON_INSTRUCTIONS\}\}\n/;
  let expanded: string;
  if (lineRe.test(content)) {
    expanded = content.replace(lineRe, block === "" ? "" : block);
  } else {
    expanded = content.replaceAll("{{PROJECT_COMMON_INSTRUCTIONS}}", block);
  }

  return { expanded, mode };
}

/**
 * 上位 wrap helper（T413）。`{{PROJECT_INSTRUCTIONS}}` と `{{PROJECT_COMMON_INSTRUCTIONS}}`
 * を 1 度に展開する。
 *
 * 展開順序は **role → common の順**。理由（plan §3 判断 3）:
 * - `expandProjectInstructions` の `lineRe` は document 全体での最初の 1 件にマッチする。
 *   common→role 順で展開すると、common body 内に literal `{{PROJECT_INSTRUCTIONS}}` が
 *   含まれる場合に lineRe の最初のマッチが common body 内 literal に当たり、本来の role
 *   placeholder ではなく common body 内 literal が誤置換される可能性がある。
 * - role → common 順なら `expandProjectInstructions` 実行時点では common body は未挿入なので、
 *   template 内の `{{PROJECT_INSTRUCTIONS}}` placeholder のみが対象になり、common body 内
 *   literal は自然に保護される。
 *
 * テンプレート上の placeholder 物理位置は `{{PROJECT_COMMON_INSTRUCTIONS}}` が
 * `{{PROJECT_INSTRUCTIONS}}` より前なので、出力上は common が role より前に表示される。
 */
export async function expandPromptOverlays(
  projectRoot: string,
  role: string,
  content: string,
): Promise<{
  expanded: string;
  commonMode: "noop" | "empty" | "applied";
  roleMode: "noop" | "unknown-role" | "empty" | "applied";
}> {
  const r = await expandProjectInstructions(projectRoot, role, content);
  const c = await expandProjectCommonInstructions(projectRoot, r.expanded);
  return { expanded: c.expanded, commonMode: c.mode, roleMode: r.mode };
}

export async function generateConductorTaskPrompt(
  projectRoot: string,
  taskRunId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
  baseBranch: string | undefined,
  taskDir: string | undefined,
  mainBranch: string
): Promise<string> {
  // T253: mainBranch は required。空文字なら fail-stop（silent failure 防止）
  if (!mainBranch.trim()) {
    throw new Error(
      "generateConductorTaskPrompt: mainBranch must be a non-empty string " +
        "(T253: fail-stop when mainBranch is unresolved)",
    );
  }
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

  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, taskRunId)
    .replace(/\{\{MAIN_BRANCH\}\}/g, mainBranch)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || mainBranch);

  await writeFile(promptFile, content);
  await log("conductor_task_prompt_generated", `taskRunId=${taskRunId} path=${promptFile}`);
  return promptFile;
}
