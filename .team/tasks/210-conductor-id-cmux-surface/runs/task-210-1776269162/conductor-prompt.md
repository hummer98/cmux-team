# タスク割り当て

## タスク内容

---
id: 210
title: CONDUCTOR_ID 環境変数の廃止（CMUX_SURFACE に一本化）
priority: medium
created_at: 2026-04-15T16:05:36.933Z
---

## タスク
## 背景

`CONDUCTOR_ID` 環境変数は cmdConductor / cmdResume で `surface` と同じ値が設定されており、`CMUX_SURFACE` と完全に重複している。過去の経緯（slot-id 時代の名残 / T150 で surface に一本化済み）で残っているが、現在は値が surface と同一で、daemon 側でも実質的に利用されていない。hook 引数やスキーマフィールドとして残っているが死に体のため整理する。

## 現状確認（調査済み）

**設定箇所（surface と同じ値）:**
- `skills/cmux-team/manager/main.ts:1370` — `cmdConductor`: `process.env.CONDUCTOR_ID = surface`
- `skills/cmux-team/manager/main.ts:1455` — `cmdResume`: 同上

**参照箇所:**
1. `main.ts:1306` — conductor-settings.json の `SessionEnd` hook (matcher: clear): `--conductor-id \"\$CONDUCTOR_ID\"`
2. `main.ts:1314` — 同 (matcher: logout|prompt_input_exit)
3. `main.ts:1134, 1142` — `DETECT_ASK_SCRIPT` (Stop hook forwarder): `CONDUCTOR_ID=\"\${CONDUCTOR_ID:-}\"` を読み SESSION_STOP に載せる
4. `skills/cmux-team/manager/statusline.sh:92` — team.json から task 情報を逆引きするキー
5. `skills/cmux-team/manager/schema.ts:81, 89, 100` — `SessionClearedMessage` / `SessionEndedMessage` / `SessionStopMessage` に `conductorId: z.string().optional()`

**実質的な死に体の根拠:**
- T203 m2 で **SessionStart hook の `--conductor-id` は既に削除済**（SessionStartedMessage schema に対応フィールドが無い）
- daemon 側で `message.conductorId` を分岐・利用する処理は無い。`daemon.ts:972` で SESSION_ASK 合成時に引き継ぐだけで、その後の処理も surface ベース
- `findConductor(state, message.surface)` など全ての解決は surface で行われている

## ゴール

- Conductor / Agent / Master の hook・メッセージ経路から `CONDUCTOR_ID` を完全に除去
- `CMUX_SURFACE` のみで識別する状態にする
- statusline の表示が壊れないこと（Conductor ペインで現在のタスク名が出続けること）

## 作業内容

1. **hook 引数の削除**
   - `main.ts:1306` SessionEnd(clear) hook から `--conductor-id \"\$CONDUCTOR_ID\"` を削除
   - `main.ts:1314` SessionEnd(logout) hook から同削除
   - 既存 Conductor が持つ `.team/prompts/conductor-settings.json` を再生成させる（次回 cmdConductor 起動で上書き）

2. **detect-ask.sh（DETECT_ASK_SCRIPT）の更新**
   - `main.ts:1134` の `CONDUCTOR_ID=\"\${CONDUCTOR_ID:-}\"` 行を削除
   - `main.ts:1140-1142` の SESSION_STOP メッセージ組み立てから `conductorId` フィールドを削除
   - jq 合成部分も連動修正

3. **schema の整理**
   - `schema.ts:81, 89, 100` の `SessionClearedMessage` / `SessionEndedMessage` / `SessionStopMessage` から `conductorId` フィールドを削除
   - 合わせて `daemon.ts:972` の SESSION_ASK 合成で `conductorId` を引き継ぐ行を削除
   - `main.ts:779-784` 付近の空文字正規化 (`if (o.conductorId === \"\") o.conductorId = undefined`) も不要になるので削除
   - `main.ts:929, 939` の `conductorId: getArg(\"conductor-id\")` 解析も削除（`--conductor-id` CLI 引数の受理も廃止）

4. **statusline.sh の切り替え**
   - `skills/cmux-team/manager/statusline.sh:92` で `CONDUCTOR_ID` を参照している箇所を `CMUX_SURFACE` に置き換え
   - team.json 内の `conductors[].surface` と突き合わせる設計なので、値が同じなら動作は変わらない
   - Conductor ペインで手動確認: 現在の task_id / task_title が statusline に表示されること

5. **環境変数セットの削除**
   - `main.ts:1370` の `process.env.CONDUCTOR_ID = surface` 削除
   - `main.ts:1455` の同削除

6. **テスト更新**
   - `main.test.ts:746, 756, 856` — `conductor_id` / `conductorId` フィールドを期待するアサーションの更新
   - `daemon.test.ts:1488` — `conductorId: \"task-010-xxx\"` を使うテストの更新
   - hook 経由メッセージの組み立てテストも修正

## 影響範囲 / リスク

- **他プロジェクトの .team/prompts/conductor-settings.json** は次回 cmdConductor 実行時まで古いまま残る可能性があるが、古い hook がまだ `\$CONDUCTOR_ID` を渡しても schema 側で optional を削ると zod パースエラーになる → **schema は最後に削る**（段階移行）
- 移行順序: (A) hook 引数削除 & 新 Conductor を起動させる → (B) 動作確認 → (C) schema / 環境変数 / statusline を削る
- 本番 (cmux-team 本体) 以外のクライアント（Dear, mado 等）も conductor-settings.json を再生成する必要がある — リリース後に `cmux-team start` を叩かせる

## 検証手順

1. 本リポジトリで `cmux-team start` し、Conductor を1つ起動
2. タスクを投げて assigned → closed まで一通り走ることを確認
3. SESSION_CLEAR / SESSION_ENDED / SESSION_STOP が manager.log に正常に記録されること
4. statusline に現在のタスク名が表示され続けること
5. `bun test` グリーン
6. タスクに `CONDUCTOR_ID` / `conductorId` が残っていないこと を grep で確認

## 参照

- 関連タスク: T150 (surface 一本化), T203 (SessionStart hook の conductor-id 引数削除)
- 確認済み grep: `rg -n CONDUCTOR_ID skills/cmux-team/manager`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-210-1776269162` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-210-1776269162
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-210-1776269162/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/210-conductor-id-cmux-surface/runs/task-210-1776269162
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/210-conductor-id-cmux-surface/runs/task-210-1776269162/summary.md` に書き出す。

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
