# T213 Implementation Report

- Task: Conductor のマージ先ブランチを `.team/config.json` で設定可能にする
- Run: task-213-1776272738
- Branch: task-213-1776272738/task
- Worktree: /Users/yamamoto/git/cmux-team/.worktrees/task-213-1776272738
- Plan: plan.md (Revision History v2, Approved by design-reviewer round 2)

## 変更ファイル一覧

### 実装（manager/）

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `MainBranchSource`（`"config" \| "detected" \| "fallback"`）と `MainBranchResolution` 型を追加 |
| `skills/cmux-team/manager/main-branch.ts` | **新規** — `resolveMainBranch(projectRoot, opts)` と `persistMainBranch(projectRoot, branch)` を提供。`opts.git` で DI 可能 |
| `skills/cmux-team/manager/main.ts` | `TeamConfig.mainBranch?: string` 追加。`cmdStart` で `resolveMainBranch` → `persistMainBranch`（source が `config` 以外のとき）→ `log("main_branch_resolved", ...)` → `createDaemon` → `state.mainBranch = ...` の順に初期化。`cmdConductor` で env > config > `"main"` の 3 段フォールバックで `mainBranch` を解決し `generateConductorRolePrompt(PROJECT_ROOT, mainBranch)` に渡す |
| `skills/cmux-team/manager/daemon.ts` | `DaemonState` に `mainBranch: string` を追加。`createDaemon` は `mainBranch: "main"` で初期化。`initializeLayout` から `initializeConductorSlots(..., state.mainBranch)`、tick ループから `assignTask(..., state.mainBranch)` を渡すよう変更 |
| `skills/cmux-team/manager/conductor.ts` | `launchConductor(...opts: { resumeTaskId?; mainBranch? })` を追加。セッション開始直後に `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1 CMUX_TEAM_MAIN_BRANCH=<mainBranch>` を送信。`initializeConductorSlots(..., mainBranch = "main")` / `assignTask(..., mainBranch = "main")` を追加（デフォルト引数で既存テスト互換を維持） |
| `skills/cmux-team/manager/template.ts` | `generateConductorRolePrompt(projectRoot, mainBranch)` を追加し `{{MAIN_BRANCH}}` を置換。`generateConductorTaskPrompt` に optional 9 番目引数 `mainBranch` を追加し、`{{MAIN_BRANCH}}` と（baseBranch 未指定時の）`{{BASE_BRANCH}}` のフォールバックに使用 |

