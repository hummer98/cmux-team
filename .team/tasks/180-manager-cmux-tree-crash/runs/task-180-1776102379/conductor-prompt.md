# タスク割り当て

## タスク内容

---
id: 180
title: Manager: cmux tree タイムアウトを crash 判定から除外 + エラーログ強化
priority: high
created_at: 2026-04-13T17:11:35.210Z
---

## タスク
# 背景

2026-04-14 に KDG-discord-listner プロジェクトの surface:570 (Conductor, task-022) が**実際は稼働中にもかかわらず Manager が crash 判定**し、task-022 が誤って aborted になる事象が発生した。

## 時系列（~/git/KDG-discord-listner/.team/logs/manager.log）

| 時刻 | イベント |
|---|---|
| 01:34:59 | Conductor が task-022 開始 |
| 01:37-01:55 | Planner/Design-Reviewer 正常進行 |
| **01:56:56** | 初回 `monitor_tree_failed: Command failed: cmux tree --workspace workspace:4` |
| **01:57:28** | 3 連続失敗で `validate_surface_failed` → `conductor_disconnected kind=crashed` |
| 01:57-02:02 | 5 分間 `monitor_tree_failed` 連続。surface:597/598/599 も validation 巻き添え |
| **02:02:37** | disconnect_timeout (308s) → `task_aborted task_id=022 reason=disconnect_timeout` |
| 02:03:09 | `conductor_reset surface=surface:570` → team.json で idle に書き換え |
| **02:05:19** | **Conductor は生きており** surface:600 を Implementer として spawn（Phase 3 継続中） |

## 根本原因

Manager の `validateSurface()` は `cmux tree --workspace <ws>` の成功に依存している。cmux daemon が高負荷（8 ワークスペース並列）で応答遅延した際、

```
cmux tree タイムアウト → crash 判定 → 5 分後に task abort + conductor reset
```

**cmux daemon の一時的応答不能とプロセスクラッシュを区別できていない**のが設計上の欠陥。

## 副次的な問題: ログ情報不足

`skills/cmux-team/manager/daemon.ts:1013` の `monitor_tree_failed` ログは `e.message` のみ記録しており、CLAUDE.md 「ロギングポリシー」節の要件を満たしていない:

> cmux コマンド（`send`, `sendKey`, `tree` 等）の失敗は `log(\"error\", ...)` で記録する。**error オブジェクトに `stderr` / `stdout` が付いている場合は必ず detail に含める**

実ログ例（情報不足）:
```
[2026-04-14T01:56:56+09:00] monitor_tree_failed last_error=Command failed: cmux tree --workspace workspace:4
```

タイムアウトなのか、真のエラー応答なのか、停止なのか、`e.message` のみでは判別不能。別箇所（`resetConductor` 内）は `stderr=Error: Command timed out` まで含めており参考になる。

# タスクのゴール

1. **cmux コマンドのタイムアウトと真のエラーを区別**し、タイムアウトだけでは crash 判定しないようにする
2. **エラーログに stderr/stdout を含める**（CLAUDE.md 準拠）
3. 既存の crash 検出ロジック（プロセス消失・本物の surface 不在）は壊さない

# 調査してほしいこと（Agent 向け）

- `skills/cmux-team/manager/` 配下で cmux コマンド呼び出しをしている全箇所を洗い出す（`cmux.ts`, `daemon.ts` 等）
- どのエラーが「タイムアウト」で、どのエラーが「真の crash」かを判別する方法を設計する
  - cmux の exec ラッパーがタイムアウトを明確に示すエラーを返すかを確認（`stderr=Error: Command timed out` 等）
  - タイムアウト・一時的失敗と、プロセス消失・surface 消失を区別する基準を決める
- `validateSurface` / `monitorConductors` の判定ロジックをどう変えるか設計する
  - 例: タイムアウトは N 回連続で初めて disconnected 扱い、あるいは別ステータス `unresponsive` を導入
- `DISCONNECT_TIMEOUT_SEC=300` のままで良いか、タイムアウト中は経過時間をカウントしないべきか検討
- ログ強化: `formatExecError(e)` のようなヘルパーが既にあるか確認（`conductor.ts:358` で使用されている）し、全 cmux エラーログで一貫して使う

# 受け入れ基準

- cmux tree が一時的にタイムアウトしても、Conductor が実際に稼働中であれば task が aborted にならない
- `monitor_tree_failed` 等の cmux エラーログに stderr が含まれる
- 既存の正常系（本物の Conductor クラッシュを検出する）が壊れていない（テストまたは手動検証）
- CLAUDE.md 「ロギングポリシー」に沿ったログ出力になっている

# 参考ファイル

- `skills/cmux-team/manager/daemon.ts:1005-1020` (`monitorConductors` の tree 呼び出し)
- `skills/cmux-team/manager/daemon.ts:1001-1003` (`DISCONNECT_TIMEOUT_SEC`)
- `skills/cmux-team/manager/cmux.ts` (cmux コマンドラッパー)
- `skills/cmux-team/manager/conductor.ts:358, 496` (`formatExecError` 使用例)
- `CLAUDE.md` 「ロギングポリシー」節


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-180-1776102379` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-180-1776102379
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-180-1776102379/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/180-manager-cmux-tree-crash/runs/task-180-1776102379
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/180-manager-cmux-tree-crash/runs/task-180-1776102379/summary.md` に書き出す。

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
