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
   - team.json, specs/, output/, tasks/open/, tasks/closed/, prompts/, docs-snapshot/, logs/
3. team.json 初期化（`architecture: "4-tier"`）
4. `.team/.gitignore` 作成 (output/, prompts/, docs-snapshot/, logs/)
6. `.gitignore` に `.worktrees/` が含まれていなければ追加を提案

### Phase 1: Master 用プロンプトを生成

templates/common-header.md + templates/master.md からプロンプトを合成し、`.team/prompts/master.md` に書き出す。

※ templates/master.md が存在しない場合は、以下の内容で `.team/prompts/master.md` を直接生成する:

```markdown
# Master ロール

あなたは 4層エージェントアーキテクチャの **Master** です。
ユーザーと対話し、タスクを `.team/tasks/open/` に作成してください。

## やること
- ユーザーの指示を解釈し `.team/tasks/open/` にタスクファイルを作成
- 真のソースを直接参照してユーザーに進捗を報告（`cmux tree`, `ls .team/tasks/`, `manager.log`, `cmux read-screen`）
- Manager (隣のペイン) の健全性を `cmux read-screen` で確認
- task を `status: ready` にしたら Manager に `cmux send` で通知する

## やらないこと（厳守）
- コードの読解・実装・テスト・レビュー・リファクタリング
- ファイルの直接編集（.team/tasks/ と .team/specs/ 以外）
- Conductor / Agent の直接起動・監視
- ポーリング・ループ実行

## タスクファイル形式
`.team/tasks/open/<id>-<slug>.md` に以下の形式で作成:
---
id: <連番>
title: <タスク名>
priority: high|medium|low
status: draft
created_at: <ISO 8601>
---
## タスク
<タスク内容>
## 完了条件
<何をもって完了とするか>

## status フロー
- `status: draft` — 作成直後。Manager は無視する
- `status: ready` — ユーザー承認後。Manager が拾って Conductor を起動する
- ready にしたら `cmux send --surface MANAGER "[TASK_CREATED]"` で Manager に通知

## Manager の再起動
Manager は Sonnet モデルで動作する。再起動時は `--model sonnet` を忘れないこと:
cmux send --surface MANAGER "claude --dangerously-skip-permissions --model sonnet '.team/prompts/manager.md を読んで指示に従ってください。'\n"
```

### Phase 2: Master を spawn

```bash
# Master ペインを作成
cmux new-split right  # → surface:M
cmux rename-tab --surface surface:M "[M] Master"

# Claude を起動（初期プロンプト付きで起動 → Trust 承認後すぐに実行される）
cmux send --surface surface:M "claude --dangerously-skip-permissions '.team/prompts/master.md を読んで指示に従ってください。ユーザーからのタスクを待ってください。'\n"

# Trust 確認が出たら承認
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:M 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface surface:M "return"
    sleep 3; break
  elif echo "$SCREEN" | grep -qE '(Thinking|Reading|❯)'; then
    break
  fi
  sleep 3
done
```

### Phase 3: Manager 用プロンプトを生成

templates/common-header.md + templates/manager.md からプロンプトを合成し、`.team/prompts/manager.md` に書き出す。

### Phase 4: Manager を spawn

```bash
# Manager ペインを作成（Master の下に）
cmux new-split down --surface surface:M  # → surface:G
cmux rename-tab --surface surface:G "[G] Manager"

# Claude を起動（初期プロンプト付き）
cmux send --surface surface:G "claude --dangerously-skip-permissions --model sonnet '.team/prompts/manager.md を読んで指示に従って作業を開始してください。'\n"

# Trust 確認が出たら承認
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:G 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface surface:G "return"
    sleep 3; break
  elif echo "$SCREEN" | grep -qE '(Thinking|Reading|❯)'; then
    break
  fi
  sleep 3
done
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

## 既存セッションの検出（Phase 1 の前に実行）

Master / Manager が既に稼働中の場合は再起動しない。以下の手順で検出する:

```bash
# 1. team.json から surface 情報を読む
MASTER_SURFACE=$(python3 -c "import json; d=json.load(open('.team/team.json')); print(d.get('master',{}).get('surface',''))" 2>/dev/null)
MANAGER_SURFACE=$(python3 -c "import json; d=json.load(open('.team/team.json')); print(d.get('manager',{}).get('surface',''))" 2>/dev/null)

# 2. 各 surface が生きているか確認
if [ -n "$MASTER_SURFACE" ]; then
  SCREEN=$(cmux read-screen --surface $MASTER_SURFACE --lines 5 2>&1)
  if echo "$SCREEN" | grep -qv "Error"; then
    echo "Master は稼働中 ($MASTER_SURFACE)"
    MASTER_ALIVE=true
  fi
fi

if [ -n "$MANAGER_SURFACE" ]; then
  SCREEN=$(cmux read-screen --surface $MANAGER_SURFACE --lines 5 2>&1)
  if echo "$SCREEN" | grep -qv "Error"; then
    echo "Manager は稼働中 ($MANAGER_SURFACE)"
    MANAGER_ALIVE=true
  fi
fi
```

- **両方稼働中** → 「チーム稼働中。Master ($MASTER_SURFACE) に切り替えてタスクを伝えてください。」と表示して終了
- **Master のみ死亡** → Master だけ再 spawn（Phase 2 のみ実行）
- **Manager のみ死亡** → Manager だけ再 spawn（Phase 3-4 のみ実行）
- **両方死亡 or 未起動** → 通常通り全 Phase を実行

## 注意事項

- `.team/` が既に存在する場合はインフラ準備をスキップ
- Conductor や Agent は Manager が必要に応じて spawn する
- このセッション自身は Master にも Manager にもならない
