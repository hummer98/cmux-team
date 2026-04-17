# Plan: assigned タスク resume の boot シーケンス修正 (task-174)

## 背景（おさらい）

`cmux-team start` の boot 時、新規 Conductor slot では `launchConductor` が `cmux-team conductor\n` をシェルに送って Claude を起動する。その後 main.ts:414-473 の resume ブロックが `cmux-team resume <task-id>\n` を同じ surface に送るが、この時点では Claude が既に起動済みのためチャット入力として消費されてしまう（シェルコマンドとして実行されない）。

## 採用案: 案A（launchConductor に resume オプションを追加）

### 選択理由

- **責務が自然** — 「そのペインで Claude を何として起動するか」は launchConductor の内側の判断。呼び出し側は起動対象を指定するだけ。
- **変更範囲が局所的** — `launchConductor` のシグネチャ拡張と、呼び出し元（2 箇所）の変更で済む。
- **team.json 復元パスと干渉しない** — 復元成功時は `initializeConductorSlots` を呼ばないので、resume オプションは新規起動時のみ発火する。案B（initializeConductorSlots 側に配る）だと復元パスでも同じロジックを二重に考えることになり複雑。
- **可読性** — `launchConductor(..., { resumeTaskId: "174" })` は意図が明瞭。`cmux-team resume` 文字列を呼び出し側で組み立てる必要がない。

### 不採用: 案B の問題点

- `initializeConductorSlots` は「何個 slot を作るか」を決める責務で、そこにタスク割当情報を持ち込むと責務が膨らむ。
- 呼び出し階層が `main.ts → initializeLayout → initializeConductorSlots → launchConductor` と深く、Option を途中 2 層バケツリレーする必要がある。

## 変更ファイル・シグネチャ

### 1. `skills/cmux-team/manager/conductor.ts`

#### `launchConductor`
```ts
export async function launchConductor(
  projectRoot: string,
  surface: string,
  paneId?: string,
  opts?: { resumeTaskId?: string },
): Promise<void>
```

- step 3（Claude 起動）を分岐:
  - `opts?.resumeTaskId` がある場合: `cmux send <surface> 'cmux-team resume <taskId>\n'`
  - それ以外: 従来どおり `cmux send <surface> 'cmux-team conductor\n'`
- step 4（タブ名）: resume 時はタブ名をここで確定させず（タブ名は呼び出し元の boot シーケンスが `[N] ♦ T<id> <title>` に renameTab する）、デフォルト `[N] ♦ idle` のまま任せる。呼び出し側で上書きする。
  - もしくは `opts.resumeTaskId` があるときだけ `idle` 付けを飛ばす。最小変更のため後者。

#### `initializeConductorSlots`
```ts
export async function initializeConductorSlots(
  projectRoot: string,
  conductors: Map<string, ConductorState>,
  count: number,
  daemonSurface?: string,
  resumePlan?: Array<{ taskId: string; taskRunId: string; worktreePath: string; sessionId: string; taskTitle?: string }>,
): Promise<{ surface: string; paneId?: string; assignedTaskId?: string }[]>
```

- `resumePlan` を受け取ったら、pane 作成後に各 pane へ 1 件ずつ割り当てる（先頭から順）。
- `launchConductor` 呼び出し時に `{ resumeTaskId }` を渡す。
- フォールバック登録（CONDUCTOR_REGISTERED が失敗した場合の状態登録）時に、割り当てがあれば `status: "running"`, `taskId`, `taskRunId`, `worktreePath` を最初からセットする。
- 戻り値で「どの surface にどの task を割り当てたか」を呼び出し元に返す（呼び出し元がタブ名・state 詳細の後処理に使う）。

### 2. `skills/cmux-team/manager/daemon.ts`

#### `initializeLayout`
```ts
export async function initializeLayout(
  state: DaemonState,
  daemonSurface?: string,
  resumePlan?: ResumePlanItem[],
): Promise<ResumeAssignment[]>
```

- 返り値に「resume 割り当ての結果」を含める（どの surface にどの task を割り当てたか、または「割当不能」）。
- team.json 復元成功時は空配列を返す（このパスでは Claude が既に動作中と仮定し、resume 命令は一切送らない。task 状態は team.json から復元済み）。
- 復元失敗時（新規作成）は `initializeConductorSlots(..., resumePlan)` に透過させ、その戻り値を整形して返す。

### 3. `skills/cmux-team/manager/main.ts`

