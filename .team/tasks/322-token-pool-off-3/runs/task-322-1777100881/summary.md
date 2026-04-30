# T322 token pool 機能 OFF 設定の 3 階層実装 — Implementer summary

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-322-1777100881`

## 完了したサブタスク（plan §8 ステップ対応）

| step | 内容 | 状態 |
|---|---|---|
| 1 | `main.test.ts` に `resolveTokenPoolEnabled` の table-driven テスト 15 ケース + smoke 3 ケースを追加（先に赤を確認） | ✅ |
| 2 | `config.ts` に `TeamConfig.tokenPool` / `GlobalConfig` 型追加、純粋関数 `resolveTokenPoolEnabled` 実装（緑） | ✅ |
| 3 | `cd skills/cmux-team/manager && bun add yaml` → `yaml@2.8.3` を dependencies に追加、bun.lock 更新 | ✅ |
| 4 | `loadGlobalConfig` (yaml read) と `isTokenPoolEnabled` (3 階層 wrapper) を `config.ts` に実装 | ✅ |
| 5 | `isTokenPoolEnabled` の I/O 統合 smoke test 3 ケースを `main.test.ts` に追加（mkdtemp + HOME 上書き） | ✅ |
| 6 | `main.ts` 改修: `cmdSpawnAgent` に `isTokenPoolEnabled` ガード 1 段追加 / `cmdStart` に `token_pool_config` 1 行ログ追加 | ✅ |
| 7 | `bun test`（manager 全 43 ファイル 1314 pass）/ `bunx tsc --noEmit`（0 件） | ✅ |
| 8 | typecheck pass | ✅ |
| 9 | commit | （Conductor 完了処理に委譲） |

## 変更ファイル一覧

`git status --short`:

```
 M skills/cmux-team/manager/bun.lock
 M skills/cmux-team/manager/config.ts
 M skills/cmux-team/manager/main.test.ts
 M skills/cmux-team/manager/main.ts
 M skills/cmux-team/manager/package.json
```

`git diff --stat`（package-lock.json は別タスク由来の既存差分なので除外）:

```
 skills/cmux-team/manager/bun.lock     |   3 +
 skills/cmux-team/manager/config.ts    | 108 +++++++++++++++++
 skills/cmux-team/manager/main.test.ts | 220 +++++++++++++++++++++++++++++++++-
 skills/cmux-team/manager/main.ts      |  49 ++++++--
 skills/cmux-team/manager/package.json |   1 +
