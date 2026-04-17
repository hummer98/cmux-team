# T225 完了サマリー

## 概要

`.envrc` が `direnv allow` されていない状態で `cmux-team start` / `cmux-team spawn-agent` が実行された際、認証経路が乱れる前に fail-fast で停止するチェックを追加した。

## 実装内容

### 新規ファイル

- `skills/cmux-team/manager/direnv-check.ts`
  - `export type DirenvAllowStatus = "ok" | "not_allowed" | "no_envrc" | "no_direnv"`
  - `checkDirenvAllowed(projectRoot, options?)`: `.envrc` 存在 + `direnv` バイナリ + `direnv status` parse で 4 値判定
  - `formatDirenvNotAllowedMessage(projectRoot)`: stderr に出すユーザー向けメッセージを生成
  - DI インターフェース `CheckDirenvOptions { which?, runDirenvStatus? }` でテスト差し替え可能
- `skills/cmux-team/manager/direnv-check.test.ts`
  - 8 ケース: no_envrc / no_direnv / ok / not_allowed / Found 行不在 / allowed 2（deny） / execFile throw / formatDirenvNotAllowedMessage 内容検証

### 変更ファイル

- `skills/cmux-team/manager/main.ts`
  - `import { checkDirenvAllowed, formatDirenvNotAllowedMessage } from "./direnv-check"` を追加
  - `cmdStart`: preflight 直後・`loadConfig` より前に fail-fast チェックを挿入
    - `not_allowed` → stderr + `log("direnv_not_allowed", "command=start")` + `exit 1`
    - `no_direnv` → `log("direnv_not_found", ...)` + `console.warn` で続行
    - `ok` / `no_envrc` → 続行
  - `cmdSpawnAgent`: 引数検証直後・`resolveProxyPort` より前に同等チェック
    - `not_allowed` → stderr + `log("direnv_not_allowed", "command=spawn-agent role=<role>")` + `exit 1`

## 重要な発見（plan からの変更点）

plan §3.6 は task.md の記述（`0 = 未 allow, 1 = allow 済み`）を想定していたが、
**実測で値マッピングが逆**であることが判明:

| 状態 | Found RC allowed |
|---|---|
| `direnv allow` 実行後 | **0** |
| 未 allow | **1** |
| `direnv deny` 実行後 | **2** |

さらに `Loaded RC allowed` は direnv hook が現シェルに統合されていない場合
常に 0 を返すため判定用に使えない。判定は `Found RC allowed` を使い、
**N = 0 のみ "ok"、それ以外は全て "not_allowed"**（fail-closed）。

この実測結果は `direnv-check.ts` 冒頭のコメントに記録済み。

## テスト結果

```
$ bun test skills/cmux-team/manager/direnv-check.test.ts
 8 pass / 0 fail / 12 expect() calls

$ bun test
 387 pass / 0 fail / 831 expect() calls

$ bunx tsc --noEmit
(exit 0, clean)
```

既存 386 テスト + 新規 8 テストで 387 件全て pass。

## Smoke test（Conductor 確認）

`direnv-check.ts` を直接呼んで動作確認:

- 親リポ（allow 済み） → `ok`
- worktree 直下（`.envrc` 無し） → `no_envrc`
- `formatDirenvNotAllowedMessage` → 期待どおり整形された日本語メッセージ（projectRoot 埋め込み）

## 検品結果

Inspector Agent による独立検品: **GO** 判定

- 機能要件 7 項目すべて充足
- 作業境界（plan §10: `envrc-prompt.ts` / `preflight.ts` 不干渉）遵守
- ロギングポリシー（CLAUDE.md）準拠
- 正規表現 `/^Found RC allowed\s+(-?\d+)\s*$/` で行頭・行末アンカー固定、`Loaded RC allowed` との部分一致事故なし
- Minor findings 4 件（いずれも blocker でなく scope 外の将来改善提案）

## 変更ファイル

- `skills/cmux-team/manager/direnv-check.ts` （新規）
- `skills/cmux-team/manager/direnv-check.test.ts` （新規）
- `skills/cmux-team/manager/main.ts` （+27 行）

## 成果物

- 計画書: `.team/tasks/225-.../runs/.../plan.md`
- 実装ノート: `.team/tasks/225-.../runs/.../impl-notes.md`
- 検品レポート: `.team/tasks/225-.../runs/.../inspection.md`
- このサマリー: `.team/tasks/225-.../runs/.../summary.md`
