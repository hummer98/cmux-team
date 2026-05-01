import { describe, test, expect } from "bun:test";
import { collectSessionEnrichment, getLoadedPluginsAndSkills } from "./session-enrichment";

// T410: session-enrichment は deps 注入式で純関数化されている。
//       本テストは execClaude / listSkillDirs を mock して挙動を検証する。

const FIXTURE_PLUGINS = [
  {
    id: "cmux-team@hummer98-cmux-team",
    enabled: true,
    installPath: "/tmp/plugins/cmux-team",
  },
  {
    id: "code-review@claude-plugins-official",
    enabled: true,
    installPath: "/tmp/plugins/code-review",
  },
  {
    id: "disabled-plugin@somewhere",
    enabled: false,
    installPath: "/tmp/plugins/disabled",
  },
];

function makeExecClaude(stdout: string): () => Promise<string> {
  return async () => stdout;
}

function makeListSkillDirs(map: Record<string, string[]>): (dir: string) => string[] {
  return (dir: string) => {
    const found = map[dir];
    if (found !== undefined) return found;
    throw new Error(`ENOENT: ${dir}`);
  };
}

describe("getLoadedPluginsAndSkills (T410)", () => {
  test("正常: enabled plugin のみ抽出される", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(JSON.stringify(FIXTURE_PLUGINS)),
      listSkillDirs: makeListSkillDirs({}),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedPlugins).toEqual([
      "cmux-team@hummer98-cmux-team",
      "code-review@claude-plugins-official",
    ]);
  });

  test("正常: skills は <source>:<name> の形式で plugin / user / project を全列挙", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(JSON.stringify(FIXTURE_PLUGINS)),
      listSkillDirs: makeListSkillDirs({
        "/tmp/plugins/cmux-team/skills": ["cmux-team", "cmux-agent-role"],
        "/tmp/plugins/code-review/skills": ["code-review"],
        "/tmp/.claude-user/skills": ["nano-banana", "ghe"],
        "/tmp/project/.claude/skills": ["cmux-team-investigate"],
      }),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedSkills).toEqual([
      "plugin:cmux-team",
      "plugin:cmux-agent-role",
      "plugin:code-review",
      "user:nano-banana",
      "user:ghe",
      "project:cmux-team-investigate",
    ]);
  });

  test("正常: 同名 skill (異 source) は両方含む（重複ではない）", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(JSON.stringify(FIXTURE_PLUGINS.slice(0, 1))),
      listSkillDirs: makeListSkillDirs({
        "/tmp/plugins/cmux-team/skills": ["cmux-team"],
        "/tmp/.claude-user/skills": ["cmux-team"],
        "/tmp/project/.claude/skills": ["cmux-team"],
      }),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedSkills).toEqual([
      "plugin:cmux-team",
      "user:cmux-team",
      "project:cmux-team",
    ]);
  });

  test("異常: execClaude が throw → 全 null fallback", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: async () => {
        throw new Error("ENOENT: claude not found");
      },
      listSkillDirs: makeListSkillDirs({}),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedPlugins).toBeNull();
    expect(result.loadedSkills).toBeNull();
  });

  test("異常: stdout が invalid JSON → null fallback", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude("not a json {{"),
      listSkillDirs: makeListSkillDirs({}),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedPlugins).toBeNull();
    expect(result.loadedSkills).toBeNull();
  });

  test("異常: stdout JSON が array でない → null fallback", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(JSON.stringify({ foo: "bar" })),
      listSkillDirs: makeListSkillDirs({}),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedPlugins).toBeNull();
    expect(result.loadedSkills).toBeNull();
  });

  test("異常: installPath が存在しない (listSkillDirs throw) → 該当 plugin の skill のみ skip、残りは収集", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(JSON.stringify(FIXTURE_PLUGINS)),
      listSkillDirs: makeListSkillDirs({
        "/tmp/plugins/code-review/skills": ["code-review"],
        // /tmp/plugins/cmux-team/skills は throw
      }),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedPlugins).toEqual([
      "cmux-team@hummer98-cmux-team",
      "code-review@claude-plugins-official",
    ]);
    // cmux-team plugin の skills は欠落、code-review のみ収集される
    expect(result.loadedSkills).toEqual(["plugin:code-review"]);
  });

  test("user / project skills dir が存在しない場合は空のまま続行", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(JSON.stringify(FIXTURE_PLUGINS.slice(0, 1))),
      listSkillDirs: makeListSkillDirs({
        "/tmp/plugins/cmux-team/skills": ["foo"],
        // user / project dir は throw
      }),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedSkills).toEqual(["plugin:foo"]);
  });

  test("異常: id が string でない要素は skip (parse 通過しても抽出失敗 = 該当要素を除外)", async () => {
    const result = await getLoadedPluginsAndSkills({
      execClaude: makeExecClaude(
        JSON.stringify([
          { id: 123, enabled: true },
          { id: "valid@source", enabled: true, installPath: "/tmp/plugins/valid" },
        ]),
      ),
      listSkillDirs: makeListSkillDirs({}),
      userSkillsDir: "/tmp/.claude-user/skills",
      projectSkillsDir: "/tmp/project/.claude/skills",
    });
    expect(result.loadedPlugins).toEqual(["valid@source"]);
  });
});

// T410 / F2: 実機 e2e test。CI に claude CLI が無い場合は skip。
//   - claude plugins list --json を実 spawn して 200 OK を確認
//   - 3 回連続実行し p95 latency が 3 秒以内に収まることを確認
function claudeAvailable(): boolean {
  try {
    return Bun.which("claude") !== null;
  } catch {
    return false;
  }
}

describe.skipIf(!claudeAvailable())(
  "collectSessionEnrichment (T410 e2e) — 実機 latency 検証",
  () => {
    test("claude plugins list --json を実機で呼んで { loadedPlugins, loadedSkills } を返す", async () => {
      const result = await collectSessionEnrichment();
      // null 取得失敗 fallback ではなく array で返ることを期待 (実機なので install 済み)
      expect(result.loadedPlugins).not.toBeNull();
      expect(result.loadedSkills).not.toBeNull();
      if (result.loadedPlugins) {
        expect(Array.isArray(result.loadedPlugins)).toBe(true);
      }
      if (result.loadedSkills) {
        expect(Array.isArray(result.loadedSkills)).toBe(true);
      }
    }, 10000);

    test("3 回連続実行し p95 latency < 3000ms (F2 対応)", async () => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await collectSessionEnrichment();
        samples.push(performance.now() - t0);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      // 3 サンプルの p95 は実質的に最大値。3 秒以内であることを確認
      const p95 = sorted[sorted.length - 1] ?? 0;
      console.log(
        `[T410-e2e] enrichment latency samples: ${samples.map((s) => s.toFixed(0)).join(", ")}ms, p95=${p95.toFixed(0)}ms`,
      );
      expect(p95).toBeLessThan(3000);
    }, 30000);
  },
);
