/**
 * テスト用ダミープロジェクト helper（T292）
 *
 * `bun test` 実行中に `logger.ts` / `task.ts` などが `process.env.PROJECT_ROOT ||
 * process.cwd()` フォールバックで repo 本体の `.team/logs/manager.log` などを書き換える
 * 汚染を防ぐための helper。各テストの beforeEach で `createDummyProject()` を呼び、
 * afterEach で `dispose()` することで、以下を保証する:
 *
 * - 一意な tmp dir を作成し、必要な `.team/` サブディレクトリを事前 mkdir
 * - `process.env.PROJECT_ROOT` を tmp dir に上書き（opts で無効化可能）
 * - dispose で tmp dir 削除 + env 復元（try/finally で復元は必ず行う）
 *
 * ## 制約
 *
 * 同一プロセス内で並行に `createDummyProject()` をネストして使うことは想定していない。
 * bun test はファイル内の test を sequential に走らせ beforeEach/afterEach で env を復元するため、
 * 通常の利用では問題ない。並列ワーカーは別プロセスなので互いに干渉しない。
 */
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 事前生成するサブディレクトリ。必要なければ opts.subdirs で上書き可能。
 * daemon 系テストで頻出するものを既定値に含める。
 */
export const DEFAULT_SUBDIRS = [
  "logs",
  "tasks",
  "conductors",
  "output",
  "queue",
  "prompts",
] as const;

export interface DummyProjectOptions {
  /** mkdtemp の prefix (default: "cmux-team-test-") */
  prefix?: string;
  /** 事前 mkdir する `.team/` 以下の相対パス (default: DEFAULT_SUBDIRS) */
  subdirs?: readonly string[];
  /** default true: process.env.PROJECT_ROOT を上書き */
  setProjectRootEnv?: boolean;
  /** default false: 空 team.json を配置 */
  seedTeamJson?: boolean;
  /** default true: `.team/` 自体を事前 mkdir する。false の場合は root だけが空の tmp dir */
  createTeamDir?: boolean;
  /**
   * default false (T416): `.team/config.json` を seed する。
   * - `true` → `{"gc":{"runOnStart":false,"periodic":false}}` を書き込み GC 無効化
   * - object → 与えた object を JSON 化して書き込む。GC を無効にしたい場合は呼び出し側で
   *   `gc.runOnStart=false / gc.periodic=false` を含めること
   *
   * `cmdStart` を in-process で起動するテストの副作用回避用。既存テストは `false` の
   * ままで挙動が変わらない。
   */
  seedConfigJson?: boolean | Record<string, unknown>;
}

export interface DummyProject {
  /** tmp dir 絶対パス */
  readonly root: string;
  /** `<root>/.team` の絶対パス */
  readonly teamDir: string;
  /** 追加の subdir を遅延生成する */
  ensureSubdir(rel: string): Promise<string>;
  /** tmp dir 削除 + env 復元。二重呼び出しは no-op */
  dispose(): Promise<void>;
}

export async function createDummyProject(
  opts: DummyProjectOptions = {},
): Promise<DummyProject> {
  const prefix = opts.prefix ?? "cmux-team-test-";
  const subdirs = opts.subdirs ?? DEFAULT_SUBDIRS;
  const setEnv = opts.setProjectRootEnv ?? true;
  const createTeamDir = opts.createTeamDir ?? true;

  const root = await mkdtemp(join(tmpdir(), prefix));
  const teamDir = join(root, ".team");
  if (createTeamDir) {
    await mkdir(teamDir, { recursive: true });
    for (const sub of subdirs) {
      await mkdir(join(teamDir, sub), { recursive: true });
    }
    if (opts.seedTeamJson) {
      await writeFile(
        join(teamDir, "team.json"),
        '{"phase":"init","masters":[],"conductors":[]}',
      );
    }
    if (opts.seedConfigJson) {
      const cfg =
        opts.seedConfigJson === true
          ? { gc: { runOnStart: false, periodic: false } }
          : opts.seedConfigJson;
      await writeFile(join(teamDir, "config.json"), JSON.stringify(cfg, null, 2));
    }
  }

  const savedEnv = process.env.PROJECT_ROOT;
  if (setEnv) {
    process.env.PROJECT_ROOT = root;
  }

  let disposed = false;
  return {
    root,
    teamDir,
    async ensureSubdir(rel: string): Promise<string> {
      const p = join(teamDir, rel);
      await mkdir(p, { recursive: true });
      return p;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        if (setEnv) {
          if (savedEnv !== undefined) {
            process.env.PROJECT_ROOT = savedEnv;
          } else {
            delete process.env.PROJECT_ROOT;
          }
        }
      }
    },
  };
}

/**
 * RAII 風 scope helper。fn が throw しても dispose は必ず呼ばれる。
 */
export async function withDummyProject<T>(
  fn: (p: DummyProject) => Promise<T>,
  opts?: DummyProjectOptions,
): Promise<T> {
  const project = await createDummyProject(opts);
  try {
    return await fn(project);
  } finally {
    await project.dispose();
  }
}
