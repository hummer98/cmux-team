# タスク割り当て

## タスク内容

---
id: 352
title: Agent 行のスピナー直後に @handle を配置（T351 後続調整）
priority: medium
depends_on: [351]
created_by: surface:123
created_at: 2026-04-26T21:20:00.541Z
---

## タスク
# 背景

T351 で dashboard.tsx に per-surface handle 表示を実装するが、Agent サブツリー行での `@handle` の配置位置が body で明示されていなかった。

T323 の spec は CLI 1 行表示用（`Agent [201] @kddi <util> cap:N%`）で、dashboard ツリー表記での位置は決めていない。本タスクで位置を確定させる。

# 仕様: Agent 行の最終レイアウト

`dashboard.tsx:652-660` の running / idle / asking それぞれで、**スピナー（または role アイコン）の直後**に `@handle` を CYAN 色で挿入する:

## running（スピナーあり）

```
   └─ [201] ▘ @kddi <taskTitle>
```

- 順序: `prefix` `[surface]` `spinner` `@handle` `taskTitle`
- spinner と handle の色は既存通り CYAN
- handle が未バインド（`tokenHandle === undefined`）の場合は省略（`└─ [201] ▘ <taskTitle>`）

## idle（role アイコン）

```
   └─ [201] ⚙ @kddi <taskTitle>
```

- 順序: `prefix` `[surface]` `roleIcon` `@handle` `taskTitle`
- handle 部分は dim にしない（taskTitle だけ dim 維持）
- 未バインド時は省略

## asking（YELLOW 強調）

```
   └─ [201] ? ⚙ @kddi <taskTitle>
```

- 順序: `prefix` `[surface]` `?` `roleIcon` `@handle` `taskTitle`
- handle も YELLOW で揃える（行全体の警告色を保つ）
- 未バインド時は省略

# Master / Conductor 行については本タスク対象外

T351 で実装される Master / Conductor 行のレイアウトは触らない。本タスクは Agent サブツリー行のみ。

# 実装メモ

- `tokenHandle` は `daemon.ts:3653` ですでに `agents` snapshot に含まれているので、dashboard 側で `a.tokenHandle` を読むだけ
- T351 の実装で per-surface handle が実装されているはずなので、Agent 行の配置のみ調整すればよい
- 既に T351 で同等位置に実装されていれば本タスクは no-op で close（journal にその旨記載）

# 完了条件

- 上記 3 つのレイアウト（running / idle / asking）でスピナー / role アイコン直後に `@handle` が出る
- 未バインド時は handle 部分が省略され、既存レイアウトと同等
- 既存の dashboard test が pass
- 新規の `dashboard-conductor.test.tsx` テストケース（agent サブツリーで handle 表示 / 非表示）を追加して pass
- `bunx tsc --noEmit` 0 errors


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-352-1777241111` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-352-1777241111
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-352-1777241111/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/352-agent-handle-t351/runs/task-352-1777241111
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/352-agent-handle-t351/runs/task-352-1777241111/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
