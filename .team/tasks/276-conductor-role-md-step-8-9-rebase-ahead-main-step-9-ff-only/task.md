---
id: 276
title: conductor-role.md Step 8/9: rebase 対象を ahead 側 main にし Step 9 ff-only 失敗時の判断必要レポートを追加
priority: high
created_at: 2026-04-20T07:44:57.830Z
depends_on: [275]
---

## タスク
## 背景

ai-web-builder T006（2026-04-19）で Conductor が `CONDUCTOR_DONE --success=false`
を **reason 空** で送信して諦めた事例。manager.log には `reason=-` としか残らず、
原因追跡に traces DB と worktree の git log 突き合わせが必要になった。

実際の詰まり方:

- Step 8 `git rebase origin/<main>`: origin が stale（local main が ahead）なため
  no-op で成功扱い
- Step 9 `git merge --ff-only <branch>` from `{{PROJECT_ROOT}}`: local main が
  worktree branch の ancestor でないため **ff-only 失敗**

現状のテンプレは「Step 8 の rebase conflict」のみ判断必要レポートのフォーマット
を定義しており、Step 9 の ff-only 失敗時の扱いが欠落している。さらに
`CONDUCTOR_DONE --success=false` の reason 必須化が文面で強制されていないため
空 reason 事故が起きる。

## 改修

### 1. Step 8 の rebase 対象を「ahead 側の main」に

`skills/cmux-team/templates/ja/conductor-role.md:445-458` および en 版の該当節で、
`git rebase origin/{{MAIN_BRANCH}}` 固定を次のパターンに置き換える:

```bash
git fetch --quiet origin {{MAIN_BRANCH}} || true

# local <main> が origin/<main> より strictly ahead なら local を rebase target
if git merge-base --is-ancestor origin/{{MAIN_BRANCH}} {{MAIN_BRANCH}} 2>/dev/null \
  && [ "$(git rev-parse origin/{{MAIN_BRANCH}})" != "$(git rev-parse {{MAIN_BRANCH}})" ]; then
  REBASE_TARGET={{MAIN_BRANCH}}
else
  REBASE_TARGET=origin/{{MAIN_BRANCH}}
fi

git rebase "$REBASE_TARGET"
```

### 2. Step 9 の ff-only 失敗時の判断必要レポート

Step 9 の `git merge --ff-only` が失敗した場合の処理を Step 8 conflict 節と
同じフォーマットで明記する。必要情報:

- `git status` の出力（dirty files / ahead-behind）
- worktree branch の HEAD SHA / local `<main>` の HEAD SHA
- ブランチ名
- worktree は温存する旨（人間が `cmux-team restart-task --task-id <X>` で
  再投入できる）
- `CONDUCTOR_DONE --success false --reason "<短い日本語>"` を送信

### 3. reason 空禁止のガード

Step 8 / Step 9 の abort セクションで `--reason "<...>"` を **必須**として明記。
reason が空だと manager.log の `conductor_done_unresolved` に `reason=-` で残り
デバッグ不能になる旨を背景として添える（1 行）。

## 対象ファイル

- `skills/cmux-team/templates/ja/conductor-role.md`
- `skills/cmux-team/templates/en/conductor-role.md`（同内容で同期）
- `docs/spec/04-templates.md`（Step 8/9 の記述があれば更新）

## 検証

1. 既存 worktree で故意に local main を ahead にし、Step 8 が local main に
   rebase できること
2. Step 9 ff-only 失敗を再現させ、Conductor が判断必要レポートを出すこと
3. `CONDUCTOR_DONE --success=false` 呼出に `--reason` が付いていること
4. 通常の「origin が ahead」ケースで従来通り動作すること（リグレッション）

## 関連

- 発生事例: ai-web-builder T006（2026-04-19）
- 兄弟タスク: worktree-base.ts の `config-local-ahead` 分岐追加（独立に merge 可）
- 本タスクだけ merge されても worktree 作成時点で古い base から切られる問題は
  残るが、Conductor が適切にレポート出力して aborted に倒せるようになる
