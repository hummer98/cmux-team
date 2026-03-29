---
id: 1774711253
title: 手動コマンドのteam.json直接操作を廃止しdaemon CLI経由に統一
priority: high
status: ready
created_at: 2026-03-28T16:23:34.844Z
---

## タスク
## 問題

手動オーバーライドコマンド群（/team-impl, /team-research, /team-design, /team-review, /team-test）が team.json にエージェントを直接登録している。daemon の updateTeamJson() も定期的に team.json を書き換えるため、両者が競合し重複や不整合が発生する（Conductor リストの重複表示など）。

## 修正内容

### 1. team.json への書き込みを daemon に一元化
- team.json は daemon（updateTeamJson）のみが書き込む
- 手動コマンドからの team.json 直接操作を全て削除

### 2. 手動コマンドの更新
以下のコマンドから team.json 直接操作を削除し、必要なら daemon CLI 経由に変更:
- commands/team-impl.md
- commands/team-research.md
- commands/team-design.md
- commands/team-review.md
- commands/team-test.md
- commands/team-spec.md
- commands/team-disband.md

### 3. SKILL.md の更新
skills/cmux-team/SKILL.md が現在の daemon ベースのアーキテクチャと乖離している箇所を修正:
- Manager が TypeScript daemon である点の反映
- Conductor が常駐スロットである点の反映
- CLI サブコマンド一覧の更新
- 手動コマンドの位置づけ明確化（daemon 経由が正規フロー）

## 対象ファイル
- commands/team-impl.md
- commands/team-research.md
- commands/team-design.md
- commands/team-review.md
- commands/team-test.md
- commands/team-spec.md
- commands/team-disband.md
- skills/cmux-team/SKILL.md

## Journal

- summary: 手動コマンド7ファイルからteam.json直接書き込みを削除し、SKILL.mdをdaemonベースアーキテクチャに合わせて更新
- files_changed: 8
