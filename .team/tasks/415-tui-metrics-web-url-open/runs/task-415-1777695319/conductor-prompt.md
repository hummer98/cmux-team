# タスク割り当て

## タスク内容

---
id: 415
title: TUI Metrics タブ縮小 + Web URL open キーバインド
priority: medium
depends_on: [414]
created_by: surface:586
created_at: 2026-05-02T02:23:12.359Z
---

## タスク
# 概要

T-1（T414）で実装した Web ダッシュボードに集計表示を寄せ、TUI Metrics タブは「今危険か」を即座に見るための最小構成に縮小する。

## 表示要素（縮小後）

- **Pool Tokens** テーブル（既存をそのまま）
- **Rate Limit projection**（5h / 7d）の risk badge を 1 行に詰める
- **Latest activity**: 最新 api_usage 行 1 行（role / surface / Ns ago）
- **Web URL 行**: `Open dashboard: http://127.0.0.1:NNNN`
  - URL は `team.json.dashboardServer.url` から読む
  - URL が無い（server 起動失敗）場合は `Web dashboard: not running`

## 削除する要素

- roleRows（Aggregated by role）テーブル → Web の Tokens ページへ移管済み
- taskRows（Aggregated by task）テーブル → Web の Tokens / Tasks ページへ移管済み
- `MetricsData.roleRows` / `taskRows` 自体はテストや今後の拡張に備え残すか削るかは Implementer 判断（現状の利用箇所を grep して決定）

## キーバインド

- Metrics タブ focus 中に **`o`** キーで `team.json.dashboardServer.url` を `open`（macOS）/ `xdg-open`（Linux）で起動
- URL 未取得時は no-op + 1 行 status メッセージ
- ヘルプテキスト（`ui.kbd("O") ui.text("open browser")`）を該当 focus area に追加

## i18n

- `metrics_open_browser_hint` / `metrics_url_not_running` 等を `i18n.ts` (ja / en) に追加
- 既存 i18n キーで未参照になるものは Implementer 判断で削除

## 検証

- TUI 起動 → Metrics タブで Pool / projection / latest activity / URL 行が表示
- `o` キーでブラウザが立ち上がり Web ダッシュボードが開く
- Web server 未起動の状態で `o` を押しても安全に no-op
- 既存 `dashboard-metrics.test.tsx` を縮小後の表示に合わせて更新
- bun test の per-file 実行ルールを遵守

## 関連

- 依存: T414（Web server 完成必須）
- spec: T414 で追加した `docs/spec/12-web-dashboard.md` の TUI 連携節を更新


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-415-1777695319` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-415-1777695319
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-415-1777695319/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/415-tui-metrics-web-url-open/runs/task-415-1777695319
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/415-tui-metrics-web-url-open/runs/task-415-1777695319/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
