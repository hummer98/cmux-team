# T323 task run summary

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-323-1777102517`
branch: `task-323-1777102517/task`
verdict: Inspector GO（Critical 0 / Major 0 / Minor 3）

## 完了したサブタスク

| # | タスク | 状態 |
|---|--------|------|
| 1 | schema 拡張（`tokenHandle` + `AGENT_TOKEN_BOUND`） | done |
| 2 | `ANTHROPIC_CUSTOM_HEADERS` への `x-cmux-surface` 注入 + proxy 受信拡張 | done |
| 3 | `pool-next-reset.ts` 実装 | done |
| 4 | `pool-status-header.ts` 実装 | done |
| 5 | `pool-surface-row.ts` 実装 | done |
| 6 | `AGENT_TOKEN_BOUND` 経路の実装 | done |
| 7 | `proxy.ts` の handle 反映ロジック | done |
| 8 | `cmdStatus` への pool セクション統合 | done |
| 9 | `token-format.ts` 共通フォーマッタ抽出 | done |
| 10 | `cmux-team pool status` サブコマンド + routing | done |
| 11 | `i18n.ts` のヘルプ更新 | done |
| 12 | 全体 verify（bun test + tsc） | done |

## 変更ファイル

### 新規作成（10 ファイル）

- `skills/cmux-team/manager/pool-status-header.ts` + `.test.ts`
- `skills/cmux-team/manager/pool-surface-row.ts` + `.test.ts`
- `skills/cmux-team/manager/pool-next-reset.ts` + `.test.ts`
- `skills/cmux-team/manager/pool-cli.ts` + `.test.ts`
- `skills/cmux-team/manager/token-format.ts` + `.test.ts`

### 変更（10 ファイル）

- `skills/cmux-team/manager/schema.ts` / `schema.test.ts`
- `skills/cmux-team/manager/daemon.ts` / `daemon.test.ts`
- `skills/cmux-team/manager/main.ts` / `main.test.ts`
- `skills/cmux-team/manager/proxy.ts` / `proxy.test.ts`
- `skills/cmux-team/manager/token-cli.ts`
- `skills/cmux-team/manager/i18n.ts`

## テスト結果

- `bun test`: **1370 pass / 1 skip / 0 fail / 3249 expect()** (48 files)
- `bunx tsc --noEmit`: **EXIT 0**（touched files 型エラーゼロ）

## 設計上のハイライト

1. **observational path（R1 Option A）**: `ANTHROPIC_CUSTOM_HEADERS` に `x-cmux-surface: <surface>` を加えて proxy が surface ↔ handle を識別できるようにした。proxy は既存 `x-cmux-conductor-id` を legacy fallback として保持。
2. **AGENT_TOKEN_BOUND（R2.B）**: T244 race（surface 作成 → AGENT_SPAWNED → Claude 起動）を破壊しないため、`AGENT_SPAWNED` の位置・内容を一切変えず、`selectToken` 成功直後に独立した `AGENT_TOKEN_BOUND` メッセージを `postMessage` で送る方式を採用。
3. **token-format.ts 共通化**: `formatUtil` / `formatReset` / `formatSelectable` を `token-cli.ts` から抽出し、`pool-cli.ts` でも再利用（DRY）。
4. **OFF 時の既存レイアウト維持**: `isTokenPoolEnabled` が false なら従来出力を維持。新規 pool セクションは ON 時のみ。
5. **DB アクセス失敗フォールバック**: `cmdStatus` で tokens.db 読み取り失敗時は `(token pool read failed: <msg>)` 1 行 warning + 既存レイアウト。

## 残課題（Inspector minor 指摘）

- F1: `formatRelativeDuration` が `pool-status-header.ts` / `rate-limit-status.ts` / `proxy.ts` の 3 箇所に類似実装で並存。`time-format.ts` への共通化は別タスク（#175 等）扱い。
- F3: `updateTeamJson` の agents シリアライズに既存の `spawnedAt` / `taskTitle` 欠落あり（D14 でスコープ外宣言）。別タスクで一括補修。
- N3（implementer): 実環境での `ANTHROPIC_CUSTOM_HEADERS` カンマ併記の Claude Code 解釈は smoke 検証として残る。fallback 経路（`x-cmux-conductor-id` legacy + `(no token)` 表示）で動作維持される設計。

## 納品

- マージ先: `main`
- 方式: ローカルマージ（ff-only）
