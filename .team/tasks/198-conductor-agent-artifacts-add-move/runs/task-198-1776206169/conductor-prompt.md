# タスク割り当て

## タスク内容

---
id: 198
title: Conductor/Agent テンプレート見直し + artifacts add を move 化（ドキュメント集約）
priority: medium
created_at: 2026-04-14T22:03:41.724Z
depends_on: [197]
---

## タスク
# 背景

KDG-discord-listner T026（調査タスク: Discord 短音声 ASR ハルシネーション対策）で以下が観測された:

- タスク本文にリテラルパス `artifacts/transcription-best-practices.md` と「artifact 作成のみ」と指示
- Conductor は `role=impl` で Agent を spawn し、project-level の `artifacts/` に直接書き込み
- Conductor の Step 6「調査系なら summary.md を artifact 化」は skip された
- 結果、`.team/artifacts/A003` は後から Master が手動登録（`author: master`）
- **project-level `artifacts/` と `.team/artifacts/` に同じ内容が二重登録され、ドキュメントが分散**

## 問題の構造

### ① `conductor-role.md` Step 6 が summary.md 縛り

`skills/cmux-team/templates/{ja,en}/conductor-role.md` の Step 6（ja 版 L267-292）は「summary.md を `cmux-team artifacts add` で登録する」としか書いていない。調査レポートが summary.md 以外のファイルに分離している場合、レポート本体を登録する経路がなく、artifact 登録ごと skip される。

### ② Researcher テンプレート（`researcher.md`）が死文化

`conductor-role.md` の複雑度分岐では「調査系 = 軽微」と判定され Implementer 単独経路に流れる。`skills/cmux-team/templates/{ja,en}/researcher.md` を `role=researcher` で spawn する経路が存在せず、T026 では researcher.md は一度も参照されなかった。

### ③ Agent の出力先ルールが曖昧

Agent がタスク本文の指示に従って project-level `artifacts/` や任意のパスに直接書き込める。結果、Conductor が後段で move しようとすると git 履歴が汚れる（既存コミットに古いパスが残る）。

### ④ `cmux-team artifacts add` がコピー（move ではない）

`skills/cmux-team/manager/artifact.ts:215` は `writeFile` のみで元ファイルを残す。結果、登録しても元の場所にも残り続け、ドキュメントが分散する。

## 方針（ユーザー合意済み）

- **ドキュメントは `.team/artifacts/` に集約する**（分散させない）
- **`artifacts add` は常に move**（`--copy` エスケープハッチは作らない）
- **Agent は `/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169` にだけ書く**（project-level `artifacts/` も `.team/artifacts/` も Agent は触らない）
- **Conductor が commit 前に `artifacts add` で move** → worktree 内に `.team/artifacts/Axxx-<slug>.md` が現れる → それを `git add` してコミット → マージ
- これにより git 履歴が 1 コミットでクリーン、分散ゼロ

## 修正対象

### A. CLI の挙動変更（コア）

**`skills/cmux-team/manager/artifact.ts`**
- `writeFile(destPath, output, \"utf-8\")` の直後（L215 付近）に `await unlink(sourcePath)` を追加
- `fs/promises` から `unlink` を import 追加
- エラー時: `writeFile` が成功したあとに `unlink` が失敗した場合はログに警告を出すが CLI 全体は成功扱いにする（ユーザーが手動削除できる）
- 冒頭の JSDoc / CLI help (`main.ts` の `cmux-team artifacts add` ヘルプ文) に「move 動作」を明記
- `--copy` フラグは作らない

**完了条件:** `cmux-team artifacts add /tmp/test.md --type research --title \"Test\"` を実行し、`/tmp/test.md` が削除され `.team/artifacts/Axxx-test.md` が生成されることを確認。

### B. `conductor-role.md` Step 6 の拡張

`skills/cmux-team/templates/{ja,en}/conductor-role.md` の Step 6（ja 版 L267-292 相当、en 版も並行）:

- **「summary.md を artifact 化」縛りを撤廃**
- **調査系タスクの判定条件を明記**:
  - コード変更ゼロ（`git diff --cached --quiet` が true）
  - または、タスク本文に「調査」「artifact」「まとめ」「ベストプラクティス」「レポート」等のキーワード
  - または、`/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169` に summary.md 以外のレポート系ファイルが存在する