#### 新 boot 順序（擬似コード）
```ts
// 1) task-state.json を先にロードして resumePlan を決定
const taskState = await loadTaskState(PROJECT_ROOT);
const assignedEntries = Object.entries(taskState)
  .filter(([, ts]) => ts.status === "assigned");

let taskStateModified = false;
const resumePlan: ResumePlanItem[] = [];
for (const [taskId, ts] of assignedEntries) {
  const canResume = ts.sessionId
    && ts.worktreePath && existsSync(ts.worktreePath)
    && ts.taskRunId;
  if (!canResume) {
    taskState[taskId] = { ...ts, status: "ready" };
    taskStateModified = true;
    await log("resume_fallback_to_ready", ...);
    continue;
  }
  resumePlan.push({
    taskId,
    taskRunId: ts.taskRunId!,
    worktreePath: ts.worktreePath!,
    sessionId: ts.sessionId!,
  });
}

// slot 数より多い場合: 超過分を ready に差し戻す
const MAX_SLOTS = state.maxConductors;
while (resumePlan.length > MAX_SLOTS) {
  const overflow = resumePlan.pop()!;
  taskState[overflow.taskId] = { ...taskState[overflow.taskId], status: "ready" };
  taskStateModified = true;
  await log("resume_overflow_to_ready", `task_id=${overflow.taskId}`);
}

// タスクタイトルを取得（renameTab 用）
for (const item of resumePlan) {
  const file = await findTaskFile(item.taskId);
  if (file) {
    const content = await readFile(file, "utf-8").catch(() => "");
    item.taskTitle = content.match(/^title:\s*(.+)/m)?.[1]?.trim();
  }
}

// 2) Layout 初期化（resumePlan を透過）
state.bootPhase = "conductors";
const resumeResults = await initializeLayout(state, daemonSurface, resumePlan);

// 3) 各 resume 割り当て結果を反映（ConductorState の詳細 + タブ名）
for (const r of resumeResults) {
  const c = state.conductors.get(r.surface);
  if (!c) continue;
  c.taskId = r.taskId;
  c.taskRunId = r.taskRunId;
  c.worktreePath = r.worktreePath;
  c.taskTitle = r.taskTitle;
  c.status = "running";
  c.startedAt = new Date().toISOString();
  c.agents = [];
  const num = c.surface.replace("surface:", "");
  const short = (c.taskTitle ?? "").slice(0, 30);
  await cmux.renameTab(c.surface, `[${num}] ♦ T${r.taskId} ${short}`).catch(() => {});
  await log("task_resumed", `task_id=${r.taskId} session_id=... surface=${c.surface} (via boot)`);
}

// 4) Master spawn / 以降は従来どおり
await startMaster(...);

// 5) main.ts:414-473 の resume ブロックは削除
if (taskStateModified) await saveTaskState(PROJECT_ROOT, taskState);
```

### 4. `skills/cmux-team/manager/schema.ts`

- `ResumePlanItem`, `ResumeAssignment` 等の型追加（必要なら）。最小限でよければ conductor.ts 側に置いて export する。

## 既存挙動との互換性

| パス | 変更前 | 変更後 |
|------|-------|--------|
| 通常の fresh start（assigned なし） | `cmux-team conductor` 起動 | 同上（resumePlan 空） |
| assigned あり・fresh start | 起動後に resume をチャット投入（**バグ**） | 起動時に `cmux-team resume <id>` をシェルに投入 |
| team.json 復元成功 | 復元 + resume コマンド投入（無意味／害） | 復元のみ。resume 命令は送らない（Claude 稼働中前提） |
| `cmdSpawnConductor`（手動起動: CLI から1つ追加） | `launchConductor(project, surface, paneId)` | 同じ呼び出しで OK（`opts` 省略時はデフォルトで `cmux-team conductor`） |
| resume 不可（sessionId 欠損等） | ready に戻す | 同じ（ロジックを launch 前に移しただけ） |

`launchConductor` の第4引数は optional なので既存呼び出し箇所（`cmdSpawnConductor` 内、`initializeConductorSlots` 内のいずれも現行のまま動作）に影響なし。

## テスト戦略

自動テストはプロジェクト方針により整備しない。以下の E2E 手動手順で検証する。

### ケース1: fresh start で assigned タスクあり（本修正の主目的）
1. 適当なタスクを作成し Conductor に走らせ、`cmux send-key C-c` 等で daemon を止め、`task-state.json` で `status: assigned` かつ `sessionId`/`worktreePath`/`taskRunId` が残る状態を作る（もしくは既存の assigned タスクを使う）。
2. `cmux-team stop` → full quit → 新しい cmux セッションで `cmux-team start`。
3. 期待動作:
   - ログに `task_resumed ... (via boot)` が記録される。
   - 対象 Conductor ペインがシェル経由で `cmux-team resume <id>` を実行（プロンプトに `$` が一瞬見える）。
   - 次行で Claude が `--resume <sessionId>` で起動し、過去の会話がそのまま復元される。
   - 以前の「Claude のプロンプト欄に `cmux-team resume 174` が入力された状態で止まる」症状が出ない。

