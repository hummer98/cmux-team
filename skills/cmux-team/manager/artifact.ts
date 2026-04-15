/**
 * アーティファクトファイルのパース・検索
 */
import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";

export interface ArtifactMeta {
  id: string;
  type: string;       // research | decision | session | spec | report
  title: string;
  created: string;     // ISO 8601
  updated?: string;    // ISO 8601
  author: string;      // master | conductor-N | agent-xxx
  task?: string;       // 関連タスク (例: T038)
  tags?: string[];
  filePath: string;
  fileName: string;
  body: string;        // フロントマター以降の本文
}

/**
 * YAML frontmatter からアーティファクトメタデータを抽出
 */
export function parseArtifactMeta(content: string, fileName: string, filePath: string): ArtifactMeta | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length).trim();

  const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
  const id = unquote(fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const type = unquote(fm.match(/^type:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const title = unquote(fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const created = unquote(fm.match(/^created:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const updatedRaw = fm.match(/^updated:\s*(.+)$/m)?.[1]?.trim();
  const updated = updatedRaw ? unquote(updatedRaw) : undefined;
  const author = unquote(fm.match(/^author:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const taskRaw = fm.match(/^task:\s*(.+)$/m)?.[1]?.trim();
  const task = taskRaw ? unquote(taskRaw) : undefined;

  // tags: [tag1, tag2]
  let tags: string[] | undefined;
  const tagsMatch = fm.match(/^tags:\s*\[(.+)\]$/m);
  if (tagsMatch?.[1]) {
    tags = tagsMatch[1].split(",").map((s) => unquote(s.trim())).filter(Boolean);
  }

  return { id, type, title, created, updated, author, task, tags, filePath, fileName, body };
}

/**
 * .team/artifacts/A*.md を一括読み込み
 */
export async function loadArtifacts(projectRoot: string): Promise<ArtifactMeta[]> {
  const artifactsDir = join(projectRoot, ".team/artifacts");
  if (!existsSync(artifactsDir)) return [];

  const files = await readdir(artifactsDir);
  const artifacts: ArtifactMeta[] = [];

  for (const f of files) {
    if (!f.startsWith("A") || !f.endsWith(".md")) continue;
    const filePath = join(artifactsDir, f);
    const content = await readFile(filePath, "utf-8");
    const meta = parseArtifactMeta(content, f, filePath);
    if (meta) artifacts.push(meta);
  }

  return artifacts;
}

/**
 * フロントマター + 本文の全文検索（大文字小文字を区別しない）
 */
export async function searchArtifacts(
  projectRoot: string,
  query: string
): Promise<{ artifact: ArtifactMeta; matches: { lineNum: number; line: string }[] }[]> {
  const artifacts = await loadArtifacts(projectRoot);
  const lowerQuery = query.toLowerCase();
  const results: { artifact: ArtifactMeta; matches: { lineNum: number; line: string }[] }[] = [];

  for (const artifact of artifacts) {
    const content = await readFile(artifact.filePath, "utf-8");
    const lines = content.split("\n");
    const matches: { lineNum: number; line: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(lowerQuery)) {
        matches.push({ lineNum: i + 1, line: lines[i]! });
      }
    }

    if (matches.length > 0) {
      results.push({ artifact, matches });
    }
  }

  return results;
}

/**
 * フロントマター必須フィールドの検証
 */
export function validateArtifact(artifact: ArtifactMeta): string[] {
  const errors: string[] = [];
  if (!artifact.id) errors.push("id が未設定");
  if (!artifact.type) errors.push("type が未設定");
  if (!artifact.title) errors.push("title が未設定");
  if (!artifact.created) errors.push("created が未設定");
  if (!artifact.author) errors.push("author が未設定");
  const validTypes = ["research", "decision", "session", "spec", "report"];
  if (artifact.type && !validTypes.includes(artifact.type)) {
    errors.push(`type "${artifact.type}" は不正（${validTypes.join(", ")} のいずれか）`);
  }
  return errors;
}

/**
 * 次のアーティファクト ID を自動採番
 */
export async function nextArtifactId(projectRoot: string): Promise<string> {
  const artifacts = await loadArtifacts(projectRoot);
  if (artifacts.length === 0) return "A001";
  const nums = artifacts
    .map(a => parseInt(a.id.replace(/^A/, ""), 10))
    .filter(n => !isNaN(n));
  const max = Math.max(0, ...nums);
  return `A${String(max + 1).padStart(3, "0")}`;
}

function buildFrontmatter(meta: Partial<ArtifactMeta>): string {
  const lines = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`type: ${meta.type}`);
  lines.push(`title: "${meta.title}"`);
  lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  lines.push(`author: ${meta.author}`);
  if (meta.task) lines.push(`task: ${meta.task}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

export interface AddArtifactOpts {
  projectRoot: string;
  srcPath: string;
  type?: string;
  title?: string;
  task?: string;
  tags?: string[];
}

/**
 * 既存ファイルをアーティファクトとして登録（move 動作）。
 *
 * srcPath の内容を読み取り、フロントマターを付与した上で
 * `{projectRoot}/.team/artifacts/<id>-<slug>.md` に書き出し、
 * 書き出し成功後に srcPath を削除する。
 *
 * srcPath の削除に失敗した場合は CLI 全体としては成功扱いにし、
 * 呼び出し側にはログ警告だけを返す（二重管理防止がメインゴールで、
 * srcPath の残存は手動で回収可能なため）。
 */
export async function addArtifact(
  opts: AddArtifactOpts,
): Promise<{ id: string; destPath: string; unlinkWarning?: string }> {
  const id = await nextArtifactId(opts.projectRoot);
  const content = await readFile(opts.srcPath, "utf-8");
  const now = new Date().toISOString();

  const srcFileName = basename(opts.srcPath);
  const existing = parseArtifactMeta(content, srcFileName, opts.srcPath);

  let meta: Partial<ArtifactMeta>;
  let body: string;

  if (existing) {
    // フロントマターあり: 既存値をベースに CLI オプションで上書き
    meta = {
      id,
      type: opts.type ?? existing.type,
      title: opts.title ?? existing.title,
      created: existing.created || now,
      updated: now,
      author: existing.author || "master",
      task: opts.task ?? existing.task,
      tags: opts.tags ?? existing.tags,
    };
    body = existing.body;
  } else {
    // フロントマターなし: 新規生成
    const nameWithoutExt = srcFileName.replace(/\.[^.]+$/, "").replace(/-/g, " ");
    meta = {
      id,
      type: opts.type ?? "research",
      title: opts.title ?? nameWithoutExt,
      created: now,
      author: "master",
      task: opts.task,
      tags: opts.tags,
    };
    body = content.trim();
  }

  const frontmatter = buildFrontmatter(meta);
  const output = body ? `${frontmatter}\n\n${body}\n` : `${frontmatter}\n`;

  // slug: 元ファイル名から拡張子除去、既存 Axxx- prefix を除去
  let slug = srcFileName.replace(/\.[^.]+$/, "");
  slug = slug.replace(/^A\d{3}-/, "");
  const destFileName = `${id}-${slug}.md`;

  const artifactsDir = join(opts.projectRoot, ".team/artifacts");
  if (!existsSync(artifactsDir)) {
    await mkdir(artifactsDir, { recursive: true });
  }

  const destPath = join(artifactsDir, destFileName);
  await writeFile(destPath, output, "utf-8");

  let unlinkWarning: string | undefined;
  try {
    await unlink(opts.srcPath);
  } catch (e: any) {
    unlinkWarning = `unlink failed: ${e?.message ?? e}`;
  }

  return { id, destPath, unlinkWarning };
}
