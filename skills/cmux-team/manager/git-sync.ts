/**
 * T283: local `<mainBranch>` と `origin/<mainBranch>` の整合性を
 * 7 状態 enum で網羅し、`cmux-team create-task --status ready` /
 * `cmux-team update-task --status ready` のゲートとして使う pure module。
 *
 * 責務分離:
 * - `collectSyncFacts` (async) — git コマンド群を叩いて `SyncFacts` を組み立てる
 * - `decideSyncState`  (pure)  — `SyncFacts` から state を判定
 * - `classifyVerdict`  (pure)  — state とメッセージ材料から Verdict を返す
 * - `checkSyncState`   (async) — 3 つを束ねる一発 API
 *
 * state 決定順序:
 *   1. headStatus === "detached" → "detached"
 *   2. hasUncommittedOnMain       → "uncommitted"
 *   3. !originMainExists || !localMainExists → "no-remote"
 *   4. SHA 比較: clean / behind-ff / ahead / diverged
 *
 * hasUncommittedOnMain は on-main のときのみ true になりうる（on-other-branch /
 * detached では collectSyncFacts が常に false を返す — 実装規約で担保）。
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { log } from "./logger";

const execFile = promisify(execFileCb);

export type SyncState =
  | "clean"
  | "behind-ff"
  | "ahead"
  | "diverged"
  | "uncommitted"
  | "detached"
  | "no-remote";

export interface SyncFacts {
  mainBranch: string;
  originMainExists: boolean;
  localMainExists: boolean;
  originSha: string | null;
  localSha: string | null;
  headStatus: "on-main" | "on-other-branch" | "detached";
  /**
   * on-main で dirty tree がある場合のみ true。
   * on-other-branch / detached では常に false（collectSyncFacts で担保）。
   */
  hasUncommittedOnMain: boolean;
  /** `git merge-base --is-ancestor origin/<main> <main>` が成功したか（local が origin を含むか） */
  isOriginAncestorOfLocal: boolean;
  /** `git merge-base --is-ancestor <main> origin/<main>` が成功したか（origin が local を含むか） */
  isLocalAncestorOfOrigin: boolean;
}

export type Verdict =
  | { kind: "allow"; state: SyncState }
  | { kind: "warn"; state: SyncState; message: string }
  | { kind: "reject"; state: SyncState; message: string };

/** pure: SyncFacts → SyncState */
export function decideSyncState(facts: SyncFacts): SyncState {
  if (facts.headStatus === "detached") {
    return "detached";
  }
  if (facts.hasUncommittedOnMain) {
    return "uncommitted";
  }
  if (!facts.originMainExists || !facts.localMainExists) {
    return "no-remote";
  }
  if (facts.originSha !== null && facts.localSha !== null && facts.originSha === facts.localSha) {
    return "clean";
  }
  if (facts.isLocalAncestorOfOrigin && !facts.isOriginAncestorOfLocal) {
    return "behind-ff";
  }
  if (facts.isOriginAncestorOfLocal && !facts.isLocalAncestorOfOrigin) {
    return "ahead";
  }
  return "diverged";
}

const BYPASS_HINT =
  "\n\nBypass: add --force or set CMUX_TEAM_SKIP_SYNC_CHECK=1";

/**
 * pure: state + facts → Verdict。
 * message には state 名と推奨コマンド（facts.mainBranch を埋め込む）を含める。
 */
export function classifyVerdict(state: SyncState, facts: SyncFacts): Verdict {
  const mb = facts.mainBranch;
  switch (state) {
    case "clean":
      return { kind: "allow", state };
    case "ahead":
      return { kind: "allow", state };
    case "behind-ff":
      return {
        kind: "warn",
        state,
        message:
          `warning: local ${mb} is behind-ff origin/${mb}.\n` +
          `  Recommended: git fetch origin && git pull --ff-only origin ${mb}`,
      };
    case "no-remote":
      return {
        kind: "warn",
        state,
        message:
          `warning: no-remote — origin/${mb} or local ${mb} is missing.\n` +
          `  Recommended: verify 'git remote -v' and 'git fetch origin'`,
      };
    case "diverged":
      return {
        kind: "reject",
        state,
        message:
          `Error: diverged — local ${mb} and origin/${mb} have conflicting histories.\n\n` +
          `  Recommended: git fetch origin && git pull --rebase origin ${mb}` +
          BYPASS_HINT,
      };
    case "uncommitted":
      return {
        kind: "reject",
        state,
        message:
          `Error: uncommitted — ${mb} is checked out with a dirty working tree.\n\n` +
          `  Recommended: git stash / git commit / git restore ...` +
          BYPASS_HINT,
      };
    case "detached":
      return {
        kind: "reject",
        state,
        message:
          `Error: detached — HEAD is detached.\n\n` +
          `  Recommended: git checkout ${mb}` +
          BYPASS_HINT,
      };
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      throw new Error(`unreachable: ${state as string}`);
    }
  }
}

