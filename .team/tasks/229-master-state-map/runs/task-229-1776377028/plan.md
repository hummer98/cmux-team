# T229 実装計画: Master を複数受け入れる基盤

## 概要

Manager daemon の Master 表現を singleton (`state.masterSurface: string`) から複数インスタンス (`state.masters: Map<surface, MasterState>`) に改修する。既存の 1 Master 運用は維持したまま、以下の基盤を整える:

1. **データモデル Map 化**: `masterSurface` / `masterPid` / `masterStatus` / `masterDisconnectedAt` / `masterPrompt` / `masterPidWatcherInterval` の 6 個のフラットフィールドを `MasterState` 型にまとめ、Map に格納する
2. **hook handler 対称化**: `message.surface === state.masterSurface` の比較を `state.masters.get(message.surface)` に置換し、Conductor と対称な分岐構造にする
3. **PID watcher の複数化**: `spawnMasterPidWatcher(state, pid)` → `spawnMasterPidWatcher(state, surface, pid)` にシグネチャ変更
4. **マイグレーション**: 旧 `.team/master.surface` 単一ファイル / `team.json.master: {...}` を新形式 (`.team/masters/` ディレクトリ / `team.json.masters: [...]`) に自動変換
5. **task 出所記録**: `TaskState.createdBy` / frontmatter `created_by` / artifact `author` を surface ベースに置換 (ハードコード `"master"` を排除)。**破壊的仕様変更**
6. **dashboard 表示**: Master セクションを Conductor と同様のリスト表示にリファクタ
7. **docs/spec 更新**: `05-install-and-infrastructure.md` / `00-project-overview.md` / `CLAUDE.md` の Master 周辺記述を多重化に追従

**cmdStart の挙動は変更しない** (従来通り 1 Master を spawn する)。複数 Master の登録手段 (self-register / spawn-master の多重呼び出し) は T230 で実装する。本タスクは基盤整備のみ。

## Open Questions への方針決定（Conductor 判断）

Design Review で指摘された 3 つの Open Question に対し、以下の方針を確定する:

### Q1. `spawnMaster` の戻り値に pid を含めるか

**含めない**。`spawnMaster` の戻り値は `{ surface: string, startedAt: string }` のみとする。

- cmux 経由の Master 起動では、spawn 時点で PID は判明しない。PID は Claude Code プロセス内の `SessionStart` hook (`master-hook-session-start.py`) が `/api/messages` → daemon `handleMessage` に `SESSION_STARTED` として push してきた時に初めて得られる
- spawnMaster 直後に Map 登録する段階では `pid: undefined`
- `SESSION_STARTED` 受信時に `pid` を設定し、**そのタイミングで初めて** `spawnMasterPidWatcher(state, surface, pid)` を起動する
- この順序を §PID 取得・watcher 起動の唯一の正式経路（M1）で明示する

### Q2. `surface_fallback` 経路 (daemon.ts L533-543) をどうするか

**T229 で撤廃する**。PID 不明の Master は restore せず廃棄する。

- 旧 `startMaster` (daemon.ts L520-568 付近) には、team.json の `master.pid` が無いときに `cmux.getPaneForSurface(surface)` で surface 存在のみで restore を許容する `surface_fallback` 分岐があった
- これは v3.46.0 → v3.47.0 マイグレーション互換用で、本タスクで撤廃する
- 旧 `.team/master.surface` → 新 `.team/masters/<normalized>.json` への **ファイルマイグレーション時のみ** team.json の旧 `master.pid` を拾い上げる（S4）
- restore ロジック本体は「ファイルに pid がある + PID 生存」のみを成功条件とする（C4）

### Q3. artifact の author の意味を surface ベースに変えるか

**T229 で実施する**。破壊的仕様変更として明記する。

- タスクの受け入れ条件に「artifact の author/createdBy が surface ベースで記録される」と明記されているため、T229 スコープ内で対応する
- `CLAUDE.md §Artifacts` のフォーマット節を更新し、`author` の値ドメインが `"surface:<id>"` 文字列に変わることを明示する（M3）
- **後方互換**: 既存 artifact の frontmatter `author: "master"` 等の文字列値は読み取り時にそのまま保持する（書き換え/マイグレーションはしない）。新規 artifact のみ surface ベースで記録する

## 型定義

### `MasterState`

新設。配置は `skills/cmux-team/manager/schema.ts` (Zod) を canonical とし、`master.ts` から re-export する。

```ts
// schema.ts に追加
export const MasterStateSchema = z.object({
  surface: z.string(),
  pid: z.number().optional(),
  status: z.enum(["idle", "running", "disconnected"]),
  startedAt: z.string().datetime(),
  disconnectedAt: z.string().datetime().optional(),
  prompt: z.string().optional(), // 将来的な per-master プロンプト保持用 (T229 では未使用)
});

export type MasterState = z.infer<typeof MasterStateSchema> & {
  pidWatcherInterval?: ReturnType<typeof setInterval>;
};
```

**schema.ts 配置の依存制約**（m2）:
- `schema.ts` は **logger.ts / cmux.ts に依存しない純粋な型・zod schema のみ** という既存制約を維持する
- `MasterState` はこの制約に適合する（純粋な shape 定義）
- `pidWatcherInterval` は Zod schema には含めず、TypeScript の intersection で後付けする（interval ハンドルはランタイム値なので zod バリデーション対象外）

**注意**: `master.ts` に既存の `interface MasterState { surface: string }` があるので、`master.ts` 側の定義を削除して schema.ts の型を import して使う。

### `DaemonState` の変更点

```ts
// 削除
// masterSurface: string | null;
// masterPid: number | undefined;
// masterStatus: "idle" | "running" | "disconnected";
// masterDisconnectedAt: string | undefined;
// masterPrompt: string | undefined;
// masterPidWatcherInterval?: ReturnType<typeof setInterval>;

// 追加
masters: Map<string, MasterState>;  // key = surface
```

### `TaskState` の変更点 (task.ts)

