# タスク割り当て

## タスク内容

---
id: 341
title: auto-discover gate + token promote コマンド追加
priority: high
created_by: surface:125
created_at: 2026-04-26T07:30:36.691Z
---

## タスク
## 背景

cmux-team の token pool 仕様 (`docs/spec/09-token-pool.md`) は 3 階層 opt-in（env / project / global、未指定 = false）で機能を ON/OFF する設計だが、proxy 経由の auto-discover は **pool 設定に関わらず常に走る**。

実装上の根拠：
- `skills/cmux-team/manager/main.ts:705` で proxy は無条件に起動
- `skills/cmux-team/manager/proxy.ts:91` の `updateTokensDB` は pool 設定を見ず、authHash 不一致 + organization_id あり → そのまま `auto-discover` で INSERT

このため発生する不具合：
1. **opt-in 原則の破壊** — pool OFF の project でも `claude` が動くだけで tokens.db に INSERT される
2. **migration 不可能** — auto-discover で登録された token を削除しても、Manager/Conductor の API call で即座に再登録される。organization_id UNIQUE 制約により `cmux-team token add` で正規 handle に置き換えできない（実例: 本リポで `@cd8d` を 2 回 remove しても都度復活し、`@kddi` として正規登録不可）
3. **token rotate 時の残骸** — auth_hash 変化のたびに新規 INSERT されるリスク

## ゴール

opt-in 原則を回復し、auto-discover で登録された token を正規 handle に migration できるようにする。

## 対応

### (1) auto-discover gate

`updateTokensDB` (proxy.ts:91) の auto-discover 分岐 (line 144-158) に `isTokenPoolEnabled` チェックを追加する：
- pool 機能 OFF → auto-discover skip（usage tracking の既知 token snapshot 更新は **維持**）
- pool 機能 ON → 従来通り INSERT

判定タイミングは proxy 起動時に 1 度キャッシュ + spawn-agent 経路と同じ「PROJECT_ROOT 解決」を使う。proxy.ts は PROJECT_ROOT を `startProxy(PROJECT_ROOT, ...)` で受け取っているのでそれを使う。

### (2) `cmux-team token promote` コマンド

auto-discover 登録済みの token を正規昇格する CLI を追加。

```
cmux-team token promote @<auto-handle> <new-display-name>
```

処理内容：
- 対話式で token 文字列を取得（`token add` と同じ source 選択 UI: claude credential / 手動入力）
- 取得した token の auth_hash と DB 既存の `organization_id` が一致することを検証（不一致なら error）
- `tokens.tokens` レコードを更新：
  - `handle` を `@<new-display-name の先頭 4 文字>` に変更
  - `auth_hash` を新しい token のものに更新（既存と同じはずだが念のため）
  - `plan` / `plan_ratio` を `/v1/models` probe で取得 (`token add` と同じロジック)
  - `tags` を対話で再取得（デフォルト: `any`）
  - `selectable` を `1` に
  - `credential_source` を `manual` または `claude-credentials` に
- macOS Keychain に handle / token を登録
- 既存 `usage_snapshots.token_id` 参照は `token_id` を維持するので壊れない

新 handle が既存と衝突する場合は error。

### 受け入れ条件

1. **AC1**: pool OFF の project（`.team/config.json` に tokenPool 設定なし、`~/.cmux-team/config.yaml` も無し、env も無し）で `claude` を動かしても tokens.db に新規 INSERT されない
2. **AC2**: pool ON の project では従来通り auto-discover が走る
3. **AC3**: auto-discover で登録された `@cd8d` に対して `cmux-team token promote @cd8d kddi` を実行すると、selectable=1 / handle=@kddi / plan 設定済み / Keychain 登録あり に変わる
4. **AC4**: promote 前後で `usage_snapshots` が壊れない（token_id が維持される）
5. **AC5**: pool OFF 状態でも proxy の usage tracking（既知 token の snapshot 更新）は機能する

### テスト

- `proxy.test.ts` に「pool OFF の状態で未知 authHash + organization_id を流しても INSERT されない」テスト追加
- `token-cli.test.ts` 新規 or 既存に promote コマンドのテスト追加（in-memory keychain stub を使う既存パターンに倣う）

### ドキュメント

- `docs/spec/09-token-pool.md` の auto-discover 節に「pool 機能 OFF では走らない」明記
- `token promote` コマンドのリファレンス追加

## 参考

- 現リポでの実例調査: `@cd8d` (organization_id=cd8db5e8...) は pod-d 認証の auto-discover 残骸。Manager 稼働中に削除しても即復活することを実機確認済み
- 関連 Artifact: `.team/artifacts/A019-token-pool-design.md`、`.team/artifacts/A020-token-pool-probe.md`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-341-1777188656` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-341-1777188656
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-341-1777188656/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/341-auto-discover-gate-token-promote/runs/task-341-1777188656
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/341-auto-discover-gate-token-promote/runs/task-341-1777188656/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
