---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "チーム体制を構築する（Master + Manager を spawn）"
---

# /cmux-team:start

cmux-team のチーム体制を構築してください。
Master と Manager を新しいペインに spawn し、ユーザーに Master ペインへの切り替えを案内します。

**重要: このコマンドを実行したセッション自身はどの層にもならない。ランチャーの役割のみ。**

## 手順

### Phase 0: インフラ準備（初回のみ）

`.team/` が存在しなければ作成する:

1. cmux 環境チェック (`CMUX_SOCKET_PATH`)
   - 設定されていなければエラー（cmux 内でのみ動作）
2. `.team/` ディレクトリ構造を作成:
   - team.json, status.json, specs/, output/, issues/open/, issues/closed/, tasks/, prompts/, docs-snapshot/
3. team.json 初期化（`architecture: "4-tier"`）
4. status.json 初期化（空状態）
5. `.team/.gitignore` 作成 (output/, prompts/, docs-snapshot/, status.json)
6. `.gitignore` に `.worktrees/` が含まれていなければ追加を提案

### Phase 1: Master 用プロンプトを生成

templates/common-header.md + templates/master.md からプロンプトを合成し、`.team/prompts/master.md` に書き出す。

※ templates/master.md が存在しない場合は、以下の内容で `.team/prompts/master.md` を直接生成する:

```markdown
# Master ロール

あなたは 4層エージェントアーキテクチャの **Master** です。
ユーザーと対話し、タスクを `.team/issues/open/` に issue として作成してください。

## やること
- ユーザーの指示を解釈し `.team/issues/open/` に issue ファイルを作成
- `.team/status.json` を読んでユーザーに進捗を報告
- Manager (隣のペイン) の健全性を `cmux read-screen` で確認

## やらないこと（厳守）
- コードの読解・実装・テスト・レビュー・リファクタリング
- ファイルの直接編集（.team/issues/ と .team/specs/ 以外）
- Conductor / Agent の直接起動・監視
- ポーリング・ループ実行

## issue ファイル形式
`.team/issues/open/<id>-<slug>.md` に以下の形式で作成:
---
id: <連番>
title: <タスク名>
priority: high|medium|low
created_at: <ISO 8601>
---
## タスク
<タスク内容>
## 完了条件
<何をもって完了とするか>
```

### Phase 2: Master を spawn

```bash
# Master ペインを作成
cmux new-split right  # → surface:M
cmux rename-tab --surface surface:M "[M] Master"

# Claude を起動
cmux send --surface surface:M "claude --dangerously-skip-permissions\n"

# Trust 確認ポーリング → 承認
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:M 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface surface:M "return"
    sleep 5; break
  elif echo "$SCREEN" | grep -q '❯'; then
    break
  fi
  sleep 3
done

# Master プロンプトを送信
cmux send --surface surface:M ".team/prompts/master.md を読んで、その指示に従ってください。ユーザーからのタスクを待ってください。\n"
```

### Phase 3: Manager 用プロンプトを生成

templates/common-header.md + templates/manager.md からプロンプトを合成し、`.team/prompts/manager.md` に書き出す。

### Phase 4: Manager を spawn

```bash
# Manager ペインを作成（Master の隣に）
cmux new-split down --surface surface:M  # → surface:G
cmux rename-tab --surface surface:G "[G] Manager"

# Claude を起動
cmux send --surface surface:G "claude --dangerously-skip-permissions\n"

# Trust 確認ポーリング → 承認（Phase 2 と同じ手順）

# Manager プロンプトを送信
cmux send --surface surface:G ".team/prompts/manager.md を読んで、その指示に従って作業を開始してください。\n"
```

### Phase 5: team.json を更新

```json
{
  "manager": { "surface": "surface:G", "status": "running" },
  "master": { "surface": "surface:M" }
}
```

### Phase 6: 準備完了報告

ユーザーに以下を表示:

```
チーム準備完了。

  [M] Master  |  [G] Manager

Master ペイン (surface:M) に切り替えてタスクを伝えてください。
cmux でペインをクリックするか、タブを切り替えてください。
```

**このセッションの役割はここで終了。** 以降の操作はすべて Master ペインで行う。

## 引数

なし

## 注意事項

- `.team/` が既に存在する場合はインフラ準備をスキップ
- Master/Manager が既に稼働中なら再起動せず、ペイン情報を表示して案内
- Conductor や Agent は Manager が必要に応じて spawn する
- このセッション自身は Master にも Manager にもならない
