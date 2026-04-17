# 実装計画: .envrc 依存をオプション化し worktree source_up 生成を削除

## 背景

現在 `CMUX_CLAUDE_HOOKS_DISABLED=1` を Agent/Conductor まで伝播させる経路が **3 層に重複**している:

1. `envrc-prompt.ts` — 親 `.envrc` への対話追記(direnv 経由で load)
2. `conductor.ts:348-370` — worktree の `.envrc` に `source_up` を生成 + `direnv allow`
3. `main.ts:2644,2807` / `conductor.ts:107` — spawn 時 `cmux send 'export CMUX_CLAUDE_HOOKS_DISABLED=1\n'`

3 つとも目的は同じ(cmux wrapper の auto-hook 注入を抑制)。シングルソースに統一する。

## 方針

- `.envrc` 依存は **optional**(`claude` 直接起動時の親切機能として `envrc-prompt.ts` は残す)
- `CMUX_CLAUDE_HOOKS_DISABLED` は spawn 時に Master/Conductor/Agent 各々で **explicit export** (authoritative mechanism)
- worktree への `source_up` 生成は **削除**(冗長)

## 削除対象

### `skills/cmux-team/manager/conductor.ts`

- **Lines 348-353**: worktree `.envrc` 生成ブロック
  ```ts
  const envrcSrc = join(projectRoot, '.envrc');
  if (existsSync(envrcSrc)) {
    writeFileSync(join(worktreePath, '.envrc'), 'source_up\n');
    await log("envrc_generated", `worktree=${worktreePath}`);
  }
  ```

- **Lines 362-370**: worktree `direnv allow` ブロック
  ```ts
  if (existsSync(join(worktreePath, ".envrc"))) {
    try {
      await execFile("direnv", ["allow"], { cwd: worktreePath });
      await log("direnv_allowed", `worktree=${worktreePath}`);
    } catch (e: any) {
      await log("error", `direnv allow failed: worktree=${worktreePath} ${formatExecError(e)}`);
    }
  }
  ```

- 関連する未使用 import があれば削除(例: `writeFileSync` が他で使われていなければ削除)

## 保持するもの(変更しない)

| 箇所 | 理由 |
|---|---|
| `main.ts:2644` `export CMUX_SURFACE=${...} CMUX_CLAUDE_HOOKS_DISABLED=1\n` (spawn-agent) | Agent shell に env を確実に渡す |
| `main.ts:2807` 同上 | 同上 |
| `conductor.ts:107` 同上 | Conductor shell 起動直後に env 設定 |
| `main.ts:1368,1454,1499` `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` | daemon / cmdConductor / cmdResume / cmdLaunchMaster プロセス自身 |
| `main.ts:1659` `CMUX_CLAUDE_HOOKS_DISABLED=1` (spawn env リスト) | spawn-master 経由の env 注入 |
| `envrc-prompt.ts` 全体 | `claude` 直接起動ユーザー向け親切機能として残す |
| `bin/postinstall.js` などの install 系 | 影響なし |

## ドキュメント更新

### `docs/spec/05-install-and-infrastructure.md`

- **L40** — `.envrc` 追記が必須前提だった記述を "`claude` 直接起動時の optional な親切機能" に書き直し
- **L387** — `envrcHookPromptSkipped` の位置付けを optional 側に
- **L396** — `.envrc` 追記フローの文脈を "optional, cmux-team spawn には不要" に

(行番号はあくまで目安。実際の記述箇所を grep で特定し、意図通りの箇所を修正すること)

### `CLAUDE.md`

- `.envrc` / `direnv` 依存に関する記述があれば optional と明記(該当箇所を grep で確認)

### `.team/artifacts/A007-cmux-sidebar-status-api.md`

- L108 の記述("Conductor/Agent spawn 時にこの環境変数を設定")は現状どおりだが、source_up 経路が消えたことを補足しても良い(任意)

## 検証項目

1. **Conductor 起動** — `.envrc` 無しのプロジェクトでも Conductor が正常起動し、`CMUX_CLAUDE_HOOKS_DISABLED=1` が shell に export されている(`cmux send 'env | grep CMUX_CLAUDE' ` で確認)
2. **Agent spawn** — worktree に `.envrc` が**生成されていない**こと(`ls .worktrees/*/`)
3. **Agent 実行時の env** — Agent shell で `CMUX_CLAUDE_HOOKS_DISABLED=1` が有効であること
4. **cmux サイドバー** — `claude_code` キーが自動上書きされないこと(cmux-team の管理するキーが残っていること)
5. **既存テスト** — `envrc-prompt.test.ts` は無変更で通ること(`envrc-prompt.ts` 自体は触らない)
6. **`rg 'source_up|envrc_generated|direnv allow' skills/`** で 0 件(テスト・ドキュメント除く)

## Phase(作業手順)

1. `conductor.ts` の該当ブロック削除(worktree `.envrc` 生成 + direnv allow)
2. 関連 import / ログ定義の cleanup
3. docs/spec / CLAUDE.md / artifacts の記述更新
4. worktree 内に残っている旧世代の `.envrc` ファイル(`source_up` だけ書かれたやつ)の削除 — 本 worktree にも残存しているので削除する
5. 型チェック / ビルドが通ることを確認(`npm run typecheck` または `bun run` 等、存在するコマンドのみ)
6. rg で source_up / envrc_generated / direnv allow の残存確認
7. summary.md に結果記載

## 作業境界(Implementer 向けの注意)

- worktree ルート: `/Users/yamamoto/git/cmux-team/.worktrees/task-212-1776272124`
- ブランチ: `task-212-1776272124/task`
- **実行時検証(検証項目 1-4)は Conductor が後段で行う**ので、Implementer は静的検証(typecheck / rg / ファイル編集)に集中する
- `package-lock.json` が既に modified 状態だが、これは worktree ブートストラップの副作用なので commit には含めても問題ない(最終判断は Conductor)
- `.envrc` や環境変数設定ファイル(`envrc-prompt.ts`)には一切触らない
