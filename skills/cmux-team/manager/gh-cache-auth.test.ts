import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  tokenHash,
  ghCliHostname,
  resolveGithubToken,
} from "./gh-cache-auth";

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

describe("tokenHash", () => {
  test("長さ 32 の 16 進文字列", () => {
    const h = tokenHash("ghp_abcdef1234567890");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  test("同じ入力 → 同じ出力", () => {
    expect(tokenHash("x")).toBe(tokenHash("x"));
  });

  test("違う入力 → 違う出力", () => {
    expect(tokenHash("a")).not.toBe(tokenHash("b"));
  });
});

describe("ghCliHostname", () => {
  test("api.github.com → github.com", () => {
    expect(ghCliHostname("api.github.com")).toBe("github.com");
  });

  test("GHE `/api/v3` は落とす", () => {
    expect(ghCliHostname("ghe.example.com/api/v3")).toBe("ghe.example.com");
  });

  test("`/api/v3` なしの GHE もそのまま", () => {
    expect(ghCliHostname("ghe.example.com")).toBe("ghe.example.com");
  });
});

describe("resolveGithubToken", () => {
  test("GITHUB_TOKEN が優先される (github.com)", async () => {
    process.env.GITHUB_TOKEN = "token_A";
    process.env.GH_TOKEN = "token_B";
    const r = await resolveGithubToken("api.github.com", {
      ghCliTokenFn: async () => "token_cli",
    });
    expect(r.kind).toBe("env");
    if (r.kind === "env") expect(r.token).toBe("token_A");
  });

  test("GITHUB_TOKEN が無ければ GH_TOKEN", async () => {
    process.env.GH_TOKEN = "token_B";
    const r = await resolveGithubToken("api.github.com", {
      ghCliTokenFn: async () => "token_cli",
    });
    expect(r.kind).toBe("env");
    if (r.kind === "env") expect(r.token).toBe("token_B");
  });

  test("env 無ければ gh CLI", async () => {
    const r = await resolveGithubToken("api.github.com", {
      ghCliTokenFn: async (h) => {
        expect(h).toBe("github.com");
        return "cli_token";
      },
    });
    expect(r.kind).toBe("gh-cli");
    if (r.kind === "gh-cli") expect(r.token).toBe("cli_token");
  });

  test("どこにもなければ kind=none", async () => {
    const r = await resolveGithubToken("api.github.com", {
      ghCliTokenFn: async () => undefined,
    });
    expect(r.kind).toBe("none");
  });

  test("GHE は GH_ENTERPRISE_TOKEN を優先", async () => {
    process.env.GITHUB_TOKEN = "wrong";
    process.env.GH_ENTERPRISE_TOKEN = "ghe_A";
    process.env.GITHUB_ENTERPRISE_TOKEN = "ghe_B";
    const r = await resolveGithubToken("ghe.example.com/api/v3", {
      ghCliTokenFn: async () => "cli",
    });
    expect(r.kind).toBe("env");
    if (r.kind === "env") expect(r.token).toBe("ghe_A");
  });

  test("GHE で GH_ENTERPRISE_TOKEN が無ければ GITHUB_ENTERPRISE_TOKEN", async () => {
    process.env.GITHUB_ENTERPRISE_TOKEN = "ghe_B";
    const r = await resolveGithubToken("ghe.example.com/api/v3", {
      ghCliTokenFn: async () => "cli",
    });
    expect(r.kind).toBe("env");
    if (r.kind === "env") expect(r.token).toBe("ghe_B");
  });

  test("checked 配列に確認した env 名と gh コマンドが入る", async () => {
    const r = await resolveGithubToken("api.github.com", {
      ghCliTokenFn: async () => undefined,
    });
    expect(r.checked).toContain("GITHUB_TOKEN");
    expect(r.checked).toContain("GH_TOKEN");
    expect(r.checked.some((s) => s.startsWith("gh auth token"))).toBe(true);
  });

  test("空白だけの env は無視される", async () => {
    process.env.GITHUB_TOKEN = "   ";
    const r = await resolveGithubToken("api.github.com", {
      ghCliTokenFn: async () => "cli",
    });
    expect(r.kind).toBe("gh-cli");
  });
});
