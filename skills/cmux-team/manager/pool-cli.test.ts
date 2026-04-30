import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir } from "fs/promises";
import { createDummyProject, type DummyProject } from "./test-project";
import { cmdPoolStatus } from "./pool-cli";

let project: DummyProject;
let testDir: string;
let originalDb: string | undefined;
let originalKeychain: string | undefined;
let originalEnv: string | undefined;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-pool-cli-test-", subdirs: ["logs"] });
  testDir = project.root;
  const dbDir = join(testDir, "tokens");
  await mkdir(dbDir, { recursive: true });
  originalDb = process.env.TOKEN_STORE_DB_PATH;
  originalKeychain = process.env.KEYCHAIN_TEST_MODE;
  originalEnv = process.env.CMUX_TEAM_TOKEN_POOL;
  process.env.TOKEN_STORE_DB_PATH = join(
    dbDir,
    `tokens-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.KEYCHAIN_TEST_MODE = "1";
});

afterEach(async () => {
  if (originalDb !== undefined) process.env.TOKEN_STORE_DB_PATH = originalDb;
  else delete process.env.TOKEN_STORE_DB_PATH;
  if (originalKeychain !== undefined) process.env.KEYCHAIN_TEST_MODE = originalKeychain;
  else delete process.env.KEYCHAIN_TEST_MODE;
  if (originalEnv !== undefined) process.env.CMUX_TEAM_TOKEN_POOL = originalEnv;
  else delete process.env.CMUX_TEAM_TOKEN_POOL;
  await project.dispose();
});

function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; out: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let buf = "";
  console.log = (...args: any[]) => { buf += args.join(" ") + "\n"; };
  console.error = (...args: any[]) => { buf += args.join(" ") + "\n"; };
  return Promise.resolve(fn())
    .then((result) => ({ result, out: buf }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    });
}

describe("cmdPoolStatus (T323)", () => {
  test("pool 機能 OFF (env=0) → 1 行メッセージ + exit 0", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "0";
    const { out } = await captureConsole(() => cmdPoolStatus(testDir));
    expect(out).toContain("pool 機能は無効です");
  });

  test("pool 機能 ON だが token 未登録 → (no tokens registered)", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "1";
    const { out } = await captureConsole(() => cmdPoolStatus(testDir));
    expect(out).toContain("(no tokens registered)");
  });

  test("pool 機能 ON + token 登録あり → ヘッダーと行が出力され末尾に pool capacity", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "1";
    const { initTokenDB, insertToken, upsertUsageSnapshot } = await import("./token-store");
    const db = initTokenDB();
    const tok = insertToken(db, {
      handle: "@pers",
      organization_id: "org-pers",
      auth_hash: "hash-pers",
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any"],
      credential_source: "manual",
      selectable: true,
    });
    upsertUsageSnapshot(db, {
      token_id: tok.id,
      util_5h: 0.10,
      util_7d: 0.20,
      reset_5h_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reset_7d_at: new Date(Date.now() + 86400 * 1000).toISOString(),
      unified_status: "allowed",
    });
    db.close();

    const { out } = await captureConsole(() => cmdPoolStatus(testDir));
    expect(out).toContain("HANDLE");
    expect(out).toContain("@pers");
    expect(out).toContain("max-x20");
    expect(out).toContain("10%"); // 5h
    expect(out).toContain("20%"); // 7d
    expect(out).toContain("pool capacity");
    // T390: fresh snapshot のみで marker は出ない → 凡例も出さない
    expect(out).not.toContain("(* = reset 通過済み");
  });

  test("T390: reset 通過済み stale token は 5H 列が effUtil=0%、行末に * マーカー、フッタに凡例", async () => {
    process.env.CMUX_TEAM_TOKEN_POOL = "1";
    const { initTokenDB, insertToken, upsertUsageSnapshot } = await import("./token-store");
    const db = initTokenDB();
    const tok = insertToken(db, {
      handle: "@tayo",
      organization_id: "org-tayo",
      auth_hash: "hash-tayo",
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any"],
      credential_source: "manual",
      selectable: true,
    });
    upsertUsageSnapshot(db, {
      token_id: tok.id,
      util_5h: 0.02,
      util_7d: 0.91,
      reset_5h_at: new Date(Date.now() - 60 * 1000).toISOString(),
      reset_7d_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      unified_status: "allowed",
    });
    // T390: stale を作るため recorded_at を 35 分前に巻き戻す（token-store.test.ts:1714 と同パターン）
    const STALE_RECORDED = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
      .run(STALE_RECORDED, tok.id);
    db.close();

    const { out } = await captureConsole(() => cmdPoolStatus(testDir));
    expect(out).toContain("@tayo");
    // 5H USE 列は effUtil=0% を表示（snap 0.02 ではなく救済された 0%）
    const lines = out.split("\n");
    const tayoLine = lines.find((l) => l.startsWith("@tayo"));
    expect(tayoLine).toContain("0%");
    expect(tayoLine).toContain("91%");
    // 行末（NEXT_RESET の右）に独立した * マーカー
    expect(tayoLine?.trim().endsWith("*")).toBe(true);
    // フッタ凡例
    expect(out).toContain("(* = reset 通過済みで実質クリア)");
  });
});
