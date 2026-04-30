# T390 conflict-resolution

## Task run

- taskRunId: `task-390-1777531936`
- branch: `task-390-1777531936/task`
- rebase target: `main` (local main, ahead of origin/main)
- pre-rebase HEAD: `e9436e65329bf062e31f411bfa6f7ebfeb67e4b3`
- post-rebase HEAD: `dfaeed6`

## 衝突 commit

| 相手側 commit | タスク | 概要 |
|---|---|---|
| `e03e93f` | T391 | refactor(token-pool): claude-credentials を廃止し subscription source に置換 (Dear T340 401 起因) |

## 衝突ファイル別採用方針

### 1. `package-lock.json`

| 軸 | ours (HEAD = main 側 T391) | theirs (T390) |
|---|---|---|
| version | 4.20.0 | 4.19.0 |

**採用**: ours (4.20.0)。理由: T391 で v4.20.0 にリリースされた。T390 は worktree 作成時 (4.16.0) → npm install で 4.19.0 に進めただけの副次更新で、最終的に main と整合させるべき。意味的衝突なし。

### 2. `skills/cmux-team/manager/token-store.test.ts`

両側とも独立した describe block を末尾に追加していた:

- T391: `shouldInjectCredential`, `assertCanRetrieveFromKeychain` を import に追加。describe block 4 つ (`shouldInjectCredential` / `assertCanRetrieveFromKeychain` / `subscription source: organization_id / auth_hash NULL の扱い` / `schema migration (T391)`) を末尾に追加。
- T390: `computeEffUtil`, `STALE_THRESHOLD_MS` を import に追加。describe block 1 つ (`computeEffUtil (T390)`) を末尾に追加。

**採用**: 両方統合 (union)。

具体的な resolution:
- import block: 両方の symbol を含める (`shouldInjectCredential, assertCanRetrieveFromKeychain, computeEffUtil, STALE_THRESHOLD_MS`)
- 末尾の describe block: T391 のセクション → T390 のセクションの順で並べる
- conflict marker が `expect(...).toBe(true);` の途中で切れていた箇所 (T391 の最後の test、T390 の最後の test) はそれぞれ `});\n});` で閉じ括弧を補完

意味的衝突なし — 互いに別の関数をテストしているため両方とも保持する以外の選択肢なし。

## Resolution Strategy

両 commit は token-pool 関連の独立な機能追加 (T391: credential_source 整理 / T390: per-handle 表示の effUtil 化) で、touch するファイルが大半重複しないため union での統合が自然。共通する `token-store.ts` 本体は auto-merge で衝突なし、`token-store.test.ts` のみ末尾追加同士で衝突したが、両 describe block は独立しているため共存可能。

## Verification

| 検証項目 | 結果 |
|---|---|
| scope_violation 検知 | none (新 commit が touch したファイルは元 commit が touch したファイルのサブセット) |
| `bun test token-store.test.ts` | 154 pass / 1 skip / 0 fail (T391 migration test 含む) |
| `bun test token-format.test.ts` | 20 pass / 0 fail |
| `bun test pool-throttle.test.ts` | 31 pass / 0 fail |
| `bun test pool-summary.test.ts` | 12 pass / 0 fail |
| `bun test pool-header-display.test.ts` | 13 pass / 0 fail |
| `bun test pool-cli.test.ts` | 4 pass / 0 fail |
| `bun test token-cli.test.ts` | 39 pass / 9 skip / 0 fail |
| `bunx tsc --noEmit` | 新規エラー 0 / 既存エラー 0 |

## Iterations

1 回 (rebase 一発で 2 ファイルが unmerged になり、両方を解消して continue で完走)。
