# T359 実装計画 — `cmux-team events` サブコマンド

T358 の writer (`skills/cmux-team/manager/events-writer.ts`) が emit する `.team/logs/events.jsonl` を tail / filter / format conversion する CLI を実装する。spec は `docs/spec/10-events-stream.md`（reader 実装ガイドラインは §8）。

---

## 1. 設計概要

### 1.1 ファイル配置

| 種別 | パス | 役割 |
|------|------|------|
| 新規 | `skills/cmux-team/manager/events-cli.ts` | CLI 本体（パーサ・filter・出力・follow loop）。`runEventsCli(opts): Promise<number>` を export し、exit code を返す。副作用（`process.exit` / signal handler）は呼び出し側に寄せて test 容易性を確保 |
| 新規 | `skills/cmux-team/manager/events-cli.test.ts` | bun test。temp dir を `createDummyProject` で用意し、events.jsonl を直接組み立てて検証 |
| 修正 | `skills/cmux-team/manager/main.ts` | switch 文に `case "events":` 追加（後述 §5.1）。i18n に `help_events` 追加 |
| 修正 | `skills/cmux-team/manager/i18n.ts` | `help_events` を ja / en の両 `messages` blob に追加。**ja blob は en と同一英語文を流用**（既存 `help_status` 等にも英語直書きの慣行があり、CLI help は英語維持で実害なし。ユーザー向け Markdown / README は別途日本語）。usage / error message は `t()` 経由で出す |

`events-cli.ts` を **module 化**するのは以下のため:

- main.ts は既に 5,500 行超で巨大化しており、新規 subcommand を直書きすると testability が大きく損なわれる
- `cmdTraceTask` 等の旧パターン（`process.argv` を直接読む）に揃えると test から呼べない
- `runEventsCli({ args, projectRoot, stdout, stderr, abortSignal, pollIntervalMs? }): Promise<number>` 形に切り出せば、test は in-process で stdout を集めて assert できる

シグネチャ概略:

```ts
export interface RunEventsCliOpts {
  args: string[];                 // "events" を除いた残り
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
  pollIntervalMs?: number;        // follow loop test 用 inject、default 200
}
export function runEventsCli(opts: RunEventsCliOpts): Promise<number>; // exit code
```

### 1.2 依存ライブラリ — 標準のみ

追加 dep は **入れない**。経路ごとに line buffering 戦略を分担する:

| 経路 | 読み取り API | line buffering |
|------|-------------|---------------|
| **non-follow**（§2.2） | `FileHandle.createReadStream()` | `node:readline` の `createInterface({ input })` で行単位 iterate |
| **follow**（§2.6.1） | 自前 `read(fd, buf, offset, len, pos)` | 自前 buffer に `\n` で flush（部分 chunk の結合） |

理由: non-follow は EOF まで一括ストリーム読みが自然で `readline` で十分。follow は inode 変化・size shrink の検知と offset 制御が必要なので低レベルの `read(fd, ...)` を直叩きする方が rotate 検知ロジックを混ぜずに書ける。両経路で共通化を試みると follow の rotate 制御が `readline` の lifecycle と衝突する。

使う module:

- `fs/promises` — `open` / `stat`（read 用 file handle）
- `node:fs` — `existsSync`
- `node:readline` — non-follow の line iterator
- `node:timers/promises` — follow loop の `setTimeout({ signal })`

`chokidar` 等は **使わない**（バンドルサイズと spec §7 の rotate 想定なし方針に揃える）。理由は §6.3。

### 1.3 main.ts への dispatcher 追加位置

`switch (command)` の `case "trace-hooks":` の **直後**、`case "conductor":` の **直前** に配置（行番号は変動するため構造で特定）。アルファベット順ではなく既存の lifecycle 系・trace 系の流れに合わせる。

```ts
case "events":
  await cmdEvents();
  break;
```

`cmdEvents()` は thin wrapper。`runEventsCli({ args, projectRoot: PROJECT_ROOT, stdout: process.stdout, stderr: process.stderr, abortSignal: ... })` を呼んで exit code を伝搬する。

---

## 2. 各機能の実装方針

### 2.1 引数パーサ

既存 main.ts の `getArg` / `hasFlag` パターン（`--flag value` 形式のみ、`--flag=value` 非対応）に揃える。`-f` を `--follow` の short alias として扱う。

