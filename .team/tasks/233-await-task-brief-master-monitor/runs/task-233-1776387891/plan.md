# T233 実装計画: `await-task --brief` + Master テンプレ Monitor ルール

## 1. 課題分析

### 現状の `cmdAwaitTask` / `printSummaries` 挙動

**`cmdAwaitTask`** (`skills/cmux-team/manager/main.ts` L2605–2685)
- `--task-id <id>`（カンマ区切り複数可）と `--timeout`（デフォルト 3600s）を受ける
- `loadTaskState()` で現在状態を確認し、`aborted` なら stderr + `process.exit(1)`、全 `closed` なら `printSummaries()` → `exit(0)`
- 残りは `fs.watch(task-state.json)` で closed 検出 → `printSummaries()` → `exit(0)`、aborted 検出 → stderr + `exit(1)`、timeout → stderr + `exit(2)`
- **Monitor ツール側の契約**: stdout 1 行 = 1 イベント / exit code で結果判定可能という前提と既に整合

**`printSummaries`** (L2844–2887)
- 各 taskId について:
  1. `findTaskFile(id)` (L278) で `.team/tasks/NNN-slug/task.md` or `.team/tasks/NNN-*.md` を検索
  2. タスクディレクトリ形式なら `runs/` 配下の最新 `task-<id>-*` の `summary.md` を `console.log` でダンプ
  3. なければ `task-state.json` の `journal` を出力
  4. それも無ければ `"Task <id>: closed (no summary available)"` を出力
- 複数タスク時は `--- Task <id> ---` セパレータを挿入

### brief 出力で必要な情報源

| 情報 | 取得元 | API |
|------|--------|-----|
| title | `.team/tasks/NNN-*/task.md` の frontmatter | `findTaskFile(id)` → `readFile` → `parseTaskMeta(content, fileName, filePath)` |
| summary（先頭 120 字） | `.team/tasks/NNN-*/runs/task-<id>-*/summary.md` | `printSummaries` 内の既存ロジックと同じ探索 |

`parseTaskMeta` は `skills/cmux-team/manager/task.ts` L48 の export。現在 `main.ts` の import (L43) には含まれていないため追加が必要。

## 2. 技術アプローチ

### フラグ解析

- `hasFlag("brief")` (main.ts L201) を `cmdAwaitTask` 冒頭で評価
- ローカル変数 `brief: boolean` として保持し、既存 `printSummaries(taskIds)` 呼び出し 2 箇所（L2640, L2674）を `printSummaries(taskIds, { brief })` に変更

### 分岐の挿入箇所

**`printSummaries` 内に `brief` 分岐を置く**（呼び出し側で分けない）。

理由:
- closed→summary 探索のパス（taskDir/runs/latest/summary.md）を二重実装しなくて済む
- 「複数タスク時のセパレータ」等の既存ルールは brief では不要 → 関数内で自然に分岐できる
- `cmdAwaitTask` 側の制御フロー（即時 closed パス / watch 経由 closed パス）を一切変えなくて済む

### brief 分岐のロジック（printSummaries 内）

```
for id in taskIds:
  taskFile = await findTaskFile(id)
  if !taskFile: continue                        # title も summary も不明 → 省略
  content = await readFile(taskFile, "utf-8")
  meta = parseTaskMeta(content, basename(taskFile), taskFile)
  title = meta?.title                           # 取れなければ undefined
  summaryHead = ""
  taskDir = taskFile.endsWith("/task.md") ? dirname(taskFile) : null
  if taskDir:
    runsDir = join(taskDir, "runs")
    if existsSync(runsDir):
      runs = await readdir(runsDir)
      sorted = runs.filter(r => r.startsWith(`task-${id}-`)).sort()
      latest = sorted.at(-1)
      if latest:
        summaryPath = join(runsDir, latest, "summary.md")
        if existsSync(summaryPath):
          summaryHead = (await readFile(summaryPath, "utf-8")).slice(0, 120)

  # 組み立て — 取得失敗した項目は「省くだけ」
  parts = [`[T${id} closed]`]
  if title:       parts.push(title)
  if summaryHead: parts.push(`— ${summaryHead}`)
  console.log(parts.join(" "))
```

**厳守ルール（タスク指示より）:**
- summary は `slice(0, 120)` のみ。ヘッダ判定・空行スキップ・改行整形はしない
- title / summary いずれか失敗しても `(no summary)` 等のフォールバックを **出さない**
- journal へのフォールバックもしない（non-brief のみの挙動）

### aborted / timeout の brief 挙動

- **変更なし**。`printSummaries` 到達前の `cmdAwaitTask` 本体で `process.exit(1)` / `exit(2)` するため、brief フラグは影響しない
- stderr + exit code で Monitor ツールは異常終了として通知する（既存契約）

## 3. 変更対象