### ケース2: fresh start で assigned タスクなし
1. 通常どおり `cmux-team start`。
2. 期待動作: 従来どおり `[N] ♦ idle` で 3 ペイン立ち上がる。

### ケース3: daemon reload（team.json 復元成功）で assigned タスクあり
1. assigned + Claude 稼働中の状態で daemon だけ reload（`cmux-team status` から reload）。
2. 期待動作: Claude セッションは維持。`task_resumed` ログは出ない（= resume 命令は送らない）。`conductors_restored` のみ。

### ケース4: resume 不可（`sessionId` 欠損）
1. task-state.json を手動編集し assigned なのに sessionId を空にする。
2. `cmux-team start`。
3. 期待動作: `resume_fallback_to_ready` が出力され status が ready に戻り、通常どおり `cmux-team conductor` として slot が立ち上がる。assigned のまま永久に残らない。

### ケース5: assigned 数 > slot 数
1. task-state.json に assigned を 4 件仕込む（全て canResume）。
2. `cmux-team start`（maxConductors=3）。
3. 期待動作: 先頭 3 件が resume。4 件目は `resume_overflow_to_ready` でログ、status=ready、通常 slot として起動後に scanTasks が拾う。

## エッジケース・考察

| ケース | 扱い |
|--------|------|
| `sessionId`/`worktreePath`/`taskRunId` が欠けている | launch 前に `status: ready` へ差し戻す。保存は `taskStateModified` で一括。 |
| `worktreePath` がディスク上に無い（`existsSync` false） | 同上（ready 差し戻し）。 |
| assigned 件数 > `state.maxConductors` | 超過分を ready に差し戻す（ログ `resume_overflow_to_ready`）。 |
| assigned 件数 > 0 だが既に running な同タスクの Conductor がいる | team.json 復元パスの話なので resumePlan は作成しない分岐。ただし新規作成パスでは発生しないため考慮不要（復元成功時は initializeConductorSlots を呼ばない）。 |
| `launchConductor` 実行中に `cmux send` が失敗 | 既存挙動同様にエラーログのみ。CONDUCTOR_REGISTERED フォールバックで registering 済なら `status: "running"` で登録されるが、Claude が起動していないため後続の tick で disconnected 扱いになる。スコープ外。 |
| タスクタイトル取得時のファイル読み込み失敗 | タイトル空でタブ名を付ける（`[N] ♦ T174 `）。現行 main.ts の動きと同等。 |
| `cmdSpawnConductor`（CLI から手動追加）との干渉 | opts 省略で影響なし。resume 用途で手動 CLI を追加する計画は無い。 |

## リスクと緩和策

| リスク | 緩和 |
|-------|------|
| `launchConductor` の新引数を他の呼び出し元で見落とす | 静的型（TypeScript）で担保。optional のため欠落時は従来挙動。 |
| resume で起動した Conductor が `CMUX_SURFACE` 環境変数を持たずに `cmux-team resume` を実行 | `cmdResume` 内で `CMUX_SURFACE` 必須チェック済み。`launchConductor` の step 2 で既に `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1` を送信しているため問題なし。 |
| タブ名 renameTab のタイミング競合 | `launchConductor` 側で opts.resumeTaskId がある場合は `[N] ♦ idle` を付けず、呼び出し元が確定名を付ける。二重 rename は起きない。 |
| team.json 復元パスでの挙動変化 | 従来も復元直後に resume コマンド送信していたのを削除するが、Claude が既に稼働中なので実害なし。ログ `task_resumed` が消えるため、代わりに `conductors_restored` に taskId を含めるか、復元時に `conductor_resume_noop` を記録するかは任意（今回はログ追加なしで最小変更）。 |
| resumePlan の計算ミスで slot を食いつぶし、ready タスクが実行されない | `maxConductors` を超える分は ready に戻すため、scanTasks が次周で拾う。 |

## 実装ステップ（順序）

1. `conductor.ts`: `launchConductor` に opts 追加 + 分岐実装。
2. `conductor.ts`: `initializeConductorSlots` に resumePlan 追加、戻り値拡張。
3. `daemon.ts`: `initializeLayout` の引数・戻り値を更新。team.json 復元時は空配列返却。
4. `main.ts`: start コマンドの boot シーケンス書き換え（resumePlan 構築 → initializeLayout → ConductorState 反映）。
5. `main.ts:414-473` の旧 resume ブロックを削除。
6. 手動 E2E 5 ケース実施。
7. 関連ドキュメント（`CLAUDE.md` の boot 関連記述、`docs/spec/`）で言及があれば追従確認。

## スコープ外

- team.json 復元パスで「surface は生きているが Claude プロセスが死んでいる」ケースの自動検出・再 launch。別タスク扱い。
- `cmdResume` 自体（claude --resume 呼び出し部分）の変更は不要。
