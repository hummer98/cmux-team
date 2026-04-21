---
id: 287
title: cmux-team start が新規フォルダで ENOENT で落ちる — pidfile 取得前に .team/ を mkdir -p
priority: high
created_by: surface:488
created_at: 2026-04-21T02:53:18.920Z
---

## タスク
## 背景

新規フォルダ（例: `~/git/KDG-aiseminar/`）で `cmux-team start --layout 16x9` を実行すると以下で落ちる:

```
ENOENT: no such file or directory, open '/Users/yamamoto/git/KDG-aiseminar/.team/daemon.pid'
    at async acquirePidFile (skills/cmux-team/manager/pidfile.ts:96:13)
    at async acquireOrExit (skills/cmux-team/manager/pidfile.ts:154:11)
    at async cmdStart (skills/cmux-team/manager/main.ts:366:9)
```

## 原因

T259 で pidfile 取得（`acquireOrExit`）を `preflight` 成功後・`direnv` / `resolveMainBranch` / `createDaemon` より前に移動した。`.team/*` ディレクトリの作成は `daemon.ts:532-535` の `createDaemon` 内で行われているため、fresh folder では `.team/` 自体が未作成のまま `writeFile(".team/daemon.pid", ..., { flag: "wx" })` が走り ENOENT になる。

## やること

### 1. 修正

- `skills/cmux-team/manager/main.ts:365` 付近、`acquireOrExit(pidFilePath, PROJECT_ROOT)` 呼び出しの**直前**に以下を追加:
  ```ts
  await mkdir(join(PROJECT_ROOT, ".team"), { recursive: true });
  ```
- `mkdir` は `fs/promises` から import（既存 import を流用できるか確認）
- これにより preflight → `.team/` 作成 → pidfile 取得 → ... の順になる
- 注意: preflight で root が git repo であることは検証済み。preflight より前に `.team/` を作るのは NG（preflight 失敗時にゴミが残る）

### 2. 代替案検討

- 代わりに `pidfile.ts:acquirePidFile` 内で `mkdir(dirname(path), { recursive: true })` してから `writeFile` する方針もあり
- どちらでも機能的に等価だが、責務としては「pidfile モジュールが自分の格納先を作る」方がカプセル化されて綺麗
- plan.md で両案比較してどちらかを採用

### 3. 検証

- 新規フォルダ（`.team/` が存在しない）で `cmux-team start` が成功すること
- 既存フォルダ（`.team/` がある）での冪等性が壊れないこと
- pidfile が正しく作成されること（`cat .team/daemon.pid` で PID が読める）
- `bun test` / `bunx tsc --noEmit` 新規エラー 0 件

### 4. テスト追加

- `skills/cmux-team/manager/pidfile.test.ts` がある場合、「.team/ が存在しない状態から acquirePidFile が成功する」ケースを追加
- または `main.ts` 側で修正した場合、該当箇所の責務は統合テストレベル（優先度低）

## 関連

- T259: pidfile による多重起動防止（このタスクで導入された順序変更が原因）
- T286: layout restore 自己修復（別バグ、こちらとは独立）

## 再現手順

```bash
cd /tmp
mkdir test-cmux-team-fresh && cd test-cmux-team-fresh
git init
cmux  # cmux セッション内で
cmux-team start --layout 16x9
# → ENOENT で exit 1
```
