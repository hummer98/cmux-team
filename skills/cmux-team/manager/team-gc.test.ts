/**
 * team-gc.ts の単体テスト（T416）。
 *
 * 各 sweep 関数を fixture 入力で呼び、戻り値を検証する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  sweepDirByMtime,
  rotateLogFile,
  gcTraceDb,
  vacuumTraceDb,
  checkpointTokensDb,
  type GcDeletion,
} from "./team-gc";
import { initTokenDB } from "./token-store";
import { initDB } from "./trace-store";

// ─────────────────────────────────────────────────────────────────────────────
// 共通 helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpRoot: string;

function setMtime(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, t, t);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "team-gc-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepDirByMtime
// ─────────────────────────────────────────────────────────────────────────────

describe("sweepDirByMtime (T416)", () => {
  test("古いファイルが返る（30 日前 mtime / retention 14 日）", async () => {
    const dir = join(tmpRoot, "bodies");
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, "old.txt");
    writeFileSync(oldFile, "x");
    setMtime(oldFile, 30);

    const result = await sweepDirByMtime({
      dir,
      retentionDays: 14,
      protect: () => false,
      category: "bodies",
    });

    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe(oldFile);
    expect(result[0]!.category).toBe("bodies");
    expect(result[0]!.ageDays).toBeGreaterThan(14);
  });

  test("新しいファイルは返らない（1 日前 mtime / retention 14 日）", async () => {
    const dir = join(tmpRoot, "bodies");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "fresh.txt");
    writeFileSync(file, "x");
    setMtime(file, 1);

    const result = await sweepDirByMtime({
      dir,
      retentionDays: 14,
      protect: () => false,
      category: "bodies",
    });

    expect(result).toEqual([]);
  });

  test("protect=true なら全件保護", async () => {
    const dir = join(tmpRoot, "prompts");
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, "task-1.md");
    writeFileSync(oldFile, "x");
    setMtime(oldFile, 30);

    const result = await sweepDirByMtime({
      dir,
      retentionDays: 14,
      protect: () => true,
      category: "prompts",
    });

    expect(result).toEqual([]);
  });

  test("ディレクトリ entry も処理する（output/<id>/ 形式）", async () => {
    const dir = join(tmpRoot, "output");
    mkdirSync(dir, { recursive: true });
    const oldRunDir = join(dir, "task-001-1700000000");
    mkdirSync(oldRunDir, { recursive: true });
    writeFileSync(join(oldRunDir, "log.txt"), "x");
    setMtime(oldRunDir, 30);

    const result = await sweepDirByMtime({
      dir,
      retentionDays: 14,
      protect: () => false,
      category: "output",
    });

    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe(oldRunDir);
  });

  test("e2e_results category が機能する（8 日前 mtime / retention 7 日）", async () => {
    const dir = join(tmpRoot, "e2e-results");
    mkdirSync(dir, { recursive: true });
    const oldRun = join(dir, "run-old");
    mkdirSync(oldRun);
    setMtime(oldRun, 8);

    const result = await sweepDirByMtime({
      dir,
      retentionDays: 7,
      protect: () => false,
      category: "e2e_results",
    });

    expect(result.length).toBe(1);
    expect(result[0]!.category).toBe("e2e_results");
  });

  test("dir 不在 → 空配列を返す", async () => {
    const dir = join(tmpRoot, "missing");
    const result = await sweepDirByMtime({
      dir,
      retentionDays: 14,
      protect: () => false,
      category: "bodies",
    });
    expect(result).toEqual([]);
  });

  test("mixed: 古い+新しいが混在しても古いだけ返る", async () => {
    const dir = join(tmpRoot, "mix");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.txt"), "x");
    setMtime(join(dir, "old.txt"), 30);
    writeFileSync(join(dir, "new.txt"), "x");
    setMtime(join(dir, "new.txt"), 1);
    writeFileSync(join(dir, "older.txt"), "x");
    setMtime(join(dir, "older.txt"), 40);

    const result = await sweepDirByMtime({
      dir,
      retentionDays: 14,
      protect: () => false,
      category: "bodies",
    });
    const names = result.map((r) => r.path.split("/").pop()).sort();
    expect(names).toEqual(["old.txt", "older.txt"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rotateLogFile
// ─────────────────────────────────────────────────────────────────────────────

describe("rotateLogFile (T416)", () => {
  test("閾値超で .1 にローテート", async () => {
    const file = join(tmpRoot, "api-trace.jsonl");
    const big = Buffer.alloc(2 * 1024 * 1024, "a");
    writeFileSync(file, big);

    const r = await rotateLogFile({ file, sizeBytes: 1 * 1024 * 1024, keep: 5 });
    expect(r).not.toBeNull();
    expect(r?.fromBytes).toBe(2 * 1024 * 1024);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("複数世代が押し出される", async () => {
    const file = join(tmpRoot, "manager.log");
    const big = Buffer.alloc(2 * 1024 * 1024, "x");
    writeFileSync(file, big);

    // 1st rotate → .1
    await rotateLogFile({ file, sizeBytes: 1024 * 1024, keep: 3 });
    expect(existsSync(`${file}.1`)).toBe(true);

    writeFileSync(file, big);
    await rotateLogFile({ file, sizeBytes: 1024 * 1024, keep: 3 });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);

    writeFileSync(file, big);
    await rotateLogFile({ file, sizeBytes: 1024 * 1024, keep: 3 });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(true);

    // 4th rotate → .3 が unlink された後押し出される
    writeFileSync(file, big);
    await rotateLogFile({ file, sizeBytes: 1024 * 1024, keep: 3 });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(true);
    expect(existsSync(`${file}.4`)).toBe(false);
  });

  test("閾値以下は no-op", async () => {
    const file = join(tmpRoot, "small.log");
    writeFileSync(file, Buffer.alloc(1024, "y"));

    const r = await rotateLogFile({ file, sizeBytes: 10 * 1024 * 1024, keep: 5 });
    expect(r).toBeNull();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  test("file 不在 → null", async () => {
    const file = join(tmpRoot, "missing.log");
    const r = await rotateLogFile({ file, sizeBytes: 100, keep: 5 });
    expect(r).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gcTraceDb
// ─────────────────────────────────────────────────────────────────────────────

describe("gcTraceDb (T416)", () => {
  let db: Database;

  beforeEach(() => {
    db = initDB(tmpRoot);
  });

  afterEach(() => {
    db.close();
  });

  function insertHookSignal(timestamp: string): void {
    db.prepare(
      "INSERT INTO hook_signals (timestamp, type, payload_json) VALUES (?, ?, ?)",
    ).run(timestamp, "test", "{}");
  }

  function insertApiUsage(timestamp: string): void {
    db.prepare("INSERT INTO api_usage (timestamp) VALUES (?)").run(timestamp);
  }

  test("30 日超の hook_signals 行が DELETE される", () => {
    const now = new Date("2026-05-02T00:00:00Z");
    insertHookSignal("2026-03-01T00:00:00Z"); // 約 60 日前 → 削除
    insertHookSignal("2026-04-30T00:00:00Z"); // 約 2 日前 → 残す

    const r = gcTraceDb({ db, retentionDays: 30, now });
    expect(r.hookSignalsDeleted).toBe(1);

    const rows = db.prepare("SELECT timestamp FROM hook_signals").all() as Array<{
      timestamp: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.timestamp).toBe("2026-04-30T00:00:00Z");
  });

  test("api_usage も同様に DELETE される", () => {
    const now = new Date("2026-05-02T00:00:00Z");
    insertApiUsage("2026-03-01T00:00:00Z");
    insertApiUsage("2026-04-30T00:00:00Z");

    const r = gcTraceDb({ db, retentionDays: 30, now });
    expect(r.apiUsageDeleted).toBe(1);
    expect(r.hookSignalsDeleted).toBe(0);
  });

  test("dryRun=true は SELECT カウントだけ返す", () => {
    const now = new Date("2026-05-02T00:00:00Z");
    insertHookSignal("2026-03-01T00:00:00Z");
    insertHookSignal("2026-03-02T00:00:00Z");
    insertApiUsage("2026-03-01T00:00:00Z");

    const r = gcTraceDb({ db, retentionDays: 30, now, dryRun: true });
    expect(r.hookSignalsDeleted).toBe(2);
    expect(r.apiUsageDeleted).toBe(1);

    // FS 不変: 行は消えていない
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM hook_signals").get() as { c: number };
    expect(cnt.c).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vacuumTraceDb
// ─────────────────────────────────────────────────────────────────────────────

describe("vacuumTraceDb (T416)", () => {
  test("VACUUM 後にファイルサイズが縮小する（DELETE 後の free page 回収）", () => {
    const db = initDB(tmpRoot);
    // 大量の行を INSERT してから DELETE
    const insert = db.prepare(
      "INSERT INTO hook_signals (timestamp, type, payload_json) VALUES (?, ?, ?)",
    );
    const big = "x".repeat(1024);
    for (let i = 0; i < 1000; i++) {
      insert.run(`2026-01-01T00:00:00Z`, "test", big);
    }
    db.exec("DELETE FROM hook_signals");

    const dbPath = join(tmpRoot, ".team/traces/traces.db");
    const beforeSize = existsSync(dbPath) ? statSync(dbPath).size : 0;

    const r = vacuumTraceDb({ db });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }

    const afterSize = existsSync(dbPath) ? statSync(dbPath).size : 0;
    expect(afterSize).toBeLessThanOrEqual(beforeSize);
    db.close();
  });

  test("空 DB に対しても ok=true で完了する", () => {
    const db = initDB(tmpRoot);
    const r = vacuumTraceDb({ db });
    expect(r.ok).toBe(true);
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkpointTokensDb
// ─────────────────────────────────────────────────────────────────────────────

describe("checkpointTokensDb (T416)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.TOKEN_STORE_DB_PATH;
    process.env.TOKEN_STORE_DB_PATH = join(tmpRoot, "tokens.db");
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TOKEN_STORE_DB_PATH;
    else process.env.TOKEN_STORE_DB_PATH = savedEnv;
  });

  test("checkpoint が ok=true で完了する", () => {
    // 事前に DB を作る
    const db = initTokenDB();
    db.close();

    const r = checkpointTokensDb();
    expect(r.ok).toBe(true);
  });
});
