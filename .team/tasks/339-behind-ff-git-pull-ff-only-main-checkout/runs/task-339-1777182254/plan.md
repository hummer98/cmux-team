# Plan: T339 behind-ff 時の自動 git pull --ff-only

## ゴール

`cmux-team create-task --status ready` / `update-task --status ready` で sync state が `behind-ff` と判定された場合、現在 `mainBranch` を checkout 中であれば PROJECT_ROOT で `git fetch` 済みの origin に対して `git pull --ff-only origin <mainBranch>` を **自動実行** し、成功すればそのまま昇格続行、失敗すれば reject（exit 1）にする。`--no-auto-pull` フラグで自動 pull を抑止し従来どおり警告のみで続行できるようにする。`headStatus` が `on-other-branch` / `detached` の場合は副作用を避けるため現状の `warn` 挙動を維持する。

## 設計判断

### A. Verdict 型拡張: 案 1（新 kind `auto-pull` を追加）を採用

```ts
export type Verdict =
  | { kind: "allow"; state: SyncState }
  | { kind: "warn"; state: SyncState; message: string }
  | { kind: "reject"; state: SyncState; message: string }
  | { kind: "auto-pull"; state: SyncState; mainBranch: string; message: string };
```

**理由:**
- 「自動修復が前提の状態」を独立した kind として表現でき、`runSyncCheckOrExit` 側の `switch (verdict.kind)` で網羅性を TypeScript に強制させられる（`default: never` チェックが効く）。
- 案 2 の「`warn` に flag を足す」は `verdict.kind === "warn"` が「警告だけ」と「副作用付き自動修復」の二義になり、`classifyVerdict` の純粋性（pure: state + facts → 表示用 verdict）が崩れる。
- pull 実行は副作用なので、verdict は「auto-pull したい」というシグナルだけを持ち、実 pull は `runSyncCheckOrExit` 側で行う（pure / impure 分離を崩さない）。

`message` フィールドは「auto-pull を試みる旨の事前ログ」と「pull 結果（Fast-forward N commits 等）」をまとめた文字列ではなく、**事前ログ用**として持たせる。pull 結果の文字列は `runAutoPull` の戻り値で別途扱う。

### B. headStatus の利用

`classifyVerdict` の `case "behind-ff"` を以下に変更:

```ts
case "behind-ff":
  if (facts.headStatus === "on-main") {
    return {
      kind: "auto-pull",
      state,
      mainBranch: mb,
      message: `info: local ${mb} is behind-ff origin/${mb}; auto-pulling with --ff-only`,
    };
  }
  return {
    kind: "warn",
    state,
    message:
      `warning: local ${mb} is behind-ff origin/${mb} (HEAD is ${facts.headStatus}, auto-pull skipped).\n` +
      `  Recommended: switch to ${mb} and run git pull --ff-only origin ${mb}`,
  };
```

`headStatus === "on-other-branch"` / `"detached"` のときに自動 pull しないのは、PROJECT_ROOT が `mainBranch` 以外を出している（= ユーザーが意図して他ブランチで作業中、または手作業中）ケースで `git pull` を勝手に走らせるとユーザー作業を破壊しかねないため。`detached` は別途 `decideSyncState` で `"detached"` state（reject）になるので実質発生しないが、防御的に分岐を残す。

### C. 自動 pull の実行: 関数名・配置

`git-sync.ts` に以下を追加:

```ts
export interface AutoPullResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 'Fast-forward' / 'Already up to date' を粗判定したラベル（ログ用、best-effort） */
  summary: "fast-forward" | "already-up-to-date" | "unknown";
}

export interface RunAutoPullOptions {
  mainBranch: string;
  /** テスト用の git コマンド注入（args → { stdout, stderr } を返す）。throw でコマンド失敗 */
  git?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export async function runAutoPull(
  projectRoot: string,
  opts: RunAutoPullOptions,
): Promise<AutoPullResult>;
```

- 内部で `git pull --ff-only origin <mainBranch>` を `execFile("git", ...)` で実行（`cwd: projectRoot`、timeout 30000ms = 既存 `collectSyncFacts` と一致）。
- 成功時: stdout に "Fast-forward" を含めば `summary: "fast-forward"`、"Already up to date" なら `"already-up-to-date"`、それ以外は `"unknown"`。
- 失敗時: `try/catch` で `{ ok: false, stdout, stderr }` を返す（throw しない）。`stderr` には git の標準エラー出力をそのまま入れる（CLAUDE.md「外部コマンド失敗時は stderr/stdout を必ず detail に含める」）。
- **テスト容易性のため `git` 注入インターフェースを既存 `collectSyncFacts` と揃える**（ただし戻り値は `{ stdout, stderr }` の構造体。`collectSyncFacts` 側の `(args) => Promise<string>` とは別の型）。

