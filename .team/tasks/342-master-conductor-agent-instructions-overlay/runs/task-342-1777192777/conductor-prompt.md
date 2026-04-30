# タスク割り当て

## タスク内容

---
id: 342
title: Master/Conductor にも agent-instructions overlay を効かせる
priority: medium
created_by: surface:125
created_at: 2026-04-26T08:30:28.688Z
---

## タスク
## 背景

現状の overlay 機構（`.team/agent-instructions/<role>.md` → テンプレートの `{{PROJECT_INSTRUCTIONS}}` プレースホルダに展開）は Agent 8 ロール専用：

- 対象ロール: `schema.ts:355` の `AgentRole` enum（researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager）
- 走査ロジック: `agent-instructions.ts:96` で `AGENT_ROLES` を for ループ
- Master / Conductor のテンプレートには `{{PROJECT_INSTRUCTIONS}}` プレースホルダ自体が無い（conductor テンプレート内に出てくる文字列は『Conductor が heredoc で Agent プロンプトを作る際に残せ』という指示であり、Conductor 自身の prompt には展開されない）

このため Master/Conductor のシステムプロンプト枠で project 固有の追加指示を入れる手段がない。CLAUDE.md は読まれるが、ロール別の重み付け／配置調整ができない。

## ゴール

Master / Conductor のテンプレートにも `{{PROJECT_INSTRUCTIONS}}` プレースホルダを追加し、`.team/agent-instructions/master.md` / `.team/agent-instructions/conductor.md` に書いた本文が展開されるようにする。

## 対応

### (1) schema 拡張

`schema.ts` に「overlay 対応ロール」用の enum を追加（既存 `AgentRole` は spawn-agent の型整合のため変更しない）:

```ts
export const OverlayRole = z.enum([
  ...AgentRole.options,
  "master",
  "conductor",
]);
export const OVERLAY_ROLES: readonly OverlayRole[] = OverlayRole.options;
```

`agent-instructions.ts` の走査・CLI バリデーションを `OVERLAY_ROLES` ベースに置き換える。spawn-agent の `--role` パーサは引き続き `AgentRole` のみを受け付ける（master / conductor が agent として spawn されないよう型で分離）。

### (2) テンプレートに placeholder 追加

- `skills/cmux-team/templates/{en,ja}/master.md` の冒頭（既存の Role 導入文の直後）に `{{PROJECT_INSTRUCTIONS}}` を 1 行独立で追加
- `skills/cmux-team/templates/{en,ja}/conductor.md` の冒頭に同様
- `skills/cmux-team/templates/{en,ja}/conductor-role.md` も対象（実体は `--append-system-prompt-file` で渡される）

ランタイムプロンプトへの展開は既存の `{{PROJECT_INSTRUCTIONS}}` 置換ロジックを再利用するだけで効く。

### (3) CLI 拡張

- `cmux-team get-agent-instructions --role master/conductor` を許可
- `cmux-team set-agent-instructions --role master/conductor --body ...` を許可
- `cmux-team delete-agent-instructions --role master/conductor` を許可
- 検証エラー時のメッセージで master / conductor も valid role として表示

コマンド名は現行 `agent-instructions` のまま（rename はしない）。実態は overlay 一般機構なので将来的に `role-instructions` 等への rename を検討するなら別タスク。

## 受け入れ条件

1. **AC1**: `.team/agent-instructions/master.md` を作成 → `cmux-team start` でランタイム `.team/prompts/master.md` の `{{PROJECT_INSTRUCTIONS}}` 部分が overlay 本文（i18n 見出し付き）に展開される
2. **AC2**: `.team/agent-instructions/conductor.md` でも同様に `.team/prompts/conductor-role.md` に展開される
3. **AC3**: overlay ファイルが存在しないロールは空文字に展開される（既存仕様維持）
4. **AC4**: `cmux-team get-agent-instructions --role master` / `set-agent-instructions --role conductor --body "x"` / `delete-agent-instructions --role master` が成功する
5. **AC5**: `cmux-team spawn-agent --role master` / `--role conductor` は **エラー**（既存 Agent ロールのみ）
6. **AC6**: 既存の Agent overlay 動作に regression が無い（`agent-instructions.test.ts` 既存ケースが pass）

## テスト

- `agent-instructions.test.ts` に master / conductor overlay の write/read/delete テスト追加
- テンプレートレンダリング側に `{{PROJECT_INSTRUCTIONS}}` が master/conductor templates でも置換されることのテスト追加
- `spawn-agent` の role parser に master/conductor が rejected されるテスト追加

## ドキュメント

- `docs/spec/04-templates.md` の overlay 仕様に master/conductor を追加
- `docs/spec/01-skill-cmux-team.md` の overlay 機構説明を更新
- README は overlay 章があれば更新（無ければ skip）

## 参考

- 関連実装: `skills/cmux-team/manager/agent-instructions.ts`、`skills/cmux-team/manager/schema.ts:355`、`skills/cmux-team/templates/{en,ja}/{master,conductor,conductor-role}.md`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-342-1777192777` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-342-1777192777
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-342-1777192777/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/342-master-conductor-agent-instructions-overlay/runs/task-342-1777192777
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/342-master-conductor-agent-instructions-overlay/runs/task-342-1777192777/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