export interface CollectSyncFactsOptions {
  mainBranch: string;
  doFetch?: boolean;
  /** テスト用 git コマンド注入。戻り値は stdout.trim() 相当。throw でコマンド失敗 */
  git?: (args: string[]) => Promise<string>;
}

/**
 * git コマンド群を叩いて SyncFacts を構築する。個々のコマンドは best-effort で、
 * 失敗時は対応する boolean を false / 値を null にフォールバックする。
 *
 * doFetch=true の場合、最初に `git fetch --quiet origin <mainBranch>` を実行。
 * 失敗はログのみで継続する（オフライン環境でも check が走るようにするため）。
 */
export async function collectSyncFacts(
  projectRoot: string,
  opts: CollectSyncFactsOptions,
): Promise<SyncFacts> {
  const main = opts.mainBranch;
  const git =
    opts.git ??
    (async (args: string[]) => {
      const { stdout } = await execFile("git", args, {
        cwd: projectRoot,
        timeout: 30000,
      });
      return stdout.trim();
    });

  if (opts.doFetch) {
    try {
      await git(["fetch", "--quiet", "origin", main]);
    } catch (e: any) {
      await log(
        "sync_check_fetch_failed",
        `main=${main} stderr=${(e?.stderr ?? "").toString().trim()}`,
      );
    }
  }

  let originMainExists = false;
  try {
    await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${main}^{commit}`,
    ]);
    originMainExists = true;
  } catch {
    // origin にない
  }

  let localMainExists = false;
  try {
    await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${main}^{commit}`,
    ]);
    localMainExists = true;
  } catch {
    // local にない
  }

  let headStatus: SyncFacts["headStatus"];
  let currentBranch: string | null = null;
  try {
    currentBranch = await git(["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    currentBranch = null;
  }
  if (currentBranch === null || currentBranch === "") {
    headStatus = "detached";
  } else if (currentBranch === main) {
    headStatus = "on-main";
  } else {
    headStatus = "on-other-branch";
  }

  let hasUncommittedOnMain = false;
  if (headStatus === "on-main") {
    try {
      // T298: `.team/` 配下の変更は cmux-team 自身が書き込むため uncommitted から除外。
      // pathspec magic `:(exclude).team` で git 側で除外させ、porcelain 出力の自前パースを避ける。
      const out = await git(["status", "--porcelain", "--", ".", ":(exclude).team"]);
      hasUncommittedOnMain = out.trim().length > 0;
    } catch {
      hasUncommittedOnMain = false;
    }
  }

  let originSha: string | null = null;
  if (originMainExists) {
    try {
      originSha = await git(["rev-parse", `origin/${main}`]);
    } catch {
      originSha = null;
    }
  }

  let localSha: string | null = null;
  if (localMainExists) {
    try {
      localSha = await git(["rev-parse", main]);
    } catch {
      localSha = null;
    }
  }

  let isOriginAncestorOfLocal = false;
  let isLocalAncestorOfOrigin = false;
  if (originMainExists && localMainExists) {
    try {
      await git(["merge-base", "--is-ancestor", `origin/${main}`, main]);
      isOriginAncestorOfLocal = true;
    } catch {
      isOriginAncestorOfLocal = false;
    }
    try {
      await git(["merge-base", "--is-ancestor", main, `origin/${main}`]);
      isLocalAncestorOfOrigin = true;
    } catch {
      isLocalAncestorOfOrigin = false;
    }
  }

  return {
    mainBranch: main,
    originMainExists,
    localMainExists,
    originSha,
    localSha,
    headStatus,
    hasUncommittedOnMain,
    isOriginAncestorOfLocal,
    isLocalAncestorOfOrigin,
  };
}

export interface CheckSyncStateResult {
  state: SyncState;
  facts: SyncFacts;
  verdict: Verdict;
}

/** collectSyncFacts + decideSyncState + classifyVerdict を一気に呼ぶ */
export async function checkSyncState(
  projectRoot: string,
  opts: CollectSyncFactsOptions,
): Promise<CheckSyncStateResult> {
  const facts = await collectSyncFacts(projectRoot, opts);
  const state = decideSyncState(facts);
  const verdict = classifyVerdict(state, facts);
  return { state, facts, verdict };
}