呼び出しは `runSyncCheckOrExit`（`main.ts`）内で行う:

```ts
if (result.verdict.kind === "auto-pull") {
  if (opts.noAutoPull) {
    await log("ready_warning", `phase=${opts.phase} state=${result.state}${taskIdField} reason=auto_pull_disabled`);
    console.warn(`warning: ${result.state} but --no-auto-pull set; auto-pull skipped`);
  } else {
    const { runAutoPull } = await import("./git-sync");
    console.log(result.verdict.message);
    const pull = await runAutoPull(PROJECT_ROOT, { mainBranch });
    if (pull.ok) {
      await log("ready_auto_pull_succeeded",
        `phase=${opts.phase} state=${result.state}${taskIdField} summary=${pull.summary}`);
      console.log(`[sync-check] auto-pulled origin/${mainBranch} (${pull.summary})`);
    } else {
      await log("ready_auto_pull_failed",
        `phase=${opts.phase} state=${result.state}${taskIdField} stderr=${pull.stderr.trim()}`);
      console.error(
        `Error: auto git pull --ff-only origin ${mainBranch} failed.\n` +
        `  stdout: ${pull.stdout.trim()}\n` +
        `  stderr: ${pull.stderr.trim()}\n\n` +
        `  Bypass: add --no-auto-pull (warn-only) or --force (skip sync check entirely)`
      );
      process.exit(1);
    }
  }
}
```

### D. CLI フラグ

`cmdCreateTask` / `cmdUpdateTask` の両方に `--no-auto-pull` を追加し、`runSyncCheckOrExit` の引数に `noAutoPull: boolean` を増やす:

```ts
await runSyncCheckOrExit({
  status,
  forceFlag: hasFlag("force"),
  skipFetch: hasFlag("skip-fetch"),
  noAutoPull: hasFlag("no-auto-pull"),
  phase: "create",
});
```

`i18n.ts` の help テキスト 4 箇所（`help_create_task` 英 / 日、`help_update_task` 英 / 日。L295-360 / L1090-1155 付近）に `--no-auto-pull` の説明を追加する。

`--force` 指定時は従来どおり sync check 全体を skip するため、`--force` と `--no-auto-pull` を同時指定しても `--force` が優先する（早期 return で auto-pull に到達しない）。これはドキュメントで明示する。

### E. 安全性

- **pull 時の cwd は PROJECT_ROOT** — Conductor 環境（worktree 配下）では `CMUX_TEAM_SKIP_SYNC_CHECK=1` が焼き付いているため `runSyncCheckOrExit` 自体が早期 return する。Master が PROJECT_ROOT 直下で `cmux-team create-task` を叩いた場合のみ自動 pull が発火する。
- **`headStatus === "on-main"` 限定** — 他ブランチ checkout 中は `warn` にフォールバック。Master が手元で feature ブランチを試している最中に勝手に pull が走るのを防ぐ。
- **`--ff-only` で破壊的でない** — diverged 状態に転落していれば git 側がエラーを返し、`{ ok: false }` 経由で `process.exit(1)` する。`decideSyncState` が `behind-ff` と判定した時点で `isLocalAncestorOfOrigin === true && !isOriginAncestorOfLocal` が成立しているので、`--ff-only` は理論上常に成功するが、collectSyncFacts と pull の間に他プロセスが local main を進めた等のレースで失敗しうる。その時は素直に reject。
- **fetch は collectSyncFacts で既に走っている** — `doFetch: !opts.skipFetch` で `git fetch --quiet origin <main>` 済み。pull 内で再 fetch すると二重通信になるので避ける（`--ff-only` は remote-tracking ref のみ参照するので問題なし）。
- **uncommitted on main の場合** — `decideSyncState` の優先順位で `"uncommitted"` が `"behind-ff"` より先に判定されるので、auto-pull 経路には来ない（既存の reject 経路で止まる）。

### F. ログ event 名

新規:
- `ready_auto_pull_succeeded` — phase / state / summary（fast-forward 等）
- `ready_auto_pull_failed` — phase / state / stderr 抜粋
- 既存 `ready_warning` の補助情報に `reason=auto_pull_disabled` / `reason=head_not_on_main` を付ける

## 変更ファイル一覧

