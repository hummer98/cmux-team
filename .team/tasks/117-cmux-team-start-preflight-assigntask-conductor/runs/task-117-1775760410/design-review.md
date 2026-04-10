# 設計レビュー結果 v2: task-117

## 総合判定

**Approved**

Planner は v1 レビューで挙げた Major 2 件・Minor 6 件をすべて plan v2 に反映しており、設計として実装に進める状態にある。残る軽微な気付きは下記「新たな指摘」に記すが、いずれも実装判断で解決できる範囲で Approved をブロックしない。

---

## v1 指摘への対応状況

| # | 指摘 | 対応状況 | 根拠（plan.md 中の該当箇所） |
|---|------|---------|-----------------------------|
| Major 1 | ログフォーマット `task_id=` / `title=` / `journal_summary=` キー統一 | ✅ | L271 のコード例で `task_aborted` を `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}` に修正。L312 で dashboard パーサ（`dashboard.tsx:277-282`）との整合理由を明示。L515・L538 の実装順序／完了条件にも再掲 |
| Major 2 | `scanTasks` テスト方針（export 化 or スコープ外明言） | ✅ | L229「`async function scanTasks(...)` → `export async function scanTasks(...)` に変更する」と明記。L394-398「外部モジュールからの参照なしで影響ゼロ」と裏付け。L513 実装順序にも組み込み済み |
| Minor 3 | `conductor.ts:310` `renameTab` 個別 try/catch | ✅ | L196-205 で専用節を設け、CLAUDE.md の「冪等な後処理は握りつぶし可」と整合させた上で「catch-all に捕まると task abort される」旨を説明。L355 分類表および L501 実装順序にも反映 |
| Minor 4 | `team_dir_not_writable` は `.team/` を触らず `projectRoot` 直下で検証 | ✅ | L53 「`projectRoot` 直下に `.cmux-team-preflight-test` を `writeFile` → `unlink`」「`.team/` 自体は触らない」を明記し、理由（preflight 失敗時に空 `.team/` が残る不整合の回避）まで説明。L379・L475・L533 完了条件にも一貫して反映 |
| Minor 5 | `Bun.which()` 使用 | ✅ | L51 「`Bun.which("claude")` が `null` でないこと」「`execFile("which", ...)` は最小化 Linux コンテナで誤検知するので採用しない」と明記。L533 完了条件にも「`Bun.which()` を使用」 |
| Minor 6 | `printPreflightIssues` は `console.error` 使用 | ✅ | L58 「出力先は **`console.error`** を使う（`main.ts:191` の既存エラー出力パターンに揃える）」と明記。L534 完了条件にも記載 |
| Minor 7 | `spawnConductor` 内で log する理由 | ✅ | L342-343 に専用節「log 方針の一貫性について」を追加。「`spawnConductor` は戻り値 `null` 仕様を維持するため詳細情報（`kind`, `reason`）を呼び出し側に渡せない」という理由を明示し、「daemon 側のメインパスでのみ kind 分岐ログ、spawnConductor は内部 log」の二層構造を意図的な例外として宣言 |
| Minor 8 | `assignedIds.delete` の no-op コメント or 削除 | ✅ | L268 で `assignedIds.delete(task.id); // ローカル Set のため実質 no-op（... 意図の明示として残す）` とコメント付きで残置する方針を明示 |

Major 2 件・Minor 6 件すべて解消済み。

---

## 実コードとの整合確認

念のため以下を Read して突き合わせた:

- `skills/cmux-team/manager/conductor.ts:230-332` — 現状 `assignTask` は taskContent 不在で `return null`（L235-236）、catch-all も `return null`（L328-331）。plan の throw 化方針と矛盾しない
- `skills/cmux-team/manager/conductor.ts:310` — `cmux.renameTab` は try/catch なしで呼ばれており、現状 catch-all に流れる構造。plan の個別 try/catch 追加が必須であることを実コードで裏付けた
- `skills/cmux-team/manager/daemon.ts:654-673` — `assignTask` の呼び出し元は plan が述べる通りこの 1 箇所のみ。失敗時は `disconnected` に倒す現状コードも plan の記述と一致
- `skills/cmux-team/manager/dashboard.tsx:277-282` — `task_aborted` パースは `task_id=(\S+)` / `title=(.+?)(?:\s+\w+=|$)` / `journal_summary=(.+)` を使用。plan の L312 が指摘した形式と完全一致することを確認。Major 1 の方針で間違いなく dashboard に表示される

