import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseRemoteOriginToTags, resolveProjectTags, FALLBACK_TAGS } from "./project-tags";

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
