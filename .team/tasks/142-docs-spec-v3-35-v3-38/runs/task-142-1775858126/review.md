# Design Review: docs/spec v3.35〜v3.38 同期計画

## 判定: Changes Requested

全体として非常に高品質な計画書。実装コードとの整合性はほぼ完璧で、網羅性も十分。1点の引数表記の誤りを修正すれば Approved。

---

## 正確性チェック

- [x] CLI サブコマンド引数が実装と一致（`artifacts add`, `artifacts open`, `update-task --depends-on`）
- [ ] **`resume` コマンドの引数表記に誤り（Section 2-1）** — 後述
- [x] 環境変数名が正確（`CMUX_CLAUDE_HOOKS_DISABLED`, `CMUX_TEAM_MD_VIEWER`）
- [x] `THROTTLE_5H_THRESHOLD = 0.90` — `schema.ts:162` で確認済み
- [x] resume ロジックの記述が正確 — `main.ts:420-483` の boot 後 resume ロジックと一致
- [x] `sessionId` は `crypto.randomUUID()` で発行（`conductor.ts:97,173`）、`assignTask` で変更しない（`conductor.ts:398`）、`resetConductor` で消さない（`conductor.ts:488`）
- [x] `SESSION_CLEAR` で running Conductor を abort + idle リセット — `daemon.ts:669-703` で確認
- [x] `updateSidebarStatus` がメインループに存在 — `main.ts:491-493` で `tick()` → `updateTeamJson()` → `updateSidebarStatus()` の順
- [x] `CMUX_CLAUDE_HOOKS_DISABLED=1` は Conductor（`conductor.ts:170`）、Agent（`main.ts:1118`）、Master（`main.ts:1015`）の3箇所で設定
- [x] `.envrc` の `source_up` 生成 — `conductor.ts:308-312` で確認
- [x] `task-state.json` に `worktreePath`, `taskRunId`, `conductorSlot`, `sessionId` を記録 — `daemon.ts:828-834` で確認
- [x] サイドバーステータスのカテゴリと表示が実装と一致（`daemon.ts:1163-1253`）
- [x] `artifacts open` のビューア優先順位: `CMUX_TEAM_MD_VIEWER` → `mo` → `cat` — `main.ts:1877-1886` で確認

---

## 網羅性チェック

- [x] 全ての対象コミット（T127〜T141）がカバーされている
- [x] Phase 8 セクション（Section 5-1）に主要改善が網羅的にリストされている
- [x] 未実装の改善候補の更新（Section 5-2）が適切

見落とされた変更点: **なし**

---

## 文体・構造の整合性

- [x] 見出しレベルの一貫性 — 各ファイルの既存レベル（`##`, `###`, `####`）に合わせている
- [x] テーブル記法の一貫性 — 既存テーブルのカラム幅・記述粒度に揃えている
- [x] コードブロックの言語指定が既存と統一
- [x] 日本語/英語の使い分けが docs/spec/ の慣習に従っている

---

## 03-commands.md を変更不要とした判断

**正しい。** 今回追加された `resume`, `artifacts add`, `artifacts open`, `update-task --depends-on` はすべて CLI サブコマンド（`cmux-team ...`）であり、Claude セッション内のスラッシュコマンド（`/master`, `/team-task` 等）ではない。03-commands.md の対象外。

---

## 04-templates.md を変更不要とした判断

**正しい。** v3.35〜v3.38 でテンプレートファイル自体の変更やテンプレート変数の追加はない。

---

## Recommendations

### 必須修正（1件）

**Section 2-1: `resume` コマンドの引数表記を修正**

Plan の Section 2-1（01-skill-cmux-team.md への追記）:

```markdown
# 現在の記載（誤り）
| `cmux-team resume` | assigned タスクの Conductor セッション再開（`--task-id` 必須） |

# 修正後
| `cmux-team resume` | assigned タスクの Conductor セッション再開（`<task-id>` positional 引数） |
```

**根拠:** 実装（`main.ts:939-942`）では `resume` の引数は positional argument:
```
Usage: cmux-team resume <task-id>
const taskId = args[1];
```
`--task-id` ではない。Plan 自身の「検証すべきポイント」セクションでも「resume コマンドの引数は `<task-id>`（`--task-id` ではなく positional argument）」と正しく指摘しており、本文と矛盾している。

なお、Section 1-1（05-install-and-infrastructure.md への追記）の `resume` 行は引数形式に言及していないため修正不要。
