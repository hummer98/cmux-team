# タスク割り当て

## タスク内容

---
id: 398
title: run_after_all assigned 中の normal タスク新規 assignment 抑止 guard 追加（T397 続）
priority: medium
depends_on: [397]
created_by: surface:483
created_at: 2026-04-30T12:21:58.930Z
---

## タスク
## 背景

T397 で `filterRunAfterAllTasks` の `normalActive` を「ready で dep 解決済み or assigned」に絞った結果、副作用として **draft が後で ready 化されたタイミングで新 ready chain と既存 run_after_all が並走する** 可能性がある。

T397 のスコープでは「並走を許容する」と判断したが、後続として guard を追加して並走を防ぐ。これにより `--exclusive` との関係も整理される。

## 修正前後の semantics

| flag | drain（発火条件） | assigned 中の挙動 |
|------|------------------|------------------|
| 修正前 `--run-after-all` (T397 後) | ready+assigned=0（exec ベース） | 何も止めない（並走可能） |
| **修正後 `--run-after-all`（このタスク）** | ready+assigned=0（exec ベース） | normal の新規 assignment を停止（他の run_after_all とは並走可） |
| `--exclusive`（変更なし） | ready+assigned=0（runAfterAll を暗黙包含） | 全 assignment 停止（他の exclusive・run_after_all も止める） |

これで `--run-after-all` と `--exclusive` の差が「他の run_after_all とは並走するか / 単独か」に明確化される。

## 修正内容

`scanTasks` (`skills/cmux-team/manager/daemon.ts:3014` 付近の Exclusive lock guard の直後 or 直前) に新たな guard を追加:

```ts
// === run_after_all lock ガード ===
// run_after_all: true のタスクが assigned の間は normal タスクの新規 assignment を停止する。
// 他の run_after_all 同士は並走可能（単独実行を保証したい場合は --exclusive を使う）。
const assignedRunAfterAllTaskIds = new Set(
  tasks.filter((t) => t.runAfterAll && assignedIds.has(t.id)).map((t) => t.id),
);
if (assignedRunAfterAllTaskIds.size > 0 && executable.length > 0) {
  await log(
    "run_after_all_lock_active",
    `task_ids=${[...assignedRunAfterAllTaskIds].join(",")} pending_normal=${executable.length}`,
  );
  // executable（normal）は dispatch しない。runAfterAllExecutable は通す。
  // → allExecutable を再構築して runAfterAllExecutable のみにする
}
```

ポイント:
- `executable`（normal）と `runAfterAllExecutable` を区別して扱う必要があるため、現状の `allExecutable = [...executable, ...runAfterAllExecutable]` を分岐して処理する
- exclusive lock guard とは併存。exclusive が assigned ならこの guard より前に return される
- log event 名は `run_after_all_lock_active` で exclusive 系と命名規則を揃える

## 完了条件

- [ ] `scanTasks` に run_after_all lock guard を追加
- [ ] 新規テスト: run_after_all が assigned の間、新たに ready 化された normal タスクが dispatch されない
- [ ] 新規テスト: run_after_all が assigned の間でも、他の ready run_after_all は dispatch される（並走可）
- [ ] 既存テスト: `--exclusive` の単独実行 semantics は変わらない（regression）
- [ ] T397 の executable ベース判定と組み合わせて、draft → ready 化後も並走しないことを確認するテスト
- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon-*.test.ts` が green

## ドキュメント更新

- `docs/spec/07-state-machine.md` の run_after_all / exclusive の節に「run_after_all assigned 中は normal を抑止する」「exclusive は全 assignment を停止する」の差を明記
- CLAUDE.md の「タスク属性」表に補足があれば更新

## 関連

- T397: filterRunAfterAllTasks の normalActive を executable ベースに修正（このタスクの前提）
- 既存 exclusive lock guard: `daemon.ts:3014-3028`

## やらないこと（スコープ外）

- `--exclusive` の挙動変更
- 複数 run_after_all 同士の優先度・順序制御の見直し
- run_after_all の名前変更や API 変更


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-398-1777552095` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-398-1777552095
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-398-1777552095/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/398-run-after-all-assigned-normal-assignment-guard-t397/runs/task-398-1777552095
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/398-run-after-all-assigned-normal-assignment-guard-t397/runs/task-398-1777552095/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
