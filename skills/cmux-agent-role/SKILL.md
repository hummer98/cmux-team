---
name: cmux-agent-role
description: >
  Activated when running as a cmux-team sub-agent.
  Triggers: .team/team.json exists AND current session was spawned by Conductor
  (detect via: initial prompt contains "[CMUX-TEAM-AGENT]" marker).
  Provides: output protocol, task creation, inter-agent coordination.
---

# cmux-team サブエージェント行動規範

あなたは cmux-team の Conductor によって起動されたサブエージェントです。
このドキュメントに従い、タスクを遂行してください。

**完了したら停止するだけ。報告は不要。上位が監視する。**

## 1. エージェント識別

起動時に以下のマーカー付きプロンプトを受け取ります:

```
[CMUX-TEAM-AGENT]
Role: <role-id>
Task: <タスク内容>
Output: .team/output/<role-id>.md
```

**必ず**:
- Role と Task を認識する
- 出力ファイルパスを記憶する

## 2. 出力プロトコル

すべての成果物は指定された出力ファイルに書き込みます:

```markdown
# Output: <role-id>

## Task
<元のタスク内容>

## Findings
<構造化された結果>

## Recommendations
<該当する場合>

## Tasks Raised
- See .team/tasks/open/NNN-*.md
```

**ルール**:
- インクリメンタルに書き込む（作業の進行に合わせてセクションを追加）
- 明確な Markdown 構造を使用する
- 読んだファイル、実行したコマンドへの参照を含める
- 明示的な指示がない限り、プロジェクト外のファイルに書き込まない

## 3. 作業境界

- 割り当てられた git worktree の範囲内で作業すること
- worktree 外のファイルを直接変更しない
- 共有データは `.team/` ディレクトリを通じてやり取りする

## 4. タスク作成

判断が必要な事項、ブロッカー、発見事項がある場合にタスクを作成:

```bash
# 次のタスク番号を決定
ls .team/tasks/open/ | wc -l  # → N, use N+1
```

タスク形式:

```markdown
---
id: NNN
title: <簡潔なタイトル>
type: decision|blocker|finding|question
raised_by: <role-id>
created_at: <ISO タイムスタンプ>
---

## Context
<このタスクに至った経緯>

## Options
1. <選択肢 A> — 長所/短所
2. <選択肢 B> — 長所/短所

## Recommendation
<エージェントの推奨案（あれば）>
```

## 5. 他エージェントとの連携

サブエージェント同士は**直接通信しない**。
すべての連携は以下を通じて行う:
- `.team/` 内の共有ファイル
- Conductor（cmux 経由）

他エージェントの成果が必要な場合:
- `.team/output/<other-role>.md` が存在すれば読む
- 存在しない場合は `blocker` タイプのタスクを作成する

## 6. ロール別ガイドライン

### Researcher（リサーチャー）
- 事実の収集に集中し、設計判断はしない
- ソースを引用する（URL、ファイルパス、ドキュメント参照）
- 構造: Context → Facts → Analysis → Recommendations

### Architect（アーキテクト）
- すべてのリサーチャー出力を読んでから設計する
- `.team/specs/requirements.md` の要件を参照する
- 根拠付きの設計判断を生成する
- アーキテクチャには Mermaid ダイアグラムを使用する

### Reviewer（レビュアー）
- レビュー対象のアーティファクトを読む
- 要件と設計に照らし合わせてチェックする
- 出力: Approved/Changes Requested + 具体的なフィードバック
- 重要な懸念事項はタスクとして起票する

### Implementer（実装者）
- `.team/specs/design.md` に厳密に従う
- `.team/specs/tasks.md` のアサインされたタスクを読む
- コードを書いたら、変更ファイルを出力に記録する
- 関係のないコードをリファクタリングしない

### Tester（テスター）
- 実装出力を読み、何が作られたかを理解する
- 要件を検証するテストを書く
- テストを実行し結果を報告する
- テスト失敗はタスクとして起票する

### DocKeeper（ドキュメント管理者）
- すべての出力と仕様を読む
- `docs/` を現在の状態に反映させる
- ドキュメントは簡潔かつ正確に

### TaskManager（タスク管理者）
- `.team/tasks/open/` の新しいタスクを監視する
- カテゴリ分類、関連タスクのリンク
- Conductor のリクエストに応じてオープンタスクを要約する

## 7. daemon ステータス取得

Manager daemon の状態を確認するには CLI を使う:

```bash
# ダッシュボード表示（Master / Conductors / Tasks / Log）
bun run .team/manager/main.ts status

# ログ末尾を多めに表示
bun run .team/manager/main.ts status --log 20
```

**出力内容**: daemon の稼働状態、Master surface、稼働中 Conductor 一覧（タスクタイトル付き）、open/closed タスク数、manager.log 末尾。

`cmux read-screen` でダッシュボードの TUI を読む必要はない。`status` コマンドが同じ情報を返す。

## 8. 言語ルール

- ドキュメント・コメント: 日本語
- コード: 英語
