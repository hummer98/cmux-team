# T233 検品結果

## 判定: **GO**

plan §1–§7 と impl-notes の内容、実コードの差分、型チェック、動作確認すべて整合。仕様逸脱・既存動作破壊・型エラーいずれも検出されず。

補足: worktree 分岐元に T230 が入っていないため `git diff main -- ...` は T230 分の逆差分を含むが、`git diff HEAD -- ...` は T233 のみで綺麗に収まっている。本検品は HEAD 差分で評価した。

---

## A. 実装の正確性

| # | 項目 | 結果 | コメント |
|---|------|------|----------|
| 1 | `printSummaries` シグネチャ `(taskIds, opts?: { brief?: boolean })` | OK | main.ts L2846 で確認 |
| 2 | brief 分岐が plan §2 擬似コードに沿う | OK | title / summary 取得失敗 → 省略、両方失敗で `[T<id> closed]` 単独出力（L2880–L2883） |
| 3 | 既存 non-brief 動作が維持 | OK | L2887 以降の既存ループはそのまま。セパレータ（L2907–L2909）、journal フォールバック（L2918–L2924）、`no summary available`（L2926）すべて残存 |
| 4 | `cmdAwaitTask` の aborted / timeout が変更なし | OK | L2633–L2636（初期 aborted → stderr + exit 1）、L2650–L2654（timeout → stderr + exit 2）、L2665–L2670（watcher 内 aborted → stderr + exit 1）いずれも未改変 |
| 5 | 呼び出し 2 箇所に `{ brief }` 伝播 | OK | L2641（即時 closed パス）、L2675（watcher closed パス）両方に付与 |

## B. ヘルプ更新

| # | 項目 | 結果 | コメント |
|---|------|------|----------|
| 6 | en `help_await_task` Options に `--brief` 行 | OK | i18n.ts L548、`--timeout` の直後 |
| 7 | ja `help_await_task` Options に `--brief` 行 | OK | i18n.ts L1117、`--timeout` の直後 |
| 8 | フォーマット維持 | OK | インデント（列揃え）・改行とも既存行に準拠 |

## C. master.md テンプレート

| # | 項目 | 結果 | コメント |
|---|------|------|----------|
| 9 | ja/en 両方の L108 直後に Monitor 起動段落 | OK | ja L110 / en L110（L109 空行を挟んで挿入）|
| 10 | 段落文言が plan §3 通り | OK | ja/en とも完全一致 |
| 11 | L135 付近の「`await-task` は不要」記述が未改変 | OK | そもそも両テンプレートの L135 付近に該当文言は存在せず（Manager restart 手順のみ）。plan §3 の参照は現在のファイルに適用不能だが、「触らない」指示は自動的に遵守されている |
| 12 | ランタイム `.team/prompts/master.md` が未編集 | OK | `git status -uall` で変更ファイルは 4 つのみ、`.team/prompts/` は無変更 |

## D. 型・コンパイル

| # | 項目 | 結果 | コメント |
|---|------|------|----------|
| 13 | `bunx tsc --noEmit` 新規エラーゼロ | OK | EXIT=0 / 出力なし |
| 14 | import の整合性 | OK | `parseTaskMeta` は `./task` から L43 で import 追加済み。`basename` は L27 で既存 import 済み |

## E. 動作

| # | 項目 | 結果 | コメント |
|---|------|------|----------|
| 15 | `await-task --help` で `--brief` 行が表示 | OK | ja 表示で `--brief  Monitor ツール向けに 1 行サマリーを出力` を確認 |
| 16 | closed タスクで `--brief` が 1 行出力 + exit 0 | OK | T231（summary.md あり）= `[T231 closed] <title> — <summary head>` + EXIT=0、T230（summary.md なし）= `[T230 closed] <title>` + EXIT=0 を再現 |

## F. やらないことの遵守

| # | 項目 | 結果 | コメント |
|---|------|------|----------|
| 17 | summary の追加整形なし（slice(0, 120) のみ）| OK | L2872 で `content.slice(0, 120)` のみ。ヘッダ skip / 空行 skip / 改行整形いずれも未実装 |
| 18 | 取得失敗時のフォールバック文言なし | OK | `(no summary)` 等の placeholder は存在せず。`if (title) parts.push(...)` / `if (summaryHead) parts.push(...)` で省略するだけ |
| 19 | aborted / timeout の brief 用ハンドリングなし | OK | `printSummaries` 到達前に exit するため brief フラグは影響しない。専用コードも追加されていない |
| 20 | 意図しないファイル変更なし | OK | `git status -uall` で 4 ファイル（`i18n.ts`, `main.ts`, `templates/{en,ja}/master.md`）のみ。ランタイムプロンプト含め他は無変更 |

---

## 軽微な指摘（フォローアップ可）

- **summary 先頭の重複**: `summary.md` の冒頭が `# T<id> Summary: <title>` のため、brief 出力が `[T231 closed] <title> — # T231 Summary: <title>...` となり title が二重で見える。plan §3 の「slice(0, 120) のみ、整形禁止」方針に従っているため NOGO ではないが、将来的に `# T\d+ Summary: ` をスキップするか、`summary.md` 側のテンプレートを調整する選択肢あり（本タスクのスコープ外）。
- **summary に含まれる改行**: plan R4 に明記の通り Monitor が複数行とみなす可能性は残る。現状は指示通り加工しないで GO。

## 総合

- 実装は plan 通り、余計な追加なし（memory `best-effort features` / `no backward compat` の原則に合致）。
- 型・ビルド・ヘルプ表示・動作確認いずれも期待通り。
- ランタイムプロンプトへの直接書き込みなし。

**判定: GO**
