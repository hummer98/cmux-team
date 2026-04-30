# T323 Inspector Report

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-323-1777102517`
branch: `task-323-1777102517/task`
inspector run: 2026-04-25T17:54Z

## Verdict: GO

Critical 0 件, Major 0 件, Minor 3 件 — 判定基準（Critical 0 件 AND Major 2 件以下）を満たす。

## Summary

T323「TUI pool capacity 表示 + `cmux-team pool status` サブコマンド」の実装は plan.md (rev 2) のサブタスク 1〜12 を完全に充足している。新規 5 ファイル＋テスト 5 ファイル、変更 8 ファイル（テスト 4 + 本体 4）が rev 2 計画書と完全一致。

- `bun test` 1370 pass / 1 skip / 0 fail / 3249 expect calls (48 files)
- `bunx tsc --noEmit` exit 0（touched files の型エラーゼロ）
- 7 つの仕様項目全て充足（手動検証済み）
- design-review-2 で指摘された 8 finding 全てが plan に反映され、実装でも遵守されている
- DRY 原則: `token-format.ts` が `token-cli.ts` と `pool-cli.ts` の双方から import されコピペ重複なし

特筆すべき設計判断（D2 / R2.B）として、AGENT_TOKEN_BOUND を AGENT_SPAWNED とは独立した第 2 メッセージとして実装することで T244 race（surface 作成 → AGENT_SPAWNED → Claude 起動）を破壊しない構造的解決を達成している。proxy.ts の handle 反映ロジックは agent role を skip して race を防止している。

## Findings

### F1 (minor): formatRelativeDuration の重複

`pool-status-header.ts:66-79` と `rate-limit-status.ts:95` に同一ロジックの `formatRelativeDuration` が並存する（更に `proxy.ts:212-228` の `formatResetRemaining` も類似実装）。plan §2.2 の「重複避けたい場合は time-format.ts 抽出を検討するが、本タスクスコープでは複製で許容」に従い、また proxy.ts の同関数は「別タスク（#175 等）で整理予定」とコメントで示されている。本タスクでは許容範囲。

**Recommendation**: 別タスク（#175 等）で `time-format.ts` への共通化を継続。

### F2 (minor): branch が main より 1 commit 遅れている

`merge-base main HEAD` = HEAD = `3816233`（T322）であり、main は `e4388a0`（T325 cherry-pick）が一段先行している。実装期間中に main へ T325 が cherry-pick されたため、納品時の rebase で以下が再導入される:

- `token-cli.test.ts`（667 行、cmdTokenList の integration テスト）
- `token-store.test.ts`（165 行、token-store API テスト）
- `token-store.ts`（D 系 API 45 行）

main の `token-cli.test.ts` は `cmdTokenList` の integration（console 出力検証）のみで `formatUtil/formatReset/formatSelectable` は直接 import していないため、rebase 後も import 切替（token-cli.ts の internal → token-format.ts への移譲）と矛盾しない見込み。本タスク実装内容の正当性には影響しないが、Conductor の「完了時の処理」Step 7-9 で rebase 実施が必要。

**Recommendation**: Conductor が main にマージする前に `git rebase origin/main` を実行し、conflict（あれば token-cli.ts の formatUtil/formatReset/formatSelectable 削除部分）を解決。rebase 後に再度 `bun test` / `bunx tsc --noEmit` を走らせて regress を確認。

### F3 (minor): agents シリアライズの spawnedAt / taskTitle 欠落（既存欠落）

plan D14 / design-review-2 §Finding #8 で本タスクスコープ外と明示されている既存の欠落。実装でも `updateTeamJson` の agents シリアライズで `spawnedAt` / `taskTitle` が出力されない（`tokenHandle` のみ追加）。`restoreConductorState` のフォールバック動作（`a.spawnedAt ?? new Date().toISOString()`）で顕在化していない。

**Recommendation**: 別タスクで agent シリアライズの欠落を一括補修。

## 検証コマンド出力

### tsc --noEmit
```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
EXIT 0 (0 lines)
```

### bun test (全体)
```
$ bun test
 1370 pass
 1 skip
 0 fail
 3249 expect() calls
Ran 1371 tests across 48 files. [54.25s]
```

### grep verifications (plan 完了条件)
```
$ grep -n "tokenHandle\|AGENT_TOKEN_BOUND\|AgentTokenBound" schema.ts | wc -l
10  (基準 ≥ 5)

$ grep -n "x-cmux-surface" main.ts proxy.ts | wc -l
6  (基準 ≥ 3)

$ grep -n "import.*token-format" token-cli.ts pool-cli.ts
pool-cli.ts:18:import { formatUtil, formatReset, formatSelectable } from "./token-format";
token-cli.ts:28:import { formatUtil, formatReset, formatSelectable } from "./token-format";

