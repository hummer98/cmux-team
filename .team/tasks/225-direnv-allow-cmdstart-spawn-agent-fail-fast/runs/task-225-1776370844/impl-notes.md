# T225 実装ノート

## 実装したもの

### 新規ファイル

- `skills/cmux-team/manager/direnv-check.ts`
  - `DirenvAllowStatus` 型（ok / not_allowed / no_envrc / no_direnv）
  - `CheckDirenvOptions` interface（which / runDirenvStatus を DI）
  - `checkDirenvAllowed(projectRoot, options?)`: `direnv status` を実行し parse
  - `formatDirenvNotAllowedMessage(projectRoot)`: stderr 出力用メッセージ
- `skills/cmux-team/manager/direnv-check.test.ts`
  - 全 8 ケース（plan §6.3 + §6.4）: no_envrc / no_direnv / ok / not_allowed /
    Found 行不在 / allowed 2（deny） / execFile throw / formatDirenvNotAllowedMessage

### 変更ファイル

- `skills/cmux-team/manager/main.ts`
  - import 1 行追加（direnv-check）
  - `cmdStart`: preflight 直後・loadConfig より前に `checkDirenvAllowed` を挿入。
    `not_allowed` → stderr + `log("direnv_not_allowed", "command=start")` + exit 1。
    `no_direnv` → `log("direnv_not_found", ...)` + console.warn（既存挙動維持のため続行）。
  - `cmdSpawnAgent`: 引数検証直後・proxy 解決より前に `checkDirenvAllowed` を挿入。
    `not_allowed` → stderr + `log("direnv_not_allowed", "command=spawn-agent role=<role>")` + exit 1。
    no_direnv / no_envrc は続行（spawn-agent は警告を出さない）。

## plan からの変更点（重要）

**`direnv status` の値マッピングが plan §3.6 の想定と逆だった。**

plan §3.6 は task.md の記述（`Loaded RC allowed 0` = 未 allow、`1` = allow 済み）を
ベースに書かれていたが、実測（2026-04-17, macOS, direnv v2.x）で以下を確認:

| 状態 | Found RC allowed |
|---|---|
| `direnv allow` 実行後 | **0** |
| 未 allow（新規 .envrc） | **1** |
| `direnv deny` 実行後 | **2** |

さらに、`Loaded RC allowed` は direnv hook が現シェルに入っていない場合に
常に `0` を返すため、判定用としては信頼できない。
（cmux-team CLI は direnv 非統合の環境からも呼ばれうる）

**実装方針（確定）:**
- 判定行は `Found RC allowed <N>` を使う（Loaded ではない）
- `N = 0` のみ `"ok"`、それ以外（1/2/不明/行不在/execFile throw）は全て `"not_allowed"`（fail-closed）

この実測結果は `direnv-check.ts` の冒頭コメント（`=== direnv status の出力値 ===`）に
記録済み。

## 確認結果

### 型チェック

```
$ bunx tsc --noEmit
(clean — 0 errors)
```

### 単体テスト

```
$ bun test direnv-check.test.ts
 8 pass
 0 fail
 12 expect() calls
```

### 全体テスト

```
$ bun test
 387 pass
 0 fail
 831 expect() calls
```

既存テスト（386 件）を壊していないことを確認。

## 境界

- `envrc-prompt.ts` は触っていない（既存挙動を維持）
- `preflight.ts` に統合せず独立ファイルにした（plan §2 の通り、責務分離）
- 手動 E2E は Implementer 側では実施せず、Conductor に委ねる（プロンプト指示通り）
