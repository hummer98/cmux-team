# T388 サマリー — close-task --deliverable-kind=merged 後の origin sync を Master 担当に明文化 (#45)

## 概要

`cmux-team close-task --deliverable-kind=merged` でローカル ff-only マージを確定した直後の `origin/<base>` 同期責務を Master に明文化した。実装は master.md (ja/en) / i18n.ts の `help_close_task` / README.md / README.ja.md への追記のみで、FSM や CLI 引数仕様は不変更。

採用方針: **案 D（Master 介在 + `await-task`）**。Conductor / Agent は worktree 内に閉じており push は本来スコープ外。Master が `await-task` 経由で merged 完了を捕捉して serialize 実行する形に統一した。

## 変更ファイル

| パス | 種別 | 概要 |
|---|---|---|
| `skills/cmux-team/templates/ja/master.md` | テンプレート | §やらないこと の git 書き込み禁止に例外注記 / §明示指示があっても禁止 の `git push` 行に注記 / §`await-task` の用途リストに 1 項目 / 新セクション `## Deliverable sync プロトコル` 追加 |
| `skills/cmux-team/templates/en/master.md` | テンプレート | 上記の 1:1 英訳。新セクション見出し `## Deliverable sync protocol` |
| `skills/cmux-team/manager/i18n.ts` | コード | `help_close_task` の en / ja 両方の `merged` Examples 先頭に NOTE 2 行追加 |
| `README.md` | ドキュメント | `### Communication` 表直下に `### Master responsibilities (origin sync)` 段落（3 文）を新設 |
| `README.ja.md` | ドキュメント | `### 通信モデル` 表直下に `### Master の責務（origin sync）` 段落（3 文）を新設 |

## 受け入れ基準（タスク本文 §受け入れ基準 の再掲）

- [x] master.md (ja/en) の差分が PR 上で確認できる
- [ ] `cmux-team start` でランタイムプロンプトが再生成され、新セクションが反映される（**PR マージ後に Master 側で実施。Conductor は実施しない**。下記 §ランタイムプロンプト再生成 参照）
- [x] close-task --help / README の差分が一貫している（`help_close_task` の NOTE と README の Master responsibilities が同じ用語・参照先 master.md を指している）
- [ ] Dear リポで軽微なテストタスクを起票し、案 D フローで origin sync が成功するまで動作確認（**PR マージ後の運用検証項目**。本タスクの実装スコープ外。Master / ユーザー側で実施する）
- [ ] PR description に issue #45 を `Closes #45` で紐付け（下記 §PR 起票時の指示 参照）

## ランタイムプロンプト再生成（PR マージ後の必須手順）

テンプレート (`skills/cmux-team/templates/{ja,en}/master.md`) は **ソースオブトゥルース**。
ランタイムプロンプト (`.team/prompts/master.md`) は派生物で、**本タスクでは触っていない**
（CLAUDE.md「プロンプト編集ルール（厳守）」: ランタイム直接編集禁止）。

PR がマージされたら以下を Master 側で実行する:

```bash
cmux-team start
# または既に起動中なら Manager を再起動して再生成させる
```

`cmux-team start` がテンプレートから `.team/prompts/master.md` を再生成し、新セクション
`## Deliverable sync プロトコル`（ja）/ `## Deliverable sync protocol`（en）が Master ロールに
反映される。**Conductor は `.team/prompts/master.md` を直接書き換えない**。

## PR 起票時の指示

PR 起票担当者（Master または後続 Conductor）へ:

- **deliverable_kind**: `pr` を推奨（外部レビュー前提のドキュメント変更）。
- **PR description 末尾に `Closes #45` を必ず含める** — issue #45 をこの PR で close するため
  GitHub の自動リンクを発火させる必要がある。本文末尾に独立した行で `Closes #45` を追記する。
- 受け入れ基準（上記 §受け入れ基準）の各項目を PR description にもチェックリスト形式で再掲し、
  実装で満たしたものと運用検証項目（PR マージ後）を区別して記載する。

## Decision Log（plan §7 の要点）

| ID | 決定 | 理由 |
|---|---|---|
| D1 | 「Deliverable sync プロトコル」を §`await-task` 直後 / §排他タスク前 に挿入 | await-task の具体ユースケースとして自然に繋がり、排他タスクと並ぶ「運用判断の 2 大パターン」になる |
| D2 | 並行 merged の serialize は文章で説明（疑似コード回避） | Claude のターン直列性に依拠する設計を「mutex」のような並行制御と誤読されないため |
| D3 | rescue タスクは title `"rescue: T{id} merged 後の origin sync"` / priority high / status ready で起票 | implementer agent に委ね、Master は force push / reset --hard を直接行わない |
| D4 | README は `## Communication` 表直下に Master responsibilities 段落（3 文）を新設 | 既存の `## Project-Specific Agent Instructions`（overlay 説明）と混同しないよう独立段落 |
| D5 | 案 A（close-task 自動 push）は将来オプションとして余地残し | 本タスクは FSM・CLI 引数仕様を変えない（`--auto-push` フラグ等は別タスクで） |
| D6 | overlay (`agent-instructions/master.md`) は触らない | 現状存在しない（`implementer.md` のみ）。テンプレートが SoT |

## 検証済み grep / tsc

実装後に以下が全て通っていることを確認:

- `grep -n "Deliverable sync プロトコル" skills/cmux-team/templates/ja/master.md` → 4 件
- `grep -n "Deliverable sync protocol" skills/cmux-team/templates/en/master.md` → 4 件
- `grep -nE "git push origin <base>"` → ja 3 件 / en 3 件
- `grep -nE "Master is expected to fetch|origin への fetch/pull/push は Master"` → en/ja 各 1 件（i18n.ts）
- `grep -nE "Master responsibilities|Master の責務"` → README.md / README.ja.md 各 1 件
- `bunx tsc --noEmit` → i18n.ts は新規エラーなし（クリーン継続）
- `diff <(grep -c "^### " en) <(grep -c "^### " ja)` → 差分ゼロ（ja/en の `### ` 見出し数は一致）

詳細は `impl-report.md` 参照。