```ts
export interface TaskState {
  // ... 既存フィールド
  createdBy?: string;  // 新設: 作成元 surface (例: "surface:100")。undefined = 不明/旧データ
}
```

## ファイル名規則（§ファイル名規則 — C2）

`.team/masters/` 配下のファイル名生成・復元ルールを確定する。

### 関数仕様

```ts
export function normalizeSurfaceForPath(surface: string): string
```

- **配置場所**: `skills/cmux-team/manager/master.ts` に新設。daemon.ts / master.ts / （必要なら）テストコードが共通で import する
- **規則**: `surface` 文字列中の **コロン `:` のみ** を `_` に置換する。他の文字（英数字・ハイフン）はそのまま保持する
  - `"surface:100"` → `"surface_100"`
  - `"surface:abc-def"` → `"surface_abc-def"`
  - `""` (空文字) → **エラーを throw** する（不正入力の fail-fast）
- **用途**: `.team/masters/<normalized>.json` のファイル名部分にのみ使う

### 真のソース

- **ファイル名は一意キーとしてのみ扱う**。ファイル本体の `surface` フィールド（JSON 内）が真のソース
- **restore 時はファイル名から surface を逆算しない**。必ずファイル内容を parse して `surface` を取得する
  - 理由: 将来 surface の命名規則が変わっても、正規化の逆変換に依存しない設計にするため
- ファイル名の衝突は「同一 surface に対する複数ファイル」を意味する異常状態なので、後勝ちで上書き保存する（ログに `master_file_conflict` を出す）

### テスト対象（m3 に追加、3 ケース）

- `normalizeSurfaceForPath("surface:100")` → `"surface_100"`
- `normalizeSurfaceForPath("surface:abc-def")` → `"surface_abc-def"`
- `normalizeSurfaceForPath("")` → throw

## データフロー

### state.masters の読み書きルール

1. **追加**: `spawnMaster` の成功直後（M1）／ restore 時（C4）／ (将来の) self-register でのみ実行。`state.masters.set(surface, { surface, pid: undefined, status: "idle", startedAt: now })`
2. **削除**: SESSION_ENDED (reason=disconnected) の確定時、もしくは PID watcher が PID 死亡を検出した時のみ。必ず `removeMaster(state, surface, reason)` ヘルパー経由（R4 / D5）
3. **更新**: 必ず `state.masters.get(surface)` で取得した参照を介して個別フィールドを mutate。Map の再代入（`state.masters.set(...)` で同じ key に新オブジェクト）は原則避ける（PID watcher の interval ハンドルが失われる危険）
4. **判定**: `state.masters.has(surface)` / `.get(surface)` が Master 判定の唯一のソース。`state.masterSurface === surface` 相当のロジックは全て Map ベースに置換
5. **参照**: `[...state.masters.values()]` で一覧取得。順序は挿入順（ECMAScript Map 仕様）

### hook handler での判定パターン

現状 (singleton):
```ts
if (message.surface === state.masterSurface) {
  state.masterStatus = "running";
  ...
}
```

新 (Map):
```ts
const master = state.masters.get(message.surface);
if (master) {
  master.status = "running";
  ...
}
```

「Master か否か」の分岐と「特定 Master の状態更新」を 1 回の `get()` で兼ねる。`has()` は後続で state を触らない純粋な判定のみに使う。

### PID 取得・watcher 起動の唯一の正式経路（M1）

**spawnMaster から PID watcher 起動までの順序を厳格に定める**。これ以外の経路で Master を `state.masters` に入れない／watcher を起動しない。

1. `spawnMaster(projectRoot, daemonSurface)` を呼ぶ
   - 返り値: `{ surface: string, startedAt: string }` （**pid は含まない**）
   - 内部で `.team/masters/<normalizeSurfaceForPath(surface)>.json` を `{ surface, pid: null, status: "idle", startedAt, disconnectedAt: null }` で書き込む（C1）
2. 呼び出し側（`startMaster`）は直ちに Map 登録:
   ```ts
   state.masters.set(surface, {
     surface,
     pid: undefined,
     status: "idle",
     startedAt,
     pidWatcherInterval: undefined,
   });
   ```
3. **この時点では PID watcher を起動しない**（pid 未知のため）
4. 後続で `SESSION_STARTED` hook が `message.surface === surface` かつ `message.pid === <numeric>` で届く
5. `handleMessage` の SESSION_STARTED 分岐で:
   ```ts
   const master = state.masters.get(message.surface);
   if (master) {
     master.pid = message.pid;
     master.status = "idle";
     if (master.pidWatcherInterval) clearInterval(master.pidWatcherInterval);
     master.pidWatcherInterval = spawnMasterPidWatcher(state, message.surface, message.pid);
     // ファイル側の pid も同期
     await persistMasterFile(state, master);  // .team/masters/<normalized>.json を再書き込み
   }
   ```
6. これ以降、`spawnMasterPidWatcher` が `process.kill(pid, 0)` で生存確認し、死亡時に `removeMaster` を呼ぶ

**restore 経路（C4 参照）**: ファイルに pid が既にあり生存確認済みの場合のみ、Map 登録と同時に `spawnMasterPidWatcher` を起動する。

**ファイル再書き込み**: SESSION_STARTED で pid が判明したら `.team/masters/<normalized>.json` を再書き込みする（pid を永続化しないと daemon 再起動時に restore できない）。`persistMasterFile(state, master)` ヘルパーを `master.ts` に新設する。

### PID watcher のライフサイクル

- **spawn**: `SESSION_STARTED` 受信時（M1）／ restore 時（C4）
- **stop**: `removeMaster(state, surface, reason)` 内で `clearInterval(master.pidWatcherInterval)` を呼ぶ
- **判定**: interval 内で `state.masters.get(surface)` を取得し、存在しなければ自身を clearInterval して終了（race 対策）

## 変更ファイル一覧

### S1. `skills/cmux-team/manager/schema.ts`

- **追加**: `MasterStateSchema` (Zod) と `MasterState` 型（§型定義 参照）
- **依存制約**: schema.ts は logger.ts / cmux.ts に依存しない純粋な型・zod schema のみという既存制約を維持する（m2）

