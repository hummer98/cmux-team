# タスク割り当て

## タスク内容

---
id: 319
title: cmux-team token add|list|remove|rotate|set-plan CLI
priority: high
created_at: 2026-04-24T22:40:52.314Z
---

## タスク
## 概要

tokens.db に対するトークン管理 CLI サブコマンドを実装する。

依存: tokens.db schema + Keychain + CRUD ライブラリ（先行タスク）

## 設計根拠

`.team/artifacts/A019-token-pool-design.md` 参照。

## サブコマンド

### token add（対話式）

```bash
$ cmux-team token add
source:
  [1] Claude Code credential (~/.claude/.credentials.json)
  [2] 手動入力（token を貼り付け）
> 1

Found credential:
  organizationId: cd8db5e8-05fb-4aef-bb8c-17bb78e24406
  rateLimitTier: default_claude_max_20x  → plan: max-x20 (ratio 20.0)

display name (例: personal, kddi-dev): personal
  → handle: @pers  ← 重複時はエラー終了

tags (comma-separated, 例: any / oss-only / org:kddi): any

Registered: @pers  max-x20  tags:[any]  ✓
```

credential 自動取得の rateLimitTier → plan 変換:
- `default_claude_max_20x` → max-x20 (20.0)
- `default_claude_max_5x`  → max-x5  (5.0)
- `default_claude_pro`     → pro     (1.0)
- その他                  → unknown (NULL)

### token list

```
HANDLE   PLAN     TAGS       SELECTABLE  CAP      UTIL_5H  UTIL_7D  NEXT_RESET
@pers    max-x20  any        yes         100%      10%      30%      5h @ 14:30
@kddi    max-x20  org:kddi   yes          40%      82%      60%      7d @ Apr 27
@auto    unknown  auto       no           --        8%      20%      5h @ 12:00
```

### token remove @handle

確認プロンプト → tokens.db から削除 + Keychain から削除

### token rotate @handle

```bash
$ cmux-team token rotate @pers
新しい token を貼り付け（または [1] credential ファイルから再取得）:
> [1]
Keychain の token を更新し、auth_hash を更新しました。  ✓
```

organization_id は変わらないのでレコードはそのまま更新（handle / tags は維持）

### token set-plan @handle <plan>

plan_ratio が NULL（unknown）のアカウントに plan を後付けで設定する。

## 配置

- `bin/cmux-team` の token サブコマンド群に追加
- or `skills/cmux-team/manager/token-cli.ts`（main.ts からルーティング）

## 検証

- `cmux-team token add` で credential 自動取得 → DB + Keychain に登録されること
- `cmux-team token list` で pool_capacity が正しく表示されること
- `cmux-team token remove @pers` で DB + Keychain 両方から削除されること
- `cmux-team token rotate @pers` で auth_hash が更新されること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-319-1777097734/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/319-cmux-team-token-add-list-remove-rotate-set-plan-cli/runs/task-319-1777097734
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/319-cmux-team-token-add-list-remove-rotate-set-plan-cli/runs/task-319-1777097734/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
