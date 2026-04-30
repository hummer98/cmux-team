# タスク割り当て

## タスク内容

---
id: 388
title: close-task --deliverable-kind=merged 後の origin sync を Master 担当に明文化 (#45)
priority: high
created_by: surface:141
created_at: 2026-04-29T13:18:00.988Z
---

## タスク
## 背景

issue #45 — Dear で 4/29 に `close-task --deliverable-kind=merged` 後の origin push 不在による diverge 連鎖事故が 3 回発生 (T328/T329 → PR #2110, T322 → PR #2112, T332 → PR #2113)。

## 方針

**案 D（Master 介在 + `await-task`）を採用**、案 A（close-task 内自動 push）は見送り。

理由:
- 実装が軽い（master.md への追記 + 禁止リスト緩和のみ、FSM 不変更）
- 設計原則「判断が必要なものは AI で」「上位が下位を監視する」に整合
- push 競合判断は局所では決定不能、Master 層が serialize するのが構造的に正しい
- 失敗時に「気づかれない」リスクが無い（Master が握っているため）

## 変更内容

### 1. `skills/cmux-team/templates/ja/master.md`

- **禁止リスト（現状 L62 付近）に例外明記**:
  - `merged` deliverable で closed 直後の以下は許可:
    - `git fetch origin <base>`
    - `git pull --ff-only origin <base>`
    - `git push origin <base>`（共有ブランチへの push を限定的に許可）
- **`await-task` 用途リスト（現状 L172–177）に追加**:
  - 「`merged` deliverable の completion を捕捉し、Master が dev sync (pull/push) を行うため」
- **新セクション「Deliverable sync プロトコル」を追加**:
  - 起票時 deliverable_kind の見極め（merged を選ぶケース vs pr を選ぶケース）
  - ready 直後に `cmux-team await-task --task-id N` を `Bash(run_in_background=true)` で起動
  - 完了通知受信時の分岐:
    - `closed (merged)` → `git fetch origin <base>` → `git pull --ff-only origin <base>` → `git push origin <base>`。失敗時は新タスク起票で rescue 委譲
    - `closed (pr)` → 何もしない（PR 起票で完結）
    - `aborted` → rescue 判断
  - 複数並行 merged の場合は逐次処理（Master が serialize すれば push 競合しない）

### 2. `skills/cmux-team/templates/en/master.md` にも同等内容を反映

### 3. `close-task --help` の Examples 更新

- `--deliverable-kind=merged` の例に「Master が await-task で sync 担当する前提」を 1 行追記

### 4. README の Master 役割にも追記

- 「Master の役割」段落に「`merged` deliverable の origin sync」を 1 項目追加

### 5. issue #45 をこの PR で close

## 受け入れ基準

- [ ] master.md (ja/en) の差分が PR 上で確認できる
- [ ] `cmux-team start` でランタイムプロンプトが再生成され、新セクションが反映される
- [ ] close-task --help / README の差分が一貫している
- [ ] Dear リポで軽微なテストタスクを起票し、案 D フローで origin sync が成功するまで動作確認
- [ ] PR description に issue #45 を `Closes #45` で紐付け

## 注意事項

- `merged` deliverable 自体を deprecated にはしない（既存運用を壊さない）
- 案 A（自動 push）は将来オプションとして余地を残す（このタスクでは実装しない）
- Master が落ちた / 別作業で詰まった場合の遅延検知（24h 以上 sync されてない closed タスクの WARN）はスコープ外、別タスクで追う


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-388-1777468681` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-388-1777468681
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-388-1777468681/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/388-close-task-deliverable-kind-merged-origin-sync-master-45/runs/task-388-1777468681
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/388-close-task-deliverable-kind-merged-origin-sync-master-45/runs/task-388-1777468681/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
