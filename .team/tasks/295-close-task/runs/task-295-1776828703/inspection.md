# T295 close-task 納品物明示を強制化 — Inspection Report

**Role**: inspector
**Run**: task-295-1776828703
**Worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-295-1776828703`
**Base commit**: 4d484d2 (T294 完了)

---

## Verdict: GO

## Summary

S1〜S11 全 11 サブタスクが plan §3.1 想定どおり 21 ファイルで実装されており、`bun test` は **1064 pass / 0 fail**、touched-files の tsc 新規エラーは **0 件**（2 件残るエラーはいずれも plan §6 で明示された T295 対象外の既存エラー）。CLI 検証 6 パターン（kind 未指定 / kind merged 付随欠落 / kind files 付随欠落 / kind pr 付随欠落 / kind none 排他違反 / 不明 kind）はすべて exit 1 + 適切なエラーメッセージで動作し、`--help` は 4 kind の example を網羅している。`daemon.ts` の T274 auto-close 経路は `deliverable: { kind: "none" }` を自動付与しており、`loadTaskState` は旧 closed 行を `deliverable=undefined` で後方互換に読める。一方、**plan §5.1 Risks で明示された `README.md` / `README.ja.md` の sweep が未実施**（`close-task --task-id <id> [--journal <text>]` の旧署名が残存）で、`templates/{ja,en}/manager.md:73` の例示コマンドも旧仕様のまま。いずれもドキュメント側の見落としで、実装コード / テスト / 主要テンプレ / docs/spec / CLAUDE.md / CHANGELOG は整合しているため GO 判定。

## Findings

### 1. README.md / README.ja.md に旧 CLI 署名が残存 — major

- `README.md:110`: `` `cmux-team close-task --task-id <id> [--journal <text>]` | Close a task ``
- `README.ja.md:110`: `` `cmux-team close-task --task-id <id> [--journal <text>]` | タスク close ``
- plan.md §5.1 Risks は「docs/spec/ のサンプルや CLAUDE.md の `close-task --task-id 035 --journal` 系記述が古いまま残る」対策として `rg "close-task --task-id.*--journal" docs/ CLAUDE.md README.md README.ja.md` を 0 件まで掃くことを明記している。実際に実行すると `README.md:110` と `README.ja.md:110` の 2 件がヒットする。
- impl-report の Files Changed / 変更ファイル数 21 は plan §3.1 の想定と一致しているが、§3.1 自身が README を target に含めておらず、§5.1 sweep 対策との齟齬がそのまま残った。
- 影響: 初見ユーザーがクイックリファレンスで `--journal` だけで close-task を呼ぶ → 実行時 exit 1（`--deliverable-kind is required` エラー）で止まる。CHANGELOG と `close-task --help` を読めば回復できるため致命ではないが、ユーザー導線上の不整合は major。

### 2. templates/{ja,en}/manager.md:73 に旧コマンド例 — minor

- `templates/en/manager.md:73`: `Conductor executes \`cmux-team close-task --task-id <TASK_ID> --journal "..."\``
- `templates/ja/manager.md:73`: `Conductor が \`cmux-team close-task --task-id <TASK_ID> --journal "..."\` を実行`
- plan §3.1 は S8（テンプレ更新）を `conductor-role.md` / `conductor.md` / `conductor-task.md` の 6 ファイルに限定しているため、`manager.md` は対象外として扱われた（impl-report でも明示なし）。
- 文脈は「Manager/daemon が完了を検出する仕組み」を説明する informational ブロックで、読者に実行させる instructional 箇所ではない。また Manager ロールが close-task を直接叩く運用ではない。
- ただし例示コマンドそのものは T295 以降 exit 1 で落ちるため、表記は陳腐化している。Minor（運用影響なし、表記 hygiene のみ）。

### 3. parseCloseTaskArgs の invalid kind + foreign flag 同時指定時の error 順序 — minor