| flag | type | required | default | 備考 |
|------|------|----------|---------|------|
| `--follow` / `-f` | bool | no | `false` | tail -F |
| `--types` | csv string | no | (filter なし) | exact match。空白を `trim`、空要素は drop |
| `--since` | duration or ISO 8601 | no | (filter なし) | §2.4 |
| `--format` | enum `json` / `text` | no | `"json"` | 不正値は引数エラー |
| `--help` / `-h` | bool | no | — | `t("help_events")` を出して exit 0 |

引数エラー（未知 flag、`--format` の不正値、`--since` の parse 失敗、`--types` 値なし）は **exit 1 + stderr に 1 行 error message + 1 行 hint**。pattern は `cmdAgents` 等に合わせる:

```
Error: invalid --format value: yaml (must be json or text)
Run 'cmux-team events --help' for usage.
```

`getArg` は `--types` の値を string で返す。値なしで指定された (`--types --follow` 等) と、未指定 (`indexOf` が -1) を区別したいので、`runEventsCli` 内で argv を線形に走査する小さな専用パーサを書く（既存の `getMultiArg` と同じ style）。

### 2.2 ファイル全体読み取り（non-follow）

§1.2 の分担に従い、**`FileHandle.createReadStream()` + `readline.createInterface({ input })`** で実装する。

```text
1. eventsPath = join(projectRoot, ".team/logs/events.jsonl")
2. existsSync(eventsPath) === false → exit 1 ("Error: events.jsonl not found at <path>")
3. fh = await fs.promises.open(eventsPath, "r")
   stream = fh.createReadStream()
   rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
   for await (const line of rl) { ... }  // 行単位の iterator は readline 任せ
4. 各行で:
   a. line.trim() === "" → skip（trailing \n 等）
   b. JSON.parse(line) を try/catch — 失敗時は warnInvalidLine(line, reason) → skip continue
   c. record.schema_version !== 2 → warnSchemaVersion(record) → skip continue
   d. typeof record.event !== "string" → warnMissingField → skip continue
   e. filterByTypes(record) === false → skip
   f. filterBySince(record) === false → skip
   g. format === "json" → stdout.write(line + "\n")
      format === "text" → stdout.write(formatText(record) + "\n")
5. EOF 到達 → exit 0
```

警告は **stderr へ 1 行**:

```
warn: invalid JSON at events.jsonl line 17: Unexpected token } in JSON at position 42
warn: skipping record with schema_version=3 at line 23 (current=2)
warn: skipping record with unknown event=foo at line 24
```

spec §8 のとおり **abort せず continue**。`schema_version` が想定より小さいケース（v1 以下）も同じく skip + warn する。

### 2.3 `--types` filter

```ts
function parseTypes(raw: string | undefined): Set<string> | null {
  if (!raw) return null; // null = pass all
  return new Set(
    raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  );
}
```

- null → all pass
- empty Set（`--types ""` や `--types ", ,"`）は **引数エラー扱い**（exit 1, stderr に `Error: --types value cannot be empty`）
- record.event の **exact match**（`startsWith` 等の partial match はしない、spec § CLI 仕様に明記）

**選択の根拠（plan として確定）**: empty Set を all pass にすると「ユーザーが意図的に 0 件出力を期待して `--types ""` を渡す」シナリオを区別できなくなり、シェル変数展開バグの黙殺にもつながる。strict に弾いて即座にエラーを返す方が予想可能性が高い。task instruction に言及がないため、Implementer 判断ではなく **plan 側で「引数エラー」を採用する** ことで方針を一本化する。

### 2.4 `--since` filter

入力を `parseSince(raw): Date | null` で正規化:

| 入力例 | 解釈 |
|--------|------|
| `5m` | `now - 5*60*1000` ms |
| `1h` | `now - 60*60*1000` ms |
| `2d` | `now - 2*86400*1000` ms |
| `3w` | **引数エラー**（`m`/`h`/`d` のみ受理） |
| `2026-04-27T12:00:00Z` | `Date.parse` の結果。NaN なら引数エラー |
| `2026-04-27T12:00:00+09:00` | 同上（`Date.parse` が解釈可能なら通す） |
| `5` | 引数エラー（suffix なし） |
| `abc` | 引数エラー |

判定:

```ts
const m = /^(\d+)([mhd])$/.exec(raw);
if (m) { ... return new Date(now - n * unitMs[unit]); }
const t = Date.parse(raw);
if (!Number.isNaN(t)) return new Date(t);
throw new Error(`invalid --since value: ${raw}`);
```

filter 適用:

```ts
const ts = Date.parse(record.ts as string);
if (Number.isNaN(ts)) { warn(...); skip; }  // ts 自体が壊れているケース
if (ts < since.getTime()) skip;
```

### 2.5 `--format` 出力

#### 2.5.1 `json`（default） — **raw line を出す**

`JSON.parse → JSON.stringify` するのではなく、**読み取った原文 line をそのまま `stdout.write(line + "\n")`** する。理由:

- spec §8 で reader は forward-compat — つまり writer が将来 optional field を足しても CLI 側は素通しすべき
- parse → stringify するとフィールド順や空白が変わる。外部 reader が JSONL ハッシュで重複検出している場合に壊す
- 不要なシリアライズコストを避ける（follow mode で重要）

ただし、以下のケースでは raw を信頼できない:

- JSON parse に成功した行（→ 構造的に valid なので raw 出力で問題なし）
- JSON parse に失敗した行 → 既に skip 済みなので出力経路に来ない

なので **「parse は filter 判定のために行うが、出力は raw line」** が一貫した方針。

#### 2.5.2 `text` — `<ts> <event> <key fields>` 1 行

format:

```
2026-04-27T12:34:56.789Z task_assigned task_id=T357 conductor_surface=surface:5 task_run_id=task-357-1777260538
```

- `ts` は record の ts そのまま
- 各 key field は `key=value`
- value に `\n` / `\t` / 空白 を含む可能性のある field は `JSON.stringify(value)`（つまり `"..."` で quote + escape）
- 未定義 optional field は出力しない

#### 2.5.3 全 17 event の text format key field mapping

writer の `EventStreamRecord` 型は spec の 16 event + T392 で追加された `api_error_received`（schema_version は据置）の **計 17 event**。すべて mapping を持つ。

**writer 17 event vs spec §5 16 event の不一致への対応方針**:

- **本 plan は writer 実装 (`events-writer.ts:126-134` の `EventStreamRecord` 型) を真値として採用する**。理由: 実装は既に T392 で `api_error_received` を schema_version=2 のまま add-only で加えており、ランタイムで観測される 17 event 全てを CLI が text 化できなければ debug 用途で穴が空く
- spec §5 の脚注「合計 16 event 種」は T392 の add-only 追加が反映されておらず stale。**spec 修正は T361 / docs-sync の責務であり本タスクの scope 外**
- この方針は §6.10 にも再掲し、retro での docs-sync 連携トリガーとして明示する

| event | text 出力の key fields（順序固定） | quote 必要な可能性 |
|-------|-----------------------------------|--------------------|
| `task_created` | `task_id`, `title` | `title` |
| `task_ready` | `task_id` | — |
| `task_assigned` | `task_id`, `conductor_surface`, `task_run_id` | — |
| `task_completed` | `task_id`, `conductor_surface`, `worktree_path` | `worktree_path` |
| `task_completed_state_mismatch` | `task_id`, `conductor_surface`, `reason`, `worktree_path` | `worktree_path` |
| `task_aborted` | `task_id`, `reason` | — |
| `task_sync_guard_rejected` | `task_id`, `kind`, `main_branch`, `detail` | `detail` |
| `task_reverted_to_ready` | `task_id`, `reason` | — |
| `conductor_running` | `conductor_surface`, `task_id` | — |
| `conductor_recovered` | `conductor_surface`, `new_status` | — |
| `conductor_disconnected` | `conductor_surface`, `reason`, `task_id` (optional) | — |
| `conductor_asking` | `conductor_surface`, `question` | `question` |
| `conductor_done_unresolved` | `task_id`, `conductor_surface`, `worktree_path` | `worktree_path` |
| `conductor_start_timeout` | `conductor_surface`, `elapsed_ms` | — |
| `conductor_assign_timeout` | `conductor_surface`, `task_run_id`, `elapsed_ms` | — |
| `conductor_disconnect_timeout` | `conductor_surface`, `elapsed_ms`, `task_id` (optional) | — |
| `api_error_received` | `surface`, `role`, `kind`, `message` (optional) | `message` |