### S2. `skills/cmux-team/manager/master.ts`

- **既存**: `interface MasterState { surface: string }` (L5 付近)
  - **削除**し、`schema.ts` の型を import して使う
- **`spawnMaster(projectRoot, daemonSurface)`**:
  - 戻り値を `{ surface: string, startedAt: string }` に変更（**pid は含まない** — Q1 回答）
  - 成功直後に `.team/masters/<normalizeSurfaceForPath(surface)>.json` を `{ surface, pid: null, status: "idle", startedAt: <ISO>, disconnectedAt: null }` で書き込む（C1）
  - `.team/master.surface` 旧マーカーは **spawnMaster からは一切書かない**（マイグレーションでのみ読む）
- **新設ヘルパー**:
  - `normalizeSurfaceForPath(surface: string): string` — §ファイル名規則
  - `persistMasterFile(state: DaemonState, master: MasterState): Promise<void>` — 最新の MasterState を `.team/masters/<normalized>.json` に書き出す
  - `deleteMasterFile(state: DaemonState, surface: string): Promise<void>` — `removeMaster` 経由で呼ぶ
- **`isMasterAlive(projectRoot)` の廃止**:
  - 複数 Master 時代では team.json の `master.pid` 単一値に依存する設計は使えない
  - `startMaster` の restore 側で直接 `process.kill(pid, 0)` を呼ぶロジックに書き換え、この関数を廃止する（または surface 引数を追加して残すかは実装者判断。廃止推奨）

### S3. `skills/cmux-team/manager/daemon.ts`

#### S3-1. `DaemonState` (L42-100)

- 6 個のフラットフィールドを削除し、`masters: Map<string, MasterState>` を追加

#### S3-2. `createDaemon` / 初期化 (L200-240 付近)

- 初期値の `masterSurface: null` 等を削除し、`masters: new Map()` に置換

#### S3-3. `initInfra` の team.json 初期化 (L476-495)

- `master: {}` を削除して `masters: []` に変更
- 旧 `master` キーは `updateTeamJson` 内で毎回 `delete teamJson.master` し、自然に消す（R2）

#### S3-4. `startMaster`（C4 — 簡明化後の手順）

**旧実装（L506-585）の `surface_fallback` 経路は撤廃する**（Q2 回答）。

手順:

1. `.team/masters/` ディレクトリを `readdir` し、`.json` ファイルを列挙する
   - ディレクトリが存在しない場合は空リストとして扱う
2. 各ファイルを `JSON.parse` し `{ surface: string, pid?: number, status: "idle"|"running"|"disconnected", startedAt: string, disconnectedAt?: string }` を取得
   - parse 失敗時はそのファイルを `unlink` して廃棄し、`master_file_corrupted` をログ出力して continue
3. 各エントリについて PID 生存確認:
   - `typeof pid === "number"` かつ `process.kill(pid, 0)` が成功 → 生存。`state.masters.set(surface, { ...entry, pid, pidWatcherInterval: undefined })` に登録し、直後に `entry.pidWatcherInterval = spawnMasterPidWatcher(state, surface, pid)` を起動
   - pid が無い／数値でない／dead → **そのファイルを `unlink` して廃棄**（surface_fallback 経路は撤廃）、`master_restore_discarded` をログ出力
4. `proxyPortChanged === true` の場合、restore した全 Master を `removeMaster` で close し、`state.proxyPortChanged = false` にリセットしてから step 5 へ進む
5. 1 個も restore できなければ `spawnMaster` を呼んで 1 個新規起動する（cmdStart の外部挙動を維持）
6. **マイグレーションは呼ばない**（`initInfra` の末尾で 1 回だけ実行済み — m1）

**注意**: 旧 `isMasterAlive` は廃止。team.json の `master.pid` への依存を解消する。

#### S3-5. hook handler 置換

以下の 6 箇所をパターン化して置換する:

- **SESSION_STARTED** (L842-850 付近):
  ```ts
  const master = state.masters.get(message.surface);
  if (master) {
    master.pid = message.pid;
    master.status = "idle";
    if (master.pidWatcherInterval) clearInterval(master.pidWatcherInterval);
    master.pidWatcherInterval = spawnMasterPidWatcher(state, message.surface, message.pid);
    await persistMasterFile(state, master);  // pid をファイルにも反映
    notifyStateChanged("daemon.ts:SESSION_STARTED:master_pid_set");
  }
  ```
  この経路が PID watcher 起動の唯一の正式経路（M1）。

- **SESSION_ENDED** (L955-973 付近):
  ```ts
  const master = state.masters.get(message.surface);
  if (master) {
    master.status = "disconnected";
    master.disconnectedAt = new Date().toISOString();
    await persistMasterFile(state, master);
    // タイムアウト後の forced close / removal は既存のロジックを踏襲し、
    // 最終的に removeMaster(state, surface, "disconnected") を呼ぶ
  }
  ```

- **SESSION_ACTIVE** (L1020-1028 付近):
  ```ts
  const master = state.masters.get(message.surface);
  if (master) master.status = "running";
  ```

- **SESSION_IDLE** (L1081-1089 付近):
  ```ts
  const master = state.masters.get(message.surface);
  if (master) master.status = "idle";
  ```

- **SESSION_ASK** (L1163-1165 付近): `state.masters.has(message.surface)` で早期 return（Master は ask を無視する既存挙動を維持）

- **SESSION_CLEAR** (L1131 付近): 同じく `state.masters.has(message.surface)` で早期 return

#### S3-6. `spawnMasterPidWatcher` (L1549-1579)

- シグネチャ: `spawnMasterPidWatcher(state, pid)` → `spawnMasterPidWatcher(state, surface, pid): ReturnType<typeof setInterval>`
- interval 内で:
  - `const master = state.masters.get(surface)` を取得
  - master が存在しなければ `clearInterval(this)` + return（race 対策）
  - `process.kill(pid, 0)` で生存確認、失敗したら `await removeMaster(state, surface, "pid_dead")` を呼ぶ
