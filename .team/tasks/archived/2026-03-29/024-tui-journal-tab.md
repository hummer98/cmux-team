---
id: 24
title: TUI ジャーナルタブ + Conductor 完了報告
priority: high
status: ready
created_at: 2026-03-28T00:00:00Z
depends_on: [23]
---

## 概要

TUI のデフォルト表示をログからジャーナル（タスクライフサイクルの時系列）に変更し、タブ切り替えで詳細ログを見られるようにする。Conductor の完了報告をジャーナルに反映する仕組みも追加。

## 設計

### 1. TUI タブ切り替え

- **Tab 1: Journal（デフォルト）** — タスクのライフサイクルイベント
- **Tab 2: Log** — 現在の manager.log 末尾表示（既存）
- 切り替え: `1` / `2` キー、または `Tab` キー
- フッター: `1:journal  2:log  r:reload  q:quit  v2.x.x`

### 2. ジャーナル表示フォーマット

```
HH:MM [+] #ID タイトル                    ← タスク作成
HH:MM [▶] #ID conductor-xxx started       ← 処理開始
HH:MM [■] #ID conductor-xxx aborted       ← 中止
HH:MM [✓] #ID サマリー（1行）              ← 完了
```

ジャーナルのデータソース:
- `manager.log` から `task_received`, `conductor_started`, `task_completed` イベントを抽出
- 完了時のサマリーは後述の Conductor 完了報告から取得

### 3. Conductor 完了報告（タスクファイルへの追記）

Conductor テンプレートの「完了時の処理」に、タスクファイルへの Journal セクション追記を追加:

```markdown
## Journal

- summary: APIエンドポイントの調査完了、3つのスキーマを設計
- files_changed: 5
- tests: 12 passed, 0 failed
- duration: 14m
```

daemon はタスクを closed に移動する際にこのセクションを読み、ジャーナルに反映。

### 4. （オプション）Stop hook でのサマリー LLM

完了時 hook に haiku で 1 行サマリーを生成するステップを追加:
- `git diff --stat` + タスクタイトルを入力
- 1 行の日本語サマリーを出力
- `.team/tasks/open/NNN-*.md` の Journal セクションに追記
- コスト: haiku なので 1 タスクあたり数セント

**判断**: まず構造化セクション（LLM 不要）で実装し、サマリー LLM は後から追加可能にする。

## 完了条件

- [ ] TUI にタブ切り替え機能（1:journal / 2:log）
- [ ] ジャーナルがタスクライフサイクルを時系列表示
- [ ] Conductor テンプレートに Journal セクション追記手順を追加
- [ ] daemon がタスクファイルの Journal セクションを読んでジャーナルに反映
- [ ] フッターにタブ切り替えキーヒント表示
