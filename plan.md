# Plan: PreToolUse hook の .team/tasks/ 書き込み制限緩和

## 概要

`.claude/settings.json` の PreToolUse hook の判定ロジックを修正し、`.team/tasks/*/runs/**` への書き込みを許可する。

## 現状

```python
# 現在のロジック（settings.json:33）
'.team/tasks/' in p  # → True ならブロック
```

すべての `.team/tasks/` 配下への Write/Edit がブロックされている。

## 変更内容

判定条件を精緻化:

```python
# 新しいロジック
'.team/tasks/' in p and '/runs/' not in p and not p.endswith('sessions.json')
```

| パス例 | 許可/禁止 |
|--------|----------|
| `.team/tasks/104-xxx/task.md` | 禁止 |
| `.team/tasks/099-xxx.md` | 禁止 |
| `.team/tasks/104-xxx/runs/task-104-xxx/summary.md` | **許可** |
| `.team/tasks/104-xxx/sessions.json` | **許可** |

## 対象ファイル

- `.claude/settings.json` — PreToolUse hook の command フィールド（1箇所）

## 実装手順

1. `.claude/settings.json` の PreToolUse hook 内 Python ワンライナーを修正
2. 判定条件: `'.team/tasks/' in p` → `'.team/tasks/' in p and '/runs/' not in p and not p.endswith('sessions.json')`
3. エラーメッセージはそのまま維持

## 検証方法

修正後の Python ロジックを単体テスト（python3 -c で各パスケースを検証）