設計判断:

- `journal_summary` は **text format から省く**。理由: 改行を多く含む長文要約で 1 行可読フォーマットを破壊し、debug 用途にはノイズが大きい。必要なら `--format json` を使う旨を help に明記
- 未知 event（forward-compat path）は §2.2 の段階で skip + warn。text 出力経路には来ない

### 2.6 `--follow` 実装

#### 2.6.1 基本ループ — 自前 `read(fd, buf, ...)` + line buffer (poll 主駆動)

§1.2 の分担に従い、follow 経路は **`FileHandle.read(buf, offset, len, position)` を直接呼んで自前 buffer に貯め、改行で flush** する。`readline.createInterface` を使わない理由: rotate 時に input stream を破棄して再 open するライフサイクル制御が `readline` だと煩雑になり、partial line buffer の取り扱いも自前管理になるため。

```text
1. fh = await open(path, "r"); position = 0; lineBuf = ""
2. read all from position=0 to size: 増分読み + lineBuf に追記、改行で行を切り出して emit each line（filter 後）
3. lastInode = stat.ino; lastSize = stat.size
4. loop:
   a. await setTimeout(pollIntervalMs, undefined, { signal: abortSignal })  // 既定 200ms、test 用に inject 可
   b. try { st = await stat(path) } catch (ENOENT) { continue }  // 一時的に消えたら待つ
   c. inode 変化 OR st.size < lastSize → await fh.close(); fh = await open(path, "r"); position = 0; lastSize = 0; lastInode = st.ino; lineBuf = ""
   d. st.size > lastSize → read(buf, 0, len, position) で増分を読み、lineBuf に追記して改行 split → 各行 emit、最後の半端は lineBuf に残す
   e. lastSize = st.size; position は読み取り済みバイト数で更新
5. SIGINT / abortSignal で fh.close → 半端な lineBuf は破棄 → exit 0
```

**`pollIntervalMs` の渡し方**: `runEventsCli` の option object で受ける（`pollIntervalMs?: number`、default 200）。env (`CMUX_TEAM_EVENTS_POLL_MS`) 経由は採用しない。理由: option injection の方が test 時に env leak の心配がなく、§5.2 help の Notes にユーザー向け env を記載する責務が増えない。

`fs.watch` を補助的に併用すると Linux/macOS で event-driven に近づくが、**poll を主駆動とする**:

- macOS の fs.watch は rename + new file 作成の組合せでイベントを取りこぼす実例あり（既存 daemon.ts:529 でも poll fallback を併用）
- Bun の fs.watch は recent でも platform 差が残る
- poll 200ms の余分な CPU は無視できる規模

ただし「初回 open 時にファイルが存在しない」場合は ENOENT で exit 1（spec の終了コード仕様）。一度 open に成功した後の rename / unlink は **rotate 扱いで再 open を試みる**（poll ループ内）。

#### 2.6.2 rotate detection

spec §7 では rotate なし方針だが、手動 GC（`tail -n N > tmp; mv tmp events.jsonl`）が起きうる。

検知条件:

- `st.ino !== lastInode` — 別 inode に置き換わった
- `st.size < lastSize` — truncate 系（同 inode で size が縮んだ）

検知後の挙動: **新ファイルを先頭から読む**（重複出力を許容）。理由は task instruction の「rotate 対応」要件。重複は CLI 利用者の責任で重複排除する想定で、help にもこの挙動を記述する。

#### 2.6.3 SIGINT で graceful exit

`runEventsCli` は AbortSignal を受け取り、ループ内の `await sleep(POLL_MS, { signal })` がそれを反映する。`process.on("SIGINT", () => ac.abort())` を main.ts 側 wrapper で 1 回だけ install する。abort 時:

- fd を close
- pending な partial line buffer を捨てる（改行で終わっていない最終バイトは出力しない）
- exit 0

### 2.7 PROJECT_ROOT 解決

`runEventsCli` 引数で `projectRoot: string` を受け取る。test では `createDummyProject` の root を渡し、main.ts wrapper では `PROJECT_ROOT` を渡す。`process.env.PROJECT_ROOT` を直接見る経路は **使わない**（テスト時の env leak を避ける）。

---

## 3. テスト方針（TDD）

