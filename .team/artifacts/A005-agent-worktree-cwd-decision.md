---
id: A005
type: decision
title: "Agent/Conductor の worktree CWD 問題 — 設計選択肢の議論"
created: 2026-04-09T14:30:00+09:00
author: master
tags: [worktree, agent, conductor, spawn-agent, authentication, security]
status: undecided
---

# Agent/Conductor の worktree CWD 問題

## 背景

`spawn-agent` で起動した Agent（surface:83, KDG-lab T005 の inspector）が、Claude Code の初回セットアップ画面（テーマ選択）で止まる事象が発生。原因調査の結果、**worktree CWD と `.claude/` 設定の不整合**が判明した。

## 現状の非対称性

| | Conductor | Agent |
|---|---|---|
| 起動時 CWD | プロジェクトルート | worktree（`cd <worktreePath> && claude`） |
| `.claude/settings.local.json` 参照 | **可能**（プロジェクトルートに存在） | **不可**（worktree には untracked なので不在） |
| `.team/tasks/` 参照 | 可能 | 不可 |
| worktree 内での作業 | プロンプト指示で `cd` | シェルで既に `cd` 済み |

### 実測

- `~/git/KDG-lab/.claude/settings.local.json` — **あり**
- `~/git/KDG-lab/.worktrees/task-005-xxx/.claude/settings.local.json` — **なし**（`.claude/skills/` のみ git tracked）
- `.gitignore` に `.claude/` は入っていないが、`settings.local.json` は untracked のまま

### 該当コード

`skills/cmux-team/manager/main.ts:1095`
```typescript
const cdPrefix = worktreePath ? `cd ${worktreePath} && ` : "";
claudeCmd = `${cdPrefix}${exports.join(" && ")} && claude --dangerously-skip-permissions ${modelFlag} '...'`;
```

`skills/cmux-team/manager/conductor.ts:281`（Conductor は `cd` しない）
```typescript
await cmux.send(conductor.surface, "/clear");
// ... プロンプト送信のみ
```

## 選択肢

### 選択肢 A: Conductor も worktree CWD で起動

Conductor を `claude --directory <worktree>` または `cd <worktree> && claude` で起動。両方 worktree CWD で一貫させる。

**必要な対応:**
- `.claude/settings.local.json` を worktree にコピー
- タスクファイル（`.team/tasks/`）の参照方法を変える（絶対パス or コピー）
- `.envrc` 等の untracked 設定ファイルの扱いを決める
- Conductor 初期化フローの大幅改修

**メリット:**
- プロジェクトルートへの誤操作リスク低（CWD が worktree）
- Agent と一貫

**デメリット:**
- 変更量大
- コピー漏れ/同期ズレのリスク

### 選択肢 B: Agent をプロジェクトルート CWD に統一

`spawn-agent` の `cd` prefix を除去。Agent のプロンプト（`templates/implementer.md` 等）に `cd {{WORKTREE_PATH}}` を追加して Conductor 流に合わせる。

**メリット:**
- 変更量最小（`cd` prefix 除去 + プロンプト追記）
- コピー不要
- `.claude/settings.local.json` と `.team/tasks/` が見える

**デメリット:**
- **プロジェクトルートのコード誤変更リスクが Agent にも広がる**（Conductor と同じリスク）
- Claude がプロンプトの `cd` 指示を無視した場合、main を汚染しうる
- 相対パスが worktree ではなくプロジェクトルートに解決される

### 選択肢 C: Agent に `--directory <worktree>` + `settings.local.json` だけコピー

`cd` prefix の代わりに `claude --directory <worktree>` で起動。起動前に `.claude/settings.local.json` 1ファイルだけを worktree の `.claude/` にコピー。

**メリット:**
- CWD は worktree なので相対パスが自然
- プロジェクトルート誤変更リスク低
- コピー対象が 1 ファイルのみで同期ズレリスク低
- タスクファイルはプロンプトに絶対パスで渡すので不要

**デメリット:**
- `settings.local.json` のコピー基盤が必要
- `--directory` フラグの挙動確認が必要（Claude Code の設定ファイル探索経路に影響するか）
- Conductor の扱いが不統一のまま（Conductor も同様にすべきか別議論）

## 現状の根本リスク（共通）

**どの選択肢でも残る問題:** Claude はプロンプトで「worktree 内で作業せよ」と指示されているだけで、従う保証はない。

現状の Conductor でも同じ: プロジェクトルート CWD で起動しており、プロンプトで `cd` を指示しているだけ。Claude が従わずプロジェクトルートの git 管理下ファイルを Edit/Write する可能性がある。

### 追加の対策案

1. **hooks で制限する** — Agent/Conductor の `settings.json` に PreToolUse hook を入れて、worktree 外への Write/Edit をブロック
2. **`--directory` で worktree を指定する** — 相対パス解決のデフォルトを worktree に向ける（完全ではないが軽減）

## 未決事項

- どの選択肢を採用するか（A/B/C）
- Conductor の CWD も worktree に変更するか
- worktree 外への書き込みを hooks でブロックするか
- `settings.local.json` のコピー vs. symlink
- Claude Code の `--directory` フラグの実際の挙動（設定ファイル探索経路への影響）

## 関連

- 発生事例: KDG-lab T005 inspector agent (surface:83) が初回セットアップ画面で停止
- 関連ファイル:
  - `skills/cmux-team/manager/main.ts:1095` (spawn-agent の cd prefix)
  - `skills/cmux-team/manager/conductor.ts:281` (Conductor assignTask)
  - `skills/cmux-team/templates/conductor-task.md:9` (worktree cd 指示)

## 次のステップ

ユーザーが決断できないため議論保留。再検討時はこの artifact を起点に続きを進める。
