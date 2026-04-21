/**
 * test-project.ts ヘルパー自身のテスト（T292）
 */
import { describe, test, expect, afterEach } from "bun:test";
import { access, readFile, stat } from "fs/promises";
import { join } from "path";
import {
  createDummyProject,
  withDummyProject,
  DEFAULT_SUBDIRS,
} from "./test-project";

// 各テスト後に PROJECT_ROOT が必ず元に戻っていることを保証するガード。
// createDummyProject は savedEnv を記憶してから上書きするため、
// dispose を呼べば元の値（テスト環境では通常 undefined）に戻る。
const ORIGINAL_PROJECT_ROOT = process.env.PROJECT_ROOT;
afterEach(() => {
  // テスト間で env が残らないよう、最終的に初期値に揃える
  if (ORIGINAL_PROJECT_ROOT !== undefined) {
    process.env.PROJECT_ROOT = ORIGINAL_PROJECT_ROOT;
  } else {
    delete process.env.PROJECT_ROOT;
  }
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("createDummyProject", () => {
  test("一意な tmp dir を作成し teamDir が mkdir されている", async () => {
    const project = await createDummyProject();
    try {
      expect(project.root).toContain("cmux-team-test-");
      expect(project.teamDir).toBe(join(project.root, ".team"));
      const s = await stat(project.teamDir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await project.dispose();
    }
  });

  test(".team/<DEFAULT_SUBDIRS> が全て mkdir されている", async () => {
    const project = await createDummyProject();
    try {
      for (const sub of DEFAULT_SUBDIRS) {
        const p = join(project.teamDir, sub);
        const s = await stat(p);
        expect(s.isDirectory()).toBe(true);
      }
    } finally {
      await project.dispose();
    }
  });

  test("subdirs オプションで事前生成対象を上書きできる", async () => {
    const project = await createDummyProject({ subdirs: ["only-this"] });
    try {
      expect(await pathExists(join(project.teamDir, "only-this"))).toBe(true);
      // DEFAULT_SUBDIRS の "logs" は作られない
      expect(await pathExists(join(project.teamDir, "logs"))).toBe(false);
    } finally {
      await project.dispose();
    }
  });

  test("process.env.PROJECT_ROOT が root に書き換わる", async () => {
    const before = process.env.PROJECT_ROOT;
    const project = await createDummyProject();
    try {
      expect(process.env.PROJECT_ROOT).toBe(project.root);
    } finally {
      await project.dispose();
    }
    expect(process.env.PROJECT_ROOT).toBe(before);
  });

  test("dispose 後、root が削除される", async () => {
    const project = await createDummyProject();
    expect(await pathExists(project.root)).toBe(true);
    await project.dispose();
    expect(await pathExists(project.root)).toBe(false);
  });

  test("dispose 後、env が元の値に復元される（元 undefined）", async () => {
    delete process.env.PROJECT_ROOT;
    const project = await createDummyProject();
    // 直前の `delete` で TS が env の型を undefined に narrow してしまうため、
    // expect の generic 推論が undefined 固定になって toBe(string) が通らない。
    // 実際の runtime 値は createDummyProject 内で string に設定済み。
    expect(process.env.PROJECT_ROOT as unknown as string).toBe(project.root);
    await project.dispose();
    expect(process.env.PROJECT_ROOT).toBeUndefined();
  });

  test("dispose 後、env が元の値に復元される（元 string）", async () => {
    process.env.PROJECT_ROOT = "/tmp/preexisting-value";
    try {
      const project = await createDummyProject();
      expect(process.env.PROJECT_ROOT).toBe(project.root);
      await project.dispose();
      expect(process.env.PROJECT_ROOT).toBe("/tmp/preexisting-value");
    } finally {
      delete process.env.PROJECT_ROOT;
    }
  });

  test("setProjectRootEnv: false なら env を書き換えない", async () => {
    const before = process.env.PROJECT_ROOT;
    const project = await createDummyProject({ setProjectRootEnv: false });
    try {
      expect(process.env.PROJECT_ROOT).toBe(before as string | undefined as string);
    } finally {
      await project.dispose();
    }
    expect(process.env.PROJECT_ROOT).toBe(before as string | undefined as string);
  });

  test("seedTeamJson: true で team.json が生成される", async () => {
    const project = await createDummyProject({ seedTeamJson: true });
    try {
      const content = await readFile(join(project.teamDir, "team.json"), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.phase).toBe("init");
      expect(parsed.masters).toEqual([]);
      expect(parsed.conductors).toEqual([]);
    } finally {
      await project.dispose();
    }
  });

  test("createTeamDir: false なら `.team/` を作らず空 tmp dir だけ返す", async () => {
    const project = await createDummyProject({
      createTeamDir: false,
      setProjectRootEnv: false,
    });
    try {
      expect(await pathExists(project.root)).toBe(true);
      expect(await pathExists(project.teamDir)).toBe(false);
    } finally {
      await project.dispose();
    }
  });

  test("ensureSubdir で追加の subdir を遅延生成できる", async () => {
    const project = await createDummyProject({ subdirs: [] });
    try {
      const created = await project.ensureSubdir("specs");
      expect(created).toBe(join(project.teamDir, "specs"));
      expect(await pathExists(created)).toBe(true);
    } finally {
      await project.dispose();
    }
  });

  test("二重 dispose は no-op（safe）", async () => {
    const project = await createDummyProject();
    await project.dispose();
    // 2 回目も throw しない
    await project.dispose();
    expect(await pathExists(project.root)).toBe(false);
  });

  test("逐次に複数プロジェクトを作ると root が異なる", async () => {
    const a = await createDummyProject();
    const b = await createDummyProject();
    try {
      expect(a.root).not.toBe(b.root);
      expect(process.env.PROJECT_ROOT).toBe(b.root);
    } finally {
      // LIFO で dispose しないと env は混乱するが、
      // b を先に dispose すると savedEnv=a.root に戻る
      await b.dispose();
      expect(process.env.PROJECT_ROOT).toBe(a.root);
      await a.dispose();
    }
  });
});

describe("withDummyProject", () => {
  test("fn 正常終了時に dispose される", async () => {
    let captured: string | undefined;
    const result = await withDummyProject(async (p) => {
      captured = p.root;
      expect(await pathExists(p.root)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(captured).toBeDefined();
    expect(await pathExists(captured!)).toBe(false);
  });

  test("fn が throw しても dispose される（try/finally）", async () => {
    let captured: string | undefined;
    await expect(
      withDummyProject(async (p) => {
        captured = p.root;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(captured).toBeDefined();
    expect(await pathExists(captured!)).toBe(false);
  });

  test("fn が throw しても env が復元される", async () => {
    const before = process.env.PROJECT_ROOT;
    await expect(
      withDummyProject(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env.PROJECT_ROOT).toBe(before as string | undefined as string);
  });
});
