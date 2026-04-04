---
id: 057
title: 「全タスク完了後に実行」フラグの追加
priority: high
created_at: 2026-04-03T13:51:19.442Z
---

## タスク
## 背景

/release や同時実行不可能なタスクを、他の全タスクが完了してからキュー実行したい。

## 仕様

### フラグ

タスクの frontmatter に `run_after_all: true` を追加可能にする（フラグ名は実装者が適切と判断する名前でOK）。

### 制約

- このフラグ付きタスクは同時に1つしか存在できない（create-task 時にバリデーション）

### 実行条件

以下が全て満たされたとき、フラグ付きタスクを実行可能と判定する:

1. フラグなし通常タスクの ready + assigned が 0
2. ただし、フラグ付きタスクに `depends_on` で依存しているタスクは「全てのタスク」のカウントから除外する

例:
```
T060: 機能A (通常)           → ready/assigned なら実行条件をブロック
T061: 機能B (通常)           → ready/assigned なら実行条件をブロック
T062: リリース (run_after_all) → T060,T061 完了後に実行可能
T063: リリースノート (通常, depends_on: [T062]) → T062 に依存しているのでカウントから除外
```

この場合、T060 と T061 が closed になれば T062 が実行される。T063 は T062 完了後に実行。

### 実装箇所

1. **task.ts の parseTaskMeta()**: frontmatter から run_after_all フラグを読み取り TaskMeta に追加
2. **task.ts の filterExecutableTasks()**: run_after_all タスクは通常のフィルタリングから除外
3. **daemon.ts の tick()**: 通常タスク（run_after_all でないもの、かつ run_after_all タスクに depends_on しているものを除く）の ready + assigned が 0 のとき、run_after_all タスクを実行可能と判定
4. **main.ts の cmdCreateTask()**: run_after_all タスクが既に存在する場合はエラー（1つ制約）
5. **main.ts の cmdCreateTask()**: --run-after-all フラグを受け付ける

### CLI

```bash
cmux-team create-task --title "リリース" --run-after-all --status ready --body "v3.17.0 リリース"
```