| # | File | 変更概要 | 行範囲 |
|---|------|---------|--------|
| 1 | `skills/cmux-team/manager/main.ts` | `parseTaskMeta` を import に追加 | L43 |
| 2 | `skills/cmux-team/manager/main.ts` | `cmdAwaitTask` 冒頭で `brief = hasFlag("brief")` | L2606 直後 |
| 3 | `skills/cmux-team/manager/main.ts` | `printSummaries(taskIds)` 呼び出し 2 箇所に `{ brief }` を渡す | L2640, L2674 |
| 4 | `skills/cmux-team/manager/main.ts` | `printSummaries` シグネチャを `(taskIds, opts?: { brief?: boolean })` に拡張し、brief 分岐を先頭に追加 | L2844–2887 |
| 5 | `skills/cmux-team/manager/i18n.ts` | 英語 `help_await_task` の Options に `--brief` 行追加 | L545–548 付近 |
| 6 | `skills/cmux-team/manager/i18n.ts` | 日本語 `help_await_task` の Options に `--brief` 行追加 | L1113–1116 付近 |
| 7 | `skills/cmux-team/templates/ja/master.md` | L108 直後に Monitor 起動ルール段落挿入 | L109 |
| 8 | `skills/cmux-team/templates/en/master.md` | L108 直後に Monitor 起動ルール段落挿入（英訳） | L109 |

### 7/8 で挿入する段落

**ja:**
> **投入後の追跡（任意）:** ready 作成後、Monitor ツールで `cmux-team await-task --task-id NNN --brief` をバックグラウンド起動しておくと、closed 時に 1 行が会話に流入して受動的に把握できる。便利機能なので必須ではない。依存チェーンは末端 ID だけで十分。

**en:**（ja の意図を保った自然な英訳。`await-task` / `Monitor` / `ready` 等の固有名詞はそのまま。末尾 ID = leaf ID という意味を明示）
> **Optional follow-up tracking:** After setting a task to ready, you may launch `cmux-team await-task --task-id NNN --brief` via the Monitor tool in the background. A one-line update flows into the conversation when it closes, so you can track it passively. This is a convenience — not required. For dependency chains, the leaf task ID is enough.

L135（ja/en 双方の「`await-task` は不要」記述）は **触らない**。

## 4. サブタスク分割

1. **main.ts の import に `parseTaskMeta` 追加**
   - 対象: `skills/cmux-team/manager/main.ts` L43
   - 完了条件: `rg -n "parseTaskMeta" skills/cmux-team/manager/main.ts` で import 行 + 使用箇所 1 以上が出る
   - 検証: `rg "import.*parseTaskMeta" skills/cmux-team/manager/main.ts`

2. **`cmdAwaitTask` に brief フラグ抽出を追加**
   - 対象: main.ts L2605–2609 付近
   - 完了条件: `const brief = hasFlag("brief")` 追加
   - 検証: `rg -n 'hasFlag\("brief"\)' skills/cmux-team/manager/main.ts`

3. **`printSummaries` シグネチャ拡張 + brief 分岐実装**
   - 対象: main.ts L2844–2887
   - 完了条件:
     - 第2引数 `opts?: { brief?: boolean }` 追加
     - brief=true の場合: `[T<id> closed] <title> — <summary head 120>` 形式で 1 行出力
     - title/summary 取得失敗は **省略**（`(no summary)` 等を出さない）
     - brief=false の場合: 既存挙動（セパレータ・journal フォールバック・`no summary available` メッセージすべて維持）
   - 検証:
     - `rg -n "opts.*brief" skills/cmux-team/manager/main.ts`
     - `rg -n "closed\]" skills/cmux-team/manager/main.ts` で新ログ文字列を確認

4. **`printSummaries` 呼び出し 2 箇所に brief を伝播**
   - 対象: main.ts L2640, L2674
   - 完了条件: 両方 `await printSummaries(taskIds, { brief })`
   - 検証: `rg -n "printSummaries\(taskIds" skills/cmux-team/manager/main.ts` で 2 件とも `{ brief }` 付き

5. **i18n.ts の help_await_task に `--brief` 行追加（英語）**
   - 対象: skills/cmux-team/manager/i18n.ts の en ブロック L545–548 付近
   - 完了条件: `--brief                 print one-line summary (for Monitor tool)` が `--timeout` の次に入る
   - 検証: `rg -n "\\-\\-brief" skills/cmux-team/manager/i18n.ts`（2 件以上ヒット）

6. **i18n.ts の help_await_task に `--brief` 行追加（日本語）**
   - 対象: i18n.ts の ja ブロック L1113–1116 付近
   - 完了条件: 日本語 Options の `--timeout` 次行に `--brief` 行が入る（訳例: `Monitor ツール向けに 1 行サマリーを出力`）
   - 検証: 同上

7. **`skills/cmux-team/templates/ja/master.md` に Monitor 起動段落追加**
   - 対象: L108 直後（L109 相当）
   - 完了条件: 指示どおりの段落（上記 §3 参照）を挿入
   - 検証: `rg -n "Monitor ツール" skills/cmux-team/templates/ja/master.md`

8. **`skills/cmux-team/templates/en/master.md` に Monitor 起動段落追加**
   - 対象: L108 直後
   - 完了条件: 英訳段落を挿入
   - 検証: `rg -n "Monitor tool" skills/cmux-team/templates/en/master.md`

