# T208 タスク完了サマリー

## 概要

`classifyStopPayload()` を `stop_reason` ベースの 2 択（ASK / IDLE）に縮退し、`SKIP(agent_monologue)` 判定を完全削除した。

旧コードは「最後の assistant 行に tool_use が無い ＝ まだモノローグ中」と推測していたが、Stop hook は `stop_reason === "end_turn"` 時にしか発火しないため前提自体が不成立。これにより A[191] 事例（Write 連打 → 最終ターン text-only 完了報告 → SKIP 判定で `await-agent` が永久ブロック）を修正。

## 完了したサブタスク

1. **Phase 1 Plan**: Planner Agent (surface:194) が plan.md を作成
2. **Phase 3 Implementation**: Implementer Agent (surface:197) が TDD で実装
3. **Phase 4 Inspection**: Inspector Agent (surface:201) が独立検証 → **GO**

## 変更ファイル一覧

| ファイル | 変更要点 |
|---------|---------|
| `skills/cmux-team/manager/classify-stop.ts` | `StopClassification` から `SKIP` バリアント削除、`ClassifyContext.isConductor` 削除、`toolCount` ロジック削除、docstring を T208 の意図に書き直し |
| `skills/cmux-team/manager/classify-stop.test.ts` | makeCtx から `isConductor` 引数削除、テスト #3 (旧 SKIP) 削除、#9b 期待値を IDLE に変更、#15 (Write 40 連打 → text-only IDLE) と #16 (空 content) を追加。16 件パス |
| `skills/cmux-team/manager/daemon.ts` | SESSION_STOP 分岐から `isConductor` ローカル変数・`is_conductor=`/`reason=` ログキー・`if (cls.kind === "SKIP") break` 削除 |
| `skills/cmux-team/manager/daemon.test.ts` | 旧「Agent / Case B (SKIP=monologue) → writeAgentDone 呼ばれない」を反転、A[191] integration テスト追加 |
| `skills/cmux-team/manager/schema.ts` | コメント `ASK/IDLE/SKIP` → `T189/T208 ... ASK/IDLE` |
| `skills/cmux-team/manager/main.ts` | コメント `分類（ASK/IDLE/SKIP）` → `分類（ASK/IDLE）` |

合計 6 ファイル変更、+111 / -64 行。

## テスト結果

```
$ cd skills/cmux-team/manager && bun test
274 pass / 0 fail / 557 expect() calls
Ran 274 tests across 14 files. [8.52s]

$ bunx tsc --noEmit -p tsconfig.json
（出力なし = pass）

$ rg -n 'agent_monologue|isConductor|is_conductor=' skills/cmux-team/manager
0 件

$ rg -n 'kind: "SKIP"' skills/cmux-team/manager
0 件
```

## A[191] 事例の修正の流れ

**修正前**:
```
Stop hook (text-only) → SESSION_STOP → classify=SKIP → break (副作用なし)
→ done マーカー書かれず → await-agent 永久ブロック
```

**修正後**:
```
Stop hook (text-only) → SESSION_STOP → classify=IDLE → SESSION_IDLE 合成
→ daemon.ts:1016-1035 の Agent 分岐 → writeAgentDone(status=completed)
→ await-agent が STATUS=completed で解放
```

## 設計上のポイント

- Stop hook の発火条件（`end_turn` のみ）が classifier の前提を決定するという根本的事実を踏まえ、推測ロジックを削除し型レベルで SKIP を消滅させた
- `cls.kind` の型が `"ASK" | "IDLE"` の 2 択になることで daemon.ts の `if (cls.kind === "SKIP")` は dead branch として TS 型エラー化し、削除漏れを防いだ
- A[191] 事例は classify-stop.test.ts の単体テスト（#15）と daemon.test.ts の統合テスト（40 件 tool_use + 最後 text-only）の双方でカバー

## マージコミット / PR URL

- ブランチコミット: `765654a fix(classify-stop): stop_reason ベースに置換し agent_monologue SKIP を削除 (T208)`
- マージコミット: `83c275f Merge branch 'task-208-1776244853/task' (T208 classify-stop stop_reason base)` (main)
- 納品方法: ローカルマージ（main）
