# T349 実装ノート: token add/promote で rateLimitTier 由来 plan 解決失敗時の対話 prompt

## サマリー

`cmux-team token add` / `token promote` の登録経路で、`rateLimitTier` から plan が解決できない
場合（手動入力経路 / 未知 tier）に **登録確定前に plan を対話的に尋ねる prompt を追加**した。
plan が確定すれば `set-plan` での事後訂正は不要になる。

plan.md (Round 2 通過) §3 の設計判断に従って実装:

- §3.2: `PLAN_BY_NAME` 定数 + `resolvePlanForRegistration` / `promptManualPlan` helper を導入
  （`validPlans` は触らない）
- §3.3: 不正値は再入力ループ（exit 1 ではない）
- §3.4: `cmdTokenRotate` には変更を入れない
- §3.6.2: 未知 tier も prompt 対象（後者解釈）
- §3.6.1: rateLimitTier 行ログと空行の出力責務は helper に内包

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/token-cli.ts` | `PLAN_BY_NAME` / `resolvePlanForRegistration` / `promptManualPlan` helper 追加。`cmdTokenAdd` と `cmdTokenPromote` の plan 解決を helper 呼び出しに置き換え。`cmdTokenPromote` に `Found credential:` ブロックを追加。 |
| `skills/cmux-team/manager/token-cli.test.ts` | T1〜T4 / T5a / T6 の新規テスト追加。`organization_id 重複は exit 1` / `handle 重複は exit 1` / `manual 経路成功` / `R-promote-2` / `R-promote-8` / `R-promote-9` / `R-promote-10` の readline 回答列に plan prompt 用の空 Enter を 1 つ挿入。 |
| `docs/spec/09-token-pool.md` | `cmux-team token add` / `cmux-team token promote` セクションに新 prompt の挙動を追記（未知 tier も prompt 対象である旨を含む）。 |

## 追加テスト一覧

| ID | 内容 |
|---|---|
| T1 | source=2 + plan="max-x20" → DB plan=max-x20 / plan_ratio=20.0 |
| T2 | source=2 + 空 Enter → plan=unknown / plan_ratio=null。`organizationId:` 行と plan prompt 行の間に空行（`consoleLogs[i+1] === ""`）を assert。`rateLimitTier:` ログが出ていないことも assert |
| T3 | source=2 + "wrong-plan" → エラー → "max-x5" → plan=max-x5。`consoleErrors` が `pro / max-x5 / max-x20` を含む（部分一致） |
| T4 | source=1 + rateLimitTier=default_claude_max_20x → plan prompt が出ない（`consoleLogs` に `plan (pro / max-x5 / max-x20` が含まれないことを explicit に assert） |
| T6 | source=1 + rateLimitTier=default_claude_max_50x（未知 tier）→ plan prompt → "max-x20" で確定。`consoleLogs` に `default_claude_max_50x` が含まれない（未知 tier ログを出さない） |
| T5a | promote の source=2 + plan="max-x20" → plan=max-x20。Hint 文（`set-plan` / `Hint:`）が出ない |

## 検証コマンドの結果

### bun test

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-349-1777208453/skills/cmux-team/manager
$ bun test --timeout 30000 token-cli.test.ts
bun test v1.3.12 (700fc117)

 37 pass
 4 skip
 0 fail
 156 expect() calls
Ran 41 tests across 1 file. [191.00ms]
```

T1〜T6 の新規テスト + 既存改修テスト（manual 経路成功 / R-promote-2/8/9/10）含めて全 green。
set-plan 既存 3 テスト（unknown→max-x20 / 不正 plan exit 1 / 不存在 handle exit 1）も
無改造で全 pass。

### bunx tsc --noEmit

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-349-1777208453/skills/cmux-team/manager
$ bunx tsc --noEmit -p tsconfig.json
(no output)
```

型エラー 0 件。

## 設計上の細部

### `PLAN_BY_NAME` の non-null assertion

tsconfig.json で `noUncheckedIndexedAccess: true` のため `PLAN_MAP.default_claude_pro` は
`{...} | undefined` 型になる。`PLAN_BY_NAME` の各値は静的に存在することが
保証されているので `!` で narrow した。代替案（PLAN_BY_NAME に値を再記述する）よりも
plan.md §3.2 の「真実は PLAN_MAP に一本化」原則を維持する方が筋が良いと判断。

### `cmdTokenPromote` の `Found credential:` ブロック追加

既存の `cmdTokenPromote` は probe 後に `Found credential:` を出していなかったが、
plan.md §3.6.3 のレイアウト統一と helper 内のログ出力責務の都合で追加した。
これにより promote と add で UI が揃う。既存テストはこのブロックを
explicit に assert していないため影響なし。

### `cmdTokenRotate` は scope 外

plan.md §3.4 に従い rotate には変更を入れていない。rotate は auth_hash の更新専用で
plan / plan_ratio を扱わない設計（`set-plan` という専用コマンドが既に存在）。

## コミット計画

plan.md §6 に従い 2 コミット案:

1. `feat(token): plan prompt for unknown rateLimitTier (T349)` (token-cli.ts + token-cli.test.ts)
2. `docs(token): describe plan prompt behavior in 09-token-pool.md (T349)` (docs/spec/09-token-pool.md)

PR description には plan.md §3.4 / §3.6.2 / §3.2 の判断要約を記載する想定。