- 戻り値として interval ハンドルを返し、呼び出し側が `master.pidWatcherInterval` に保存する
- テスト用エクスポート `__testSpawnMasterPidWatcherTick` も surface を受け取るよう変更

#### S3-7. `removeMaster(state, surface, reason)` を新設

- 冪等性を持たせる:
  ```ts
  async function removeMaster(state: DaemonState, surface: string, reason: string): Promise<void> {
    const master = state.masters.get(surface);
    if (!master) return;
    if (master.pidWatcherInterval) clearInterval(master.pidWatcherInterval);
    state.masters.delete(surface);
    await deleteMasterFile(state, surface);
    await log("master_removed", `${formatSurface(surface, "U")} reason=${reason}`);
    notifyStateChanged(`daemon.ts:removeMaster:${reason}`);
  }
  ```
- 1 箇所に集約することで interval の取りこぼしを防ぐ（R4 / D5）
- 呼び出し元: PID watcher、SESSION_ENDED タイムアウト、`stopDaemon`（m4）

#### S3-8. `updateTeamJson` (L1707-1751)

- 旧: `teamJson.master = { surface, status, pid }`
- 新: `teamJson.masters = [...state.masters.values()].map(m => ({ surface: m.surface, status: m.status, pid: m.pid, startedAt: m.startedAt, disconnectedAt: m.disconnectedAt }))`
- **後方互換**: `delete teamJson.master` を毎回実行する（旧キーが混入していれば自然に消える — R2）

#### S3-9. `computeSidebarStatus` (L1786 以降) など state を読む箇所

- `state.masterSurface` / `state.masterStatus` / `state.masterPid` 等を参照している箇所をすべて grep し、`state.masters` ベースに書き換える
- サイドバー表示上の集約は「1 つでも `running` があれば running 扱い」で十分（M4 / S5 と整合）

#### S3-10. `stopDaemon` (graceful shutdown) の watcher 全停止（m4）

- `stopDaemon` ／ SIGTERM ハンドラの終了処理に以下を追加:
  ```ts
  for (const m of state.masters.values()) {
    if (m.pidWatcherInterval) clearInterval(m.pidWatcherInterval);
  }
  // state.masters.clear() はプロセス終了で自然に破棄されるので不要
  ```
- これで daemon 終了時に setInterval リークが残らない

### S4. マイグレーション (daemon.ts 内、`initInfra` の末尾で 1 回のみ実行 — m1)

#### 呼び出し位置の不変条件（m1）

- `migrateMasterLayout(state)` は **`initInfra` の末尾で 1 度だけ** 呼ばれる
- `startMaster` はマイグレーションを呼ばない
- マイグレーション失敗時は旧マーカーが残り、次回 daemon 起動の `initInfra` で再試行される（冪等性）

#### 旧形式 → 新形式の変換

**入力**:
- `.team/master.surface` (単一ファイル、surface 文字列のみ)
- `.team/team.json` の `master: { surface, pid, status }` キー（PID 拾い上げ用）

**出力**:
- `.team/masters/<normalizeSurfaceForPath(surface)>.json` (per-master 状態ファイル)
- `.team/team.json` の `masters: [...]` 配列（`updateTeamJson` が keep-alive で上書き）

#### 擬似コード

```ts
async function migrateMasterLayout(state: DaemonState): Promise<void> {
  const root = state.projectRoot;
  const oldMarker = join(root, ".team/master.surface");
  const newDir = join(root, ".team/masters");

  // 冪等性チェック
  if (!existsSync(oldMarker)) {
    if (existsSync(newDir)) {
      await log("master_migration_skipped", "reason=already_migrated");
    }
    return;
  }
  if (existsSync(newDir)) {
    // 旧マーカーも新ディレクトリも両方ある：旧マーカーを削除するだけ
    try {
      await unlink(oldMarker);
      await log("master_migration_skipped", "reason=new_dir_exists removed_old_marker");
    } catch (e: any) {
      await log("master_migration_failed", e.message);
    }
    return;
  }

  try {
    await mkdir(newDir, { recursive: true });
    const surface = (await readFile(oldMarker, "utf-8")).trim();
    if (surface) {
      // team.json の master.pid があれば拾う（Q2 回答: マイグレーション時のみの救済経路）
      let pid: number | undefined;
      const teamJsonPath = join(root, ".team/team.json");
      if (existsSync(teamJsonPath)) {
        const tj = JSON.parse(await readFile(teamJsonPath, "utf-8"));
        if (typeof tj?.master?.pid === "number") pid = tj.master.pid;
      }
      const masterStatePath = join(newDir, `${normalizeSurfaceForPath(surface)}.json`);
      await writeFile(masterStatePath, JSON.stringify({
        surface,
        pid: pid ?? null,
        status: "idle",
        startedAt: new Date().toISOString(),  // 旧形式に startedAt がないので now() でフォールバック
        disconnectedAt: null,
      }, null, 2) + "\n");
    }
    await unlink(oldMarker);
    await log("master_migration_single_to_multi", `surface=${surface} pid=${pid ?? "unknown"}`);
  } catch (e: any) {
    await log("master_migration_failed", `${e.message}`);
    // 失敗しても daemon 起動は続行。旧マーカーが残っていれば次回再試行
  }

  // .gitignore のエントリ書き換え（m5）
  await migrateGitignore(state);
}
```

#### team.json のマイグレーション

- `updateTeamJson` 側で毎回 `delete teamJson.master` する（S3-8）
- 明示的な 1 回だけの変換は不要（keep-alive が上書きする）

#### マーカーファイル廃止の判断

- `.team/master.surface` は **廃止**。代わりに `.team/masters/<normalized>.json` ディレクトリが真のソース
- `.team/.gitignore` のエントリは `master.surface` → `masters/` に自動書き換え（m5）

#### 失敗時の挙動

- `migrateMasterLayout` 内の例外は全て catch し、`master_migration_failed` でログに残して daemon は起動を続行
- 次回起動時に旧マーカーが残っていれば再試行（冪等性）

#### ログイベント名（m6）

