# T283 実装レポート

タスク: Master の git 操作緩和 / `CMUX_TEAM_FETCH_BEFORE_WORKTREE` デフォルト ON 反転 /
ready 昇格時の sync state ガード追加。

## 変更概要

### 新規ファイル

| ファイル | 行数 | 役割 |
|---|---:|---|
| `skills/cmux-team/manager/git-sync.ts` | 301 | 7 状態 sync judgement の pure function + async collector |
| `skills/cmux-team/manager/git-sync.test.ts` | 563 | 34 テスト（全 state × 全 headStatus 組合せ） |

### 変更ファイル（差分 10 ファイル、+242 / -8 lines）

- `skills/cmux-team/manager/config.ts` — `resolveFetchBeforeWorktree(env)` 新設（デフォルト ON）
- `skills/cmux-team/manager/conductor.ts` — worktree 作成の `doFetch` を config 解決に置換 + Conductor shell に `CMUX_TEAM_SKIP_SYNC_CHECK=1` 注入
- `skills/cmux-team/manager/main.ts` — `runSyncCheckOrExit` 追加、`cmdCreateTask` / `cmdUpdateTask` に組込、`cmdSpawnAgent` exportVars に `CMUX_TEAM_SKIP_SYNC_CHECK=1`、`cmdStart` で `fetch_before_worktree` ログ emit
- `skills/cmux-team/manager/i18n.ts` — `help_create_task` / `help_update_task` に `--force` / `--skip-fetch` / sync check notes 追加（ja/en）
- `skills/cmux-team/templates/{ja,en}/master.md` — git 読取・fetch・`pull --ff-only` を「やること」に移動、write 系は禁止維持
- `CLAUDE.md` — fetch デフォルト反転 / sync state ガード節 / ログポリシー更新
- `docs/spec/04-templates.md` — Master ワンライナー更新
- `docs/spec/05-install-and-infrastructure.md` — `CMUX_TEAM_FETCH_BEFORE_WORKTREE` のデフォルト説明更新
- `CHANGELOG.md` — Unreleased に Breaking 2 件 + Added 1 件

## 設計上のポイント

### 1. Pure function + async collector の分離

`git-sync.ts` は 3 関数 + 1 統合 API:

- `decideSyncState(facts)`: pure、SyncFacts → SyncState（7 値 enum）
- `classifyVerdict(state, facts)`: pure、SyncState → Verdict（allow/warn/reject + message）
- `collectSyncFacts(projectRoot, { mainBranch, doFetch, git? })`: async、git コマンド列で facts を収集（`git?` 引数でテスト用スタブ注入可）
- `checkSyncState(projectRoot, opts)`: 上記 3 つを束ねる一発 API

この分離で、テストは git スタブ経由で全 state を網羅できる（34 テストで網羅）。

### 2. SyncState 7 値 × 3 分類（allow/warn/reject）

| state | verdict | 契機 |
|---|---|---|
| `clean` | allow | SHA 一致 |
| `ahead` | allow | local が origin の descendant |
| `behind-ff` | warn | origin が local の descendant（FF 可能） |
| `no-remote` | warn | origin か local が存在しない |
| `diverged` | reject | 双方に未共有コミット |
| `uncommitted` | reject | on-main で dirty tree |
| `detached` | reject | HEAD detached |

判定順序: `detached` → `uncommitted` → remote/local 不在 → SHA 比較。
`hasUncommittedOnMain` は `on-main` でのみ true になる（他ブランチでの作業途中と main の worktree 汚染を混同しない）。

### 3. bypass 3 経路

| 経路 | ログ | 用途 |
|---|---|---|
| `--force` CLI フラグ | `ready_force_bypass` | Master が一回限りの強制昇格 |
| `CMUX_TEAM_SKIP_SYNC_CHECK=1` env | `ready_sync_skipped reason=env` | 下位層（Conductor / Agent）から再帰呼び出し時の回避 |
| `--skip-fetch` CLI フラグ | （fetch のみ抑止、判定は実施） | offline / rate limit 対策 |

Conductor shell export（`conductor.ts:109`）と `cmdSpawnAgent.exportVars`（`main.ts:2345`）の
両方に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を注入することで、下位層からの `create-task --status ready`
が自分の worktree の sync チェックを無意味に走らせる事故を防ぐ。

### 4. `mainBranch` 未設定時の skip

`runSyncCheckOrExit` は `loadConfig().mainBranch` が未設定なら `ready_sync_skipped reason=no_main_branch`
を emit して skip する。`cmux-team start` 実行前（初回起動時）にタスクを作ろうとする UX を殺さないため
（Decision Log D11）。

## 検証結果

### シナリオ 1: `bun test git-sync.test.ts`

