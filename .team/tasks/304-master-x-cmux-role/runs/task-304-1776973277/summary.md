# T304 Summary: Master への `x-cmux-role` ヘッダー注入

## 概要

`generate{Master,Conductor,Agent}Settings` が生成する settings.json に
`env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: <role>"` を追加し、Claude Code が
Anthropic API に送るリクエストに `x-cmux-role` ヘッダーを自動付与するようにした。

proxy.ts:352 の既存ロジック `req.headers.get("x-cmux-role") || opts?.role` が
そのまま新ヘッダーを拾い、trace JSONL の `role` 列に `master` / `conductor` /
`agent` が記録される。

## 重要発見

**タスク本文の前提「Conductor / Agent は既に role を付与している」は事実と異なり、
調査時点で 3 ロール全員が `role=unknown` として記録されていた**（Planner による実測: 
`.team/logs/traces/api-trace.jsonl` 全 53,748 行が `unknown`）。このため Master だけでなく
3 ロール同時に修正する判断を下した。

## 変更ファイル

| path | 変更内容 | 差分 |
|------|---------|-----|
| `skills/cmux-team/manager/main.ts` | `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` に `env.ANTHROPIC_CUSTOM_HEADERS` を追加 | +13 行 |
| `skills/cmux-team/manager/main.test.ts` | T304 用 test 3 件を追加（describe 3 つ） | +29 行 |

`git diff --stat`:
```
skills/cmux-team/manager/main.test.ts | 29 +++++++++++++++++++++++++++++
skills/cmux-team/manager/main.ts      | 13 +++++++++++++
2 files changed, 42 insertions(+)
```

## テスト結果

- `bun test skills/cmux-team/manager/main.test.ts`: **148 pass / 0 fail** / 396 expect() calls
- `bunx tsc --noEmit`（`skills/cmux-team/manager/` 内）: **新規エラー 0 件**
  - 残存 3 件は base branch (T303, HEAD=06a074a) 由来で scope 外
- `bun test -t "T211"`: 9 pass / 0 fail（CMUX_ROLE regression 遵守）

## T211 regression 遵守

- `grep -c "CMUX_ROLE" skills/cmux-team/manager/main.ts` → **0 件**
- 追加コメントは「ロール識別ヘッダー」の日本語表現を使用し、`CMUX_ROLE` 文字列は
  コード・コメント問わず一切含まない

## 成果物

- `plan.md` (L18,089 bytes) — 実装計画書（Planner 作成）
- `impl-notes.md` (L3,096 bytes) — 実装ノート（Implementer 作成）
- `inspection.md` (L3,286 bytes) — 検品レポート（Inspector 作成、GO 判定）
- `summary.md` — 本ファイル

## 納品

- マージコミット SHA: `0150f02bfd440cae9bc6e5a8a71e14002ed625ba`
- マージ先: `main`
- 納品方式: ローカル ff-only マージ（push なし）

## 検証（手元で追加確認する場合）

```bash
# 1. release / npm install -g 後に
cmux-team start
# 2. Master セッションで何か問いかけ
# 3. trace JSONL で role 確認
jq -r '.role // "unknown"' /Users/yamamoto/git/cmux-team/.team/logs/traces/api-trace.jsonl \
  | sort | uniq -c
# 期待: master / conductor / agent のいずれかが 1 件以上、新規記録では unknown が 0 件
```

## 関連

- 計画フェーズ: Planner Agent（surface:768）が plan.md を作成
- 実装フェーズ: Implementer Agent（surface:770）が TDD で実装
- 検品フェーズ: Inspector Agent（surface:772）が GO 判定
- T305 以降の「token 消費量観測」機能の前段として本タスクが位置付けられる
- 参考: `CLAUDE.md`「トレーサビリティ（v3.4.0）」節 / `proxy.ts:350-352`