- `master_migration_single_to_multi` — 成功
- `master_migration_failed` — 失敗
- `master_migration_skipped` — スキップ（既にマイグレーション済み）
- 既存 `master_*` イベントとの衝突確認: 実装時に `rg 'master_' skills/cmux-team/manager/*.ts` で 0 件である（または意図した衝突のみ）ことを確認する

### S5. `skills/cmux-team/manager/dashboard.tsx`

#### `buildMasterSection` (L338-375)

- 現状: `state.masterSurface` から 1 行を組み立てる
- 変更: `[...state.masters.values()]` を回してリスト表示。Conductor セクション (`buildConductorsSection` L491-497) の構造を参考
- 0 個の場合は「no master」、1 個の場合は従来と同じ見た目、2 個以上なら複数行
- `sectionTitle("Master")` → `sectionTitle("Masters")` に変更（複数形）

#### spinner check (L1297) — M4

- `daemon.masterStatus === "running"` → `[...daemon.masters.values()].some(m => m.status === "running")`
- **表示方針**: 「running な Master が 1 個以上あればスピナーを 1 個だけ表示する」。個別のスピナー並列表示はしない（UX 上の雑音回避）

### S6. `skills/cmux-team/manager/statusline.ts` — M4

- `StatuslineState` (L23-30):
  - `masterStatus` / `masterSurface` を削除
  - `masters: Array<{ surface: string, status: MasterState["status"], pid?: number }>` に置き換え
- `resolveRole` (L168-186):
  - `state.masterSurface === surface` → `state.masters.some(m => m.surface === surface)` または `find(m => m.surface === surface)`
- `renderMaster` (L230-244):
  - 1 Master の場合は従来の見た目を維持
  - 複数 Master の場合は連番で表示（例: "Master(1/2): surface:100 idle"）

**Map → Array 変換の責務**:
- `proxy.ts` L238 周辺の `formatStatusline` 呼び出し側で `[...state.masters.values()]` を用意し、statusline 用のスナップショットとして渡す
- `StatuslineState.masters` は **プレーンな Array**（Map ではない）として受け取る。statusline は純粋描画層のため、daemon 内部状態（Map + interval ハンドル）を持ち込まない

### S7. `skills/cmux-team/manager/proxy.ts` — `/master-state` エンドポイント (L247-274)

- 現状: `state.masterStatus` を直接書き換える（surface 認識なし）
- **T229 範囲 / 方針 A（既知の制約として明記）**:
  - request body に `surface?: string` フィールドを optional で受け付ける
  - `surface` 指定あり → `state.masters.get(surface)?.status` を更新
  - `surface` 指定なし かつ Master が **ちょうど 1 個** → その 1 個を自動解決して更新（既存 hook スクリプトが無改修で動くため）
  - `surface` 指定なし かつ Master が **2 個以上** → `log("master_state_surface_ambiguous", ...)` を出して **何もしない**（破壊的変更なし、曖昧な更新を避ける）
- hook スクリプト（`master-hook-busy.py` / `master-hook-stop.py`）は T229 では変更しない（D3）

### S8. `skills/cmux-team/manager/main.ts`

#### S8-1. `cmdStart` full-quit (L592-594)

- `state.masterSurface` を close する → `for (const surface of state.masters.keys()) { await cmux.closeSurface(surface); }` に変更

#### S8-2. `cmdStatus` (L1044-1110)

- `teamJson.master?.surface` → `teamJson.masters?.[0]?.surface` もしくは `teamJson.masters?.map(m => m.surface).join(", ")`
- 表示内容は複数対応に（「Masters: surface:100, surface:200」等）
- **m3 テスト対象**: `teamJson.masters` が 2 要素のとき CLI 出力が壊れないこと（JSON アクセス経路と表示整形）

#### S8-3. `cmdCreateTask` (L2283-2330) — タスク出所記録

- 引数に `createdBy?: string` を受け付ける（CLI 側は後続タスクで追加。T229 では undefined のまま通せる）
- **env 由来の自動設定**: `process.env.CMUX_SURFACE` が設定されていれば `createdBy` として採用
- `createTaskProgrammatic` に渡す

#### S8-4. master-hook スクリプト (L1280-1393)

- T229 では **変更しない**（方針 A で surface なしでも singleton 互換動作を維持）
- T230 で `CMUX_SURFACE` を body に乗せる変更を行う（D3）

#### S8-5. caffeinate 判定 (main.ts L779) — C3

- 現状:
  ```ts
  const systemActive =
    state.masterStatus === "running" ||
    [...state.conductors.values()].some(c => c.status === "running" || c.agents.length > 0);
  ```
- 変更後:
  ```ts
  const systemActive =
    [...state.masters.values()].some(m => m.status === "running") ||
    [...state.conductors.values()].some(c => c.status === "running" || c.agents.length > 0);
  ```
- 複数 Master のいずれかが `running` ならスリープ抑止する

### S9. `skills/cmux-team/manager/task.ts` — `TaskState` と frontmatter

#### S9-1. `TaskState` interface (L25-37)

- `createdBy?: string` フィールド追加

#### S9-2. `createTaskProgrammatic` (L263-359)

- 引数 opts に `createdBy?: string` を追加
- TaskState の `createdBy` に保存
- frontmatter builder (L330-341) に `created_by` を追加（undefined の場合は省略）

#### S9-3. frontmatter parser

- `loadTasks` / `loadTaskState` の parser で `created_by` → `createdBy` を読み込む

### S10. `skills/cmux-team/manager/artifact.ts` — `addArtifact` (L186-208) — Q3 実施

**破壊的仕様変更**: author の値ドメインが `"master"` ハードコードから `process.env.CMUX_SURFACE` 由来の surface 文字列に変わる。

- `author: existing.author || "master"` (L191): 既存 author があればそれを優先（後方互換）、なければ `process.env.CMUX_SURFACE ?? "unknown"`
- `author: "master"` (L204): 同様に `process.env.CMUX_SURFACE ?? "unknown"`
- Master プロセスから呼ばれる場合は CMUX_SURFACE が設定されている想定（master spawn 時に env で注入される — R9）
- **後方互換**: 既存 artifact の frontmatter `author: "master"` 等の文字列値は読み取り時にそのまま保持する