`skills/cmux-team/manager/events-cli.test.ts` を新設し、bun test で実行。`createDummyProject` で project root を用意して `.team/logs/events.jsonl` を fixture として直接書き、`runEventsCli({ ... })` を in-process で呼んで stdout / stderr / exit code を assert する。

### 3.1 共通 fixture helper

```ts
async function writeFixture(root: string, lines: object[]): Promise<void> {
  const path = join(root, ".team/logs/events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function captureStreams() {
  const out: string[] = [], err: string[] = [];
  const stdout = { write: (s: string) => { out.push(s); return true; } } as any;
  const stderr = { write: (s: string) => { err.push(s); return true; } } as any;
  return { out, err, stdout, stderr };
}
```

### 3.2 テストケース一覧（**TDD: 各ケースを red → green → refactor の順に積む**）

| # | テスト名 | 目的 | 期待値 |
|---|---------|------|--------|
| 1 | `events.jsonl 不在 → exit 1` | spec §終了コード | exit 1, stderr に `not found` を含む |
| 2 | 全件読み取り（filter なし、format=json）| baseline 動作 | stdout に fixture と同じ raw 行が並ぶ。order 保持 |
| 3 | `--types task_completed,task_aborted` | 単独 + 複数 type filter | matched record のみ出力 |
| 4 | `--since 5m` | duration 形式 | 5 分以内の record だけ出力 |
| 5 | `--since 2026-04-27T12:00:00Z` | ISO 8601 形式 | 指定時刻以降だけ出力 |
| 6 | `--since abc` / `--since 3w` | 引数エラー | exit 1, stderr に `invalid --since` |
| 7 | `--format text` 出力 fmt | 全 17 event を fixture に投入し各行が `<ts> <event> key=value...` 形式になる | mapping 表通り。journal_summary 不出力。quote 必要 field は `JSON.stringify` 形式 |
| 8 | 不正 JSON 行 skip + warning | spec §8 forward-compat | 不正行は stdout に出ず、stderr に warn 1 行。後続 valid 行は出る |
| 9 | `schema_version=3` を skip + warn | spec §4 / §8 | exit 0, stderr に warn |
| 10 | 未知 `event=foo` を skip + warn | spec §8 | 同上 |
| 11 | `--format` 不正値 / 未知 flag | 引数エラー | exit 1 |
| 12 | （optional）follow + 後発 append | tail 動作 | child task で events.jsonl に append → CLI が標準出力に拾う。AbortSignal で停止 |
| 13 | （optional）follow + rotate | inode 変化検知 | events.jsonl を mv で差し替え → 新ファイル先頭から読み出される |

#### 3.2.1 follow 系テスト（#12, #13）の方針

bun test では `runEventsCli({ ..., abortSignal, pollIntervalMs: 20 })` を fire-and-forget で起動し、`setTimeout` で fixture に追記したり mv で置き換えたりして再 await する。POLL_MS は **`pollIntervalMs` option injection** で test 時に 20ms 程度に下げる（env override は使わない、§2.6.1 末尾と整合）。

テスト時間が flaky になりやすいため #12, #13 は **green になったら refactor で安定化** を狙い、初版では #1〜#11 の 11 ケースを必須とする（task instruction の最低 8 ケースを満たす）。

#### 3.2.2 TDD 順序

1. **red**: skeleton `runEventsCli`（NotImplemented を throw）と test #1 (exit 1 on missing) を書く → 落ちる
2. **green**: existsSync チェックと早期 exit 1 を実装 → #1 通る
3. **red**: test #2 (全件 raw 出力)
4. **green**: open + stream read + stdout 経路を実装 → #2 通る
5. **red**: test #3 → **green**: types filter 実装
6. **red**: test #4, #5, #6 → **green**: parseSince + filter 実装
7. **red**: test #7 → **green**: text formatter + mapping 実装
8. **red**: test #8, #9, #10 → **green**: forward-compat skip + warn 実装
9. **red**: test #11 → **green**: arg parser エラー path
10. **refactor**: 共通化（filter chain、warn 関数）
11. **(任意) red**: test #12, #13 → **green**: follow loop 実装

---

## 4. 出力ファイル一覧