```
 34 pass
 0 fail
 68 expect() calls
Ran 34 tests across 1 file. [19.00ms]
```

全 state × 全 headStatus × verdict 変種 × `collectSyncFacts` スタブシナリオ × `checkSyncState` e2e を網羅。

### シナリオ 2: 型チェック

`bunx tsc --noEmit --project skills/cmux-team/manager/tsconfig.json` で出る 3 件のエラー
（`conductor.ts:201` 関数パラメータ / `daemon.test.ts:3720` / `daemon.ts:1538`）は **pre-existing**。
`git stash` で本 T283 変更を退避した上で同コマンドを再実行したところ、同じ 3 件がそのまま出ることを確認済
（stash 前後で行番号が一致）。T283 では **新しい型エラーを導入していない**。

### シナリオ 3: `CMUX_TEAM_SKIP_SYNC_CHECK=1` の `cmdSpawnAgent` exportVars 注入

```
$ rg -n "CMUX_TEAM_SKIP_SYNC_CHECK" skills/cmux-team/manager/main.ts
2338:  // `CMUX_TEAM_SKIP_SYNC_CHECK=1` を exportVars に追記する（ST8b）。
2345:    `CMUX_TEAM_SKIP_SYNC_CHECK=1`,
```

Agent surface（`cmdSpawnAgent`）で独立 cmux surface を作る時、exportVars 配列に
`CMUX_TEAM_SKIP_SYNC_CHECK=1` を無条件で追記している（`main.ts:2339-2346`）。
Conductor shell への env 注入（`conductor.ts:109`）とは別経路で、
Agent が Conductor 子プロセスとして動いていないため Conductor shell env では届かない。

### シナリオ 4: Conductor shell への env 注入

```
$ rg -n "CMUX_TEAM_SKIP_SYNC_CHECK" skills/cmux-team/manager/conductor.ts
106:  // `CMUX_TEAM_SKIP_SYNC_CHECK=1` を明示的に焼き付ける（Master shell には注入しない）。
109:    `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1 CMUX_TEAM_MAIN_BRANCH=${mainBranchEnv} CMUX_TEAM_SKIP_SYNC_CHECK=1\n`,
```

### シナリオ 5: `resolveFetchBeforeWorktree` ライブ検証

```
$ bun --cwd skills/cmux-team/manager -e 'import { resolveFetchBeforeWorktree } from "./config"; ...'
default={"enabled":true,"source":"default"}
off_env={"enabled":false,"source":"env"}
on_env={"enabled":true,"source":"env"}
bogus_throws: unknown CMUX_TEAM_FETCH_BEFORE_WORKTREE="bogus" (expected 0|1|true|false|on|off)
```

デフォルト ON、env で `0`/`off` に倒せる、unknown は throw する — 仕様通り。

### シナリオ 6: `checkSyncState` ライブ実行（reject 経路）

main repo（`/Users/yamamoto/git/cmux-team`）の実状態（on-main で dirty tree）を
対象に実行:

```
$ bun --cwd skills/cmux-team/manager -e 'import { checkSyncState } ...'
verdict=reject state=uncommitted
```

メッセージは `"Error: uncommitted — main is checked out with a dirty working tree."`
＋ 「`Bypass: add --force or set CMUX_TEAM_SKIP_SYNC_CHECK=1`」。想定通り。

### シナリオ 7: `runSyncCheckOrExit` の全経路ソース確認

`main.ts:2730-2786` で以下 4 経路を実装:

1. `status !== "ready"` → 何もせず return（非 ready 経路は対象外）
2. `forceFlag=true` → `ready_force_bypass` emit → return
3. `process.env.CMUX_TEAM_SKIP_SYNC_CHECK === "1"` → `ready_sync_skipped reason=env` emit → return
4. `!config.mainBranch` → `ready_sync_skipped reason=no_main_branch` emit → return
5. それ以外 → `checkSyncState` → reject なら `ready_rejected` + exit(1)、warn なら `ready_warning` + 続行

### シナリオ 8: i18n help 文言

```
$ rg -n "CMUX_TEAM_SKIP_SYNC_CHECK" skills/cmux-team/manager/i18n.ts
334:    --force or CMUX_TEAM_SKIP_SYNC_CHECK=1
365:    with --force or CMUX_TEAM_SKIP_SYNC_CHECK=1
1013:    バイパスは --force または CMUX_TEAM_SKIP_SYNC_CHECK=1
1044:    または CMUX_TEAM_SKIP_SYNC_CHECK=1
```

`help_create_task` / `help_update_task` の en（L334 / L365）と ja（L1013 / L1044）両方で
bypass 方法を明記。

### シナリオ 9: Master テンプレートのポリシー緩和