### S11. `.team/.gitignore` — m5

- **方針**: daemon 側で自動書き換えする（推奨）
- **実装**: `migrateGitignore(state)` ヘルパーを `daemon.ts` に新設し、`migrateMasterLayout` の末尾で呼ぶ
  - `.team/.gitignore` を読み、`master.surface` 行があれば `masters/` に置換して書き戻す
  - 両方ある場合は `master.surface` を削除（`masters/` のみ残す）
  - 冪等性: `masters/` が既にあり `master.surface` が無ければ何もしない
  - ログ: `gitignore_migrated from=master.surface to=masters/`
- 既存環境ユーザーは手動書き換え不要

### S12. docs/spec 更新 — M3 反映

以下を plan の「§docs/spec 更新箇所」に集約（M3 の artifact author 仕様変更を含む）。

## 既知の制約（T229 完了時点）— M2

T229 の範囲で以下の制約を明示的に残す。T230 で解消する。

### `/master-state` エンドポイントの曖昧解決

- POST `/master-state` の body に `surface` 指定が無い場合:
  - Master が **ちょうど 1 個** のとき → その Master の状態を更新
  - Master が **2 個以上** のとき → `log("master_state_surface_ambiguous", "count=N")` を出して **何もしない**
- この「何もしない」挙動は T230 で解消される（hook スクリプトへの `CMUX_SURFACE` 注入で常に surface 指定されるようになる）

### hook スクリプトへの `CMUX_SURFACE` 注入

- `master-hook-busy.py` / `master-hook-stop.py` / `master-hook-session-start.py` 等の hook スクリプトへの `CMUX_SURFACE` 環境変数注入は **T230 で対応する**（T229 のスコープ外）
- 本タスクでは hook スクリプト側の変更は行わない（D3）

### cmdStart の挙動

- T229 では cmdStart の外部挙動は変更しない（1 Master spawn のまま）
- 複数 Master の登録手段（self-register / spawn-master の多重呼び出し）は T230 で実装

## テスト計画

自動テストは既存に無い（CLAUDE.md 参照）。手動検証の手順を明記し、加えて `daemon.test.ts` に最小限の unit test を追加する。

### 自動テスト (daemon.test.ts に追加)

T201 の startMaster pid fallback テスト (L1619-1780) の構造を踏襲。

1. **migrate: old marker → new dir**
   - `.team/master.surface` と team.json を準備 → `migrateMasterLayout` 呼び出し → `.team/masters/<surface>.json` が作成され、`.team/master.surface` が削除されていることを確認
2. **migrate: idempotent (m3)**
   - `.team/masters/` が既にあり旧マーカーが無い状態で呼んでも何も変わらないこと
   - 2 回目の呼び出しで `master_migration_skipped` ログが出ること
3. **migrate: failure keeps old marker**
   - mkdir を失敗させる (mock) → 旧マーカーが残っていることを確認
