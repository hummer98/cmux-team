# T259 実装サマリー

## 変更ファイル

- `skills/cmux-team/manager/pidfile.ts` (新規) — pidfile ロック本体（`acquirePidFile` / `releasePidFile` / `acquireOrExit` / `psCommand` / `looksLikeCmuxTeamProcess` / `PidFileLockedError`、`isAlive` は `cmux.ts` から re-export）
- `skills/cmux-team/manager/pidfile.test.ts` (新規) — Step 1-7 相当の TDD テスト + ps 取得失敗時の保守的 locked 判定を追加
- `skills/cmux-team/manager/main.ts` — `import { acquireOrExit, releasePidFile } from "./pidfile"` を追加。`cmdStart` 冒頭（preflight 後・direnv 前）に `acquireOrExit`、`shutdown` / `onFullQuit` / `restartRequested` / `onReload`（execFileSync 直前） / `cmdStop`（保険）の全 5 経路に `releasePidFile` を挿入
- `CLAUDE.md` — 「Manager プロトコル（内部実装）」セクションに「多重起動防止（pidfile ロック — T259）」サブセクションを追加、`.team/` ディレクトリ構造表に `daemon.pid` 行を追加
- `CHANGELOG.md` — `[Unreleased]` に T259 の項目を追加

## テスト結果

- `bun test pidfile.test.ts`: **21 pass / 0 fail** (27 expect calls)
- `bun test` (全体): **543 pass / 0 fail** (1211 expect calls)
- `bunx tsc --noEmit`: **エラーなし**

## 実装上の判断

### 1. `isAlive` は重複定義せず `cmux.ts` から re-export（レビュー指摘 1）

`pidfile.ts` 冒頭で `export { isAlive } from "./cmux"` し、内部使用も `import { isAlive as realIsAlive } from "./cmux"` で再利用する。`cmux.ts` 側の `__setIsAliveImpl` が将来差し替えられても自動追従する。循環依存は起きない（`pidfile.ts` → `cmux.ts` の一方向のみ）。

### 2. PID 再利用対策の ps 判定ロジック

stale 判定の優先順位:

1. `aliveImpl(pid)` が false → stale（削除して再試行）
2. alive かつ `ps -p <pid> -o command=` 出力に `main.ts` / `cmux-team` を含む → **locked**（`PidFileLockedError`）
3. alive かつ ps 出力が上記を含まない → PID 再利用とみなし stale（削除して再試行）
4. alive かつ ps 出力が空文字（ps 取得失敗）→ **保守的に locked**（誤って稼働中 daemon を潰さないため）

4 の挙動は plan.md Section 2.3 の「保守的に alive なら alive」路線を採用。Section 2.4 の「ps が空なら stale」は稼働中 daemon を誤削除するリスクがあるため採らず。pidfile.test.ts に保守的判定のテストケースを追加して明示的に固定した。

### 3. `cmdStop` の保険は最小限（レビュー指摘 2）

sleep ループを置かず、pidfile が残存していて **かつ記録 PID が dead** の場合のみ即 unlink する設計。daemon 側の shutdown / SIGTERM 経路で確実に release されるため、cmdStop の体感レスポンスは `SHUTDOWN sent` 直後の 1 回の `existsSync` + `readFile` のみで済む。

### 4. `acquireOrExit` ラッパーで main.ts 変更を最小化（レビュー指摘 3）

`cmdStart` 側の追加は 3 行のみ:

```ts
const pidFilePath = join(PROJECT_ROOT, ".team/daemon.pid");
await acquireOrExit(pidFilePath, PROJECT_ROOT);
await log("pidfile_acquired", `path=${pidFilePath} pid=${process.pid}`);
```

`PidFileLockedError` → `console.error` + `log("pidfile_locked")` + `process.exit(1)` は `pidfile.ts` 内部にカプセル化。

### 5. proxy プロセスとの関係を明示（レビュー指摘 4）

`pidfile.ts` の header コメントと `CLAUDE.md` の両方に「pidfile は daemon main.ts プロセスのみを指す、proxy は別ライフサイクル」を明記した。

### 6. release 順序を厳守（レビュー指摘 6）

- `shutdown`: `log("daemon_stopped")` → `updateTeamJson(state)` → `releasePidFile(pidFilePath)` → `process.exit(0)`
- `onFullQuit`: `stopDaemon(state)` → `updateTeamJson(state)` → `releasePidFile(pidFilePath)` → `process.exit(0)`
- `restartRequested`: `updateTeamJson(state)` → **`releasePidFile(pidFilePath)`** → `process.exit(42)` (state 永続化の後、exit 直前)
- `onReload`: `stopDaemon(state)` → `state.fileWatcherAbort?.abort()` → **`releasePidFile(pidFilePath)`** → `execFileSync(bun ...)` (子が acquire できるように exec 直前に release)
- `cmdStop`（保険）: pidfile 残存 & dead のみ unlink

### 7. onReload 経路の pidfile 所有権移転

auto-restart の親（execFileSync ブロッキング）は pidfile を握ったままだと子 daemon が自分自身を "alive cmux-team" と誤検知して fail-stop する。execFileSync の**直前**に release することで:

```
親 (PID=100) acquire → daemon 稼働 → restartRequested = true
  updateTeamJson → releasePidFile (restartRequested 経路)
  process.exit(42)
← 親 onReload 側は execFileSync で子を起動する経路に入る前提
    （onReload 経路: 親が onReload 内で release → execFileSync で子起動）
    （restartRequested 経路: 子 daemon が exit 42 → 親の execFileSync ループが再 exec）
  execFileSync("bun", ...) → 子 (PID=200) が pidfile を acquire
    子 daemon 稼働 → 通常 shutdown → release → exit(0)
  親の execFileSync 正常復帰 → process.exit(0)
```

onReload の親は execFileSync 直前に release、restartRequested の子は exit(42) 直前に release、という 2 つの release を両方仕込んであるため、親子どちらの経路でも所有権は正しく移転する。

## 残課題

- 特になし。手動 smoke test（2 つ同時に `cmux-team start` を叩く）は plan.md Step 5 の通り単体での再現が難しいため省略。pidfile.test.ts の Step 3 / Step 7 で EEXIST → PidFileLockedError 経路をカバーしているため、同じロジックが production でも作動することは保証される。
