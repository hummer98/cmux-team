---
id: 1774711257
title: Conductorのシェルセッションにexport ANTHROPIC_BASE_URLを設定
priority: high
status: ready
created_at: 2026-03-28T16:49:36.080Z
---

## タスク
## 問題

Conductor 起動時に ANTHROPIC_BASE_URL はコマンド前置環境変数として渡されるが、シェルセッションの永続的な環境変数にはならない。Conductor が spawn-agent CLI を使わずに直接 cmux send で claude コマンドを実行すると、子プロセスに ANTHROPIC_BASE_URL が継承されず API Usage Billing（Not logged in）エラーになる。

実際に surface:316 の Conductor がこの動作をしており、Agent が全て認証失敗で停止した。

## 修正内容

Conductor の Claude 起動前に、シェルセッション自体に環境変数を export する。

### Before（conductor.ts initializeConductorSlots）
```bash
ANTHROPIC_BASE_URL=http://... claude --dangerously-skip-permissions '...'
```

### After
```bash
export ANTHROPIC_BASE_URL=http://... && export PROJECT_ROOT=... && claude --dangerously-skip-permissions '...'
```

これにより Conductor がどのような方法で Agent を起動しても、子プロセスに環境変数が自動継承される。

## 対象ファイル
- skills/cmux-team/manager/conductor.ts — initializeConductorSlots() の envParts 組み立て部分

## Journal

- summary: コミット 666c3b6 で既に修正済みのため、変更不要で完了
- files_changed: 0
