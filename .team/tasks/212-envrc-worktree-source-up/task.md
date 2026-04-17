---
id: 212
title: .envrc 依存をオプション化し worktree source_up 生成を削除
priority: medium
created_at: 2026-04-15T16:55:24.219Z
---

## タスク
# 背景

現在 `CMUX_CLAUDE_HOOKS_DISABLED=1` を Agent/Conductor まで伝播させる経路が **3 層に重複**している:

1. `envrc-prompt.ts` — 親 `.envrc` への対話追記（direnv 経由で load）
2. `conductor.ts:348-370` — worktree の `.envrc` に `source_up` を生成 + `direnv allow`
3. `main.ts:2644,2807` / `conductor.ts:107` — spawn 時 `cmux send 'export CMUX_CLAUDE_HOOKS_DISABLED=1\n'`

3 つとも目的は同じ（cmux wrapper の auto-hook 注入を抑制）。シングルソースに統一する。

# 方針

- **`.envrc` 依存は optional**（`claude` 直接起動時の親切機能として `envrc-prompt.ts` は残す）
- **`CMUX_CLAUDE_HOOKS_DISABLED` は spawn 時に Master/Conductor/Agent 各々で explicit export**（authoritative mechanism）
- **worktree への `source_up` 生成は削除**（冗長）

# 削除対象

## `skills/cmux-team/manager/conductor.ts`

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

- 関連する未使用 import があれば削除

# 保持するもの（変更しない）

| 箇所 | 理由 |
|---|---|
| `main.ts:2644` `export CMUX_SURFACE=${...} CMUX_CLAUDE_HOOKS_DISABLED=1\n` (spawn-agent) | Agent shell に env を確実に渡す |
| `main.ts:2807` 同上 | 同上 |
| `conductor.ts:107` 同上 | Conductor shell 起動直後に env 設定 |
| `main.ts:1368,1454,1499` `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` | daemon / cmdConductor / cmdResume / cmdLaunchMaster プロセス自身 |
| `main.ts:1659` `CMUX_CLAUDE_HOOKS_DISABLED=1` (spawn env リスト) | spawn-master 経由の env 注入 |
| `envrc-prompt.ts` 全体 | `claude` 直接起動ユーザー向け親切機能として残す |
| `bin/postinstall.js` などの install 系 | 影響なし |

# ドキュメント更新

## `docs/spec/05-install-and-infrastructure.md`

- **L40** — `.envrc` 追記が必須前提だった記述を "`claude` 直接起動時の optional な親切機能" に書き直し
- **L387** — `envrcHookPromptSkipped` の位置付けを optional 側に
- **L396** — `.envrc` 追記フローの文脈を "optional, cmux-team spawn には不要" に

## `CLAUDE.md`

- `.envrc` / `direnv` 依存に関する記述があれば optional と明記（該当箇所を grep で確認）

## `.team/artifacts/A007-cmux-sidebar-status-api.md`

- L108 の記述（"Conductor/Agent spawn 時にこの環境変数を設定"）は現状どおりだが、source_up 経路が消えたことを補足しても良い（任意）

# 検証項目

1. **Conductor 起動** — `.envrc` 無しのプロジェクトでも Conductor が正常起動し、`CMUX_CLAUDE_HOOKS_DISABLED=1` が shell に export されている（`cmux send 'env | grep CMUX_CLAUDE' ` で確認）
2. **Agent spawn** — worktree に `.envrc` が**生成されていない**こと（`ls .worktrees/*/`）
3. **Agent 実行時の env** — Agent shell で `CMUX_CLAUDE_HOOKS_DISABLED=1` が有効であること
4. **cmux サイドバー** — `claude_code` キーが自動上書きされないこと（cmux-team の管理するキーが残っていること）
5. **既存テスト** — `envrc-prompt.test.ts` は無変更で通ること（`envrc-prompt.ts` 自体は触らない）
6. **`rg 'source_up\|envrc_generated\|direnv allow' skills/`** で 0 件（テスト・ドキュメント除く）

# リスク

| リスク | 緩和策 |
|---|---|
| direnv でプロジェクト固有の他 env（API キー等）を worktree に期待しているケース | そもそも user の責務。README / CLAUDE.md で "worktree は親の env を自動継承しない" と明記する |
| 既存プロジェクトで worktree に生成された `.envrc` が残存する | 削除しても実害なし（source_up が解決できないだけ）。Conductor は `main.ts` 側の explicit export で動く |
| cmux new-surface での env inheritance が想定と異なる環境 | 既に `cmux send 'export ...\n'` で上書きしているので影響なし |

# T211 との関係

- 独立タスク。ファイル・概念とも被りなし
- T211 が `CMUX_SURFACE` を spawn 時 export 経由で期待する → T212 でも `cmux send ... export` は残すので影響なし
- 並行実行可能

# Phase

1. `conductor.ts` の該当ブロック削除（worktree `.envrc` 生成 + direnv allow）
2. 関連 import / ログ定義の cleanup
3. docs/spec / CLAUDE.md / artifacts の記述更新
4. 手動検証（検証項目 1-4）
5. rg で source_up / envrc_generated / direnv allow の残存確認