---

## 新たな指摘

### [Minor] worktree 作成後に失敗した場合の残骸処理

`assignTask` のうち `git worktree add`（L246-248）が成功した後に、`generateConductorTaskPrompt`（L281-290）や `cmux.send`（L294-305）が失敗した場合、作成済み worktree が残る。plan は "task" kind / "conductor" kind どちらに分類する場合も cleanup 処理に言及していない。

- 影響: `.worktrees/<taskRunId>/` とブランチ `<taskRunId>/task` が残留。次回以降 `git worktree add` が「ブランチ名衝突」で失敗し、また task kind エラーになる悪循環の可能性
- 推奨: `assignTask` 内でブロック単位の try/finally もしくは catch 内で `git worktree remove --force` + `git branch -D` を試みる cleanup 手順を plan に追記するのが望ましい
- 優先度: 設計段階で止めるほどではない。実装時に「catch 句で worktree 作成後フェーズを判定し cleanup する」ことを Implementer が判断すればよい。この観点を Implementer への指示に一言添えれば十分

### [Minor] `updated: ConductorState | null = null` の型宣言

plan L252 の daemon 側実装例で `let updated: ConductorState | null = null;` と宣言しているが、`assignTask` の戻り値型は `Promise<ConductorState>` に変わる（L149, L362）。try 成功後は必ず `ConductorState` に確定するため、`let updated: ConductorState;`（宣言のみ）か `const updated = ...;` の方が TypeScript 的に自然。L294 の `if (updated)` ガードも実は不要になる（try/catch で失敗時は `continue` しているため）。

- 優先度: スタイルの問題で、動作に影響なし。実装時に Implementer が整理すればよい

### [Minor] daemon 側 catch の「`AssignTaskError` 以外」分岐

plan L286-291 で「`AssignTaskError` 以外の想定外例外」を処理しているが、`conductor.ts` の catch-all（L213-217）が「すべての非 `AssignTaskError` 例外を `AssignTaskError("task", ...)` でラップして throw」するため、daemon 側には常に `AssignTaskError` しか届かない設計になっている。厳密にはデッドコードだが、defensive code として残すのは妥当。

- 優先度: 情報提供のみ。plan の意図（`assignTask` が将来変更された場合のセーフティネット）として受け入れる

---

## Recommendations

**Changes Requested ではないため必須修正はない**。ただし Implementer へ伝達したい点:

1. 実装時、`assignTask` の catch 内で **「`git worktree add` 成功後に失敗した場合は worktree を cleanup する」** 処理を追加することを検討する（新たな指摘 1）。最低限でも `execFile("git", ["worktree", "remove", "--force", worktreePath])` → `execFile("git", ["branch", "-D", branch])` を `void .catch(...)` で後処理し、失敗は `log("error", ...)` に残す
2. daemon 側の `updated` 変数は try 成功後に確定する値として扱い、`| null` 型は外す
3. plan L262-267 の「`ts[task.id]` スプレッドで `status: "aborted"`」は既存 `abort-task`（`main.ts:1543`, `main.ts:1595`）と同一の形にすること。必要なら plan が示唆する通り `task.ts` に `markTaskAborted(projectRoot, taskId, journal)` helper を新設してコード重複を排除する
4. `preflight.test.ts` の `team_dir_not_writable` ケースは macOS で `chmod 555` が root に無視されないよう test skip 条件（`process.getuid?.() === 0` のとき skip）を加えると CI で安定する

上記は Approved の条件ではない。Implementer が実装時に判断すれば十分。

---

## レビュー総括

- Major 指摘 2 件・Minor 指摘 6 件すべてが plan v2 に組み込まれており、修正理由・実装根拠（該当行・dashboard パーサの挙動・CLAUDE.md のロギングポリシー等）も明示されている
- 実コードと突き合わせて検証した限り、plan の前提（`conductor.ts:310` の try/catch 不在、`daemon.ts:654` が唯一の呼び出し元、`dashboard.tsx` のログ parser 仕様）はいずれも正しい
- 新たな Minor 指摘は 3 件あるがいずれも実装段階で吸収可能で、設計を差し戻す理由にはならない
- **実装フェーズへ進めることを推奨する**