| 種別 | パス | 内容 |
|------|------|------|
| 新規 | `skills/cmux-team/manager/events-cli.ts` | `runEventsCli({ args, projectRoot, stdout, stderr, abortSignal })`、`parseTypes`、`parseSince`、`formatText`、`runFollowLoop` を export |
| 新規 | `skills/cmux-team/manager/events-cli.test.ts` | bun test。3.2 のケースを実装 |
| 修正 | `skills/cmux-team/manager/main.ts` | `import { runEventsCli } from "./events-cli";` を追加。`switch (command)` に `case "events": await cmdEvents(); break;` を追加。thin wrapper `cmdEvents()` で signal handler install + projectRoot 渡し |
| 修正 | `skills/cmux-team/manager/i18n.ts` | `help_events` を ja / en に追加。Error message が i18n 化対象なら `events_not_found` 等のキーを追加 — ただし trace-task 等を見ると技術的 error message は英語直書きで OK な慣行 |
| 修正なし | `skills/cmux-team/manager/events-writer.ts` | T358 で完成済み。本タスクでは触らない |

---

## 5. 既存 CLI への統合

### 5.1 main.ts dispatcher

```ts
// case "trace-hooks": の直後、case "conductor": の直前 (行番号は変動するため構造で特定)
case "events":
  await cmdEvents();
  break;
```

`cmdEvents()` 実装（main.ts 内に追加）— `runEventsCli` は `Promise<number>` (exit code) を返す。`process.exit` は `try` ブロックでは呼ばず、**listener を解除してから exit する** ことで「`process.exit` 後の `finally` は実行されない」問題を避ける:

```ts
async function cmdEvents(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_events"));
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  let exitCode = 1;
  try {
    exitCode = await runEventsCli({
      args: args.slice(1),  // "events" 自身を除く
      projectRoot: PROJECT_ROOT,
      stdout: process.stdout,
      stderr: process.stderr,
      abortSignal: ac.signal,
    });
  } finally {
    // listener 解除はここで完了させる
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
  // exit は try/finally の外で
  process.exit(exitCode);
}
```

代替案として「`runEventsCli` を `process.exit` させない設計のまま、main の `switch` 文を抜けた後で exit 処理を一括する」パターンも検討した。ただし既存 `cmdStatus` / `cmdTraceTask` も各 case で `process.exit` を呼ぶ慣行のため、整合性を優先して上記を採用する。

### 5.2 `--help` / usage 文（i18n）

`i18n.ts` は ja / en の両 `messages` blob を持っている（既存 `help_main` / `help_status` / `help_trace_task` 参照）。`help_events` を **両方の blob に追加**する。CLI help は既存慣行に従い英語維持（`help_status` も英語のみ）であり、**ja blob には en と同一の英語文を流用**する。

`i18n.ts` の en / ja messages に追加（同一文）:

```
help_events: `
cmux-team events -- tail / filter the events stream

Usage:
  cmux-team events [options]

Options:
  --follow, -f             tail -F equivalent (rotate aware). Stream new lines until SIGINT.
  --types <list>           comma-separated event type filter (exact match).
                           e.g. --types task_completed,task_aborted
                           (empty list "" / ", ," is rejected with exit 1)
  --since <when>           filter records older than the given threshold.
                           duration: 5m / 1h / 2d
                           ISO 8601: 2026-04-27T12:00:00Z
  --format json|text       output format (default: json — raw JSONL)
                           text: <ts> <event> <key=value...> (debug only)

Notes:
  - Records that fail to parse, have unknown event, or unsupported schema_version
    are skipped with a warning to stderr (spec §8 forward-compat).
  - --format text omits journal_summary fields to keep one record per line.
  - --follow re-opens the file after rotate (inode change or size shrink),
    re-emitting from the new file's head; the consumer must dedupe if needed.
  - SIGINT exits with code 0 (graceful shutdown). If your CI scripts need to
    distinguish SIGINT from normal EOF, this is a follow-up consideration.

Exit codes:
  0  normal exit (EOF without --follow, or SIGINT during --follow)
  1  argument error / events.jsonl not found
`
```

`help_main`（top-level help、`case "help":` 内で表示される）の subcommand 一覧にも `events` 行を追加する。

---

## 6. 懸念・判断ポイント

### 6.1 `--format json` を pretty にしない

spec §2 の「JSONL（1 行 1 record）」の不変条件を守る。pretty (`JSON.stringify(rec, null, 2)`) を出すと downstream の `jq` / `tail` パイプを壊す。pretty 化は将来 `--pretty` flag を別建てで足すなら可能だが、本タスクの scope 外。