$ grep -n "cmux-team pool" i18n.ts | wc -l
4  (基準 ≥ 2)
```

### 仕様充足の手動検証（PROJECT_ROOT=/tmp/t323-inspect-{off,on}）

OFF (`CMUX_TEAM_TOKEN_POOL=0`):
```
cmux-team  STOPPED  PID 1  conductors 1  layout=wide
─ Master ────────────────────────────────────────────────────
  ◐ [100] running
─ Conductors 1 ────────────────────────────────────────────
  ● [200]  T123  test
─ Tasks ───────────────────────────────────────────────────
─ Rate Limit ──────────────────────────────────────────────
─ Log (last 10) ────────────────────────────────────────
```
→ token pool box 非表示、handle/util suffix 非付与、Agent 子行非表示。既存レイアウト維持を確認。

ON (`CMUX_TEAM_TOKEN_POOL=1`, team.json に tokenHandle 設定):
```
cmux-team  STOPPED  PID 1  conductors 1  layout=wide
┌─ token pool ─────────────────────────────────────────────┐
│ pool capacity: 0%                                        │
└──────────────────────────────────────────────────────────┘
─ Master ────────────────────────────────────────────────────
  ◐ [100] @kddi  <5h:--/7d:--%> running
─ Conductors 1 ────────────────────────────────────────────
  ● [200] @pers  <5h:--/7d:--%>  T123  test
      └ [201] @kddi  <5h:--/7d:--%> (implementer)
```
→ token pool box 表示、handle/util suffix 付与、Agent 子行が Conductor 配下に indent 表示（D5）。

`cmux-team pool status`:
- OFF → `pool 機能は無効です（CMUX_TEAM_TOKEN_POOL=1 / config / global yaml で有効化してください）。`
- ON / 未登録 → `(no tokens registered)`
- ON / 登録あり → ヘッダー + 各 token 行 + `pool capacity: X%`（pool-cli.test.ts でカバー）

### 構造的検証

- `case "pool"` switch routing: `main.ts:5265-5280` ✅
- per-surface settings.json: master/conductor/agent 3 経路全て `${surface}-{role}-settings.json` 命名 ✅
- ANTHROPIC_CUSTOM_HEADERS: master/conductor は `x-cmux-role: <role>, x-cmux-surface: <surface>` 形式（main.ts:1976, 2133）、agent のみ `x-cmux-role: agent` 単独（main.ts:2062） ✅
- proxy.ts:534 の優先順位: `x-cmux-surface` → `x-cmux-conductor-id` (legacy) → `opts?.conductorSurface` ✅
- AGENT_TOKEN_BOUND POST 位置: `selectToken` 成功直後・`exportVars.push(CLAUDE_CODE_OAUTH_TOKEN)` の直後・`cmux.send(surface, "export ...")` の前（main.ts:2686-2702）✅ T244 race 保護
- daemon の AGENT_TOKEN_BOUND ハンドラ: `findAgentBySurface` 風 inline 探索 + orphan 時 warning + state 変更なしフォールバック（daemon.ts:1479-1510）✅
- proxy.ts の `maybeApplyTokenHandle`: master/conductor は `tokenHandle !== handle` の差分検知でのみ更新、agent role は no-op（proxy.ts:169-199）✅

## Spec 充足チェック（タスク本文）

| 項目 | 状態 |
|------|------|
| pool 有効時に TUI ヘッダーに capacity が表示されること | ✅ ON 時に `pool capacity: 0%` 行表示確認 |
| handle が各 surface 行に表示されること | ✅ Master/Conductor/Agent 全行で `@kddi` / `@pers` 表示確認 |
| 5h > 80% のアカウントで ⚠ が表示されること | ✅ formatSurfaceRow.ts で UTIL5H_WARN=0.80 判定実装 + テスト |
| pool 無効時は追加表示がないこと（既存レイアウト維持） | ✅ OFF 時は token pool box / handle suffix / Agent 子行を一切出さないことを確認 |
| `cmux-team pool status` で全アカウント一覧が表示されること | ✅ pool-cli.test.ts で 3 ケース pass |
| `bun test` + `tsc --noEmit` が通ること | ✅ 1370 pass / EXIT 0 |

## 結論

T323 は plan.md (rev 2) の全サブタスクを充足し、design-review-2 で指摘された 8 finding 全てに対応済み、`bun test` 1370 pass / `tsc --noEmit` 0 error、7 つの仕様項目全てを手動検証で確認した。Major / Critical 級の問題なし。3 つの minor finding は全て本タスクスコープ外もしくは plan で許容済み。

**GO** 判定。Conductor は完了時の処理（rebase + merge）に進んで差し支えない。
