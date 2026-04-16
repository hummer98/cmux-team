# T225 検品レポート

## 判定: GO

## サマリー

task.md の要件（`checkDirenvAllowed` 4 値判定 + `cmdStart` / `cmdSpawnAgent` への fail-fast 組込）は全て満たされており、全テスト（386 → 387, +8）pass、tsc clean。plan §3.6 との値マッピング乖離は Implementer が実測で検証・コメントに記録済みで合理的。作業境界（§10）も厳守されている。

## 機能要件の充足

- [x] `checkDirenvAllowed(projectRoot, options?)` が 4 値 (`ok` / `not_allowed` / `no_envrc` / `no_direnv`) を返す — `direnv-check.ts:45,69-102`
- [x] `.envrc` 無し → `no_envrc` — `direnv-check.ts:73-76`
- [x] direnv バイナリ無し → `no_direnv` — `direnv-check.ts:78-81`
- [x] `direnv status` parse による allow 判定 — `direnv-check.ts:58-67, 99-101`
- [x] `cmdStart` 冒頭でチェック（preflight 直後・`ensureEnvrcHookPrompt` より前）、`not_allowed` → stderr + exit 1、`no_direnv` → warning — `main.ts:337-350`
- [x] `cmdSpawnAgent` 冒頭でチェック（引数検証直後・`resolveProxyPort` / throttle ガードより前）、`not_allowed` → stderr + exit 1 — `main.ts:1833-1842`
- [x] テスト 4 分岐（no_envrc / no_direnv / ok / not_allowed）+ 追加 4 ケース — `direnv-check.test.ts:64-138`

## 実装品質

- **変更ファイル（想定通り）**: `skills/cmux-team/manager/direnv-check.ts`（新規）、`skills/cmux-team/manager/direnv-check.test.ts`（新規）、`skills/cmux-team/manager/main.ts`（+27 行）のみ。`envrc-prompt.ts` / `preflight.ts` への波及なし（plan §10 境界遵守）。
- **DI パターン**: `CheckDirenvOptions { which?, runDirenvStatus? }` が `preflight.ts` の `(b) => Bun.which(b)` DI パターンと整合。デフォルトは `Bun.which` / `execFile("direnv", ["status"])` で、テスト時のみ差し替え可能。
- **fail-closed 設計**: execFile throw → `not_allowed`（`direnv-check.ts:94-97`）、`Found RC allowed` 行不在 → `not_allowed`（`:99-101`）。allow=0 のみを "ok" とする安全側ロジックが一貫している。
- **ロギング**: `log("direnv_status_failed", formatExecError(e))`（`:95`）、`log("direnv_not_allowed", "command=start")`（`main.ts:344`）、`log("direnv_not_found", "command=start")`（`:348`）、`log("direnv_not_allowed", "command=spawn-agent role=${role}")`（`:1839`）— CLAUDE.md のロギングポリシー（event 名 + key=value）に準拠。`formatExecError` で stderr を含めており「原因追跡不能」ポリシーも OK。
- **正規表現の堅牢性**: `/^Found RC allowed\s+(-?\d+)\s*$/` で行頭・行末アンカー固定。`Loaded RC allowed` との部分一致事故なし（§5 セキュリティ項目の懸念をクリア）。
- **エラーメッセージ**: `formatDirenvNotAllowedMessage` は共通関数で cmdStart/spawn-agent 両方から再利用（plan §5.3 案 B 採用）。`❌` + インデント形式で `printPreflightIssues` のスタイルと揃っている。

## テスト結果

```
$ bun test skills/cmux-team/manager/direnv-check.test.ts
bun test v1.3.12 (700fc117)
 8 pass
 0 fail
 12 expect() calls
Ran 8 tests across 1 file. [22.00ms]

$ bun test
 387 pass
 0 fail
 831 expect() calls
Ran 387 tests across 18 files. [9.32s]

$ bunx tsc --noEmit
(clean — exit 0)
```

既存テスト 386 件を破壊せず、新規 8 件がすべて pass。

## direnv status 実測結果

現 worktree（`/Users/yamamoto/git/cmux-team/.worktrees/task-225-1776370844`）での実測:

```
$ direnv status
Loaded RC path /Users/yamamoto/git/cmux-team/.envrc
Loaded RC allowed 0
Found RC path /Users/yamamoto/git/cmux-team/.envrc
Found RC allowed 0
```

- 現 worktree の直下には `.envrc` が**存在しない**ため、`existsSync(join(projectRoot, ".envrc"))` が false を返し `"no_envrc"` で抜ける（worktree 上での `cmux-team start` は gating off）。
- 親リポジトリ `/Users/yamamoto/git/cmux-team/` は `direnv allow` 済みで `Found RC allowed 0`。もし PROJECT_ROOT がそちらだった場合 `"ok"` 判定になる。
- 実装の「allow=0 のみ ok、それ以外は not_allowed」が実測値（allow=0 / unallow=1 / deny=2）と正しく噛み合っている。
- `direnv-check.ts:11-34` の冒頭コメントに実測結果を記録済みで、将来の読者が迷わない。

impl-notes に書かれている plan §3.6 との「値が逆だった」乖離（task.md の `0=未 allow / 1=allow 済み` 想定 → 実測 `0=allow / 1=未 allow / 2=deny`）は合理的に説明・コードへ反映されており、fail-closed 方針と併せて安全性を担保している。

## Critical findings (NOGO の場合)

なし。

## Minor findings (参考)

1. **`cmdStart` の `no_direnv` warning 文言と `envrc-prompt.ts` のメッセージの統一**（plan §4.3 の将来課題として明記済み）: 現状 `cmdStart` の warning は `console.warn` 即時出力、`ensureEnvrcHookPrompt` は内部で warning を配列に push するスタイル。本タスクでは scope 外として明示的に切り分けられているが、将来的に `cmdStart` 側で warnings 集約リファクタを行うと一貫性が増す。
2. **`parseFoundRcAllowed` の複数行ヒット挙動**: `Found RC allowed` は `direnv status` に 1 回しか出ないため問題ないが、仕様として「最初にマッチした行の N を返す」という挙動はテストで固定していない。実用上は blocker ではない。
3. **worktree 直下に `.envrc` が無い場合の扱い**: 現 worktree では `no_envrc` で gating off になる。親リポの `.envrc` を参照したい場合は `direnv` の walk up 仕様に寄せる必要があるが、task.md は「projectRoot 直下の `.envrc`」を対象としているため仕様通り。plan §7 にもエッジケースとして記載済み（「本タスクでは projectRoot 直下の `.envrc` のみ対象」）。
4. **手動 E2E (`direnv allow` 前の `.envrc` で `cmux-team start` → exit 1)** は impl-notes に「Conductor に委ねる」と明記されており、本タスクの scope としては単体テストで担保。CLAUDE.md の機能テスト手順に従い、統合時に最終確認されれば十分。

## 結論

- 機能要件・実装品質・テスト・境界遵守のすべてを満たす。
- plan §3.6 との値マッピング乖離は Implementer が実測で検証し、コード冒頭コメントに記録、fail-closed 方針で安全側に倒しており合理的。
- **GO** 判定。このまま merge 可能。
