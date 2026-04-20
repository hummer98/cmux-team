/**
 * T283: git-sync の pure function / stub 経由 e2e テスト
 *
 * - decideSyncState の全 7 state を網羅（detached / uncommitted / no-remote /
 *   clean / behind-ff / ahead / diverged）
 * - on-other-branch 入力 3 ケース
 * - collectSyncFacts を git stub 経由で検証（origin 不在 / local 不在 /
 *   detached / dirty tree / ahead / behind / diverged）
 * - classifyVerdict の reject / warn / allow 振り分け
 * - checkSyncState の e2e（collect + decide + classify を stub で 1 回通す）
 */
import { describe, test, expect } from "bun:test";
import {
  decideSyncState,
  classifyVerdict,
  collectSyncFacts,
  checkSyncState,
  type SyncFacts,
  type SyncState,
} from "./git-sync";

// --- decideSyncState ---

function baseFacts(): SyncFacts {
  return {
    mainBranch: "main",
    originMainExists: true,
    localMainExists: true,
    originSha: "aaa",
    localSha: "aaa",
    headStatus: "on-main",
    hasUncommittedOnMain: false,
    isOriginAncestorOfLocal: true,
    isLocalAncestorOfOrigin: true,
  };
}

describe("decideSyncState — 7 states", () => {
  test("detached → detached", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      headStatus: "detached",
    };
    expect(decideSyncState(facts)).toBe("detached");
  });

  test("on-main + uncommitted → uncommitted", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      hasUncommittedOnMain: true,
    };
    expect(decideSyncState(facts)).toBe("uncommitted");
  });

  test("detached がある場合 uncommitted より優先される", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      headStatus: "detached",
      hasUncommittedOnMain: true,
    };
    expect(decideSyncState(facts)).toBe("detached");
  });

  test("originMainExists=false → no-remote", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      originMainExists: false,
      originSha: null,
    };
    expect(decideSyncState(facts)).toBe("no-remote");
  });

  test("localMainExists=false → no-remote (clone 直後)", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      localMainExists: false,
      localSha: null,
    };
    expect(decideSyncState(facts)).toBe("no-remote");
  });

  test("originSha === localSha → clean", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      originSha: "abc",
      localSha: "abc",
    };
    expect(decideSyncState(facts)).toBe("clean");
  });

  test("local ⊂ origin → behind-ff", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      originSha: "new",
      localSha: "old",
      isOriginAncestorOfLocal: false,
      isLocalAncestorOfOrigin: true,
    };
    expect(decideSyncState(facts)).toBe("behind-ff");
  });

  test("local ⊃ origin → ahead", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      originSha: "old",
      localSha: "new",
      isOriginAncestorOfLocal: true,
      isLocalAncestorOfOrigin: false,
    };
    expect(decideSyncState(facts)).toBe("ahead");
  });

  test("どちらも ancestor でない → diverged", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      originSha: "x",
      localSha: "y",
      isOriginAncestorOfLocal: false,
      isLocalAncestorOfOrigin: false,
    };
    expect(decideSyncState(facts)).toBe("diverged");
  });
});

describe("decideSyncState — on-other-branch 入力", () => {
  test("on-other-branch + 同一 SHA → clean", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      headStatus: "on-other-branch",
      hasUncommittedOnMain: false,
      originSha: "abc",
      localSha: "abc",
    };
    expect(decideSyncState(facts)).toBe("clean");
  });

  test("on-other-branch + ahead", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      headStatus: "on-other-branch",
      hasUncommittedOnMain: false,
      originSha: "old",
      localSha: "new",
      isOriginAncestorOfLocal: true,
      isLocalAncestorOfOrigin: false,
    };
    expect(decideSyncState(facts)).toBe("ahead");
  });

  test("on-other-branch + behind-ff", () => {
    const facts: SyncFacts = {
      ...baseFacts(),
      headStatus: "on-other-branch",
      hasUncommittedOnMain: false,
      originSha: "new",
      localSha: "old",
      isOriginAncestorOfLocal: false,
      isLocalAncestorOfOrigin: true,
    };
    expect(decideSyncState(facts)).toBe("behind-ff");
  });
});

// --- classifyVerdict ---

