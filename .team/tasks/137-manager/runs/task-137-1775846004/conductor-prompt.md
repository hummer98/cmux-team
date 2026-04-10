# タスク割り当て

## タスク内容

---
id: 137
title: Manager がサイドバーステータスをリアルタイム更新する
priority: medium
created_at: 2026-04-10T18:33:24.761Z
---

## タスク
## 背景

Conductor/Agent spawn 時に CMUX_CLAUDE_HOOKS_DISABLED=1 を設定し（T130）、claude_code キーの自動更新を無効化した。これにより Manager がサイドバーを完全制御できるようになった。

サイドバーはワークスペースを切り替えずにチラ見する場所なので、「今そっちに注意を向ける必要があるか」が一目でわかる信号機として機能させる。

## 仕様

状態遷移に応じて `cmux set-status` で `claude_code` キーを更新する:

| 状態 | 値 | アイコン (SF Symbols) | 色 | トリガー |
|------|-----|----------------------|-----|---------|
| タスク実行中 | `2 running` | `bolt.fill` | `#4C8DFF`（青） | Conductor に assignTask した時 |
| 待ちタスクあり | `2 running +3` | `bolt.fill` | `#4C8DFF`（青） | pending tasks > 0 |
| スロットリング | `⏸ reset 2h34m` | `pause.circle.fill` | `#FF3B30`（赤） | 5h utilization >= 閾値 |
| エラー/要対応 | `! attention` | `exclamationmark.triangle` | `#FF3B30`（赤） | Conductor disconnected 等 |
| 全タスク完了 | `done` | `checkmark.circle.fill` | `#34C759`（緑） | open tasks が 0 になった && 直前に running だった |
| アイドル | `idle` | `pause.circle.fill` | `#8E8E93`（グレー） | Conductor 全 idle && open tasks 0 |

## 実装方針

- daemon.ts の `tick()` 末尾、または `updateTeamJson()` と同じタイミングで状態を判定し `cmux set-status` を呼ぶ
- 前回の表示値をメモリに保持し、変化があった場合のみ `set-status` を呼ぶ（毎 tick の無駄な呼び出しを防ぐ）
- `--workspace` は `state.workspace` を使用
- リセット残り時間はフォーマット済み文字列（`2h34m` 等）を使う。dashboard.tsx の `formatResetRemaining()` を再利用可能
- cmux.ts にヘルパー関数 `setStatus(key, value, icon, color, workspace)` を追加

## 確認ポイント

- タスク実行開始 → running 表示に変わること
- タスク完了 → done 表示になること
- 全 idle → idle 表示になること
- スロットリング中 → reset 残り時間が表示されること
- ワークスペースを切り替えずにサイドバーで状態が見えること

## 参考

- A007: cmux サイドバーステータス API 仕様
- A008: cmux markdown viewer の対応状況


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-137-1775846004` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-137-1775846004
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-137-1775846004/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/137-manager/runs/task-137-1775846004
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/137-manager/runs/task-137-1775846004/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
