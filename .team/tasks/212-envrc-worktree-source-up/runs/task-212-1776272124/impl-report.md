# T212 Implementer Report

## 概要

`.envrc` 依存を optional 化し、worktree への `source_up` 生成経路を削除した。
`CMUX_CLAUDE_HOOKS_DISABLED=1` は spawn 時 explicit export に一本化済み。

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/conductor.ts` | worktree `.envrc` 生成ブロック + `direnv allow` ブロック削除、`writeFileSync` import 除去 |
| `docs/spec/05-install-and-infrastructure.md` | `.envrc` 記述を optional 化 (4 箇所) |
| `.team/artifacts/A007-cmux-sidebar-status-api.md` | L108: spawn 時 explicit export + T212 補足 |
| (worktree ルート) `.envrc` | 削除 (generated, untracked) |

差分サマリ (`git diff --stat HEAD`):
```
 .team/artifacts/A007-cmux-sidebar-status-api.md |  2 +-
 docs/spec/05-install-and-infrastructure.md      | 12 +++++++-----
 skills/cmux-team/manager/conductor.ts           | 19 +------------------
 3 files changed, 9 insertions(+), 24 deletions(-)
```

## 削除行数概算

- `conductor.ts`: -19 (import -1 + 生成ブロック -6 + direnv allow ブロック -9 + 空行 -3 相当、net +2 は import 差し替え分)
  - 削除ブロック本体: 15 行 (`.envrc` 生成 + `direnv allow`)
- `docs/spec/05-install-and-infrastructure.md`: +12 / -9 (optional 説明追記 + 既存文修正)
- `.team/artifacts/A007-cmux-sidebar-status-api.md`: +1 / -1

## 実行した検証

### 1. 静的 rg チェック
```
rg 'source_up|envrc_generated|direnv_allowed|direnv allow' skills/
  → .team/tasks/212-envrc-worktree-source-up/runs/task-212-1776272124/rg-check.txt
  → 32 行
```

残存は以下のみ (全て意図的、コード側からは削除済み):

| 箇所 | 種類 | 判断 |
|---|---|---|
| `skills/cmux-team/manager/envrc-prompt.ts` | optional な親切機能本体 | 触らない (task 指示) |
| `skills/cmux-team/manager/envrc-prompt.test.ts` | 上記のテスト | 触らない (task 指示) |
| `skills/cmux-team/manager/main.ts:1674` `cmux send 'direnv allow 2>/dev/null\n'` | Master spawn 時 worktree cd 直後、`.envrc` がユーザーの optional な場合に備える no-op-safe 呼び出し | 保持 (plan.md の保持対象扱い。2>/dev/null でエラー握りつぶし済み) |
| `skills/cmux-team/templates/{en,ja}/conductor.md:35` | Conductor prompt 内のコメント例示 (`direnv allow  # if .envrc exists`) | 保持 (コメント/ドキュメント、task 指示通り残存許容) |

`envrc_generated` / `direnv_allowed` イベント名は `conductor.ts` から削除済み。enum/型定義は存在しない (文字列直書きだった) ため他所参照なし。

### 2. 型チェック (tsc --noEmit)
```
cd skills/cmux-team/manager && bunx tsc --noEmit
→ exit=0 (エラーなし)
```

`package.json` に `typecheck` スクリプトは未定義だが、`tsconfig.json` がある manager ディレクトリで直接 `bunx tsc --noEmit` を実行して通過を確認。

### 3. worktree ルート `.envrc` 削除
```
rm .envrc && ls .envrc → No such file or directory
```

## 迷った判断

- **`main.ts:1674` の `direnv allow 2>/dev/null`**: plan.md の保持対象リストには明示されていないが、Master spawn 経路で `.envrc` が optional に存在する可能性 (`envrc-prompt.ts` で追記後のユーザー) に備える no-op-safe な呼び出しであり、`cmux-team` 自体が worktree に `.envrc` を生成する経路は消えても意味を失わない。範囲外として保持。
- **`templates/{en,ja}/conductor.md:35` のコメント**: Conductor への instruction 内で `.envrc` がある場合の手順例として残っているが、plan.md で言及なく、コメント/ドキュメントは残存許容のため触らなかった。必要なら後続タスクで optional 化の追記を検討。