- `skills/cmux-team/manager/git-sync.ts` — `Verdict` に `auto-pull` kind 追加、`classifyVerdict` の `behind-ff` 分岐を `headStatus` で出し分け、`runAutoPull` 関数を新設、`AutoPullResult` / `RunAutoPullOptions` 型を export。
- `skills/cmux-team/manager/main.ts` — `runSyncCheckOrExit` に `noAutoPull` 引数を追加し、`verdict.kind === "auto-pull"` 分岐を実装。`cmdCreateTask` / `cmdUpdateTask` で `hasFlag("no-auto-pull")` を渡す。
- `skills/cmux-team/manager/git-sync.test.ts` — 既存の `behind-ff → warn` 期待値を更新、新規 3 ケース（on-main / on-other-branch / detached）追加、`runAutoPull` 単体テストを追加（成功 / 失敗）。
- `skills/cmux-team/manager/i18n.ts` — `help_create_task` / `help_update_task` の英日 4 箇所に `--no-auto-pull` 説明と Notes 追記。
- `CLAUDE.md` — L196-204「Ready 昇格時の sync state ガード」セクションを書き換え（`behind-ff` の挙動を更新、`--no-auto-pull` を bypass の段に追加）。
- `docs/spec/05-install-and-infrastructure.md` / `docs/spec/07-state-machine.md` — Ready 昇格時の挙動が明示的に書かれている箇所があれば追従（先行 grep では具体的記述は無し。L422 で `git fetch --quiet origin <mainBranch>` の言及があるが auto-pull 自体の言及は無いので新規セクション追記が望ましい）。**実装中に grep で再確認**し、影響箇所があれば修正する。

## 実装手順（TDD）

1. **failing test を書く（git-sync.test.ts）:**
   - `classifyVerdict("behind-ff", { ...baseFacts, headStatus: "on-main" })` が `kind === "auto-pull"` かつ `mainBranch === "main"` を返すことを期待。
   - `classifyVerdict("behind-ff", { ...baseFacts, headStatus: "on-other-branch" })` が `kind === "warn"` を返すことを期待。
   - 既存 `behind-ff → warn + 推奨 git pull --ff-only` テスト（L179-186）を新仕様に合わせて分割し直す（baseFacts は `headStatus: "on-main"` なので、`auto-pull` を期待する形に書き換え）。
   - `classifyVerdict("behind-ff", { ...baseFacts, headStatus: "detached" })` が `kind === "warn"` を返すことを期待（防御）。

2. **git-sync.ts の `Verdict` 型と `classifyVerdict` を更新** — テストが pass するまで。網羅性チェックのため `runSyncCheckOrExit` 側の switch にもダミー分岐を追加（次ステップで本実装）。

3. **`runAutoPull` の failing test を書く:**
   - git stub に `["pull", "--ff-only", "origin", "main"]` への応答 `{ stdout: "Fast-forward\n ...", stderr: "" }` を設定 → `{ ok: true, summary: "fast-forward" }` を返す。
   - git stub が throw（`exitError` 風）→ `{ ok: false, stderr: "..." }` を返す。
   - "Already up to date." 応答 → `summary: "already-up-to-date"`。

4. **`runAutoPull` を実装** — テストが pass するまで。

5. **main.ts の `runSyncCheckOrExit` に auto-pull 分岐を実装** — まず compile を通す。`noAutoPull` 引数追加、`verdict.kind === "auto-pull"` 分岐、`runAutoPull` 呼び出し、log 出力、失敗時 exit 1。

6. **`cmdCreateTask` / `cmdUpdateTask` で `hasFlag("no-auto-pull")` を渡す。**

7. **i18n.ts の help テキスト 4 箇所に `--no-auto-pull` 追記。**

8. **CLAUDE.md の Ready 昇格セクションを更新。**

9. **docs/spec/ を grep で再確認し、影響箇所を更新。**

10. **個別 bun test 実行**（CLAUDE.md の禁忌「bun test 全体実行は禁忌」に従い、ファイル単位で実行）:
    ```bash
    cd skills/cmux-team/manager
    bun test --timeout 30000 git-sync.test.ts
    ```
    main.ts 周りのテストは既存テスト構造を確認の上、影響を受けるテストファイルを個別に回す。

11. **`bunx tsc --noEmit` で TS エラーが新規発生していないか確認。**

## テストケース（git-sync.test.ts に追加 / 更新）

**`classifyVerdict` describe 内:**
- ✏️ 更新: `behind-ff + on-main → auto-pull + mainBranch === "main"` （旧: `→ warn`）
- 追加: `behind-ff + on-other-branch → warn`
- 追加: `behind-ff + detached → warn`（防御）
- 追加: `mainBranch が develop の場合、auto-pull verdict の mainBranch === "develop"`

**新 describe `runAutoPull` (stub git):**
- 成功 + Fast-forward → `{ ok: true, summary: "fast-forward", stdout: "Fast-forward..." }`
- 成功 + Already up to date → `{ ok: true, summary: "already-up-to-date" }`
- 成功 + 不明な stdout → `{ ok: true, summary: "unknown" }`
- 失敗（git が throw） → `{ ok: false, stderr: "..." }`（process.exit はしない）

