# T267 Inspection Report

## 判定: GO

## 確認結果

### 1. plan.md との整合性

計画通りに実装されている。主要決定事項をすべて遵守:

- **ヘルパー配置**: `task.ts` に `normalizeTaskId` / `normalizeTaskIdList` を追加・export（plan.md §2.1）
- **関数シグネチャ・エラーメッセージ**: `--depends-on must be positive integer task IDs. Got: "${raw}"` で固定（plan.md §2.2 / §2.4）
- **Invalid 判定基準**: `/^\d+$/` + `n >= 1`（`"0"` / `"000"` も reject）（plan.md §2.3）
- **空文字は `[]`**: update-task の「依存クリア」経路を維持（plan.md §2.5）
- **重複は保持**: dedup していない（plan.md §2.6）
- **4 桁以上はそのまま**: `padStart(3, "0")` の minLength 仕様に一致（plan.md §4.1）

逸脱なし。plan.md §6「CHANGELOG.md は close-task 時に Conductor が更新」の作業境界通り、CHANGELOG.md は未変更（これは Implementer 作業範囲外で正しい）。

### 2. コードレビュー

**`skills/cmux-team/manager/task.ts`** (L143-184):
- `normalizeTaskId`: `trim()` → `/^\d+$/` 検査 → `parseInt >= 1` 検査 → `padStart(3, "0")`。実装は仕様通り
- `normalizeTaskIdList`: `!raw` early return、`split(",").map(trim).filter(Boolean).map(normalizeTaskId)`。空要素 skip / 末尾カンマ許容が自然に実現される
- `Number.isFinite(n)` のチェックは `/^\d+$/` を通った後なので冗長だが、防御的で害なし
- JSDoc が具体的で読みやすい（issue #25 へのリンク、採用判断の理由まで記載）

**`skills/cmux-team/manager/main.ts`** (L43, L2561-2567, L2647-2653):
- import に `normalizeTaskIdList` を追加
- create-task / update-task の両方で try/catch で `console.error + process.exit(1)` 統一。既存の `RequiredFlagMissingError` と UX が揃っている
- エラー型は `any` で拾っているが、`Error` のみ throw する設計なので問題なし
- 変更範囲が最小限で、他の処理には影響なし

**エラー出力と exit code**: 手動検証で `Error: --depends-on must be positive integer task IDs. Got: "abc"` が stderr に出力され exit 1 を確認（下記 §4）。

**YAGNI**: 不要な抽象化・副作用なし。

### 3. テスト品質

`skills/cmux-team/manager/task.test.ts` に以下の 2 describe / 28 ケースが追加されており、plan.md §4 の観点を網羅している:

**`normalizeTaskId (T267)`** — 17 ケース:
- 正常 6 件: 1 桁 / 2 桁 / 3 桁（整形済み）/ 3 桁（非ゼロ）/ 4 桁 / 前後空白
- 異常 11 件: 英字 / 英数混在 / 小数 / 負数 / `+` 符号 / 16 進 / 指数表記 / ゼロ / `000` / 空文字 / 空白のみ

**`normalizeTaskIdList (T267)`** — 11 ケース:
- 正常 8 件: 空文字 / 単一 / 複数混在 / 前後空白 / 空要素 skip / 末尾カンマ / カンマのみ / 重複保持
- 異常 3 件: 末尾 invalid / 先頭 invalid / ゼロ混在

エラーメッセージまでアサートしており、回帰検知が強い。`toThrow` にメッセージ全文を渡すパターンで揃っている。

### 4. 回帰テスト実行結果

```
$ bun test skills/cmux-team/manager/task.test.ts
 55 pass / 0 fail / 80 expect() calls (18ms)

$ bun test skills/cmux-team/manager/
 625 pass / 0 fail / 1423 expect() calls (25 files, 30.29s)
```

既存の `parseTaskMeta depends_on`、`filterExecutableTasks`、`cascadeAbortToChildren` 等すべて非後退。

**独立した手動検証**（Inspector 側で新規 PROJECT_ROOT で実施）:

| ケース | 結果 |
|---|---|
| `create-task --depends-on 28` | frontmatter `depends_on: [028]` ✅ |
| `create-task --depends-on abc` | stderr `Error: --depends-on must be positive integer task IDs. Got: "abc"` / exit 1 ✅ |

### 5. 作業境界

```
$ git diff --name-only
skills/cmux-team/manager/main.ts
skills/cmux-team/manager/task.test.ts
skills/cmux-team/manager/task.ts

$ git log origin/main..HEAD
（空 — commit なし）
```

- `skills/cmux-team/manager/` 配下の 3 ファイルのみ
- README / CLAUDE.md / テンプレート / CHANGELOG.md / docs は未変更
- `git commit` は行われていない（Conductor の責務）
- 作業境界完全遵守

## Notes

- 実装・テスト・手動検証がすべて揃っており、クリーンな修正。サイレント失敗のメカニズム（`closedIds.has("028")` が `"28"` で miss）を根本から断つ、過剰抽象化のない最小修正になっている
- エラーメッセージは CLI flag 名まで埋め込まれているため、README や docs/spec への追記は不要（plan.md §5 の判断通り）
- impl-report.md にある `getArg` 仕様の注意事項（`--depends-on=-1` 形式は未対応、`--depends-on "-1"` で渡す必要がある）は本タスクの範囲外で、既存 CLI の全フラグ共通の仕様。今回の修正とは無関係
- CHANGELOG.md への bugfix エントリは、plan.md §6「CHANGELOG.md は close-task 時に Conductor が更新」の作業境界通り、close-task フェーズで Conductor が追記する想定
