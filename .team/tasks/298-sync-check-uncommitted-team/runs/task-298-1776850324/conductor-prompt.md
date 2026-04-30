# タスク割り当て

## タスク内容

---
id: 298
title: sync check の uncommitted 判定から .team/ 配下を除外
priority: high
created_by: surface:629
created_at: 2026-04-22T06:50:33.802Z
---

## タスク
## 背景

T283 の sync state ガード（git-sync.ts）で `hasUncommittedOnMain` が `.team/` 配下の変更も dirty としてカウントしているため、`cmux-team create-task --status ready` / `update-task --status ready` が使いづらい。

- `.team/tasks/` は `.gitignore` に入っていない（コミット対象）ため、タスクを作るたびに untracked エントリが残る
- 結果として sync check が `uncommitted` で reject しがち
- 本来 sync check が守りたいのは「main の stale origin / ユーザーの未コミット作業」であって、cmux-team 自身が作る `.team/` の副産物ではない

ユーザーとの合意: **`.team/` 全体を uncommitted 判定から除外する**。

## スコープ

対象は `hasUncommittedOnMain` の計算だけ。他の state（`diverged` / `detached` / SHA 比較）には触らない。

## 実装

### skills/cmux-team/manager/git-sync.ts

`collectSyncFacts` 内、`headStatus === 'on-main'` 分岐の `git status --porcelain` 呼び出しを pathspec で `.team/` を除外する形に変更:

```ts
const out = await git(["status", "--porcelain", "--", ".", ":(exclude).team"]);
hasUncommittedOnMain = out.trim().length > 0;
```

**pathspec magic** `:(exclude).team` により git 側で除外してくれるため、porcelain 出力のパース（quoted path / rename の `old -> new` 等のエッジケース）を自前で実装する必要はない。

**リネーム系の考慮**: `.team/` 外 → `.team/` 内、またはその逆のリネームは通常起こらない（`.team/` は cmux-team 専用ディレクトリ）。起こったとしても「`.team/` 外に存在するエントリ」として git 側が扱い、dirty と判定される。これは保守的で正しい挙動。

### skills/cmux-team/manager/git-sync.test.ts

既存のテスト方針に沿って以下を追加:

1. **`.team/` のみ dirty → uncommitted にならない**: `git` モック（`status --porcelain -- . :(exclude).team` が空を返す）で `hasUncommittedOnMain === false` を検証。合わせて SHA が一致していれば state が `clean` になることも確認。
2. **`.team/` + 他ファイル dirty → uncommitted**: mock は pathspec 除外後の出力を返すため、他ファイルが残れば空でなく uncommitted に倒れる。
3. **他ファイルのみ dirty → uncommitted**: 従来通りの動作が維持されていることを確認。
4. 既存テストの mock に `.team/` 関連の分岐が暗黙仮定されていないか確認（`status --porcelain` 呼び出しのマッチング条件を更新する必要があるか確認し、必要なら追従）。

### CLAUDE.md

「Ready 昇格時の sync state ガード（T283）」セクションの 7 状態テーブル `uncommitted` 行に脚注、または表の下に一文追加:

> **注**: `.team/` 配下の変更は `uncommitted` 判定から除外される。cmux-team 自身がタスクファイル・アーティファクト等を `.team/` 配下に書き込むため、これらを dirty に数えると ready 昇格が常に reject されてしまうため。

### docs/spec/

`07-state-machine.md` など T283 に言及している箇所で uncommitted 判定ロジックを説明している部分があれば同じ注記を追加。なければスキップ。

## 受け入れ条件

- [ ] `bun test skills/cmux-team/manager/git-sync.test.ts` が通る
- [ ] `bunx tsc --noEmit` でエラーなし
- [ ] 新規テストで `.team/` のみ dirty ケースが `clean` に分類されることを確認
- [ ] 既存テストが引き続き通る（他ファイル dirty → uncommitted）
- [ ] CLAUDE.md に除外の注記が追加されている
- [ ] 実装後、本リポジトリで `.team/tasks/*-task/` が untracked の状態で `cmux-team create-task --status ready` が成功することを手動で 1 回確認（summary.md に手順と結果を記録）

## 備考

- behavior 変更のみで CLI インターフェースは不変
- `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` bypass はそのまま維持
- 他の state（`diverged` 等）には一切触らない — scope を広げない


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-298-1776850324` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-298-1776850324
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-298-1776850324/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/298-sync-check-uncommitted-team/runs/task-298-1776850324
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/298-sync-check-uncommitted-team/runs/task-298-1776850324/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