- `--deliverable-kind xxx --pr-url foo` と指定すると `foreign flags` 検証が先に走り `--deliverable-kind xxx does not accept: --pr-url` を返す。unknown kind を優先して `--deliverable-kind must be one of: files, merged, pr, none (got: xxx)` を出したほうが親切だが、両者とも exit 1 + 有用メッセージなので blocker ではない。
- main.test.ts の既存 describe「不明な kind は error」でも foreign flag は指定していないので隠れているだけで、バグではない（仕様の優先順）。
- 修正するなら `parseCloseTaskArgs` の検証順を (a) kind enum 検証 → (b) foreign flag 検証 → (c) kind 固有必須 検証 に並べ替える 1 手。影響小。

---

## 計画充足の検証サマリ（参考）

| 観点 | 結果 |
|------|------|
| S1〜S11 全実装 | ✅ plan §8 順序で直列実装 |
| 変更ファイル 21 | ✅ `git diff main --name-only` で 21 件（plan §3.1 と一致） |
| Design Review F1〜F7 反映 | ✅ impl-report でトレース済み（F1 は保守的方針を採用） |
| 旧 cmdCloseTask 残存 | ✅ 無し（grep で旧シグネチャ非存在） |
| `bun test` pass | ✅ 1064 pass / 0 fail / 2502 expects |
| touched-files tsc 新規エラー | ✅ 0 件（`daemon.test.ts:3870` / `daemon.ts:1598` は plan §6 既知、後者は Deliverable import による 2 行 drift のみ） |
| SSOT: `Deliverable` 参照 | ✅ `schema.ts` export → `task.ts` / `main.ts` / `daemon.ts` / `dashboard.tsx` から単一 import |
| `formatDeliverable` 集約 | ✅ `task.ts` に配置、dashboard / trace-task から参照 |
| zod 網羅性 | ✅ discriminated union 4 variant + `switch` に `never` assertion |
| import chain schema → task → main → daemon → dashboard | ✅ 接続済み |
| CLI exit 1 パターン | ✅ kind 未指定 / merged 付随欠落 / files 付随欠落 / pr 付随欠落 / none 排他違反 / 不明 kind の 6 ケース exit 1 を手動確認 |
| `--deliverable-kind none` 書き込み | ✅ task.test.ts の loadTaskState 新行 zod 往復 test で lock |
| daemon auto-close (T274) の `kind: "none"` | ✅ `daemon.ts:3169` / `daemon.test.ts:4608` で assertion |
| dashboard kind suffix 表示 | ✅ `buildTaskRow` の 3 経路（flat / styleOverride / ui.text）に注入 |
| `trace-task` Deliverable 行 | ✅ Base 行の直後で multi-line 対応、旧行は `Deliverable: -` |
| `deliverable-kind` in docs / CLAUDE.md | ✅ 7 ヶ所（docs/spec × 5 + CLAUDE.md × 2） |
| `deliverable-kind` in templates | ✅ 30 ヶ所（ja 15 + en 15、conductor-role 12+12 / conductor 2+2 / conductor-task 1+1） |
| `deliverable-kind` in i18n.ts | ✅ 14 ヶ所（日英 help × 4 kind example） |
| CHANGELOG Breaking entry | ✅ 冒頭 `[Unreleased] Changed (Breaking, T295)` 節、7 箇条 + 移行手順 |
| CLAUDE.md Deliverable 型節 | ✅ L631〜 に新規節（4 variant 表 + 移行注意） |
| ja/en テンプレ対応 | ✅ conductor-role.md Step 9 表と Step 11 分岐が 1:1 対応 |

## Fix Required

GO 判定につき修正は必須ではない。ただし後追いで以下を掃くことを推奨（いずれもドキュメントのみ、コード挙動には影響しない）:

- [推奨] `README.md:110` と `README.ja.md:110` の close-task 行を `--deliverable-kind` 必須仕様に書き直す（Finding 1 の解消）。例えば `--deliverable-kind <files|merged|pr|none> [kind 別フラグ] [--journal <text>]`。
- [任意] `templates/ja/manager.md:73` と `templates/en/manager.md:73` の旧コマンド例を新仕様に差し替え（Finding 2 の解消）。文脈的には「close-task が CONDUCTOR_DONE を送る」ことだけ示せば十分なので、引数は省略して `` `cmux-team close-task ...` `` と抽象化しても良い。
- [任意] `parseCloseTaskArgs` の検証順を「enum 検証 → foreign flag → kind 固有」に並べ替え（Finding 3 の解消、UX 微調整）。