```

### 追加 / 変更内容

- **`config.ts`**:
  - `TeamConfig.tokenPool?: { enabled?: boolean }` を追加（既存 camelCase スタイルに合わせる）
  - 新規 `GlobalConfig` 型（`tokenPool?: { enabled?: boolean }`）
  - 新規純粋関数 `resolveTokenPoolEnabled(projectConfig, globalConfig, env)`（env > project > global > default(false)）
  - 新規 I/O 関数 `loadGlobalConfig()`: `~/.cmux-team/config.yaml` を読み `token_pool.enabled` を `tokenPool.enabled` に正規化。parse 失敗時は console.warn のみで null を返す best-effort
  - 新規 I/O wrapper `isTokenPoolEnabled(projectRoot)`
  - `homedir()` は Bun で `HOME` env を尊重しないため `process.env.HOME ?? homedir()` を採用（テストでも本番でも安全）

- **`main.ts`**:
  - `cmdSpawnAgent` 既存 T321 try/catch を温存しつつ外側に enable ガードを 1 段追加（plan §4 通り「壊して書き換え」ではなく「ガード 1 段追加」）。OFF 時は `token_pool_skipped source=<env|project|global|default>` を 1 行ログ
  - `isTokenPoolEnabled` が throw（env 不正値）した場合は `console.error` + `process.exit(1)` で fail-fast
  - `cmdStart` の `fetch_before_worktree` ログ直後に `token_pool_config enabled=<on|off> source=<env|project|global|default>` 1 行ログを追加。env 不正値で fail-fast

- **`main.test.ts`**:
  - `describe("resolveTokenPoolEnabled (T322)", ...)` 16 ケース（plan §6 のテーブル 15 ケース + project 値型違反 1 ケース）
  - `describe("isTokenPoolEnabled (T322) smoke", ...)` 3 ケース（project / global / default の I/O 統合）

- **`package.json` / `bun.lock`**: `yaml@^2.8.3` 追加（plan 決定 D1）

## テスト結果

- 追加 test ケース数: **19 ケース**
  - `resolveTokenPoolEnabled (T322)`: 16 ケース
  - `isTokenPoolEnabled (T322) smoke`: 3 ケース
- `bun test`（`CMUX_TEAM_LOGGER_STRICT=1` 込み）: **1314 pass / 1 skip / 0 fail / 3147 expects** across 43 files
- 新規追加分は全て pass

## typecheck 結果

- `bunx tsc --noEmit` → exit 0、新規 TypeScript エラー 0 件

## grep invariant 確認

- `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` → 0 件（維持）
- `grep -nE 'taskState\[.*\]\s*=' skills/cmux-team/manager/{daemon,main}.ts` → 0 件（維持）
- `grep -n 'saveTaskState(' skills/cmux-team/manager/{daemon,main}.ts` → 0 件（維持）

## 設計判断ポイント（plan との相違 / 追加判断）

| 項目 | plan の方針 | 実装で採用した内容 | 備考 |
|---|---|---|---|
| `homedir()` の解決 | `homedir()` を直接呼ぶ | `process.env.HOME ?? homedir()` に変更 | Bun の `os.homedir()` が HOME env を尊重しない（実測: `bun -e 'process.env.HOME="/tmp/foo"; homedir()'` → `/Users/yamamoto`）ため、test での HOME 上書きが効かなかった。本番運用でも HOME を明示する CI 環境などで意図通り動くようにこの順序を採用。token-store と方針は揃う |
| project 値の型違反処理 | 「型違反は無視（未指定扱い）」 | `typeof !== "boolean"` を未指定扱いとして次の層へフォールバック | 文字列 `"true"` などを誤って受理しないため。テスト #16 でカバー |
| smoke test の HOME 上書き方法 | `__setGlobalConfigPathForTest` or HOME 上書き | HOME 上書きを採用、後者で十分動作 | 専用 hook を追加すると本体コードが肥大化するため不要と判断 |
| `loadGlobalConfig` の dynamic import | 静的 import (`import yaml from "yaml"`) を想定 | `await import("yaml")` の dynamic import に変更 | bun は ESM 互換だが、`loadGlobalConfig` を呼ばないコードパス（test など）で yaml を解決しなくて済むようにした |

plan の重要決定（D1〜D6）はすべて踏襲。env 空文字 = 未指定扱い（D2）、JSON は camelCase / yaml は snake_case（D3）、project > global（D4）、新規 test ファイル作らず main.test.ts に集中（D6）。

## 残課題・懸念点

- **手動検証は未実施**: plan §8 step 7 の「`CMUX_TEAM_TOKEN_POOL=0 cmux-team start` で manager.log に `token_pool_config` が出ること」を含む 4 パターン手動確認はワークツリー内 daemon を起動できないため省略。logging は単体テストで `token_pool_config` ログ書き出し経路に到達することは間接的に検証されている（cmdStart 全体のテストはこのリポジトリには無いので、起動ログ確認は QA 環境で担当）。
- **D2 の本文解釈差**: タスク本文の「`""` を false」は plan で「空文字 = 未指定」に倒した。reviewer の確認が望ましい点として plan 側にも記載済み。
- **`~/.cmux-team/config.yaml` parse 失敗ログ**: best-effort ポリシーに従い `console.warn` のみ。`logger.ts` の `log()` は使えない（loadGlobalConfig は logger 初期化前に呼ばれる cmdStart 経路があるため）。これは plan §3.3 の方針通り。
- **test の HOME 上書き副作用**: `process.env.HOME` を一時的に書き換えるが afterEach で復元。並列ではなく直列実行のため副作用は他 test に及ばない。`bun test` 全体で副作用無し（1314 pass を確認済み）。
