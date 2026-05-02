/**
 * team-gc.ts の結合テスト（T416）。
 *
 * `runTeamGC(state, { trigger })` を直接呼び、FS / DB / log を assert する。
 * - active 保護プロトコル
 * - dry-run / 多重実行 race / VACUUM boot trigger 限定
 * - rotation 後 appendFile が新 inode に書かれる（proxy.ts:905 短命 fd 仮定の検証）
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  utimesSync,
  readFileSync,
} from "fs";
import { appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemon, type DaemonState } from "./daemon";
import { runTeamGC } from "./team-gc";
import { initDB } from "./trace-store";
import type { ConductorState } from "./schema";

let testDir: string;
let savedEnv: { PROJECT_ROOT?: string; TOKEN_STORE_DB_PATH?: string };

function setMtime(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, t, t);
}

function makeAgedDir(parent: string, name: string, daysAgo: number): string {
  const p = join(parent, name);
  mkdirSync(p, { recursive: true });
  // dir 内に 1 ファイル置いて mtime を制御
  writeFileSync(join(p, ".keep"), "x");
  setMtime(p, daysAgo);
  return p;
}

function makeAgedFile(parent: string, name: string, daysAgo: number, content = "x"): string {
  mkdirSync(parent, { recursive: true });
  const p = join(parent, name);
  writeFileSync(p, content);
  setMtime(p, daysAgo);
  return p;
}

function readManagerLog(): string {
  const path = join(testDir, ".team/logs/manager.log");
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), "team-gc-int-"));
  mkdirSync(join(testDir, ".team"), { recursive: true });
  savedEnv = {
    PROJECT_ROOT: process.env.PROJECT_ROOT,
    TOKEN_STORE_DB_PATH: process.env.TOKEN_STORE_DB_PATH,
  };
  process.env.PROJECT_ROOT = testDir;
  // tokens.db は隔離して書き込ませる（boot trigger checkpoint で副作用が出ないため）
  process.env.TOKEN_STORE_DB_PATH = join(testDir, "tokens.db");
});

afterEach(async () => {
  if (savedEnv.PROJECT_ROOT === undefined) delete process.env.PROJECT_ROOT;
  else process.env.PROJECT_ROOT = savedEnv.PROJECT_ROOT;
  if (savedEnv.TOKEN_STORE_DB_PATH === undefined) delete process.env.TOKEN_STORE_DB_PATH;
  else process.env.TOKEN_STORE_DB_PATH = savedEnv.TOKEN_STORE_DB_PATH;
  rmSync(testDir, { recursive: true, force: true });
});

async function buildStateWithTraceDb(): Promise<DaemonState> {
  const state = await createDaemon(testDir);
  state.traceDb = initDB(testDir);
  state.mainBranch = "main";
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// boot trigger: 全 sweep が走る + VACUUM が呼ばれる
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: boot trigger", () => {
  test("全 sweep が走り team_gc_deleted がカテゴリ別に出る", async () => {
    // 各カテゴリに古い entry を配置
    const teamDir = join(testDir, ".team");
    makeAgedFile(join(teamDir, "logs/traces/bodies"), "old.bin", 30);
    makeAgedFile(join(teamDir, "prompts"), "task-old.md", 30);
    makeAgedFile(join(teamDir, "queue/processed"), "msg-old.json", 14);
    makeAgedDir(join(teamDir, "output"), "task-001-old", 30);
    makeAgedDir(join(teamDir, "conductors"), "surface_old", 30);
    makeAgedDir(join(teamDir, "e2e-results"), "run-old", 14);

    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "boot" });

    const logText = readManagerLog();
    expect(logText).toContain("team_gc_started trigger=boot");
    expect(logText).toContain("category=bodies");
    expect(logText).toContain("category=prompts");
    expect(logText).toContain("category=queue_processed");
    expect(logText).toContain("category=output");
    expect(logText).toContain("category=conductors");
    expect(logText).toContain("category=e2e_results");
    expect(logText).toContain("team_gc_completed trigger=boot");

    // FS から消えていることを確認
    expect(existsSync(join(teamDir, "logs/traces/bodies/old.bin"))).toBe(false);
    expect(existsSync(join(teamDir, "prompts/task-old.md"))).toBe(false);
    expect(existsSync(join(teamDir, "queue/processed/msg-old.json"))).toBe(false);
    expect(existsSync(join(teamDir, "output/task-001-old"))).toBe(false);
    expect(existsSync(join(teamDir, "conductors/surface_old"))).toBe(false);
    expect(existsSync(join(teamDir, "e2e-results/run-old"))).toBe(false);
  });

  test("boot trigger で team_gc_db_vacuum が emit される", async () => {
    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "boot" });

    const logText = readManagerLog();
    expect(logText).toContain("team_gc_db_vacuum");
    expect(logText).toContain("team_gc_wal_checkpoint");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// periodic trigger: VACUUM / WAL checkpoint は呼ばれない
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: periodic trigger", () => {
  test("periodic では team_gc_db_vacuum / team_gc_wal_checkpoint が emit されない", async () => {
    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "periodic" });

    const logText = readManagerLog();
    expect(logText).toContain("team_gc_started trigger=periodic");
    expect(logText).not.toContain("team_gc_db_vacuum");
    expect(logText).not.toContain("team_gc_wal_checkpoint");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dry-run: FS 不変
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: dry-run", () => {
  test("dryRun=true は team_gc_deleted は出るが FS は変化しない", async () => {
    const teamDir = join(testDir, ".team");
    makeAgedFile(join(teamDir, "logs/traces/bodies"), "old.bin", 30);

    // config.json で dryRun=true を指定
    writeFileSync(
      join(teamDir, "config.json"),
      JSON.stringify({ gc: { dryRun: true, runOnStart: true, periodic: false } }),
    );

    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "manual" });

    const logText = readManagerLog();
    expect(logText).toContain("team_gc_deleted");
    expect(logText).toContain("dry_run=true");

    // FS 不変
    expect(existsSync(join(teamDir, "logs/traces/bodies/old.bin"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// active 保護
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: active 保護", () => {
  test("active taskRunId に対応する output/<id>/ は保護される", async () => {
    const teamDir = join(testDir, ".team");
    const activeRunId = "task-100-active";
    const inactiveRunId = "task-099-old";

    // active な task-state.json
    writeFileSync(
      join(teamDir, "task-state.json"),
      JSON.stringify({
        "100": { status: "assigned", taskRunId: activeRunId },
      }),
    );

    makeAgedDir(join(teamDir, "output"), activeRunId, 30);
    makeAgedDir(join(teamDir, "output"), inactiveRunId, 30);

    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "manual" });

    expect(existsSync(join(teamDir, "output", activeRunId))).toBe(true);
    expect(existsSync(join(teamDir, "output", inactiveRunId))).toBe(false);
  });

  test("active conductor surface (normalizeSurfaceForPath 後) は保護される", async () => {
    const teamDir = join(testDir, ".team");
    const activeSurface = "surface:100";
    const activeName = "surface_100"; // normalizeSurfaceForPath 後

    makeAgedDir(join(teamDir, "conductors"), activeName, 30);
    makeAgedDir(join(teamDir, "conductors"), "surface_999", 30);

    const state = await buildStateWithTraceDb();
    state.conductors.set(activeSurface, {
      surface: activeSurface,
      startedAt: new Date().toISOString(),
      agents: [],
      status: "idle",
    } as ConductorState);

    await runTeamGC(state, { trigger: "manual" });

    expect(existsSync(join(teamDir, "conductors", activeName))).toBe(true);
    expect(existsSync(join(teamDir, "conductors", "surface_999"))).toBe(false);
  });

  test("legacy conductor.surface:NNN ディレクトリは retention 経過で削除される", async () => {
    const teamDir = join(testDir, ".team");
    makeAgedDir(join(teamDir, "conductors"), "conductor.surface:200", 30);

    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "manual" });

    expect(existsSync(join(teamDir, "conductors", "conductor.surface:200"))).toBe(false);
  });

  test("e2e-results は active 保護なし（8 日前 mtime / retention 7 日で削除）", async () => {
    const teamDir = join(testDir, ".team");
    makeAgedDir(join(teamDir, "e2e-results"), "run-old", 8);

    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "manual" });

    expect(existsSync(join(teamDir, "e2e-results", "run-old"))).toBe(false);
  });

  test("prompt は mtime 24h 以内なら名前マッチ非該当でも保護される", async () => {
    const teamDir = join(testDir, ".team");
    // 30 日前 mtime のファイルだが、retention=1 日設定下でも 24h 内 mtime のファイルが
    // 残ることを確認するため、別ファイル recent.md（最新 mtime）を配置する。
    makeAgedFile(join(teamDir, "prompts"), "old-task.md", 30);
    const recentPath = makeAgedFile(join(teamDir, "prompts"), "recent.md", 0);
    // 0 日前で mtime をセット
    setMtime(recentPath, 0);

    // config で retention=1 日
    writeFileSync(
      join(teamDir, "config.json"),
      JSON.stringify({
        gc: {
          retention: { promptsDays: 1 },
          runOnStart: true,
          periodic: false,
        },
      }),
    );

    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "manual" });

    // recent.md は mtime 24h 以内 → 保護
    expect(existsSync(recentPath)).toBe(true);
    // old-task.md は retention 1 日超 + 24h 内 mtime ではない → 削除
    expect(existsSync(join(teamDir, "prompts/old-task.md"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 多重実行 race
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: 多重実行 race", () => {
  test("Promise.all で 2 回呼ぶ → 一方が team_gc_skipped reason=in_flight", async () => {
    const teamDir = join(testDir, ".team");
    // 大量の古い bodies を作って sweep に時間をかけさせる
    for (let i = 0; i < 30; i++) {
      makeAgedFile(join(teamDir, "logs/traces/bodies"), `old-${i}.bin`, 30);
    }

    const state = await buildStateWithTraceDb();
    await Promise.all([
      runTeamGC(state, { trigger: "manual" }),
      runTeamGC(state, { trigger: "periodic" }),
    ]);

    const logText = readManagerLog();
    expect(logText).toContain("team_gc_skipped");
    expect(logText).toContain("reason=in_flight");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state.traceDb null でも throw しない
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: traceDb null", () => {
  test("traceDb=null でも team_gc_completed まで到達する", async () => {
    const state = await createDaemon(testDir);
    state.traceDb = null;
    state.mainBranch = "main";
    await runTeamGC(state, { trigger: "manual" });

    const logText = readManagerLog();
    expect(logText).toContain("team_gc_completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rotation 後の appendFile が新 inode に書かれる (proxy.ts:905 仮定検証)
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: rotation 後 appendFile", () => {
  test("rotation 後の appendFile は新 inode に書き、.1 は元の bytes を保持する", async () => {
    const teamDir = join(testDir, ".team");
    const traceFile = join(teamDir, "logs/traces/api-trace.jsonl");
    mkdirSync(join(teamDir, "logs/traces"), { recursive: true });
    // 11MB の dummy 内容で書き込み
    const big = Buffer.alloc(11 * 1024 * 1024, "a");
    writeFileSync(traceFile, big);
    const beforeBytes = statSync(traceFile).size;

    // rotation 発火（boot trigger で proxy.ts と同じ短命 fd 流儀の appendFile を呼ぶ前段）
    const state = await buildStateWithTraceDb();
    await runTeamGC(state, { trigger: "boot" });

    // rotation 後の状態を確認
    expect(existsSync(`${traceFile}.1`)).toBe(true);
    expect(statSync(`${traceFile}.1`).size).toBe(beforeBytes);
    expect(existsSync(traceFile)).toBe(false);

    // appendFile を発行して新 inode に書かれることを確認
    await appendFile(traceFile, "X\n");
    const afterContent = readFileSync(traceFile, "utf-8");
    expect(afterContent).toBe("X\n");
    // .1 は元のサイズを保持（appendFile は古い inode に書いていない）
    expect(statSync(`${traceFile}.1`).size).toBe(beforeBytes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearInterval で停止する
// ─────────────────────────────────────────────────────────────────────────────

describe("runTeamGC: timer 制御", () => {
  test("__clearGCIntervalForTest で setInterval を解放できる", async () => {
    const { __clearGCIntervalForTest } = await import("./team-gc");
    const state = await createDaemon(testDir);

    let calls = 0;
    state.gcInterval = setInterval(() => {
      calls++;
    }, 50);

    await new Promise((r) => setTimeout(r, 110));
    __clearGCIntervalForTest(state);
    const callsAtClear = calls;

    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(callsAtClear);
    expect(state.gcInterval).toBeUndefined();
  });
});