### 6.2 text format の値 escape

`journal_summary`, `question`, `detail`, `message`, `title` はタブ・改行・スペースを含み得る。escape 方針:

- value (`String(value)`) が **正規表現 `/[\s="\\]/` のいずれかにマッチする場合のみ** `JSON.stringify(value)` で quote
  - `\s` — space / tab / newline / CR / VT / FF
  - `=` — field 名と value の区切り文字なので必須
  - `"` — quote 内に裸で出ると壊れるため
  - `\\` — backslash がそのまま出ると escape sequence 再解釈で混乱するため
- それ以外（例: `T357`、`task-359-1777559978`、`5234`）は raw（un-quoted）

ただし `journal_summary` は冒頭で議論したとおり **text format から省く**。残る可変長 field（`question`, `detail`, `message`, `title`, `worktree_path`）を上記ルールで処理。

実装疑似コード:

```ts
const ESCAPE_RE = /[\s="\\]/;
function fmtValue(v: unknown): string {
  const s = String(v);
  return ESCAPE_RE.test(s) ? JSON.stringify(s) : s;
}
```

実装簡易化のため「**常に `JSON.stringify`（毎回 quote）**」も検討したが、人間可読性を優先して conditional escape を採用する。テスト #7 で quote 必要 / 不要 の両ケースを検証する。

### 6.3 file watcher: 標準 fs で十分

`fs.watch` は platform 差があり、特に macOS で rename + create の組合せを取りこぼすことが知られる（既存 daemon.ts でも poll fallback を併用）。chokidar は依存追加コストが大きく、CLI が重くなるのと監査面でも不利。

本実装では **poll を主、fs.watch は無し** で開始する。POLL_MS=200ms は live tail として体感遅延が無視できるレベル（既存 await-task の fs.watch も最終的に毎 tick の判定があるため水準感は変わらない）。

### 6.4 stderr の warn を出力しない (silent) オプションは作らない

`--quiet` 等の追加 flag は scope 外。spec §8 の警告ログは reader の責務として常に出す。test の simplification にもなる。

### 6.5 SIGINT exit code（test 容易性のため 0、follow-up で 130 に変更可）

Node default では 130（128 + SIGINT）。task instruction の「SIGINT: 即座に中断」を満たすために `process.exit(130)` を明示するか、handler を install せず default に任せるかは判断ポイント。

選択: **handler を install して `ac.abort()` → fd close → `exit 0`**。理由: graceful shutdown を実装しないと follow ループが SIGINT で fd を leak する余地があり、test も書きづらい。task instruction は exit code を 130 と指定していないので 0 で問題ない。help にもこの挙動を記述する。

**ただし** Unix 慣行・Node default では 130 が一般的で、CI / scripts が「SIGINT で中断されたか正常 EOF か」を区別できないという trade-off がある。**Implementer 判断で、必要なら follow-up タスクで 130 に変更可能**（変更コストは低く、test も `expect(exitCode).toBe(130)` に書き換えるだけ）。本 plan では test 容易性を優先して 0 を初期実装とする。

### 6.6 `EVENTS_SCHEMA_VERSION` の参照と `< 2` skip の根拠

`runEventsCli` は `import { EVENTS_SCHEMA_VERSION } from "./events-writer"` で定数を取得し、record の version 比較に使う。`> 2` も `< 2` も skip + warn。reader を hardcoded で v2 に縛りつつ、将来 writer が v3 に上がった場合に CLI を一斉更新する運用 — spec §4 の方針と一致。

**`< 2` (v1 以下) も skip する根拠**: spec §8 は明示的には「`schema_version` が想定より大きい record は skip + 警告」としか書いていないが、spec §4 は「並行 schema は維持しない」と明記している。よって writer が v2 に統一された後に v1 以下の record が混入する経路は通常存在せず、観測された場合は **不正データ** として扱うのが整合的。`==` で strict 比較し、不一致は方向（大／小）にかかわらず skip + warn する方が forward-compat とも整合する。

### 6.7 ts 不正 record の扱い

`record.ts` が parse 不能な場合（writer 側のバグ等）、`--since` filter は安全側で **skip + warn** とする。`--format json` の raw 出力経路は record.ts を見ないので、`--since` 未指定なら通り抜ける。

