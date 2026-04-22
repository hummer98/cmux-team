---
id: 296
title: cleanup: T295 で漏れた README / manager.md の close-task 旧署名 sweep
priority: low
depends_on: [295]
created_by: surface:627
created_at: 2026-04-22T04:28:08.735Z
---

## タスク
## 発見経緯

T295（close-task の納品物明示を強制化、Conductor 本 run で close 済み）の Inspector がFinding 1 (major) / Finding 2 (minor) として指摘した箇所。plan.md §5.1 Risks で「docs/ CLAUDE.md README.md README.ja.md templates/」を `rg "close-task --task-id.*--journal"` で 0 件まで掃く方針だったが、README と template manager.md の 4 行が漏れた。

## 対象

- `README.md` L110 付近: `\`cmux-team close-task --task-id <id> [--journal <text>]\` | Close a task`
- `README.ja.md` L110 付近: `\`cmux-team close-task --task-id <id> [--journal <text>]\` | タスク close`
- `skills/cmux-team/templates/ja/manager.md` L73 付近: `cmux-team close-task --task-id <TASK_ID> --journal "..."` の例示
- `skills/cmux-team/templates/en/manager.md` L73 付近: 同上の英語版

## 方針

**README.md / README.ja.md**: 新仕様に書き直す。
`cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind 別フラグ] [--journal <text>]`

**manager.md (ja/en)**: 引数を省略して抽象化（推奨）:
`cmux-team close-task ...`

manager.md は Manager/daemon の動作説明文脈で、読み手に具体的 kind を選ばせる場所ではないため、引数を抽象化したほうが陳腐化しにくい。

## 検証

```bash
rg "close-task --task-id.*--journal" docs/ CLAUDE.md README.md README.ja.md skills/cmux-team/templates/
```

上記が 0 件になること。

## 本体への影響

実装コード / tsc / bun test には影響しない。ドキュメント hygiene のみ。軽微。

## 依存

`depends_on: [295]`（T295 が close されてから着手）
