---
id: 10
title: Conductor 起動をシェルスクリプト化し Manager の負担を軽減
priority: high
status: ready
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

Conductor の起動手順をシェルスクリプトにまとめ、Manager は `bash .team/scripts/spawn-conductor.sh <task-id>` を呼ぶだけにする。

### 背景

Conductor 起動は完全に決定論的な手順:
1. `cmux new-split down`
2. git worktree 作成
3. Claude を初期プロンプト付きで起動
4. Trust 承認

設計原則「決定論的なものはコードで、判断が必要なものは AI で」に従い、スクリプト化する。
これにより Manager（Haiku）が手順を誤るリスクを排除する。

### スクリプト仕様

`.team/scripts/spawn-conductor.sh <task-id>`

#### 入力
- `<task-id>`: task ファイルの ID（例: `009`）

#### 処理
1. task ファイル `.team/tasks/open/<task-id>-*.md` の存在を確認
2. `cmux new-split down` でペインを作成 → surface 番号を取得
3. `cmux rename-tab --surface surface:N "[N] Conductor"`
4. CONDUCTOR_ID を生成（`conductor-$(date +%s)`）
5. git worktree を作成（`.worktrees/${CONDUCTOR_ID}`）
6. Conductor 用プロンプトを `.team/prompts/${CONDUCTOR_ID}.md` に生成
7. Claude を起動: `cmux send --surface surface:N "claude --dangerously-skip-permissions '.team/prompts/${CONDUCTOR_ID}.md を読んで指示に従って作業してください。'\n"`
8. Trust 承認ポーリング（最大30秒）
9. 起動情報を stdout に出力（Manager が記録する用）:
   ```
   CONDUCTOR_ID=conductor-1774283589
   SURFACE=surface:95
   TASK_ID=009
   ```

#### 出力
- 成功時: exit 0 + 上記の起動情報
- 失敗時: exit 1 + エラーメッセージ

### Manager テンプレートの変更

manager.md の §2（Conductor 起動）を以下に簡略化:

```bash
# Conductor 起動（スクリプトに委譲）
RESULT=$(bash .team/scripts/spawn-conductor.sh ${TASK_ID})
# RESULT から CONDUCTOR_ID, SURFACE を取得して status.json に記録
```

## 対象ファイル

- `.team/scripts/spawn-conductor.sh`（新規作成）
- `skills/cmux-team/templates/manager.md` — §2 をスクリプト呼び出しに簡略化

## 完了条件

- `bash .team/scripts/spawn-conductor.sh 009` で Conductor が正しく起動すること
- Manager が直接 cmux コマンドを実行せずスクリプト経由で Conductor を起動すること
- Trust 承認が自動で行われること
- 起動情報が stdout に出力されること
