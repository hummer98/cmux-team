import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseRemoteOriginToTags,
  parseRemoteOriginToContext,
  resolveProjectTags,
  resolveProjectContext,
  FALLBACK_TAGS,
} from "./project-tags";

describe("parseRemoteOriginToTags", () => {
  // public GitHub → ["any"]
  test("github.com SSH → any", () => {
    expect(parseRemoteOriginToTags("git@github.com:foo/bar.git")).toEqual(["any"]);
  });

  test("github.com HTTPS without .git → any", () => {
    expect(parseRemoteOriginToTags("https://github.com/foo/bar")).toEqual(["any"]);
  });

  test("github.com HTTPS with .git → any", () => {
    expect(parseRemoteOriginToTags("https://github.com/foo/bar.git")).toEqual(["any"]);
  });

  test("www.github.com HTTPS → any", () => {
    expect(parseRemoteOriginToTags("https://www.github.com/foo/bar.git")).toEqual(["any"]);
  });

  // GitLab / Bitbucket / Codeberg / sr.ht → ["any"]
  test("gitlab.com HTTPS → any", () => {
    expect(parseRemoteOriginToTags("https://gitlab.com/foo/bar")).toEqual(["any"]);
  });

  test("bitbucket.org HTTPS → any", () => {
    expect(parseRemoteOriginToTags("https://bitbucket.org/foo/bar")).toEqual(["any"]);
  });

  // GHE (github.<org>.com 形式) → ["org:<org>"]
  test("github.kddi.com SSH → org:kddi", () => {
    expect(parseRemoteOriginToTags("git@github.kddi.com:foo/bar.git")).toEqual(["org:kddi"]);
  });

  test("github.kddi.com HTTPS → org:kddi", () => {
    expect(parseRemoteOriginToTags("https://github.kddi.com/foo/bar")).toEqual(["org:kddi"]);
  });

  test("github.acme.com SSH → org:acme", () => {
    expect(parseRemoteOriginToTags("git@github.acme.com:foo/bar.git")).toEqual(["org:acme"]);
  });

  test("ssh://git@github.kddi.com:22/foo/bar.git → org:kddi", () => {
    expect(parseRemoteOriginToTags("ssh://git@github.kddi.com:22/foo/bar.git")).toEqual(["org:kddi"]);
  });

  // 任意カスタム host (github で始まらない) → 最初のラベル
  test("git.internal.example.com SSH → org:git", () => {
    expect(parseRemoteOriginToTags("git@git.internal.example.com:foo/bar.git")).toEqual(["org:git"]);
  });

  test("HTTPS の任意カスタム host → 最初のラベル", () => {
    expect(parseRemoteOriginToTags("https://gitea.example.com/foo/bar")).toEqual(["org:gitea"]);
  });

  // 解析不能 / 空 → ["any"]
  test("空文字 → any", () => {
    expect(parseRemoteOriginToTags("")).toEqual(["any"]);
  });

  test("not-a-url → any", () => {
    expect(parseRemoteOriginToTags("not-a-url")).toEqual(["any"]);
  });

  test("FALLBACK_TAGS は ['any']", () => {
    expect([...FALLBACK_TAGS]).toEqual(["any"]);
  });

  // case-insensitive
  test("ホスト大文字 → 小文字に正規化して判定", () => {
    expect(parseRemoteOriginToTags("https://GitHub.com/foo/bar")).toEqual(["any"]);
    expect(parseRemoteOriginToTags("https://GitHub.KDDI.com/foo/bar")).toEqual(["org:kddi"]);
  });
});