describe("classifyVerdict", () => {
  const facts = baseFacts();

  test("clean → allow", () => {
    const v = classifyVerdict("clean", facts);
    expect(v.kind).toBe("allow");
  });

  test("ahead → allow", () => {
    const v = classifyVerdict("ahead", facts);
    expect(v.kind).toBe("allow");
  });

  test("behind-ff → warn + 推奨 git pull --ff-only + mainBranch 埋め込み", () => {
    const v = classifyVerdict("behind-ff", facts);
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") {
      expect(v.message).toMatch(/behind-ff/);
      expect(v.message).toContain("git pull --ff-only origin main");
    }
  });

  test("no-remote → warn", () => {
    const v = classifyVerdict("no-remote", facts);
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") {
      expect(v.message).toMatch(/no-remote/);
    }
  });

  test("diverged → reject + git pull --rebase 推奨", () => {
    const v = classifyVerdict("diverged", facts);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") {
      expect(v.message).toMatch(/diverged/);
      expect(v.message).toContain("git pull --rebase origin main");
      expect(v.message).toMatch(/--force|CMUX_TEAM_SKIP_SYNC_CHECK/);
    }
  });

  test("uncommitted → reject", () => {
    const v = classifyVerdict("uncommitted", facts);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") {
      expect(v.message).toMatch(/uncommitted/);
      expect(v.message).toMatch(/git stash|git commit/);
    }
  });

  test("detached → reject", () => {
    const v = classifyVerdict("detached", facts);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") {
      expect(v.message).toMatch(/detached/);
      expect(v.message).toContain("git checkout main");
    }
  });

  test("mainBranch が develop の場合、推奨コマンドが展開される", () => {
    const fd: SyncFacts = { ...facts, mainBranch: "develop" };
    const v = classifyVerdict("diverged", fd);
    if (v.kind === "reject") {
      expect(v.message).toContain("git pull --rebase origin develop");
    } else {
      throw new Error("expected reject");
    }
  });
});

// --- collectSyncFacts (stub) ---

interface StubMap {
  [joined: string]: string | { stdout: string } | Error;
}

function makeGitStub(responses: StubMap): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const key = args.join(" ");
    const r = responses[key];
    if (r === undefined) {
      throw new Error(`stub missing for: git ${key}`);
    }
    if (r instanceof Error) throw r;
    if (typeof r === "string") return r;
    return r.stdout;
  };
}

function exitError(code: number): Error & { code: number; stderr: string } {
  const e = new Error(`exit ${code}`) as Error & { code: number; stderr: string };
  e.code = code;
  e.stderr = "";
  return e;
}

