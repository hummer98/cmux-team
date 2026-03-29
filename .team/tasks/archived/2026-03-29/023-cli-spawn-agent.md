---
id: 23
title: CLI 経由の Agent spawn + ロギングプロキシ統合
priority: high
status: ready
created_at: 2026-03-27T10:55:00Z
---

## 概要

Conductor が直接 `cmux new-split` で Agent を作るのではなく、`main.ts spawn-agent` CLI を経由させる。
daemon が surface 作成・ツリー管理・ロギングプロキシ注入を一元的に行う。

## 動機

1. Agent surface のツリー管理が確実になる（hook 検出の不確実性を排除）
2. ロギングプロキシを daemon 側で注入できる（`ANTHROPIC_BASE_URL`）
3. Conductor テンプレートが簡素化される（cmux 操作・Trust 承認が不要に）
4. cmux-team 導入先でも Agent の動作ログを一元取得可能に

## 設計

### CLI コマンド

```bash
# Agent spawn
main.ts spawn-agent \
  --conductor-id conductor-xxx \
  --role impl \
  --prompt "cd /path/to/worktree && ..."
# → stdout: SURFACE=surface:N SESSION_ID=...

# Agent 一覧
main.ts agents --conductor-id conductor-xxx

# Agent 停止
main.ts kill-agent --surface surface:N
```

### daemon 内のロギングプロキシ

- bun の HTTP サーバーで透過プロキシを起動（起動時にポート確保）
- リクエスト/レスポンスを `.team/logs/traces/` に JSONL で保存
- conductor_id, task_id, role をメタデータとして付与
- Agent 起動時に `ANTHROPIC_BASE_URL=http://localhost:PORT` を自動設定

### ツリー管理

- `DaemonState.conductors[].agents[]` に spawn 時に即追加（hook 不要）
- surface 消失は monitorConductors で検出して自動除去
- team.json / status API / TUI に反映

### Conductor テンプレート変更

Before:
```bash
cmux new-split down
bash .team/scripts/validate-surface.sh surface:N
cmux send --surface surface:N "claude --dangerously-skip-permissions '...'"
# Trust 承認ポーリング...
cmux rename-tab --surface surface:N "[N] Agent-impl"
```

After:
```bash
AGENT=$(bun run .team/manager/main.ts spawn-agent \
  --conductor-id $CONDUCTOR_ID \
  --role impl \
  --prompt "cd $WORKTREE && ...")
echo "$AGENT"  # SURFACE=surface:N
```

### 注意事項

- Claude Max (OAuth) で `ANTHROPIC_BASE_URL` が有効か要検証
- ロギングプロキシのレイテンシ影響を最小化する
- PostToolUse hook (`hook-agent-spawned.sh`) は廃止可能

## 完了条件

- [ ] `main.ts spawn-agent` が Agent surface を作成し daemon に登録
- [ ] TUI にツリー表示（hook 不要で）
- [ ] ロギングプロキシが全 Agent の API 通信をキャプチャ
- [ ] Conductor テンプレートが `spawn-agent` CLI を使用
- [ ] `main.ts agents` で Agent 一覧表示
