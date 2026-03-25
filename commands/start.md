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
   - team.json, specs/, output/, tasks/open/, tasks/closed/, prompts/, docs-snapshot/, logs/, scripts/
3. team.json 初期化（`architecture: "4-tier"`）
4. `.team/.gitignore` 作成 (output/, prompts/, docs-snapshot/, logs/)
5. `.team/scripts/` にランタイムスクリプトをコピー:
   ```bash
   # スクリプトの検索順序: plugin キャッシュ → リポジトリ内 → 手動インストール
   for candidate in \
     ~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/scripts \
     ./skills/cmux-team/scripts \
     ~/.claude/skills/cmux-team/scripts; do
     if [[ -f "${candidate}/spawn-conductor.sh" ]]; then
       cp -f "${candidate}/spawn-conductor.sh" .team/scripts/
       cp -f "${candidate}/validate-surface.sh" .team/scripts/
       chmod +x .team/scripts/*.sh
       break
     fi
   done
   ```
6. `.gitignore` に `.worktrees/` が含まれていなければ追加を提案

### Phase 1: Master 用プロンプトを生成

**テンプレートを毎回 plugin キャッシュから検索して `.team/prompts/master.md` を再生成する。**
既にファイルが存在していても上書きする（plugin 更新を反映するため）。

```bash
# テンプレート検索（spawn-conductor.sh と同じ検索順序）
TEMPLATE_DIR=""
for candidate in \
  ~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/templates \
  ./skills/cmux-team/templates \
  ~/.claude/skills/cmux-team/templates; do
  if [[ -f "${candidate}/master.md" ]]; then
    TEMPLATE_DIR="$candidate"
    break
  fi
done

if [[ -n "$TEMPLATE_DIR" ]]; then
  # common-header.md + master.md を合成
  cat "${TEMPLATE_DIR}/common-header.md" > .team/prompts/master.md
  echo "" >> .team/prompts/master.md
  cat "${TEMPLATE_DIR}/master.md" >> .team/prompts/master.md
else
  echo "WARNING: master.md テンプレートが見つかりません"
fi
```

### Phase 2: Master を spawn

```bash
# Master ペインを作成
cmux new-split right  # → surface:M

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

# タブ名を設定（Claude Code 起動後に実行。起動前だと Claude Code が上書きする）
# surface 番号を含めて識別しやすくする（例: [58] Master）
MASTER_NUM=${MASTER_SURFACE##*:}  # "surface:58" → "58"
cmux rename-tab --surface surface:M "[${MASTER_NUM}] Master"
```

### Phase 3: Manager 用プロンプトを生成

**テンプレートを毎回 plugin キャッシュから検索して `.team/prompts/manager.md` を再生成する。**

```bash
# Phase 1 と同じ TEMPLATE_DIR を使用
if [[ -n "$TEMPLATE_DIR" ]]; then
  # Manager は common-header.md を使わない（ペイン操作が主要責務のため矛盾する）
  cp -f "${TEMPLATE_DIR}/manager.md" .team/prompts/manager.md
else
  echo "WARNING: manager.md テンプレートが見つかりません"
fi
```

### Phase 4: Manager を spawn

```bash
# Manager ペインを作成（Master の下に）
cmux new-split down --surface surface:M  # → surface:G

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

# タブ名を設定（Claude Code 起動後に実行。起動前だと Claude Code が上書きする）
MANAGER_NUM=${MANAGER_SURFACE##*:}  # "surface:59" → "59"
cmux rename-tab --surface surface:G "[${MANAGER_NUM}] Manager"
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
# 重要（cmux#2042）: cmux read-screen は存在しない surface でもエラーを返さず
# フォーカス中ペインの内容を返してしまう。validate-surface.sh で事前検証する。
if [ -n "$MASTER_SURFACE" ] && bash .team/scripts/validate-surface.sh "$MASTER_SURFACE" 2>/dev/null; then
  echo "Master は稼働中 ($MASTER_SURFACE)"
  MASTER_ALIVE=true
fi

if [ -n "$MANAGER_SURFACE" ] && bash .team/scripts/validate-surface.sh "$MANAGER_SURFACE" 2>/dev/null; then
  echo "Manager は稼働中 ($MANAGER_SURFACE)"
  MANAGER_ALIVE=true
fi
```

- **両方稼働中** → Phase 1, 3 のプロンプト再生成だけ実行し、「チーム稼働中。プロンプトを最新に更新しました。Master ($MASTER_SURFACE) に切り替えてタスクを伝えてください。」と表示して終了
- **Master のみ死亡** → Master だけ再 spawn（Phase 2 のみ実行）
- **Manager のみ死亡** → Manager だけ再 spawn（Phase 3-4 のみ実行）
- **両方死亡 or 未起動** → 通常通り全 Phase を実行

## 注意事項

- `.team/` が既に存在する場合はインフラ準備をスキップ
- Conductor や Agent は Manager が必要に応じて spawn する
- このセッション自身は Master にも Manager にもならない