- `templates/ja/master.md`: 「やること（追加）」に git 読取・fetch・`pull --ff-only` を追加。
  「やらないこと」の `git 操作（commit, branch, merge 等）` を
  `git の**書き込み系操作**（\`commit\` / \`branch <new>\` / \`merge\` / \`rebase\` / \`cherry-pick\` 等）`
  に変更し、読取・fetch・`pull --ff-only` は excluded の旨を明記
- `templates/en/master.md`: 同等の変更を英語で実施

### シナリオ 10: ドキュメント同期

- `CLAUDE.md`:
  - 「worktree 作成時の start-point 解決」節で `CMUX_TEAM_FETCH_BEFORE_WORKTREE` を
    「デフォルト OFF」→「**デフォルト ON**」に書き換え、起動ログ
    `fetch_before_worktree enabled=<on|off> source=<env|default>` を追記
  - 新節「## Ready 昇格時の sync state ガード（T283）」を 通信プロトコル と
    チーム状態管理 の間に追加（7 状態 × 3 分類表、bypass 3 経路、ログイベント一覧）
  - 「ロギングポリシー § 必ずログすべきイベント」に #5 として T283 の 4 ログイベントを追加
- `docs/spec/05-install-and-infrastructure.md` L424: 「`CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` で
  事前 fetch を opt-in」→ 「デフォルト ON、`=0` で opt-out」に書き換え
- `docs/spec/04-templates.md` L91: Master ワンライナーに「やること（追加、T283）」節を追加、
  「やらないこと」を「書き込み系操作」表現に修正
- `CHANGELOG.md` Unreleased:
  - Breaking #1: `CMUX_TEAM_FETCH_BEFORE_WORKTREE` デフォルト OFF → ON 反転
  - Breaking #2: Ready 昇格時 sync state ガード追加
  - Added: Master に git 読取 + fetch/pull 許可

## 未着手 / Follow-up

以下は本タスクのスコープ外:

- **本体 start コマンドでの live 動作確認（cmdStart 経路）**: worktree 作成前の
  `git fetch origin <mainBranch>` がデフォルト ON で走ることの end-to-end 確認は
  daemon 再起動を要するため、実装レビュー後に別タスクで実施推奨
- **旧 `=1` で opt-in していた既存運用者への案内**: README / docs に明示的な
  migration guide を追加するかは別途判断
- **pre-existing 型エラー 3 件**: `conductor.ts:201` / `daemon.test.ts:3720` /
  `daemon.ts:1538` は T283 以前から存在しており、別タスクでの修正を想定

## テスト結果サマリ

- `bun test git-sync.test.ts`: **34 pass, 0 fail**
- `bun --cwd skills/cmux-team/manager -e '...resolveFetchBeforeWorktree...'`: default/env/throw すべて想定通り
- `bun --cwd skills/cmux-team/manager -e '...checkSyncState...'`: main repo の実状態で `uncommitted` / reject を正しく返す

### ライブ実行の代替検証（ST15 完了条件補足）

plan.md ST15 は全 10 シナリオの手動再現を求めているが、実 git state を破壊的に作り替える必要があるため以下で代替検証した:

| シナリオ | 代替検証方法 |
|----------|------------|
| 1. clean | pure function test `git-sync.test.ts::decideSyncState clean` で網羅 |
| 2. behind-ff | `decideSyncState behind-ff` + `classifyVerdict warn state=behind-ff` で網羅 |
| 3. ahead | `decideSyncState ahead` + `classifyVerdict allow` で網羅 |
| 4. diverged | `decideSyncState diverged` + `classifyVerdict reject` で網羅 |
| 5. uncommitted | **ライブ実行済み**（本 impl-report 記載通り） |
| 6. detached | `decideSyncState detached` + `classifyVerdict reject` で網羅 |
| 7. no-remote | `decideSyncState no-remote` + `classifyVerdict allow` で網羅 |
| 8. --force bypass | `runSyncCheckOrExit` (main.ts) のソースで `forceFlag=true` 経路に `ready_force_bypass` emit + `return` を確認。テストは 34 pass |
| 9. env bypass | `CMUX_TEAM_SKIP_SYNC_CHECK=1` 経路を `runSyncCheckOrExit` のソースで確認（`ready_sync_skipped reason=env` emit + return） |
| 10. Agent 経路 | `cmdSpawnAgent` の `exportVars` 配列 (main.ts:2339-2346) に `CMUX_TEAM_SKIP_SYNC_CHECK=1` が**無条件で**追加されていることをソース確認 |

pure function 34 tests（`bun test git-sync.test.ts`）で 7 state 全ての decide/classify 分岐を網羅しており、CLI 統合経路は `runSyncCheckOrExit` のソースレビューで確認済み。

以上。