9. **型チェック**
   - 検証: worktree ルートで `cd skills/cmux-team/manager && bunx tsc --noEmit`
   - 完了条件: 新規エラーなし（baseline と同じ）

10. **動作確認（手動、軽量）**
    - worktree 内で `bun skills/cmux-team/manager/main.ts await-task --help` を叩き `--brief` が Options に表示されること
    - `summary.md` のある既存 closed タスクを使って `bun .../main.ts await-task --task-id <closed-id> --brief` が 1 行出力して exit 0 になること

## 5. リスク

| # | リスク | 対策 |
|---|-------|------|
| R1 | 既存 non-brief 呼び出し（他 CLI 等）が `printSummaries(taskIds)` を呼んでいて引数追加で壊れる | `opts?: { brief?: boolean }` を **optional** にする。`rg "printSummaries\b" skills/cmux-team/manager` で他呼び出しがないことを確認済み（使用は `cmdAwaitTask` 内の 2 箇所のみ） |
| R2 | aborted / timeout で brief 用のフォーマットが出てしまい Monitor の「成功」とまぎれる | `printSummaries` は closed 判定後にしか呼ばれない。aborted/timeout は `cmdAwaitTask` 本体で stderr + `exit 1/2` するため brief 分岐に入らない。タスク指示 §2 の「既存挙動のまま」と一致 |
| R3 | `findTaskFile` が見つけても frontmatter が古く title が空文字 | `parseTaskMeta` は `title ?? ""`。空文字は truthy でないため `if (title) parts.push(title)` で自動省略 |
| R4 | summary.md の先頭 120 字に改行が含まれ、Monitor が「2 行」とみなす | `slice(0, 120)` 後に `\n` を含む可能性あり。しかしタスク指示で「改行整形はしない」と明記。かつ `console.log` は単一呼び出しでも内部改行を含む。Monitor 側は「stdout 1 行 = 1 イベント」のため実害は出るが、**指示に従い追加処理しない**（過剰実装禁止 §2） |
| R5 | ランタイムプロンプト (`.team/prompts/master.md`) を直接書き換えてしまう | テンプレートのみ編集。CLAUDE.md の「プロンプト編集ルール」に従う。ランタイム更新は次回 `cmux-team start` で再生成される |

## 6. 既存型エラーの先読み

- worktree ルートで `cd skills/cmux-team/manager && bunx tsc --noEmit` を実行 → 現時点で **エラー出力なし**（exit 0）
- `main.ts` / `i18n.ts` 単独の baseline エラーも **該当なし**
- 本実装の追加箇所（`parseTaskMeta` 追加 import、`opts?: { brief?: boolean }`、`basename` 使用）は既存シンボルで賄える
- 新規 import 予定: `parseTaskMeta`（`./task` から）。`basename` は既に `import { ... basename ... } from "path"` で使われている前提を Subtask 1 の実装時に確認し、なければ同時に追加

## 7. Decision Log

### D1: brief 分岐を `printSummaries` 内に置く（呼び出し側で分けない）
- **理由**: closed→summary ファイル探索ロジック（taskDir/runs/latest/summary.md）を複製せずに済む。`cmdAwaitTask` 側の制御フロー（既に 2 箇所から `printSummaries` を呼ぶ watcher + 即時パス）を変えずに済み、差分が最小
- **代替案**: 独立関数 `printBriefSummaries` を作る → 探索ロジック重複のため却下

### D2: `--brief` は closed 時のみ 1 行出力、aborted/timeout はそのまま
- **理由**: タスク指示 §2 で明示。Monitor ツールは stderr 出力 + exit 1/2 で異常を通知するため、brief 固有ハンドリングは不要
- **副次効果**: 既存の non-brief 動作と exit code が完全に一致するため、単純な `--brief` 追加で済む

### D3: title / summary 取得失敗は省略し、フォールバック値を出さない
- **理由**: タスク指示 §2「`(no summary)` は出さない」「その項目を省くだけ」。便利機能であり取りこぼし許容（memory: `best-effort features`）
- **帰結**: 最悪 `[T123 closed]` だけの 1 行になる。これで十分通知になる

### D4: summary.md は `slice(0, 120)` のみ、改行・空行整形しない
- **理由**: タスク指示 §「やらないこと」で明示禁止。過剰実装の回避
- **帰結**: summary の先頭に YAML frontmatter や見出しがあればそのまま 120 字に入る。許容

### D5: ランタイムプロンプトは触らない（テンプレートのみ編集）
- **理由**: CLAUDE.md「プロンプト編集ルール（厳守）」。テンプレート = source of truth
- **帰結**: 本タスクの実装者は `.team/prompts/master.md` を編集しない。次回 `cmux-team start` 実行時に自動再生成される

### D6: 英語テンプレートは自然な英訳で対応（日本語の直訳ではない）
- **理由**: 既存 en/master.md は英語ネイティブ向けに自然な言い回し。直訳すると読みづらい
- **帰結**: §3 の en 段落案を採用。leaf task ID / convenience 等の語彙を使う