describe("resolveProjectTags", () => {
  async function makeTempProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "project-tags-test-"));
    return dir;
  }

  test(".team/config.json の project_tags 配列を優先", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["org:foo", "org:bar"] }),
      );
      const tags = await resolveProjectTags(root);
      expect(tags).toEqual(["org:foo", "org:bar"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json の project_tags が空配列なら fallback", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(join(root, ".team/config.json"), JSON.stringify({ project_tags: [] }));
      const tags = await resolveProjectTags(root);
      expect(tags).toEqual(["any"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json の project_tags が文字列以外を含むなら fallback", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["org:foo", 123] }),
      );
      const tags = await resolveProjectTags(root);
      expect(tags).toEqual(["any"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json の project_tags が array でないなら fallback", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: "not-array" }),
      );
      const tags = await resolveProjectTags(root);
      expect(tags).toEqual(["any"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json が JSON parse 失敗なら fallback (throw しない)", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(join(root, ".team/config.json"), "{ broken json");
      const tags = await resolveProjectTags(root);
      expect(tags).toEqual(["any"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json なし & 非 git project root → ['any']", async () => {
    const root = await makeTempProject();
    try {
      const tags = await resolveProjectTags(root);
      expect(tags).toEqual(["any"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("project_tags キーが無い config.json → git remote 経由 or fallback", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(join(root, ".team/config.json"), JSON.stringify({ other: "field" }));
      const tags = await resolveProjectTags(root);
      // git init していないので fallback
      expect(tags).toEqual(["any"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRemoteOriginToContext (T335: OSS 判定の純粋関数)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseRemoteOriginToContext (T335)", () => {
  test("primaryOrgs=[] → 全パターンで isOss=false（旧動作維持）", () => {
    expect(parseRemoteOriginToContext("https://github.com/foo/bar", [])).toEqual({
      tags: ["any"],
      isOss: false,
    });
    expect(parseRemoteOriginToContext("git@github.kddi.com:foo/bar.git", [])).toEqual({
      tags: ["org:kddi"],
      isOss: false,
    });
    expect(parseRemoteOriginToContext("", [])).toEqual({
      tags: ["any"],
      isOss: false,
    });
  });

  test("primaryOrgs=['myorg'] + github.com → isOss=true", () => {
    expect(parseRemoteOriginToContext("https://github.com/foo/bar", ["myorg"])).toEqual({
      tags: ["any"],
      isOss: true,
    });
  });

  test("primaryOrgs=['myorg'] + github.myorg.com → isOss=false（自社 GHE）", () => {
    expect(parseRemoteOriginToContext("git@github.myorg.com:foo/bar.git", ["myorg"])).toEqual({
      tags: ["org:myorg"],
      isOss: false,
    });
  });

  test("primaryOrgs=['myorg'] + github.other.com → isOss=true（他社 GHE）", () => {
    expect(parseRemoteOriginToContext("git@github.other.com:foo/bar.git", ["myorg"])).toEqual({
      tags: ["org:other"],
      isOss: true,
    });
  });

  test("primaryOrgs=['myorg'] + 公開 OSS host (gitlab.com) → isOss=true", () => {
    expect(parseRemoteOriginToContext("https://gitlab.com/foo/bar", ["myorg"])).toEqual({
      tags: ["any"],
      isOss: true,
    });
  });

  test("primaryOrgs=['myorg'] + カスタム host (org:internal) → isOss=true", () => {
    // host=git.internal.example.com → org:git, primaryOrgs に含まれないので OSS 扱い
    expect(parseRemoteOriginToContext("git@git.internal.example.com:foo/bar.git", ["myorg"])).toEqual({
      tags: ["org:git"],
      isOss: true,
    });
  });

  test("primaryOrgs=['git'] + カスタム host で org が一致 → isOss=false", () => {
    expect(parseRemoteOriginToContext("git@git.internal.example.com:foo/bar.git", ["git"])).toEqual({
      tags: ["org:git"],
      isOss: false,
    });
  });

  test("解析不能 URL → tags=['any'], isOss=true (primaryOrgs 非空)", () => {
    // 空文字 / not-a-url は host 不明 → org 不明 → primaryOrgs と照合不能 → OSS 扱い
    expect(parseRemoteOriginToContext("", ["myorg"])).toEqual({
      tags: ["any"],
      isOss: true,
    });
    expect(parseRemoteOriginToContext("not-a-url", ["myorg"])).toEqual({
      tags: ["any"],
      isOss: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveProjectContext (T335)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectContext (T335)", () => {
  async function makeTempProject(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "project-context-test-"));
  }

  test(".team/config.json の project_tags=['org:myorg'] + primaryOrgs=['myorg'] → isOss=false", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["org:myorg"] }),
      );
      const ctx = await resolveProjectContext(root, ["myorg"]);
      expect(ctx).toEqual({ projectTags: ["org:myorg"], isOss: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json の project_tags=['org:other'] + primaryOrgs=['myorg'] → isOss=true", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["org:other"] }),
      );
      const ctx = await resolveProjectContext(root, ["myorg"]);
      expect(ctx).toEqual({ projectTags: ["org:other"], isOss: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json の project_tags=['any'] + primaryOrgs=[] → isOss=false（旧動作維持）", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["any"] }),
      );
      const ctx = await resolveProjectContext(root, []);
      expect(ctx).toEqual({ projectTags: ["any"], isOss: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json の project_tags=['any'] + primaryOrgs=['myorg'] → isOss=true（任意 tag は OSS 扱い）", async () => {
    const root = await makeTempProject();
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["any"] }),
      );
      const ctx = await resolveProjectContext(root, ["myorg"]);
      // tags が "any" のみで primaryOrgs と一致しない → OSS
      expect(ctx).toEqual({ projectTags: ["any"], isOss: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(".team/config.json なし & 非 git → fail-safe (tags=['any'], isOss=false)", async () => {
    const root = await makeTempProject();
    try {
      const ctx = await resolveProjectContext(root, ["myorg"]);
      expect(ctx).toEqual({ projectTags: ["any"], isOss: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("primaryOrgs=[] + git remote 解決失敗 → isOss=false", async () => {
    const root = await makeTempProject();
    try {
      const ctx = await resolveProjectContext(root, []);
      expect(ctx).toEqual({ projectTags: ["any"], isOss: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveProjectTags は resolveProjectContext の wrapper（既存テストは pass）
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectTags (T335: resolveProjectContext の wrapper として)", () => {
  test("resolveProjectContext と同じ projectTags を返す", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrapper-test-"));
    try {
      await mkdir(join(root, ".team"), { recursive: true });
      await writeFile(
        join(root, ".team/config.json"),
        JSON.stringify({ project_tags: ["org:foo"] }),
      );
      const tags = await resolveProjectTags(root);
      const ctx = await resolveProjectContext(root, []);
      expect(tags).toEqual(ctx.projectTags);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
