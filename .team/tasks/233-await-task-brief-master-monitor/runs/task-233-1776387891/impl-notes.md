# T233 実装ノート

## サブタスク結果

| # | サブタスク | 結果 |
|---|-----------|------|
| 1 | main.ts に `parseTaskMeta` import 追加 | 完了（`basename` は L27 で既に import 済み、追加不要） |
| 2 | `cmdAwaitTask` 冒頭に `const brief = hasFlag("brief")` | 完了（main.ts L2610） |
| 3 | `printSummaries` シグネチャ拡張 + brief 分岐実装 | 完了（main.ts L2846〜） |
| 4 | `printSummaries` 呼び出し 2 箇所に `{ brief }` 伝播 | 完了（main.ts L2641, L2675） |
| 5 | i18n.ts 英語 help_await_task に `--brief` 行追加 | 完了 |
| 6 | i18n.ts 日本語 help_await_task に `--brief` 行追加 | 完了 |
| 7 | `templates/ja/master.md` L108 直後に Monitor 起動段落追加 | 完了 |
| 8 | `templates/en/master.md` L108 直後に Monitor 起動段落追加 | 完了 |
| 9 | 型チェック | `bunx tsc --noEmit` エラーゼロ |
| 10 | 動作確認 | `--help` / `--brief` 出力いずれも期待通り |

## 型チェック結果

```
cd skills/cmux-team/manager && bunx tsc --noEmit
→ 出力なし（exit 0）
```

baseline と同じくエラーゼロ。

## 動作確認

### `--help` の Options

```
Options:
  --task-id <id>          タスク ID（必須、カンマ区切りで複数指定可: 108,109）
  --timeout <seconds>     タイムアウト秒数（デフォルト: 3600）
  --brief                 Monitor ツール向けに 1 行サマリーを出力
```

`--brief` 行が `--timeout` の次に追加されていることを確認。

### brief 出力例（T231: summary.md あり）

```
$ bun skills/cmux-team/manager/main.ts await-task --task-id 231 --brief
[T231 closed] close-agent コマンド追加と正常完了/強制終了の status 分離 — # T231 Summary: close-agent コマンド追加と正常完了/強制終了の status 分離

## 目的

Conductor が Agent 終了に一律 `kill-agent` を使っていた結果、正常完了も `age
EXIT=0
```

- `[T<id> closed] <title> — <summary head 120>` フォーマットで出力
- exit code 0

### brief 出力例（T230: summary.md なし・title のみ）

```
$ bun skills/cmux-team/manager/main.ts await-task --task-id 230 --brief
[T230 closed] Master の self-register 化（任意の pane から cmux-team spawn-master で追加可能に）
EXIT=0
```

- summary.md が無いケースで summary 部分が自動省略されることを確認
- title のみ付与

### 複数タスク（brief）

```
$ bun skills/cmux-team/manager/main.ts await-task --task-id 231,230 --brief
[T231 closed] close-agent コマンド追加と正常完了/強制終了の status 分離 — # T231 Summary: ...
[T230 closed] Master の self-register 化（任意の pane から cmux-team spawn-master で追加可能に）
EXIT=0
```

- 各タスク 1 行（ただし summary 先頭 120 字に改行を含む場合は複数行化する。plan R4 の通り意図した挙動）
- セパレータ `--- Task <id> ---` は brief では出力されない

## 想定外の事象・修正

特になし。

- `basename` は既に import 済みだったため追加不要（plan では「必要なら」と但し書き）
- summary の先頭に `# T231 Summary: ...` 見出しが含まれ、結果として「タイトル — # T231 Summary: ...」と冗長に見えるが、plan の「slice(0, 120) のみ、ヘッダ skip しない」方針に従い加工しない
- summary 内の改行で 1 行が複数行化する点も plan R4 の通り実装指示に従い整形しない

## 編集ファイル一覧

- `skills/cmux-team/manager/main.ts` — import 追加、`cmdAwaitTask` に brief フラグ、`printSummaries` brief 分岐
- `skills/cmux-team/manager/i18n.ts` — en/ja の help_await_task に `--brief` 行
- `skills/cmux-team/templates/ja/master.md` — L108 直後に Monitor 起動段落追加
- `skills/cmux-team/templates/en/master.md` — L108 直後に Monitor 起動段落追加（英訳）

`.team/prompts/master.md`（ランタイム）は編集していない。
