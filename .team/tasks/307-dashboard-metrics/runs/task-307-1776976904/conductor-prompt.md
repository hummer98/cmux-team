# タスク割り当て

## タスク内容

---
id: 307
title: Dashboard に Metrics タブ追加（時系列 + ロール別 + バーンレート）
priority: medium
depends_on: [305]
created_by: surface:629
created_at: 2026-04-23T18:07:02.223Z
---

## タスク
## 背景

T305 の api_usage テーブルを可視化するため、dashboard TUI に Metrics タブを追加する。ユーザーが「cmux-team を使うとトークンを大量消費している気がする」という不安を、リアルタイムで数値化・可視化して解消する。

特にレート制限までの**バーンアウトレート**を見えるようにすることで、「このままいくと N 分でリミット到達」を判断できる状態にする。

## ゴール

dashboard に `m` キー等で遷移できる Metrics タブを追加。以下 3 領域をリアルタイム表示:

### 上段: Rate Limit 状況（バーンレート）

```
Tokens  [████████░░░░░░░░]  64,234 / 80,000  (rem 15,766)  reset in 2m 14s
Requests [█████████░░░░░░░]   45 / 50        (rem 5)      reset in 0m 32s

Burn rate (last 1 min): 1,240 tok/s
Projected to limit: 12 seconds  ⚠ RISK
```

- Anthropic rate limit ヘッダーの remaining / limit / reset から計算
- burn rate = 直近 N 秒の入出力トークン合計 / N
- リセットまで持つかを色分け（赤: リセット前にリミット到達 / 緑: 余裕あり）

### 中段: ロール別消費（累積 + 直近 N 分）

```
Role         Requests  Input     Output   Cache hit  Session total
master          120    34,567    5,432    82.3%      ████████░░
conductor        45    12,345      890    91.0%      ███░░░░░░░
agent           230    98,765    32,109   67.5%      ██████████
```

### 下段: タスク別消費ランキング（直近稼働 or 上位 N 件）

```
Task      Role breakdown                Total tokens  Cache hit
T305  conductor+agent (3 agents)       234,567        72.1%
T304  conductor                         45,678        85.0%
```

## 調査スコープ

- `skills/cmux-team/manager/dashboard.tsx`:
  - `activeTab` 型に `"metrics"` を追加（line 393 周辺）
  - `switchTab()` / キーバインド（line 1461 周辺）
  - 既存のタブレンダリング分岐（line 1346 周辺）
- データ取得: api_usage を定期 polling（dashboard の既存 tick と同期）
- burn rate 計算のウィンドウサイズ（60s or 300s）は実装者判断

## UX 論点（実装側で判断）

- 初期フォーカス: Metrics タブに入った瞬間何を見せるか（rate limit? ロール別?）
- 更新頻度: どの程度の interval で再集計するか
- 履歴スパン: dashboard に全期間集計は不要、直近 1h / セッション中のみで十分

## Out of scope

- Metrics 外部出力（CSV / JSON export）は本タスクでは不要
- 過去データの掘り下げ（深掘りドリル）は別タスクで

## 検証方法

- 実環境で複数タスクを並列実行し、バーンレートがそれらしく動くこと
- リミット近づいた際に色分けが発動すること
- 既存タブの挙動が regression していないこと

## 参考

- 先行調査: dashboard.tsx:393 にタブ型定義、1346-1359 に rendering 分岐、1461-1464 に switchTab


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-307-1776976904` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-307-1776976904
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-307-1776976904/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/307-dashboard-metrics/runs/task-307-1776976904
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/307-dashboard-metrics/runs/task-307-1776976904/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