- **登録ルール**:
  - `/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169` にレポートファイル（例: `research.md`, `report.md` 等の命名）があればそれを最優先で登録
  - なければ summary.md を登録
- **`cmux-team artifacts add` が move になったことに対応**:
  - commit の **前に** `artifacts add` を実行する順序に変更
  - 登録後、worktree 内に `.team/artifacts/Axxx-<slug>.md` が現れるのでそれを `git add` してコミット対象に含める
- **プロジェクト独自の `artifacts/` フォルダ慣習の扱い**:
  - 非推奨とする方針を明記（cmux-team 配下プロジェクトでは `.team/artifacts/` のみを使う）
  - ただし既存のプロジェクト独自 `artifacts/` フォルダ内のファイルは Conductor/Agent が触らない（deprecated 扱い、手動マイグレーション）

### C. `conductor-role.md` フェーズ分岐に Researcher ロールを復活

`skills/cmux-team/templates/{ja,en}/conductor-role.md` の複雑度分岐（ja 版 L15-29 相当）:

- 「調査系」を新しいレベルとして追加するか、または「軽微」の中で調査系を分離
- 調査系判定時は **`role=researcher`** で Agent を spawn する経路を明示
- spawn コマンド例:
  \`\`\`bash
  cmux-team spawn-agent \\
    --conductor-surface \$CMUX_SURFACE \\
    --role researcher \\
    --task-title \"<リサーチトピック>\" \\
    --prompt-file \"\$PROMPT_FILE\"
  \`\`\`
- Plan/Design Review は skip、Phase 4 Inspection は継続（レポート品質チェック）
- ただし `cmux-team spawn-agent --role researcher` が現在対応しているか確認すること（対応していなければ追加実装が必要 — 本タスクのスコープ内で対応）

### D. `implementer.md` / `researcher.md` に出力先ルールを明記

`skills/cmux-team/templates/{ja,en}/implementer.md` と `skills/cmux-team/templates/{ja,en}/researcher.md`:

- 次の警告ボックスを追加:
  > **出力先のルール（重要）**
  > 
  > - 成果物は `/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169` 以下にのみ書く
  > - project-level の `artifacts/` フォルダには書かない（もし存在しても deprecated 扱い）
  > - `.team/artifacts/` にも書かない（Conductor が `cmux-team artifacts add` で登録する）
  > - タスク本文に `artifacts/foo.md` 等のリテラルパスが書かれていても、それは慣習的な指示であり、実際には `/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169/foo.md` に書くこと
  > - Conductor が完了処理で `cmux-team artifacts add` を実行し、`.team/artifacts/Axxx-<slug>.md` に move する
- 既存の「出力フォーマット」「Output」セクションがある場合はそこに統合

### E. ja/en 両方の並行更新

- `skills/cmux-team/templates/ja/conductor-role.md`
- `skills/cmux-team/templates/en/conductor-role.md`（または `en/conductor.md`）
- `skills/cmux-team/templates/ja/researcher.md`
- `skills/cmux-team/templates/en/researcher.md`
- `skills/cmux-team/templates/ja/implementer.md`
- `skills/cmux-team/templates/en/implementer.md`

片方だけ更新しないこと。

## スコープ外（やらない）

- PreToolUse hook で `.team/artifacts/*.md` への Write をブロックする案は **今回スコープ外**。プロンプト改善で様子を見る（ユーザー判断）
- 既存の project-level `artifacts/` フォルダのマイグレーション（手動対応）
- `cmux-team artifacts add` の `--copy` フラグ（作らない）

## 完了条件

- `skills/cmux-team/manager/artifact.ts` に move ロジック追加
- `cmux-team artifacts add /tmp/test.md` で元ファイルが削除されることを手動確認
- 6 ファイル（ja/en × 3 role テンプレート）の更新完了
- `conductor-role.md` Step 6 が調査系全般に拡張されている
- `conductor-role.md` フェーズ分岐で role=researcher 経路が明示されている
- `implementer.md` / `researcher.md` に出力先ルールの警告が追加されている
- `tsc --noEmit` でタッチしたファイルに新規エラーなし（T197 のルール先取り）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-198-1776206169` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-198-1776206169
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-198-1776206169/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/198-conductor-agent-artifacts-add-move/runs/task-198-1776206169/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