describe("collectSyncFacts — stub 経由", () => {
  test("clean state: origin と local が同一 SHA", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc123",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc123",
      "rev-parse HEAD": "abc123",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse origin/main": "abc123",
      "rev-parse main": "abc123",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": "",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.originMainExists).toBe(true);
    expect(facts.localMainExists).toBe(true);
    expect(facts.originSha).toBe("abc123");
    expect(facts.localSha).toBe("abc123");
    expect(facts.headStatus).toBe("on-main");
    expect(facts.hasUncommittedOnMain).toBe(false);
    expect(facts.isOriginAncestorOfLocal).toBe(true);
    expect(facts.isLocalAncestorOfOrigin).toBe(true);
  });

  test("origin 不在 → no-remote へ至る事実", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": exitError(1),
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc123",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse main": "abc123",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.originMainExists).toBe(false);
    expect(facts.localMainExists).toBe(true);
    expect(facts.originSha).toBeNull();
    expect(facts.localSha).toBe("abc123");
  });

  test("local 不在 (clone 直後で未 checkout)", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc",
      "rev-parse --verify --quiet refs/heads/main^{commit}": exitError(1),
      "symbolic-ref --short -q HEAD": "feature/x",
      "status --porcelain": "",
      "rev-parse origin/main": "abc",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.localMainExists).toBe(false);
    expect(facts.localSha).toBeNull();
    expect(facts.originMainExists).toBe(true);
    expect(facts.headStatus).toBe("on-other-branch");
  });

  test("detached HEAD", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc",
      "symbolic-ref --short -q HEAD": exitError(1),
      "status --porcelain": "",
      "rev-parse origin/main": "abc",
      "rev-parse main": "abc",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": "",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.headStatus).toBe("detached");
    expect(facts.hasUncommittedOnMain).toBe(false);
  });

  test("dirty tree on main → hasUncommittedOnMain=true", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": " M foo.txt\n?? bar.txt\n",
      "rev-parse origin/main": "abc",
      "rev-parse main": "abc",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": "",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.headStatus).toBe("on-main");
    expect(facts.hasUncommittedOnMain).toBe(true);
  });

  test("dirty tree on topic branch → hasUncommittedOnMain=false (on-other-branch)", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc",
      "symbolic-ref --short -q HEAD": "topic",
      "status --porcelain": " M foo.txt\n",
      "rev-parse origin/main": "abc",
      "rev-parse main": "abc",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": "",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.headStatus).toBe("on-other-branch");
    expect(facts.hasUncommittedOnMain).toBe(false);
  });

  test("ahead: local が origin より新しい", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "old",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "new",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse origin/main": "old",
      "rev-parse main": "new",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": exitError(1),
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.isOriginAncestorOfLocal).toBe(true);
    expect(facts.isLocalAncestorOfOrigin).toBe(false);
  });

  test("behind-ff: origin が local より新しい", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "new",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "old",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse origin/main": "new",
      "rev-parse main": "old",
      "merge-base --is-ancestor origin/main main": exitError(1),
      "merge-base --is-ancestor main origin/main": "",
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.isOriginAncestorOfLocal).toBe(false);
    expect(facts.isLocalAncestorOfOrigin).toBe(true);
  });

  test("diverged: どちらも ancestor でない", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "x",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "y",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse origin/main": "x",
      "rev-parse main": "y",
      "merge-base --is-ancestor origin/main main": exitError(1),
      "merge-base --is-ancestor main origin/main": exitError(1),
    });
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(facts.isOriginAncestorOfLocal).toBe(false);
    expect(facts.isLocalAncestorOfOrigin).toBe(false);
  });

  test("doFetch=true で git fetch が呼ばれる", async () => {
    const calls: string[][] = [];
    const stub = async (args: string[]) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "fetch --quiet origin main") return "";
      if (key === "rev-parse --verify --quiet refs/remotes/origin/main^{commit}") return "abc";
      if (key === "rev-parse --verify --quiet refs/heads/main^{commit}") return "abc";
      if (key === "symbolic-ref --short -q HEAD") return "main";
      if (key === "status --porcelain") return "";
      if (key === "rev-parse origin/main") return "abc";
      if (key === "rev-parse main") return "abc";
      if (key === "merge-base --is-ancestor origin/main main") return "";
      if (key === "merge-base --is-ancestor main origin/main") return "";
      throw new Error(`stub missing: ${key}`);
    };
    await collectSyncFacts("/tmp", { mainBranch: "main", doFetch: true, git: stub });
    const fetched = calls.some((c) => c[0] === "fetch");
    expect(fetched).toBe(true);
  });

  test("doFetch=true で fetch 失敗しても継続する", async () => {
    const calls: string[][] = [];
    const stub = async (args: string[]) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "fetch --quiet origin main") throw exitError(128);
      if (key === "rev-parse --verify --quiet refs/remotes/origin/main^{commit}") return "abc";
      if (key === "rev-parse --verify --quiet refs/heads/main^{commit}") return "abc";
      if (key === "symbolic-ref --short -q HEAD") return "main";
      if (key === "status --porcelain") return "";
      if (key === "rev-parse origin/main") return "abc";
      if (key === "rev-parse main") return "abc";
      if (key === "merge-base --is-ancestor origin/main main") return "";
      if (key === "merge-base --is-ancestor main origin/main") return "";
      throw new Error(`stub missing: ${key}`);
    };
    const facts = await collectSyncFacts("/tmp", {
      mainBranch: "main",
      doFetch: true,
      git: stub,
    });
    expect(facts.originSha).toBe("abc");
  });
});

// --- checkSyncState e2e ---

describe("checkSyncState — e2e (collect + decide + classify)", () => {
  test("clean state → allow", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse origin/main": "abc",
      "rev-parse main": "abc",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": "",
    });
    const r = await checkSyncState("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(r.state).toBe("clean");
    expect(r.verdict.kind).toBe("allow");
  });

  test("diverged state → reject、メッセージに diverged / --force", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "x",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "y",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": "",
      "rev-parse origin/main": "x",
      "rev-parse main": "y",
      "merge-base --is-ancestor origin/main main": exitError(1),
      "merge-base --is-ancestor main origin/main": exitError(1),
    });
    const r = await checkSyncState("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(r.state).toBe("diverged");
    expect(r.verdict.kind).toBe("reject");
    if (r.verdict.kind === "reject") {
      expect(r.verdict.message).toContain("diverged");
      expect(r.verdict.message).toMatch(/--force|CMUX_TEAM_SKIP_SYNC_CHECK/);
    }
  });

  test("uncommitted on main → reject", async () => {
    const stub = makeGitStub({
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "abc",
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc",
      "symbolic-ref --short -q HEAD": "main",
      "status --porcelain": " M x.txt\n",
      "rev-parse origin/main": "abc",
      "rev-parse main": "abc",
      "merge-base --is-ancestor origin/main main": "",
      "merge-base --is-ancestor main origin/main": "",
    });
    const r = await checkSyncState("/tmp", {
      mainBranch: "main",
      doFetch: false,
      git: stub,
    });
    expect(r.state).toBe("uncommitted");
    expect(r.verdict.kind).toBe("reject");
  });
});

// SyncState is a type, but we can type-check the assignable union:
const _stateExample: SyncState = "clean";
void _stateExample;