**範囲外（書かない）:**
- `runSyncCheckOrExit` の auto-pull 分岐の e2e — `main.ts` に既存テストファイルがある場合のみ追加。**実装時に `ls skills/cmux-team/manager/*.test.ts` で main.ts 系のテスト構造を確認**し、書きやすいなら追加、書きにくいなら手動 smoke で代替（理想を書きすぎない）。
- 実 git に対する pull 動作 — CI で副作用が出るため避ける。

## 検証手順

1. **個別ユニットテスト:**
   ```bash
   cd skills/cmux-team/manager
   bun test --timeout 30000 git-sync.test.ts
   ```
   全 pass。

2. **TypeScript 型チェック:**
   ```bash
   cd /Users/yamamoto/git/cmux-team/.worktrees/task-339-1777182254
   bunx tsc --noEmit -p skills/cmux-team/manager
   ```
   または既存 `package.json` の `tsc` スクリプトに従う。新規エラー 0 件。

3. **手動 smoke test 手順（PROJECT_ROOT で実施）:**

   **(a) behind-ff + on-main → auto-pull 成功:**
   ```bash
   # 別 worktree か別 clone で main を 1 commit 進めて push
   # 戻って PROJECT_ROOT の main を checkout
   git checkout main
   # local を意図的に 1 commit 戻して behind 状態にする
   git reset --hard HEAD~1
   # ready 昇格を試みる
   cmux-team create-task --title "smoke-339-ok" --status ready
   # 期待:
   #   "[sync-check] auto-pulled origin/main (fast-forward)" が出て exit 0
   #   タスクが ready 昇格成功
   ```

   **(b) behind-ff + on-main + --no-auto-pull → warn:**
   ```bash
   # 同じく behind 状態にして
   cmux-team create-task --title "smoke-339-noauto" --status ready --no-auto-pull
   # 期待:
   #   "warning: behind-ff but --no-auto-pull set; auto-pull skipped" が出る
   #   pull は実行されない（git log で確認）
   #   タスクは ready 昇格成功
   ```

   **(c) behind-ff + on-other-branch → warn:**
   ```bash
   # main を behind にした上で feature ブランチを切る
   git checkout -b smoke-339-feature
   cmux-team create-task --title "smoke-339-other" --status ready
   # 期待:
   #   warn メッセージに "auto-pull skipped" が含まれ、pull は実行されない
   #   タスクは ready 昇格成功
   ```

   **(d) Conductor 環境からの create-task は影響なし:**
   ```bash
   # cmux-team start で起動した Conductor 配下から create-task を叩いても
   # CMUX_TEAM_SKIP_SYNC_CHECK=1 で skip されるため auto-pull は発火しない
   # → manager.log に ready_sync_skipped reason=env が出ること
   ```

4. **既存テスト退行確認:** `git-sync.test.ts` の既存ケース（`detached` / `uncommitted` / `no-remote` / `clean` / `ahead` / `diverged`）が依然 pass すること。

## 安全性とロールバック

- **pull 失敗時:** `process.exit(1)` で reject。タスクは ready に昇格しない。Master は手動で `git fetch && git pull --ff-only origin <main>` を試すか、`--force` で sync check 自体を bypass する。
- **--ff-only で safety 保証:** local が origin の真に祖先でない場合、git 側がエラーで止まる（破壊なし）。
- **bypass 手段（優先順）:**
  1. `--force` — sync check 全体を skip。auto-pull も走らない。緊急避難用。
  2. `--no-auto-pull` — sync check 自体は走るが、auto-pull のみ抑止して warn にフォールバック。
  3. `CMUX_TEAM_SKIP_SYNC_CHECK=1` — 環境変数で全 skip（Conductor で焼き付け済み）。
- **ロールバック:** `Verdict` の `auto-pull` kind 削除 + `classifyVerdict` の `behind-ff` 分岐を warn 単一に戻す + `runAutoPull` 削除 + `main.ts` の auto-pull 分岐削除 で完全復元可能。CLI フラグ `--no-auto-pull` を残置しても害はない（参照されないだけ）。

## 範囲外

- feature branch 上で behind-ff → warn のまま。auto-pull は `on-main` 限定。
- `git pull --rebase` での自動修復（`diverged` 用）— task 339 のスコープ外。
- `--no-auto-pull` 環境変数版（`CMUX_TEAM_NO_AUTO_PULL=1` など）— 必要になった時点で別タスクで追加。
- 並行 pull のロック制御 — Master 1 surface からの create-task は逐次なので race は実用上発生しない。
- pull の進捗バー / 詳細出力の抑制 — `--quiet` を付けるかは実装時にエラー出力との兼ね合いで判断（提案: 付けない、stdout で「fast-forward」検出に使うため）。