4. **startMaster: restore multiple masters from masters/**
   - `.team/masters/a.json` と `b.json` を PID 付きで配置（両方生きている PID） → startMaster → `state.masters` が 2 エントリを持つ
5. **startMaster: discard master with no pid**（Q2 回答の確認）
   - `.team/masters/a.json` を pid なしで配置 → startMaster → a は restore されず、ファイルが削除されている
6. **SESSION_ACTIVE on one of N masters updates only that entry**
   - 2 Master 登録状態で surface=A の SESSION_ACTIVE → A は running、B は idle のまま
7. **normalizeSurfaceForPath: 3 ケース (C2 / m3)**
   - `"surface:100"` → `"surface_100"`
   - `"surface:abc-def"` → `"surface_abc-def"`
   - `""` → throw
8. **removeMaster: interval 停止確認 (m3)**
   - Map に 1 Master 登録 + pidWatcherInterval あり → `removeMaster(state, surface, "test")` → `state.masters.has(surface)` が false、interval が clearInterval されている（setInterval の timer ハンドルが未 active）
9. **cmdStatus: 複数 Master 表示が壊れないこと (m3)**
   - `teamJson.masters` に 2 要素を仕込んで `cmdStatus` を呼び、stdout が例外なく整形されること

### 手動検証手順

#### M1. ビルドと型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-229-1776377028
cd skills/cmux-team/manager
npm install
bunx tsc --noEmit
```

TypeScript のコンパイルエラーが無いこと。

#### M2. cmdStart の挙動確認（既存挙動維持）

```bash
rm -rf .team
cmux
# cmux 内で:
cmux-team start
```

- `.team/masters/<normalized>.json` が 1 ファイル作成されること
- 最初は `pid: null`、SESSION_STARTED 受信後に pid が埋まること
- Master surface が Manager ペインに作成されること
- dashboard に Master が 1 個表示されること

#### M3. 旧形式からのマイグレーション

```bash
rm -rf .team/masters
echo "surface:100" > .team/master.surface
cat > .team/team.json << EOF
{ "master": { "surface": "surface:100", "pid": 12345 }, "conductors": [] }
EOF

cmux-team stop
cmux-team start
```

- ログに `master_migration_single_to_multi surface=surface:100 pid=12345` が出ること
- `.team/master.surface` が削除されていること
- `.team/masters/surface_100.json` が作成され、`pid: 12345` が入っていること
- team.json の `master` キーが消え、`masters` 配列になっていること
- `.team/.gitignore` の `master.surface` 行が `masters/` に書き換わっていること

#### M4. dashboard / statusline 表示

- cmdStart 直後の dashboard で Master セクションがリスト形式で 1 行表示されていること
- 従来の 1 Master 表示と実質的に同じに見えること
- statusline の `renderMaster` 出力が従来と同じであること（1 Master 時）

#### M5. hook handler 複数対応（擬似的に 2 Master 化）

```bash
cmux-team stop
cat > .team/masters/surface_200.json << EOF
{ "surface": "surface:200", "pid": 99999, "status": "idle", "startedAt": "2026-04-17T00:00:00.000Z" }
EOF
cmux-team start
```

- ログに PID 99999 が dead として検出され、surface:200 が `removeMaster` されること（surface_200.json が削除）
- 生きている surface:100 は引き続き Master として扱われること

#### M6. task 出所記録

```bash
CMUX_SURFACE=surface:100 cmux-team create-task --title "origin test" --body "test"
```

- タスクファイルの frontmatter に `created_by: surface:100` が入ること
- `.team/task-state.json` の該当 task に `createdBy: "surface:100"` が入ること

#### M7. artifact 出所記録（Q3 実施の確認）

```bash
# Master セッションで artifact を作成（/artifact コマンド経由）
```

- 新規 `.team/artifacts/A*.md` の frontmatter `author` が `surface:100` になっていること（`"master"` ハードコードが解消）
- 既存 artifact の `author: "master"` 等の値が書き換えられていない（後方互換）こと

## docs/spec 更新箇所 — M3 反映

### `docs/spec/00-project-overview.md`

- 4 層アーキテクチャ図の Master 表記に「複数 Master を受け入れる設計に移行中（T229 基盤整備、T230 で完成）」の注記を追加
- Master の役割説明で「共有ストアへの CLI クライアント」であることを明記

### `docs/spec/01-skill-cmux-team.md`

- Master セクションで「複数 Master が並行して動作し得る」旨を追加
- Master 間で直接通信しない（manager.log / task-state.json 経由）原則を明記

### `docs/spec/05-install-and-infrastructure.md`

- **L86 master.ts**: MasterState の型と、`state.masters: Map<string, MasterState>` の構造を追記。`normalizeSurfaceForPath` / `persistMasterFile` / `deleteMasterFile` ヘルパーの説明も追加
- **L196 POST /master-state**: 「body に optional `surface` フィールドを受け付ける。未指定時は Master が 1 個の場合のみ自動解決、2 個以上は `master_state_surface_ambiguous` をログして何もしない」
- **L346-371 .gitignore**: `master.surface` を `masters/` に置き換えた旨を反映
- **新規セクション** `.team/masters/` の仕様:
  - ディレクトリ構造
  - 各 `<normalized>.json` のフォーマット（MasterState）
  - ライフサイクル（spawnMaster / SESSION_STARTED で生成・更新、removeMaster で削除）
  - ファイル名規則（`normalizeSurfaceForPath`）

### `CLAUDE.md` (プロジェクトルート)

- 「チーム状態管理」セクションで、`team.json.masters` 配列の仕様を追加（旧 `team.json.master` オブジェクトは廃止）
- 「進捗情報の取得方法」表の Master 情報の取得方法を更新:
  - `jq .masters .team/team.json`（旧: `jq .master`）
- **§Artifacts のフォーマット節 — M3 実施**:
  - `author` の値ドメインを `"surface:<id>"` 文字列に更新（T229 で破壊的仕様変更）
  - 新規 artifact は作成者 surface を記録
  - 既存 artifact の値（`"master"` / `"conductor-N"` 等）は読み取り時にそのまま保持（後方互換）
  - YAML フロントマター例も更新:
    ```yaml
    author: surface:100  # 旧: master / conductor-N（読み取り時は保持）
    ```

### `docs/spec/` 配下に artifact フォーマット記述があれば同様に更新

- `docs/spec/` 配下で artifact の author フィールドに言及している箇所があれば、CLAUDE.md と同じ方針で更新する
- 実装時に `rg "author:\s*master" docs/` / `rg "author.*master" docs/spec/` で該当箇所を洗い出す

### `skills/cmux-team/SKILL.md`

- 必要に応じて Master 記述を「複数 Master」に整合。ただし現状 1 Master 運用の説明が主なので、脚注程度に留める

## リスク・落とし穴

### R1. `updateTeamJson` の race condition

- 現状 `updateTeamJson` は tmp → rename でアトミック書き込みしている
- `state.masters` の read は snapshot ではないが、`[...state.masters.values()]` を 1 回で取り出してから serialize すれば実質的に問題にならない
- PID watcher の interval が state.masters を触るのは `removeMaster` 経由のみなので writer は 1 箇所に集約される

### R2. keep-alive との整合性

- `updateTeamJson` が定期的に team.json を上書きするため、マイグレーション時に `teamJson.master` 旧キーを delete するタイミングを `updateTeamJson` 内で毎回実施する（1 行）
- 古い cmux-team（旧バイナリ）が同時に動く可能性は低い（daemon は 1 project 1 インスタンス前提）

### R3. hook handler の見落とし

- `message.surface === state.masterSurface` は **SESSION_STARTED / ENDED / ACTIVE / IDLE / ASK / CLEAR** の 6 箇所で使われる想定だが、grep で全量確認する
- 確認コマンド: `rg "masterSurface" skills/cmux-team/manager`
- 変更後に `masterSurface` 識別子が残っていないことを確認（import / 型定義以外）

### R4. PID watcher の interval リーク

- `state.masters.delete(surface)` を呼び忘れると interval が残り続ける
- 対策: **`removeMaster(state, surface, reason)` ヘルパー経由に限定**（D5）
- `stopDaemon` (graceful shutdown) でも全 master の interval を stop する（m4 / S3-10）

### R5. `/master-state` プロキシエンドポイントの surface 認識

- 現状 surface を受け取らないため、複数 Master 時代は「どの Master の状態か」が曖昧
- T229 では「body に optional surface を受け付け、無ければ Master が 1 個の場合のみ自動解決、2 個以上は何もしない」の互換動作（§既知の制約 / M2）
- T230 で hook スクリプト側に `CMUX_SURFACE` を渡す改修を行う

### R6. resume 時の Master 復元順序

- `startMaster` が `.team/masters/*.json` を全読みし、生きている PID のみ restore する
- PID 取得失敗（未設定 / 数値でない / dead）の場合は **ファイルを unlink して廃棄**（Q2 回答 — surface_fallback 撤廃）
- 複数 restore は基盤のみで、cmdStart の UI 的影響は無い（従来挙動を維持）

### R7. tmp file pollution

- マイグレーション途中でクラッシュすると `.team/masters/` が中途半端な状態になる可能性
- 対策: `writeFile` で 1 ファイルずつ書く。中途半端でも次回起動時に「生きている PID だけ採用、dead/pid 不明は discard」で回復可能

### R8. task 出所記録の既存タスク互換性

- 既存の `.team/tasks/*.md` には `created_by` が無い。parser 側で `undefined` を許容する
- `TaskState.createdBy` が `undefined` = 旧データ = `unknown` 扱い
- 表示側（dashboard / status）では省略するか `(unknown)` 表示

### R9. CMUX_SURFACE env の欠落

- Master プロセスが spawn された際に env で CMUX_SURFACE が渡されていなければ、create-task / artifact の出所記録が `"unknown"` になる
- `spawnMaster` 内の cmux コマンド呼び出しで env を注入していることを確認する（現状の実装を再確認）
- 欠落していた場合は本タスクで修正する（spawnMaster に env 注入ロジックを追加）

### R10. 型定義の重複

- `master.ts` の `interface MasterState` と schema.ts の Zod ベース MasterState の二重定義を避ける
- 対策: schema.ts を canonical にして master.ts から re-export、master.ts 側の interface は削除（S2）

## Decision Log

### D1. MasterState の型を schema.ts に置く

- ConductorState / AgentState が schema.ts にあるのと対称
- master.ts は spawn / alive 判定のみに集中
- schema.ts の依存制約（logger.ts / cmux.ts に依存しない）を維持する必要があるが、MasterState は純粋な型・shape 定義なので制約に適合する（m2）

### D2. `/master-state` は方針 A (optional surface) を採用

- 方針 A の利点: T230 での拡張が自然、既存 hook スクリプトが無改修で動く
- 方針 B の欠点: broadcast は「誰が running か」が曖昧になり dashboard 表示が劣化

### D3. master-hook スクリプト (busy.py / stop.py / session-start.py) は T229 では触らない

- T229 は「基盤整備」なので hook の挙動改変は最小化
- T230 で hook スクリプトに `CMUX_SURFACE` 注入を行う際に一括で修正

### D4. `.team/master.surface` は完全廃止

- マイグレーション後は新形式の `.team/masters/` のみ参照
- `.gitignore` も `master.surface` → `masters/` に自動書き換え（m5）

### D5. `removeMaster` ヘルパー新設

- interval リーク防止のために delete + clearInterval を必ずセットで実行
- 「Map からの削除は必ずヘルパー経由」という不変条件を作る

### D6. 1 Master 時の UX を損なわない

- dashboard の Master セクションは、1 個の場合は従来とほぼ同じ見た目
- 複数個になって初めて差が出る（T230 で実際に 2 つ目を作れるようになった時点で検証）

### D7. T229 では cmdStart の挙動を変更しない

- 既存 1 Master 運用が壊れないことを最優先
- self-register / 多重 spawn は全て T230 に切り出す

### D8. `spawnMaster` の戻り値に pid を含めない（Q1）

- cmux 経由の Master 起動では spawn 時点で pid は不明
- pid は `SESSION_STARTED` hook で後追い取得される
- spawnMaster 直後の Map 登録時は `pid: undefined`、watcher は起動しない
- `SESSION_STARTED` 受信時に初めて pid を設定し watcher を起動する（M1）

### D9. `surface_fallback` 経路を T229 で撤廃（Q2）

- PID 不明の Master は restore せず、ファイルを unlink して廃棄する
- マイグレーション時のみ team.json の旧 `master.pid` を拾う救済経路を残す
- R-D の整理に従い、S3-4 / S4 を簡明化

### D10. artifact author 仕様変更を T229 で実施（Q3）

- 受け入れ条件に含まれるため、T229 スコープ内で対応
- 破壊的仕様変更として CLAUDE.md §Artifacts を更新
- 既存 artifact の値は後方互換で保持（書き換えない）

### D11. `.team/.gitignore` は daemon 側で自動書き換え（m5）

- 既存環境ユーザーに手動対応を求めない
- `migrateGitignore` ヘルパーを `migrateMasterLayout` の末尾で呼ぶ

## サブタスク分割 (S1-S12)

| ID | 対象ファイル | 内容 |
|---|---|---|
| S1 | schema.ts | MasterState / MasterStateSchema 追加（依存制約維持） |
| S2 | master.ts | 旧 interface 削除、spawnMaster 戻り値を `{surface, startedAt}` に、normalizeSurfaceForPath / persistMasterFile / deleteMasterFile を新設 |
| S3 | daemon.ts | DaemonState.masters Map 化、hook handler 置換、PID watcher、removeMaster、updateTeamJson、stopDaemon watcher 停止 |
| S4 | daemon.ts | migrateMasterLayout（旧形式→新形式、initInfra で 1 回のみ）、migrateGitignore |
| S5 | dashboard.tsx | buildMasterSection のリスト化、spinner check |
| S6 | statusline.ts | StatuslineState / resolveRole / renderMaster、Map → Array 変換 |
| S7 | proxy.ts | /master-state に optional surface 受け付け、曖昧時は ambiguous ログ |
| S8 | main.ts | cmdStart / cmdStatus / cmdCreateTask / caffeinate 判定 (L779) の masters 参照置換 |
| S9 | task.ts | TaskState.createdBy / frontmatter created_by |
| S10 | artifact.ts | author ハードコード除去（CMUX_SURFACE ベース） |
| S11 | .team/.gitignore | daemon 自動書き換え（migrateGitignore） |
| S12 | docs/spec/* + CLAUDE.md | ドキュメント更新（artifact author 仕様変更含む） |

依存関係:

- S1 は S2〜S10 の前提（型定義）
- S3 は S4〜S8 の中核（Map 化が全てに波及）
- S5〜S8 は S3 のあとに並行可能
- S9 / S10 は独立（並行可能）
- S11 は S4 の migrateMasterLayout と同時（自動書き換え）
- S12 は全実装後の最終ステップ
