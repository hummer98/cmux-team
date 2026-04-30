# T339 Implementation Summary

## 完了したサブタスク

- [x] `Verdict` 型に `auto-pull` kind 追加（discriminated union）
- [x] `classifyVerdict` の `behind-ff` を `headStatus` で出し分け
  - `on-main` → `auto-pull`
  - `on-other-branch` / `detached` → `warn`（推奨コマンドは含む）
- [x] `runAutoPull(projectRoot, { mainBranch, git? })` を `git-sync.ts` に新設
  - `LANG=C / LC_ALL=C` でロケール固定（m1 取り込み）
  - 戻り値 `{ ok, stdout, stderr, summary }`、throw しない
- [x] `runSyncCheckOrExit` に `noAutoPull: boolean` 引数追加
- [x] `runSyncCheckOrExit` の `verdict.kind === "auto-pull"` 分岐実装
  - `--no-auto-pull` → `verdict.message`（推奨コマンド込み）+ skipped 警告 → 続行
  - 通常 → `runAutoPull` 実行 → 成功時続行 / 失敗時 stderr に Bypass + diverged ヒント + exit 1
- [x] `decideAutoPullAction` / `formatAutoPullOutcome` を pure 関数として export（M2 の unit-testable 化リファクタ）
- [x] `cmdCreateTask` / `cmdUpdateTask` に `--no-auto-pull` フラグ追加
- [x] `i18n.ts` の help 4 箇所更新（英日 × create/update）に `--no-auto-pull` 説明 + Notes 追記
- [x] `CLAUDE.md` L196-204「Ready 昇格時の sync state ガード」更新
- [x] `git-sync.test.ts` に 4 ケース追加 + `runAutoPull` 5 ケース追加 / 既存 `behind-ff → warn` を新仕様に書き換え
- [x] `main.test.ts` に `decideAutoPullAction` / `formatAutoPullOutcome` の e2e 7 ケース追加（M2 必須）
- [x] 新規 ログ event: `ready_auto_pull_succeeded` / `ready_auto_pull_failed` / `ready_warning reason=auto_pull_disabled`

## 変更ファイル一覧

- `skills/cmux-team/manager/git-sync.ts` — Verdict 拡張 + classifyVerdict 改修 + runAutoPull / AutoPullResult / RunAutoPullOptions 新設
- `skills/cmux-team/manager/git-sync.test.ts` — behind-ff の 4 ケース + runAutoPull の 5 ケース追加
- `skills/cmux-team/manager/main.ts` — `decideAutoPullAction` / `formatAutoPullOutcome` 新設、`runSyncCheckOrExit` に `noAutoPull` + auto-pull 分岐、両 cmd で `--no-auto-pull` を渡す
- `skills/cmux-team/manager/main.test.ts` — `decideAutoPullAction` 3 ケース + `formatAutoPullOutcome` 3 ケース追加
- `skills/cmux-team/manager/i18n.ts` — `help_create_task` / `help_update_task` の英日 4 箇所に `--no-auto-pull` 説明 + Notes 追記
- `CLAUDE.md` — Ready 昇格セクション更新

`package-lock.json` は元々の差分（このタスク開始時から M）で本実装では触っていない。

## テスト結果

```
$ bun test --timeout 30000 git-sync.test.ts
 45 pass
 0 fail
 97 expect() calls

$ bun test --timeout 30000 main.test.ts
 180 pass
 0 fail
 455 expect() calls

$ bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
(exit 0, no output)
```

`bun test` 全体は CLAUDE.md 禁忌（13 分ハング）のため未実行。touch したファイル関連の新規型エラー 0 件。

## design-review 取り込み状況

| ID | 必要度 | 取り込み状況 | 備考 |
|---|---|---|---|
| **M1** | 必須 | ✅ 取り込み済み | `auto-pull` verdict の `message` に `git pull --ff-only origin <main>` を埋め込み、`--no-auto-pull` 経路でそのまま `console.warn` |
| **M2** | 必須 | ✅ 取り込み済み | `runSyncCheckOrExit` から `decideAutoPullAction` / `formatAutoPullOutcome` を pure 関数に抽出し export、main.test.ts に 7 ケース追加。skip-warn / perform / ok / fail を網羅し、エラーメッセージに `Bypass:` / `--no-auto-pull` / `--force` / `diverged` ヒントを assert |
| **m1** | 推奨 | ✅ 取り込み済み | `runAutoPull` 内 `execFile` に `env: { ...process.env, LANG: "C", LC_ALL: "C" }` を渡してロケール固定 |
| **m2** | 任意 | ✅ ドキュメント済み | `RunAutoPullOptions.git` の JSDoc に「`collectSyncFacts` の git stub と戻り値型が異なる」明記 |
| **m3** | 推奨 | ✅ 取り込み済み | `formatAutoPullOutcome` の fail 経路に `Hint: local <main> may have diverged ... try git pull --rebase origin <main> manually` を含めた |
| **m4** | 任意 | スキップ | smoke test 自動化はスコープ外、plan.md の手順をそのまま残置 |
| **m5** | 任意 | スキップ | docs/spec/ 側の追記は別タスクで判断（CLAUDE.md からの参照リンクはそのまま） |
| **m6** | 推奨 | ✅ 取り込み済み | i18n.ts で `--skip-fetch` の直後に `--no-auto-pull` を並べた（英日 4 箇所） |
| **m7** | 確認 | ✅ 互換性確認済み | `grep -rn "ready_warning"` の参照は main.ts:3217 のみ。新規 `reason=auto_pull_disabled` 追加は detail 文字列の付加なので互換性問題なし |

## 設計上の補足

- `runSyncCheckOrExit` 内の switch を `case "allow" | "reject" | "warn" | "auto-pull"` で TypeScript 網羅性チェック (`default: never`) を効かせるよう変更し、verdict 追加忘れがコンパイルで弾かれる構造にした
- `decideAutoPullAction` / `formatAutoPullOutcome` を pure 化したことで、process.exit / console を mock せず副作用なしで M2 e2e 検証が可能になった

## 残課題・懸念

- 実 git に対する pull の手動 smoke test は plan.md の手順（PROJECT_ROOT で `git reset --hard HEAD~1` → `cmux-team create-task --status ready`）を実行者に委ねる
- `--force` と `--no-auto-pull` が同時指定された場合は `--force` が早期 return するため `--no-auto-pull` は未使用となる仕様（plan.md 記載のとおり）。help テキストでの優先順序の明示までは行っていない
- `docs/spec/05` / `07` への sync state ガードの詳細記述追加は別タスクで判断（CLAUDE.md L204 の「詳細は…参照」と spec 側の不在は既存ギャップで T339 のスコープ外）
