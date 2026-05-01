// T410: SESSION_STARTED hook payload に loaded_plugins / loaded_skills を含めるための
//       enrichment 取得 module。`claude plugins list --json` を 1 回 invoke して
//       enabled plugin id と plugin/user/project の skill 名を抽出する。
//
// 設計判断 (plan §7 D1〜D9 / design-review F1-F9 反映):
// - hook bash command は変更しない。CLI binary 内部 (cmdSend SESSION_STARTED 分岐)
//   から呼ぶ前提。ここでは pure な module を提供する。
// - deps 注入式の getLoadedPluginsAndSkills() を unit test 用に export。
// - production wrapper collectSessionEnrichment() で実 Bun.spawn / readdirSync を注入。
// - 取得失敗時は { loadedPlugins: null, loadedSkills: null } を返す。空配列とは区別される。
// - timeout 3 秒 (hook timeout 5 秒の余裕分)。Bun.spawn の timeout option で runtime に kill 委譲 (F1)。
// - skill walk は dirent.isDirectory() === true のみ拾う。symlink は skip (F9)。SKILL.md 存在
//   チェックはしない (D5)。
// - latency 増分は実機計測 (F2) で別途検証。

import { readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type Enrichment = {
  loadedPlugins: string[] | null;
  loadedSkills: string[] | null;
};

export type EnrichmentDeps = {
  /** `claude plugins list --json` の stdout 全文を Promise で返す。失敗時は throw。 */
  execClaude: () => Promise<string>;
  /**
   * 与えられた dir を `withFileTypes: true` で readdir し、`isDirectory() === true` の
   * dirent 名 (= skill 名候補) を順序保ったまま返す。dir が存在しない / read 不能なら throw。
   */
  listSkillDirs: (dir: string) => string[];
  /** `~/.claude/skills` 相当 (テストで上書き可能にするため引数化)。 */
  userSkillsDir: string;
  /** `<cwd>/.claude/skills` 相当 (テストで上書き可能にするため引数化)。 */
  projectSkillsDir: string;
};

type RawPluginEntry = {
  id?: unknown;
  enabled?: unknown;
  installPath?: unknown;
};

/**
 * deps 注入式の純関数。test では mock 関数を渡し、production では
 * collectSessionEnrichment() が Bun.spawn / readdirSync を注入する。
 *
 * 取得失敗時は両 field を null で返す。partial 失敗 (一部 plugin の skill walk のみ失敗)
 * は該当要素を skip して残りを収集する。
 */
export async function getLoadedPluginsAndSkills(deps: EnrichmentDeps): Promise<Enrichment> {
  let stdout: string;
  try {
    stdout = await deps.execClaude();
  } catch {
    return { loadedPlugins: null, loadedSkills: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { loadedPlugins: null, loadedSkills: null };
  }
  if (!Array.isArray(parsed)) {
    return { loadedPlugins: null, loadedSkills: null };
  }

  const enabled: RawPluginEntry[] = parsed.filter(
    (p): p is RawPluginEntry => typeof p === "object" && p !== null && (p as any).enabled === true,
  );

  const loadedPlugins: string[] = [];
  for (const p of enabled) {
    if (typeof p.id === "string" && p.id.length > 0) {
      loadedPlugins.push(p.id);
    }
  }

  const loadedSkills: string[] = [];

  // plugin source: enabled plugin の installPath/skills/* を収集
  for (const p of enabled) {
    if (typeof p.installPath !== "string" || p.installPath.length === 0) continue;
    const skillsDir = join(p.installPath, "skills");
    let names: string[];
    try {
      names = deps.listSkillDirs(skillsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      loadedSkills.push(`plugin:${name}`);
    }
  }

  // user source
  try {
    const names = deps.listSkillDirs(deps.userSkillsDir);
    for (const name of names) {
      loadedSkills.push(`user:${name}`);
    }
  } catch {
    // skip
  }

  // project source
  try {
    const names = deps.listSkillDirs(deps.projectSkillsDir);
    for (const name of names) {
      loadedSkills.push(`project:${name}`);
    }
  } catch {
    // skip
  }

  return { loadedPlugins, loadedSkills };
}

/**
 * production wrapper。`claude plugins list --json` を Bun.spawn で実行し、
 * skill dir walk は readdirSync で行う。timeout 3 秒、failure 時は { null, null }。
 *
 * SESSION_STARTED 1 件あたりの追加 latency は plan §5.3 で 100〜500ms と想定。
 * F2 対応: 実機計測は impl-report に記録する。
 */
export async function collectSessionEnrichment(): Promise<Enrichment> {
  const deps: EnrichmentDeps = {
    execClaude: defaultExecClaude,
    listSkillDirs: defaultListSkillDirs,
    userSkillsDir: join(homedir(), ".claude", "skills"),
    projectSkillsDir: join(process.cwd(), ".claude", "skills"),
  };
  return getLoadedPluginsAndSkills(deps);
}

const ENRICHMENT_TIMEOUT_MS = 3000;
const STDOUT_LIMIT_BYTES = 1024 * 1024; // 1MB

async function defaultExecClaude(): Promise<string> {
  // F1: Bun.spawn の timeout option で runtime に kill 委譲。
  // killSignal を SIGTERM にし、stdout は ReadableStream → text に変換。
  const proc = Bun.spawn(["claude", "plugins", "list", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: ENRICHMENT_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });

  // stdout を非ブロッキングで text に変換。1MB 超は parse 失敗扱い。
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`claude plugins list exited with code ${exitCode}`);
  }
  if (text.length > STDOUT_LIMIT_BYTES) {
    throw new Error(`stdout exceeded ${STDOUT_LIMIT_BYTES} bytes`);
  }
  return text;
}

function defaultListSkillDirs(dir: string): string[] {
  const dirents = readdirSync(dir, { withFileTypes: true });
  // F9: symlink dir は skip。isDirectory() === true のみ拾う。
  return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
}