### テンプレート（templates/）

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/templates/ja/conductor-role.md` | placeholder 注記ブロックで `{{PROJECT_ROOT}}` と `{{MAIN_BRANCH}}` を許可リストに追加。禁止事項「main ブランチで作業する」→「{{MAIN_BRANCH}} ブランチで作業する」 |
| `skills/cmux-team/templates/en/conductor-role.md` | 同上（英語版） |
| `skills/cmux-team/templates/ja/conductor-task.md` | 「main ブランチに直接変更を加えてはならない。」→「{{MAIN_BRANCH}} ブランチに直接変更を加えてはならない。」 |
| `skills/cmux-team/templates/en/conductor-task.md` | 「Do not make changes directly on the main branch.」→「Do not make changes directly on the {{MAIN_BRANCH}} branch.」 |
| `skills/cmux-team/templates/ja/inspector.md` | L51 付近の `git diff main...HEAD` を runtime bash 検出 (`BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \| sed 's\|refs/remotes/origin/\|\|' \|\| echo main)`) に変更。placeholder を使わずランタイム検出を選択した理由: inspector プロンプトはテンプレート変数を持たない手順書的構造を維持するため |
| `skills/cmux-team/templates/en/inspector.md` | 同上 |

### ドキュメント

| ファイル | 変更概要 |
|---------|---------|
| `CLAUDE.md` | Conductor 変数テーブルに `{{MAIN_BRANCH}}` 行を追加。レイアウト戦略セクションの直後に「プロジェクト設定（.team/config.json）」セクションを追加（`mainBranch` の 3 段優先順位 env > config > fallback、起動時の解決ロジック、`main_branch_resolved` ログの記述） |
| `docs/spec/04-templates.md` | `conductor.md` を **deprecated** マーク付けに変更。`conductor-task.md` の変数列に `{{BASE_BRANCH}}, {{MAIN_BRANCH}}` を追加。`conductor-role.md` の変数列に `{{MAIN_BRANCH}}` を追加。変数一覧テーブルの `{{BASE_BRANCH}}` 説明を「`config.mainBranch` → 検出値 → `"main"`」にし、`{{MAIN_BRANCH}}` 行を新規追加 |

## 追加したテスト

### `skills/cmux-team/manager/main-branch.test.ts`（10 ケース、全 pass）

- `config` が空でなければ source=`config` でそのまま返す
- `config` が空文字 / 空白のみなら fallthrough
- `origin/HEAD` 検出成功 → source=`detected`
- `origin/HEAD` が想定外フォーマットなら HEAD 短縮名にフォールバック
- `origin/HEAD` 失敗 → `HEAD` 短縮名で `detected`
- 両方失敗 → `"main"` で source=`fallback`
- `persistMainBranch`: 新規 `.team/config.json` 作成
- `persistMainBranch`: 既存フィールド（`layout`, `autoUpdate` 等）を保持して `mainBranch` だけマージ
- `persistMainBranch`: 壊れた JSON を空オブジェクトとして扱い上書き
- DI（`opts.git`）経由でテスト可能

## テスト結果

- `bun test`（worktree ルート、全 15 ファイル）: **293 pass / 0 fail** / 608 expect() 呼び出し / 9.13s
- `bunx tsc --noEmit`（manager ディレクトリ）: **exit 0、型エラーなし**
- 既存テスト（`conductor.test.ts` / `daemon.test.ts` / `template.test.ts` / `envrc-prompt.test.ts` など）は変更なしで全 pass

## 設計判断

1. **belt-and-suspenders for race 防止**（plan §3.1）: `cmdStart` の初期化順を固定（resolveMainBranch → persistMainBranch → `log("main_branch_resolved")` → `createDaemon` → `state.mainBranch = ...` → `initializeConductorSlots`）し、さらに `launchConductor` が `export CMUX_TEAM_MAIN_BRANCH=...` を送信する env 注入を併用。ファイル書き込みタイミングと Conductor 起動順に依存しないようにした
2. **`generateConductorTaskPrompt` の mainBranch は optional（デフォルト `"main"`）**: 既存 `daemon.test.ts` 等の呼び出しが 6 引数のため、後方互換のため optional 化。`{{BASE_BRANCH}}` 未指定時のフォールバックとしても使う
3. **`initializeConductorSlots` / `assignTask` の 4 引数目以降もデフォルト `"main"`**: 既存 `conductor.test.ts` の 3 引数呼び出しが多数あったため、関数シグネチャ変更の影響範囲を抑えるためデフォルト引数を採用
4. **inspector.md はランタイム bash で検出**（plan §3.3 / prompt 指示 #8）: inspector テンプレートはパス情報を持たない独立した手順書として設計されているため、`{{MAIN_BRANCH}}` を注入するより `git symbolic-ref refs/remotes/origin/HEAD` で実行時に取得する方がテンプレート設計上自然。フォールバックは `|| echo main`
5. **`conductor.md`（旧版）は触らない**（prompt 指示 #7）: 現行ランタイムは `conductor-role.md` + `conductor-task.md` を使用しており、`conductor.md` は歴史的リファレンス。`docs/spec/04-templates.md` に deprecated の注記を追加するにとどめた
6. **`persistMainBranch` は read-merge-write**: 既存 `envrc-prompt.ts:silenceInConfig` のパターンを踏襲し、`.team/config.json` 全体を読み・マージ・書き戻す。壊れた JSON でも空オブジェクトにフォールバックして上書きできるよう設計
7. **型エラー修正**: `main-branch.ts:51` の `m[1]` が TS strict で `string | undefined` と判定された（配列 index access の strict モード）。`if (m && m[1])` の 2 段ガードに修正

## 未解決事項

- なし。plan・prompt の全項目を実装済み。
- plan §5 のリスク項目（daemon 間 race、config 破損、Conductor spawn 失敗時の env 伝播）は belt-and-suspenders + 明示ログで抑止。運用上問題が顕在化した場合は別タスクで対応。

## 残タスク（プロンプト指示どおり未実施）

- commit / merge / worktree 削除は禁止指示に従い未実施（上位層が判断）
- `docs/spec/` の他ファイル（00–06）への波及確認は行っていない。04-templates.md のみ更新した

## ログ出力（確認用）

```
main_branch_resolved branch=<name> source=<config|detected|fallback>
main_branch_detect_failed step=origin_head stderr=<...>
main_branch_detect_failed step=head stderr=<...>
main_branch_fallback reason=git_detect_failed
main_branch_conductor_fallback reason=env_and_config_missing
```

実装は plan.md の方針に沿って完了。Inspection フェーズへ引き継ぐ。
