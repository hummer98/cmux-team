# タスク割り当て

## タスク内容

---
id: 349
title: token add/promote/rotate で rateLimitTier 取得失敗時に plan を対話入力させる
priority: medium
created_by: surface:56
created_at: 2026-04-26T13:00:53.678Z
---

## タスク
## 背景

現状、`cmux-team token add` / `token promote` / `token rotate` の source=2（手動入力）では `rateLimitTier` が取得できないため `plan` が `unknown` のまま登録され、capacity 計算に乗らない。ユーザーは登録後に毎回 `cmux-team token set-plan @xxx <plan>` で訂正する 2 ステップ運用を強いられる（ヒントログは出るが UX として悪い）。

source=1 でも probe で `rateLimitTier` が取れない rare case では同様の状態になりうる。

## 期待動作

`rateLimitTier` が取れず `plan = "unknown"` になりそうな場合のみ、登録確定前に追加 prompt を表示する:

```
plan (pro / max-x5 / max-x20, Enter で unknown): 
```

- 入力値が `pro` / `max-x5` / `max-x20` のいずれか → 対応 ratio で `plan` / `plan_ratio` を確定
- 空 Enter → 既存挙動どおり `unknown` / `plan_ratio=NULL` のまま登録（後で `set-plan` で訂正可能）
- 不正値 → エラー文言「pro / max-x5 / max-x20 のいずれかを入力してください（空 Enter で unknown）」を出して再入力させる（または exit 1）

`rateLimitTier` が取れたケースは既存挙動を維持（prompt を表示しない）。

## 影響箇所

`skills/cmux-team/manager/token-cli.ts`:

- `cmdTokenAdd`（L106 付近）
- `cmdTokenPromote`（L484 付近）
- `cmdTokenRotate`（要確認、source=2 経路があるか）

`PLAN_MAP` 由来の plan/ratio 解決ロジックを「rateLimitTier 経由」と「対話入力経由」の両方が通る形に統合（重複しない実装にする）。

## 設計判断ポイント

- prompt 文言: 既存 UI の語感に合わせる（"display name" / "tags" の prompt と同列）
- 完了メッセージのヒント文（`Hint: plan が unknown です...`）は plan 確定時には出さない、unknown のままなら従来どおり出す
- `--non-interactive` のような batch 経路は現状なさそうなので考慮不要（CI で使うなら別タスクで議論）

## テスト

`token-cli.test.ts` に追加:

- T1: source=2 で `max-x20` を入力 → plan/ratio が正しく保存される
- T2: source=2 で空 Enter → plan=unknown（既存挙動維持）
- T3: source=2 で不正値 → エラー再入力 or exit 1（実装方針次第）
- T4: source=1 で rateLimitTier 取れた場合は prompt が出ない（既存挙動）
- T5: promote / rotate でも同様の prompt が出る

## やらないこと

- `set-plan` 自体の挙動変更
- 既存の rateLimitTier → plan map（PLAN_MAP）の改変
- non-interactive モードの新設


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-349-1777208453` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-349-1777208453
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-349-1777208453/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/349-token-add-promote-rotate-ratelimittier-plan/runs/task-349-1777208453
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/349-token-add-promote-rotate-ratelimittier-plan/runs/task-349-1777208453/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