### 6.8 巨大ファイルへの読み出し効率

events.jsonl は spec §7 で rotate なし append のため、長期運用で 100MB 超える可能性あり。`createReadStream` (line iterator) で逐次処理し、メモリは O(1) を保つ。現状 spec §7 の見積もり (task 1 件あたり 5〜10 record) では当面問題にならないが、設計上同期 readFile は使わない。

### 6.9 forward-compat: optional field 欠損

spec §8 は「必須 field 欠損は警告ログ + skip」。`runEventsCli` の filter は `record.event` と `record.ts` のみ参照するため、他の field 欠損では filter は通る（出力時に値が undefined になるだけ）。text formatter は undefined を `key=undefined` ではなく **省略** する（mapping 表どおり）。

### 6.10 writer 17 event vs spec §5 16 event の乖離（再掲）

§2.5.3 で確定したとおり、本 plan は **writer 実装を真値**として 17 event 全てに text mapping を実装する。

- spec §5 の脚注「合計 16 event 種」は T392 で `api_error_received` が schema_version=2 のまま add-only で追加された経緯が反映されておらず stale
- **spec §5 の修正は T361 / docs-sync の責務であり本タスクの scope 外**
- 本 plan では writer の `EventStreamRecord` 型と spec の食い違いを「retro で docs-sync 連携をトリガーすべき項目」として明記する

writer 側の権威性根拠: T392 はランタイムイベントを実装ベースで反映する add-only の lifecycle 拡張であり、spec の文言修正が後追いになるのは設計原則「決定論的なものはコードで」と整合する。CLI が writer 出力の 100% を扱えなければ debug 用途で穴が空くため、writer を真値とするのが妥当。

### 6.11 `pollIntervalMs` の env か option か

§2.6.1 末尾と §3.2.1 で確定済み。**option injection (`pollIntervalMs?: number`) を採用**、env (`CMUX_TEAM_EVENTS_POLL_MS`) は採用しない。

理由再掲:

- env 経由は test 時に env leak / cleanup の責務が増える
- ユーザー向け新規 env を増やすと §5.2 help / docs に文書化責務が発生する
- option injection なら test だけが気にすればよく、production code path には影響しない

---

## 完了条件チェック

- [x] §1 設計概要（ファイル配置、依存、dispatcher 位置、`runEventsCli` シグネチャ + `Promise<number>`）
- [x] §1.2 line buffering 戦略の経路別分担（non-follow: readline、follow: 自前 read+buffer）
- [x] §2 各機能（args / non-follow / types / since / format / follow / projectRoot）
- [x] §2.3 `--types ""` を引数エラー扱いとする選択の根拠
- [x] §2.5.3 全 17 event の text format key field mapping 表 + writer vs spec 乖離の正当化
- [x] §3 テスト方針（red→green→refactor 順 + 11 ケース必須 + 2 ケース optional、`pollIntervalMs` 注入）
- [x] §4 出力ファイル一覧
- [x] §5.1 dispatcher（`process.off` → `process.exit` の順、行番号削除）
- [x] §5.2 i18n（en/ja 両 blob 追加、ja は en 流用方針）
- [x] §6 懸念・判断ポイント（escape regex 具体化、`< 2` skip 根拠、writer 真値、option injection、SIGINT 0 → 130 follow-up）

---

## design-review.md Recommendations 1〜7 の反映マップ

| Rec # | 内容 | 反映箇所 |
|-------|------|---------|
| 1 | line buffering 戦略の整合 | §1.2 表、§2.2 readline、§2.6.1 自前 read |
| 2 | help_events ja blob 追加 | §1.1（流用方針）、§5.2（en/ja 同一文方針） |
| 3 | `cmdEvents()` の `process.exit` / `finally` 修正 | §5.1（off → exit の順） |
| 4 | writer 17 vs spec 16 乖離の正当化 | §2.5.3、§6.10（再掲 + retro 連携） |
| 5 | `runEventsCli` 戻り値型 `Promise<number>` | §1.1 シグネチャ例、§5.1 |
| 6 | `< 2` skip 根拠 / escape regex / pollIntervalMs / `--types ""` | §6.6、§6.2、§6.11 / §2.6.1、§2.3 |
| 7 | 行番号削除 | §1.3、§5.1 dispatcher コメント |
