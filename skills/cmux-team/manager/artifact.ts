/**
 * アーティファクトファイルのパース・検索
 */
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

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
