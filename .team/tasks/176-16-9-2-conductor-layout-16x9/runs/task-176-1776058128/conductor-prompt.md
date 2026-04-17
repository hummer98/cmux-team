# タスク割り当て

## タスク内容

---
id: 176
title: 16:9 向け 2 Conductor レイアウトモードを追加（--layout=16x9）
priority: medium
created_at: 2026-04-13T05:28:23.184Z
---

## タスク
## 背景

現行 `cmux-team start` のレイアウトはウルトラワイド画面を前提とした固定 2x2（3 Conductor 構成）:

```
[Manager|Master] (1) | [Conductor-1] (2)
[Conductor-2]   (2)  | [Conductor-3] (2)
```

16:9 モニターではウルトラワイド向け配分だとペインが窮屈になるため、2 Conductor 構成の別モードを追加したい。

## 目的レイアウト（16x9 モード）

```
┌──────────────┐
│Manager|Master│   ← 上段フル幅（surface 2つが同一ペインにタブ同居）
├──────┬───────┤
│Cond-1│Cond-2 │   ← 下段を等幅で2分割
└──────┴───────┘
```

- ペイン数: 3（上段×1, 下段×2）
- surface 数: 4（Manager / Master / Conductor-1 / Conductor-2）
- maxConductors: 2

## 既存レイアウト（wide モード、デフォルト）

```
[Manager|Master] (1) | [Conductor-1] (2)
[Conductor-2]   (2)  | [Conductor-3] (2)
```

- ペイン数: 4
- surface 数: 5
- maxConductors: 3

## 切替方式

- **config.json の `layout` フィールド**（永続設定）
  - `"layout": "wide"` または `"layout": "16x9"`
  - 未設定時のデフォルトは `"wide"`（後方互換）
- **CLI フラグ `--layout=<mode>`**（一時的上書き）
  - `cmux-team start --layout=16x9` で config を無視して即時 16x9 起動
  - 値: `wide` | `16x9`

CLI フラグが指定されればそちらを優先、なければ config.json、それもなければ wide。

## 実装ポイント

### 1. 設定の解釈

- skills/cmux-team/manager/main.ts（`cmdStart` 相当）で `--layout` を parse
- config.json ローダ（`loadConfig`）で `layout` フィールドを読み取る
- DaemonState に layout モードと maxConductors を反映

### 2. レイアウト生成ロジック

- skills/cmux-team/manager/daemon.ts:`initializeConductorSlots` / skills/cmux-team/manager/conductor.ts の pane 分割処理
- wide: 現行ロジック維持
- 16x9: 上段フル幅 + 下段 2 分割（maxConductors=2）

### 3. maxConductors の可変化

- 現行は DaemonState の maxConductors（=3 固定）をベースに固定数。これを layout に応じて 2 / 3 に切り替える
- タスクキュー挙動（ready タスク割り当て）は maxConductors に依存しているため、2 モードでは 3 個目以降がキューイングされる

### 4. team.json への記録

- どのモードで起動したか `layout` フィールドを team.json に記録（デバッグ用）

## 検証方法

1. `cmux-team start --layout=16x9` で起動 → ペイン数 3・surface 数 4 を確認
2. cmux tree でレイアウトを目視確認
3. タスクを3個 ready にし、2個実行中・1個キュー待ちになることを確認
4. `cmux-team start`（フラグなし）でデフォルト wide モード起動を確認
5. config.json に `"layout": "16x9"` を書いて起動 → 16x9 が適用されることを確認
6. config.json に 16x9 を書きつつ `--layout=wide` を指定 → wide が適用されることを確認

## 関連ファイル

- skills/cmux-team/manager/main.ts（`cmdStart` / config 読み込み）
- skills/cmux-team/manager/daemon.ts（initializeConductorSlots, maxConductors）
- skills/cmux-team/manager/conductor.ts（createConductorPanes — pane 分割ロジック）
- skills/cmux-team/manager/schema.ts（config スキーマに layout フィールド追加）
- docs/spec/05-install-and-infrastructure.md（レイアウト節の更新）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-176-1776058128` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-176-1776058128
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-176-1776058128/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/176-16-9-2-conductor-layout-16x9/runs/task-176-1776058128
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/176-16-9-2-conductor-layout-16x9/runs/task-176-1776058128/summary.md` に書き出す。

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
