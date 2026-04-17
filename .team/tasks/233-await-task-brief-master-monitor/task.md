---
id: 233
title: await-task --brief フラグ追加と Master テンプレートに Monitor 起動ルール追加
priority: medium
created_at: 2026-04-17T00:25:35.806Z
---

## タスク
# 背景

Master ロールが `cmux-team create-task --status ready` で投げたタスクの動向を、毎回 `cmux-team status` を叩かず受動的に把握できる仕組みが欲しい。

設計方針: ready 作成直後に Monitor ツール（バックグラウンド、stdout 1 行 = 1 イベント）で `cmux-team await-task --task-id NNN --brief` を起動し、closed 時に 1 行流入させる。

**便利機能であり取りこぼしても問題ない。** フォールバック・例外処理・ケースフォローは最小限に留めること。

依存チェーンは末端 ID だけ Monitor すれば十分（中間状態は Manager が自動解決）。

# 実装内容

## 1. `cmdAwaitTask` に `--brief` フラグ追加

**File:** \`skills/cmux-team/manager/main.ts\`

\`printSummaries\` (L2845) に brief 分岐を追加。

**brief 時の出力（closed のみ対象、stdout 1 行）:**
\`\`\`
[T<id> closed] <title> — <summary.md の先頭 120 字>
\`\`\`

- title は \`findTaskFile()\` → \`parseTaskMeta()\` で取得
- summary.md があればそのまま先頭 120 字をスライス（ヘッダ判定や空行スキップはしない）
- title 取得 / summary 読み込みに失敗したら **その項目を省くだけ**（フォールバック値や \`(no summary)\` は出さない）
- aborted / timeout は **brief でも既存挙動のまま**（stderr + exit 1/2、Monitor の exit code 通知に乗る）

既存の non-brief 動作は変更しない。

## 2. ヘルプ更新

**File:** \`skills/cmux-team/manager/i18n.ts\`

\`help_await_task\` (en L539, ja L1107 付近) の Options に追加:
\`\`\`
  --brief                 print one-line summary (for Monitor tool)
\`\`\`

## 3. Master テンプレートに Monitor 起動ルールを追加

**Files:**
- \`skills/cmux-team/templates/ja/master.md\`
- \`skills/cmux-team/templates/en/master.md\`

**追加内容（L108 直後に短い段落）:**

> **投入後の追跡（任意）:** ready 作成後、Monitor ツールで
> \`cmux-team await-task --task-id NNN --brief\` をバックグラウンド起動しておくと、
> closed 時に 1 行が会話に流入して受動的に把握できる。便利機能なので必須ではない。
> 依存チェーンは末端 ID だけで十分。

L135 の「\`await-task\` は不要」という記述は **触らない**（フォアグラウンド待機が不要なのは引き続き正しい。Monitor は別の使い方として共存）。

# 修正ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| \`skills/cmux-team/manager/main.ts\` | \`printSummaries\` に brief 分岐を 1 ブロック追加 |
| \`skills/cmux-team/manager/i18n.ts\` | help_await_task に \`--brief\` の 1 行追加（en/ja） |
| \`skills/cmux-team/templates/ja/master.md\` | Monitor 起動ルールの段落追加 |
| \`skills/cmux-team/templates/en/master.md\` | 同上（英訳） |

# 再利用する既存資産

- \`parseTaskMeta()\` (\`skills/cmux-team/manager/task.ts:48\`) — title 取得
- \`findTaskFile()\` (\`skills/cmux-team/manager/main.ts:278\`) — タスクファイル解決
- \`hasFlag()\` (\`skills/cmux-team/manager/main.ts:201\`) — フラグ解析
- 既存の watcher / fs.watch ロジック (\`cmdAwaitTask\` L2605-2685) はそのまま

# 検証方法

1. **ビルド:** \`cd skills/cmux-team/manager && bun install\`
2. **brief 出力:** \`cmux-team await-task --task-id <既存closed> --brief\` で 1 行出ることを確認
3. **既存挙動非破壊:** \`--brief\` なしで従来のフル summary が変わらないことを確認
4. **Monitor 経由 E2E:** \`create-task --status ready\` → Monitor で await-task 起動 → closed で 1 行流入を確認

# やらないこと（過剰実装の禁止）

便利機能であり取りこぼしても問題ない。以下は実装しない:

- summary 抽出のヘッダ skip / 空行 skip / 改行整形（先頭 120 字スライスのみ）
- title / summary 取得失敗時のフォールバック値（省略する）
- aborted / timeout の brief 用ハンドリング（既存 stderr のまま）
- depends-on 中間タスクの追跡
- PushNotification
- Monitor 自動起動（Master の手動呼び出しのまま）

# 完了時

通常通り main にマージし、CHANGELOG / docs/spec/ への追記が必要かは Conductor が判断する（master.md の変更はテンプレート編集なのでランタイムプロンプト再生成は cmux-team start 次回起動時に行われる）。
