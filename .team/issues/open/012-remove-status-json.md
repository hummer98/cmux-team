---
id: 12
title: status.json を廃止し、Master が真のソースを直接参照する
priority: high
status: ready
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

status.json は他のソースのコピーでありSSOTになっていない。廃止して、Master が必要な情報を真のソースから直接取得する。

### 現状の問題

- status.json の情報はすべて他の手段で取得可能
- Manager が更新するたびにトークンを消費
- コピーなので常に古くなるリスクがある

### 廃止後の代替手段

| 情報 | 真のソース | 取得方法 |
|------|-----------|---------|
| Manager の状態 | Manager ペイン | `cmux read-screen --surface MANAGER` |
| 稼働中 Conductor | cmux ペイン構成 | `cmux tree` |
| open task 数 | task ファイル | `ls .team/tasks/open/` |
| 完了タスク履歴 | ログ | `cat .team/logs/manager.log` |

### 変更内容

1. Manager テンプレートから status.json 更新ステップを削除
2. Master テンプレートの進捗報告セクションを真のソース参照に変更
3. `.team/.gitignore` から `status.json` を削除
4. SKILL.md / CLAUDE.md から status.json スキーマの記述を削除
5. team-status コマンドを真のソース参照に変更

## 対象ファイル

- `skills/cmux-team/templates/manager.md` — §5 ステータス更新を削除
- `skills/cmux-team/templates/master.md` — 進捗報告セクション変更
- `.team/prompts/master.md` — 同上
- `skills/cmux-team/SKILL.md` — status.json スキーマ削除
- `CLAUDE.md` — status.json 関連の記述削除
- `commands/team-status.md` — 真のソース参照に変更
- `commands/start.md` — status.json 初期化ステップ削除

## 完了条件

- status.json への書き込み・読み込みがどのテンプレートにも残っていないこと
- Master が `cmux tree` / `ls` / `cmux read-screen` / ログで必要な情報を取得できること
- Manager の書き込み操作がゼロになること（Bash + Read のみで動作）
