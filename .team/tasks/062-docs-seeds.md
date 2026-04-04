---
id: 062
title: docs/seeds/ を現在の実装に同期
priority: medium
created_at: 2026-04-04T00:45:50.657Z
---

## タスク
## 概要

docs/seeds/ のシードドキュメント（設計仕様）が実装と乖離している。実装が正として、ドキュメントを現在の実装に合わせて更新する。

## 対象ファイル

- docs/seeds/00-project-overview.md
- docs/seeds/01-skill-cmux-team.md
- docs/seeds/02-skill-cmux-agent-role.md
- docs/seeds/03-commands.md
- docs/seeds/04-templates.md
- docs/seeds/05-install-and-infrastructure.md
- docs/seeds/06-implementation-tasks.md

## 方針

- 実装が正。ドキュメントを実装に合わせる
- 各ドキュメントの記述と、対応する実装（skills/, commands/, templates/, manager/ 等）を突き合わせる
- 乖離がある箇所を実装に合わせて修正する
- 廃止された機能の記述は削除する
- 新しく追加された機能（abort-task、スピナーアニメーション、ロギングポリシー等は未実装なので含めない）は、実装済みのものだけ追記する
