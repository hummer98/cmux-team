# タスク割り当て

## タスク内容

---
id: 310
title: Metrics タブにスクロール機構を追加（下段が見えない問題）
priority: high
created_by: surface:969
created_at: 2026-04-24T08:18:24.145Z
---

## タスク
## 症状

dashboard の Metrics タブで画面下部が見切れる。タスク別ランキング（`metrics_section_task`）が特に影響を受ける。

## 原因

Metrics タブに scroll 機構が無い。`dashboard.tsx:1384-1385` で `buildMetricsRows(...)` の結果をそのまま渡しているだけで、journal/log のような scroll offset + slice 処理が無い。↑/↓ キーハンドラも未登録。

## 参考実装（journal / log）

- State: `journalScrollOffset` / `logScrollOffset`（`dashboard.tsx:412, 416`）+ 初期値 0（L1192, 1196）
- 描画: `reversed.slice(startIdx, endIdx)` で可視範囲のみ（L1370-1392）
- キーバインド: ↑/↓ で offset 増減（L1525-1531, 1556-1561）+ g/G で top/bottom（L1690-1705）
- 自動追従: `journalAutoScroll` / `logAutoScroll` で最新更新時に追従（L2033-2034）

## 変更方針

Metrics は逆順表示ではなく**固定レイアウト（caption → rate limit → unified → role → task）**なので、journal/log とは scroll 方向の意味が異なる。単純な top からの offset でよい:

1. **`AppState` に `metricsScrollOffset: number` を追加**（dashboard.tsx:427 付近、MetricsData の隣）
2. **`buildMetricsRows` の戻り値を slice**: `dashboard.tsx:1384-1385` を
   ```ts
   : state.activeTab === "metrics"
   ? (() => {
       const all = buildMetricsRows(state.metricsData, state.metricsError);
       const VISIBLE = METRICS_VISIBLE_LINES; // 既存の LOG_VISIBLE_LINES と同様の定数を新設
       const total = all.length;
       const startIdx = Math.min(state.metricsScrollOffset, Math.max(0, total - VISIBLE));
       return all.slice(startIdx, startIdx + VISIBLE);
     })()
   ```
3. **↑/↓ ハンドラ**: `focusedArea === "metrics"` で offset 増減（既存の journal/log 分岐に追加）
4. **g/G**: top = 0 / bottom = `max(0, total - VISIBLE)` に（journal/log と同じパターン）
5. **footer**: `focusedArea === "metrics"` の分岐（`dashboard.tsx:1458-1465`）に `ui.kbd("↑/↓") ui.text("scroll") ui.kbd("g/G") ui.text("top/bottom")` を追加
6. **metrics 定期更新（1s polling）で scroll offset を維持**: journal/log と違って Metrics は全体 rebuild なので、offset は維持するだけで追従不要（auto-scroll フラグは不要）

## 補足

- `METRICS_VISIBLE_LINES` の値はターミナル高さから動的算出するのが理想だが、既存 journal/log が定数で運用しているので同じ方針で定数でよい（適切な値を既存 2 者から見て決める）
- T309（統合セクション削除）が先に入ると行数が数行減るが、このタスクとは独立に進めてよい（競合しない）
- 統合セクションも scroll 対象に含まれるので merge 順は問わない

## 受け入れ条件

- Metrics タブで ↑/↓ でスクロールできる
- g で先頭、G で末尾にジャンプできる
- 画面下端にあっても role/task 別ランキングが全件見られる
- footer のキーヒントに scroll 操作が表示される
- `bun test` / typecheck 通過


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-310-1777018705` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-310-1777018705
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-310-1777018705/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/310-metrics/runs/task-310-1777018705
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/310-metrics/runs/task-310-1777018705/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
