# タスク割り当て

## タスク内容

---
id: 414
title: 内部 Web ダッシュボード — Manager 同居 HTTP server + 5 ページ Metrics UI
priority: high
created_by: surface:586
created_at: 2026-05-02T02:22:37.396Z
---

## タスク
# 概要

TUI Metrics タブの集計表示は情報密度的に限界。Manager daemon に内部 HTTP server を同居させ、ブラウザで開く Web ダッシュボードを実装する。集計系は本タスクで Web に移管し、TUI 側の縮小は後続 T-2 で行う。

時間範囲は preset (1h / 24h / 7d / 30d) + free-form (datetime) で自由指定可能。

## 設計判断（前提）

- **ホスト先**: Manager daemon プロセス内に `Bun.serve` で同居（既存 proxy.ts と同手法）
- **listen**: `127.0.0.1` only — 外部 expose しない
- **port**: `Bun.serve({ port: 0 })` で ephemeral 取得し、`.team/team.json` の `dashboardServer.url` に書き出し（atomic write）。固定 port を取らないので衝突しない
- **配信**: 単一 HTML にインライン（CSS / JS / グラフライブラリ全部）。npm publish 時の bundle 不要
- **グラフ**: uPlot 推奨（軽量、time series 強い）。npm dep として追加するか単一バンドル直書きかは Implementer 判断
- **時間範囲**: URL クエリ `?from=ISO&to=ISO` を全 endpoint 共通で受け取り、permalink 可能にする
- **既存責務分担を踏襲**: trace-store.ts (SQL) / metrics-aggregate.ts (集計純粋関数) / 新設 web layer (HTTP routing + HTML)

## ページ構成

### Overview
- Throughput sparkline (day bucket): tasks_assigned / completed / aborted の積み上げ棒
- Tool failure rate sparkline (hour bucket)
- Tokens stacked area (hour bucket): input / output / cache_creation / cache_read
- Active tasks 数 + リンク
- Rate limit 5h / 7d projection の risk badge

### Tool Use
- Per-tool call count horizontal bar (Read / Edit / Bash / Grep / Glob / Write / TodoWrite ...)
- Per-tool failure rate テーブル — **Bash 強調**（即興スクリプト失敗の指標）
- Failure timeline line (2 系列: Bash / その他)
- Deny rate line (cmux-team Bash deny の頻度)
- Recent failures table 最新 20 件（task_id / tool / error 抜粋 1KB）

### Agent Strategy
- Per-task agent breakdown（直近 30 タスク、role × 起動回数の horizontal stacked bar）
- Strategy distribution（自動分類して円 or bar、分類規則は後述）
- Spawn timeline (day bucket × role の stacked area)
- Task drill-down: 1 task クリックで Conductor + Agent 起動・終了タイムライン

### Tokens
- Token timeline stacked area (input / output / cache_creation / cache_read 4 系列)
- Top tasks by tokens ranking top 20（**Conductor + Agent 込み** — T407 で結合済み）
- Per-role pie (Master / Conductor / Agent / Unknown)
- Distribution histogram (per-task token 分布、median / p95 / max)

### Tasks（横断テーブル）
列: `id / outcome / assigned_ts / duration_ms / tool_call_total / tool_failure_rate / tokens.{input,output,cache} / agent_count / time_to_first_edit_ms`
- sort / filter / CSV export
- 行クリックで Agent Strategy drill-down へジャンプ（URL hash で task_id 渡し）

## API endpoint

すべて GET、共通クエリ `?from=ISO&to=ISO` を受け取り。

| endpoint | 既存集計関数の流用 |
|---|---|
| `GET /api/health` | (新規、server ready / version / project root) |
| `GET /api/overview` | events.jsonl + hook_signals + api_usage + projection5h/7d |
| `GET /api/tool-use` | `countToolCallsByTask` / `failureRateByTask` / `denyRateByPeriod` を期間単位で集計 |
| `GET /api/agent-strategy` | task_sessions (`event='agent_spawned'`) を role 集計 |
| `GET /api/agent-strategy/:taskId` | task_sessions + events.jsonl で 1 task タイムライン |
| `GET /api/tokens` | `aggregateApiUsageByTask` / `aggregateApiUsageByRole` |
| `GET /api/tasks` | `aggregateMetricsByTask` + token JOIN |

既存集計関数を期間引数対応に拡張するか、新関数で wrap するかは Implementer 判断。`metrics-aggregate.ts` の SSOT を保つこと。

## Agent 戦略の自動分類

`task_sessions.event='agent_spawned'` を集約してカウントし、以下の決定木でラベル付与:

| ラベル | 条件 |
|---|---|
| `solo` | agent_spawned 0 件（Conductor のみ完結） |
| `research-only` | Researcher のみ |
| `plan-impl` | Planner ≥1 & Implementer ≥1（他 role なし） |
| `parallel-impl` | Implementer ≥2 |
| `full-cycle` | 4 role すべて起動 |
| `other` | 上記以外 |

> 注: この分類は**初版**であり、運用後に見直し可能。spec にも「将来見直し」と明記する。

## HTML / SPA

- 左サイドナビ: Overview / Tool Use / Agent Strategy / Tokens / Tasks
- 上部に時間範囲ピッカー（preset chip + custom datetime）
- 自動 refresh: 30s（ON/OFF トグル付き）
- task drill-down は URL hash で永続化

## docs/spec 追加

`docs/spec/12-web-dashboard.md` を新設（番号は連番の続き、確認の上で）:
- 起動経路と port 公開ルール
- listen address と security 方針
- API endpoint 一覧と response schema
- HTML ページ構成
- Agent 戦略分類規則（暫定であることを明記）
- TUI 連携（後続 T-2 で URL open）

`docs/spec/00-project-overview.md` および `docs/spec/glossary.md` から参照リンクを追加。CLAUDE.md にも 1 行追記する。

## 実装上の注意

- HTTP server は Manager daemon lifecycle に紐づける（startup で起動、shutdown でクローズ）
- listening port は `team.json.dashboardServer.url` に atomic write（fs.rename）
- 多重起動防止は不要（ephemeral port のため衝突しない）
- 既存の trace-store SQL を期間引数対応に拡張する場合、既存呼び出し側を壊さないこと（default 引数で後方互換）
- bun test の per-file 実行ルール（CLAUDE.md「既知の注意点」参照）を遵守

## 検証

- `cmux-team start` で server が立ち上がり、`team.json` に URL が記録される
- 127.0.0.1 以外からは接続できない
- ブラウザで開いて 5 ページすべてが表示される
- 時間範囲を変更すると全ページの数値が連動する
- 過去 task で Agent Strategy drill-down が機能する
- 既存 TUI Metrics タブは本タスクでは未変更（T-2 で縮小）

## 関連

- 後続: TUI Metrics タブ縮小 + URL open（T-2 で起票、本タスク closed 後に自動実行）
- spec: `docs/spec/11-metrics.md` の SSOT 構造を踏襲


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-414-1777688558` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-414-1777688558
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-414-1777688558/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/414-web-manager-http-server-5-metrics-ui/runs/task-414-1777688558
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/414-web-manager-http-server-5-metrics-ui/runs/task-414-1777688558/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
