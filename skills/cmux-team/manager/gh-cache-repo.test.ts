import { describe, test, expect } from "bun:test";
import { parseRemoteUrl, apiBaseUrl } from "./gh-cache-repo";

describe("parseRemoteUrl", () => {
  test("github.com SSH", () => {
    expect(parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({
      host: "api.github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("github.com HTTPS with .git", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      host: "api.github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("github.com HTTPS without .git", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo")).toEqual({
      host: "api.github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("GHE SSH → host includes /api/v3", () => {
    expect(parseRemoteUrl("git@ghe.example.com:o/r.git")).toEqual({
      host: "ghe.example.com/api/v3",
      owner: "o",
      repo: "r",
    });
  });

  test("GHE HTTPS → host includes /api/v3", () => {
    expect(parseRemoteUrl("https://ghe.example.com/o/r")).toEqual({
      host: "ghe.example.com/api/v3",
      owner: "o",
      repo: "r",
    });
  });

  test("gitlab.com → null", () => {
    expect(parseRemoteUrl("git@gitlab.com:o/r.git")).toBeNull();
  });

  test("bitbucket.org → null", () => {
    expect(parseRemoteUrl("https://bitbucket.org/o/r.git")).toBeNull();
  });

  test("empty string → null", () => {
    expect(parseRemoteUrl("")).toBeNull();
  });

  test("invalid URL → null", () => {
    expect(parseRemoteUrl("not a url")).toBeNull();
  });

  test("ssh:// URL 形式", () => {
    expect(parseRemoteUrl("ssh://git@github.com/owner/repo.git")).toEqual({
      host: "api.github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("www.github.com も normalize される", () => {
    expect(parseRemoteUrl("https://www.github.com/owner/repo")).toEqual({
      host: "api.github.com",
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("apiBaseUrl", () => {
  test("api.github.com", () => {
    expect(apiBaseUrl("api.github.com")).toBe("https://api.github.com");
  });

  test("GHE host with /api/v3", () => {
    expect(apiBaseUrl("ghe.example.com/api/v3")).toBe(
      "https://ghe.example.com/api/v3",
    );
  });
});
