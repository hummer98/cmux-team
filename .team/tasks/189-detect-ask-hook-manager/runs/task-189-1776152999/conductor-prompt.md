# タスク割り当て

## タスク内容

---
id: 189
title: detect-ask を hook から Manager 分類に移行
priority: medium
created_at: 2026-04-14T07:48:53.587Z
---

## タスク
## 背景

T181 で導入した Agent/Conductor の Stop hook は、`.team/prompts/detect-ask.sh` (bash + jq) で transcript を分類し、SESSION_ASK / SESSION_IDLE / skip を判定している。実装は `skills/cmux-team/manager/main.ts` の `DETECT_ASK_SCRIPT` (約 80 行の embedded string)。

現状の問題:
- 分類ロジックが shell に閉じており、**ロギング/trace が manager.log に残らない**
- python3 fallback で `SURFACE="$SURFACE" python3 -c "..."` の順序誤りバグが T181 inspection で発見済み（fail-safe 経路だが類似バグが型では捕まらない）
- `DETECT_ASK_SCRIPT` が TypeScript の文字列リテラルで lint/type-check/test が効かない
- shell エスケープ回避のために `--from-stdin` を新設したのに、ディスパッチャ自体は shell のまま

## ゴール

分類を Manager (daemon) 側に寄せ、hook は単なる forwarder にする。

## やること（提案ベース、Agent が設計を詰める）

1. **Hook の簡素化**: `detect-ask.sh` は Stop hook payload (stdin) に `surface` / `conductorId` / `pid` を足して `cmux-team send --from-stdin` に横流しするだけにする（~10 行）。jq 依存・python3 fallback を撤去。
2. **新メッセージ型の追加**: `schema.ts` に `SessionStopMessage` 等を定義（raw payload + surface/conductorId/pid を含む）。
3. **Manager 側の分類ロジック**: `classifyStopPayload(payload)` のような純粋関数を新設し、transcript_path を読んで以下を判定:
   - Case A: `AskUserQuestion` tool_use あり → SESSION_ASK 相当
   - Case B: tool_use / tool_result が 0 かつ Agent → skip（独白扱い）
   - Case C: それ以外 → SESSION_IDLE 相当
4. **daemon への統合**: queue で `SessionStopMessage` を受けたら上記分類 → 既存の SESSION_ASK / SESSION_IDLE パスにディスパッチ。分類結果を `log("session_stop_classified", ...)` で記録。
5. **fail-safe**: transcript 読込失敗や JSON パース失敗時は SESSION_IDLE として扱う（現状の degrade 方針を維持）。
6. **unit test**: `classifyStopPayload` の 3 ケース + 異常系（transcript 欠損・JSON 破損）。
7. **テンプレート更新**: `generateAgentSettings` / `generateConductorSettings` の Stop hook command を新しい簡素化 shell に差し替え。
8. **後方互換**: Conductor は `CONDUCTOR_ID` envvar で区別している現仕様を踏襲（Agent は Case B で skip / Conductor は skip しない）。

## 非ゴール

- Conductor 側の AskUserQuestion 検出パス（PreToolUse hook の `detect-ask` 経路）は別議論。本タスクは Stop hook の分類のみを対象とする。ただし同じ分類関数を再利用できる設計にすること。
- hook の TypeScript 化自体（Bun を hook から起動する方向）はスコープ外。shell は残すが薄くする。

## 成功基準

- `bun test` 新規テスト含め pass
- `DETECT_ASK_SCRIPT` の行数が削減される（jq 分岐・python3 fallback が消える）
- `manager.log` に分類イベント（Case A/B/C）が記録される
- 既存の T181 race 防御（startedAt 比較 / 残骸 unlink）は壊さない

## 参考

- T181 実装: `skills/cmux-team/manager/main.ts:1001-1137` (DETECT_ASK_SCRIPT, ensureAskDetectorScript, generateAgentSettings, generateConductorSettings)
- T181 inspection (python3 fallback バグ): `.team/tasks/181-agent-await-agent/runs/task-181-1776143077/inspection.md`
- T181 plan §5 (分類ロジック設計): `.team/tasks/181-agent-await-agent/runs/task-181-1776143077/plan.md`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-189-1776152999` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-189-1776152999
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-189-1776152999/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/189-detect-ask-hook-manager/runs/task-189-1776152999
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/189-detect-ask-hook-manager/runs/task-189-1776152999/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
