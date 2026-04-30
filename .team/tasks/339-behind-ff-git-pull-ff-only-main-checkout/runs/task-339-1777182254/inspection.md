# Inspection: T339

## 結論

**GO**

## サマリー

T339「behind-ff 時の自動 git pull --ff-only」の実装は、plan.md の設計判断（Verdict に `auto-pull` kind 追加 / `headStatus` で出し分け / `runAutoPull` を git-sync.ts に新設 / `--no-auto-pull` フラグ追加）と design-review.md の Major 2 件（M1: `--no-auto-pull` 経路で推奨コマンドを失わない / M2: `decideAutoPullAction` / `formatAutoPullOutcome` の pure 化と単体テスト）、Minor 推奨 2 件（m1: ロケール固定、m3: diverged ヒント）を漏れなく取り込んでいる。bun test は git-sync.test.ts 45 pass / main.test.ts 180 pass、`bunx tsc --noEmit` も exit 0 で新規型エラー 0 件。switch 文は `default: never` で網羅性が TS に強制されており、`--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` の早期 return も維持されているため副作用が誤発火しない構造になっている。スコープ外への逸脱や既存挙動の破壊は確認されない。

## 検証結果

### ビルド・テスト

- `bun test --timeout 30000 git-sync.test.ts`: **45 pass / 0 fail / 97 expect**（runAutoPull 5 ケース + classifyVerdict behind-ff 4 ケース新設を含む）
- `bun test --timeout 30000 main.test.ts`: **180 pass / 0 fail / 455 expect**（decideAutoPullAction 3 + formatAutoPullOutcome 3 ケース新設を含む）
- `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json`: **exit 0 / 出力なし** = 新規型エラー 0 件
- `bun test` 全体実行は禁忌に従い未実行（CLAUDE.md「13 分ハング」）

### Plan / design-review との整合性

- **M1（必須）**: ✅ 取り込み済み。`classifyVerdict` の `behind-ff + on-main` 分岐（`git-sync.ts:108-117`）の `message` に `Recommended (manual): git pull --ff-only origin <mainBranch>` を埋め込み、`decideAutoPullAction` の skip-warn 経路（`main.ts:3176-3181`）で `verdict.message` をそのまま console.warn する設計。`main.test.ts` の `decideAutoPullAction` ケースで `warnMessages[0]` に `git pull --ff-only origin main` が含まれることを assert
- **M2（必須）**: ✅ 取り込み済み。`decideAutoPullAction` / `formatAutoPullOutcome` を pure 関数として `main.ts` から export（`main.ts:3168-3217`）し、`main.test.ts` で skip-warn / perform / ok-fast-forward / fail+Bypass / fail+diverged / 改行 stderr 単一行化 の 6 ケースを網羅。process.exit / console を mock せず副作用なしで検証可能な構造
- **m1（推奨）**: ✅ 取り込み済み。`runAutoPull` の `execFile` 呼び出しに `env: { ...process.env, LANG: "C", LC_ALL: "C" }` を渡してロケール固定（`git-sync.ts:374`）
- **m2（任意）**: ✅ ドキュメント済み。`RunAutoPullOptions.git` の JSDoc に「`collectSyncFacts` の `(args) => Promise<string>` とは戻り値型が異なる」明記（`git-sync.ts:343-345`）
- **m3（推奨）**: ✅ 取り込み済み。`formatAutoPullOutcome` の fail 経路の `errorMessage` に `Hint: local <main> may have diverged since fetch; try \`git pull --rebase origin <main>\` manually.` を含める（`main.ts:3208-3213`）。`main.test.ts` で `expect(o.errorMessage).toMatch(/diverged/)` および `git pull --rebase origin main` 文字列を assert
- **m4 / m5 / m6 / m7**: m4・m5 はスキップ（任意で妥当）。m6 は i18n.ts で `--skip-fetch` の直後に `--no-auto-pull` を並べる順序を 4 箇所すべてで踏襲。m7 は `ready_warning` への `reason=auto_pull_disabled` 付加だが既存集計への破壊的影響なし

### コード品質

- **Verdict 型網羅性**: ✅ `runSyncCheckOrExit` の `switch (result.verdict.kind)` に `default: { const _exhaustive: never = result.verdict; ... }` を入れ（`main.ts:3300-3303`）、kind 追加忘れがコンパイルエラーで弾かれる構造
- **runAutoPull のエラーハンドリング**: ✅ try/catch で `{ ok: false, stdout, stderr, summary: "unknown" }` を返し throw しない（`git-sync.ts:380-403`）。stderr が空のときは `e.message` で fallback。CLAUDE.md「外部コマンド失敗時は `stderr` / `stdout` を必ず detail に含める」「空の `catch {}` 禁止」と整合
- **新規関数 export**: ✅ `runAutoPull` / `AutoPullResult` / `RunAutoPullOptions`（git-sync.ts）、`decideAutoPullAction` / `formatAutoPullOutcome` / `AutoPullDecision` / `AutoPullOutcomeFormatted`（main.ts）すべて export 済み
- **`--force` 優先**: ✅ `runSyncCheckOrExit` 冒頭の `if (opts.forceFlag) { ... return; }`（`main.ts:3231-3237`）が auto-pull 分岐より先に早期 return。`--force` 指定時は auto-pull に到達しない
- **CMUX_TEAM_SKIP_SYNC_CHECK の構造的保証**: ✅ `runSyncCheckOrExit` 冒頭の `if (process.env.CMUX_TEAM_SKIP_SYNC_CHECK === "1") { ... return; }`（`main.ts:3238-3244`）が auto-pull 分岐より先に早期 return。Conductor 環境（worktree 配下）では sync check 自体が走らないため auto-pull は発火しない

### テスト適切性

- **git-sync.test.ts カバレッジ**:
  - behind-ff の 4 ケース揃っている: on-main → auto-pull / on-other-branch → warn / detached → warn / mainBranch=develop → auto-pull (mainBranch="develop")
  - 既存「behind-ff → warn」ケース（旧仕様）は新仕様（auto-pull + 推奨コマンド）に正しく書き換わり、推奨コマンド `git pull --ff-only origin main` の埋め込みも assert
  - runAutoPull の 5 ケース: Fast-forward / Already up to date / unknown stdout / 失敗 (stub throw) / mainBranch=develop の引数伝播
- **main.test.ts カバレッジ**:
  - `decideAutoPullAction`: noAutoPull=true → skip-warn (verdict.message + --no-auto-pull 警告) / noAutoPull=false → perform / mainBranch=develop の引き継ぎ
  - `formatAutoPullOutcome`: ok=true → ok+summary+logMessage / ok=false → fail (Bypass + --no-auto-pull + --force + diverged + git pull --rebase) / 改行混じり stderr の単一行化
  - M2 が要求した「skip-warn / perform / ok-fast-forward / fail + Bypass ヒント / fail + diverged ヒント」をすべて網羅

### ドキュメント

- **CLAUDE.md L196-204**: ✅ 更新済み
  - `behind-ff + mainBranch checkout 中 → 自動 git pull --ff-only origin <mainBranch>` 追記
  - `behind-ff + 他ブランチ checkout 中 / no-remote → 警告のみ、昇格続行` に分割
  - bypass 段に `--no-auto-pull` 追加（旧記述「Master が手動で git fetch + git pull --ff-only」相当の記述は他に存在せず）
- **i18n.ts**: ✅ 英日 × create/update = 4 箇所すべて更新
  - `help_create_task` 英 (L304-305) / 日 (L1108-1109): `--no-auto-pull` Options + Notes の behind-ff 自動実行説明
  - `help_update_task` 英 (L350-351) / 日 (L1154-1155): 同上
  - `--skip-fetch` の直後に `--no-auto-pull` を配置する順序が一貫

### スコープ・安全性

- **スコープ**: ✅ 逸脱なし。feature branch の auto-pull / `git pull --rebase` / 新環境変数いずれも追加していない。`decideAutoPullAction` / `formatAutoPullOutcome` の pure 化は plan.md の M2 取り込み案として明示的に許容されたリファクタ
- **既存挙動の保持**: ✅ 既存 behind-ff → warn の単一経路を分岐に変えただけ。`headStatus !== "on-main"` のケースでは旧来の warn メッセージ相当（推奨コマンド込み）を返すので既存ユーザーへの破壊なし
- **pull cwd**: ✅ PROJECT_ROOT で実行。worktree 内では CMUX_TEAM_SKIP_SYNC_CHECK=1 で早期 return するため発火しない
- **失敗時 exit**: ✅ `outcome.kind === "fail"` で `process.exit(1)`（`main.ts:3296`）
- **--ff-only による非破壊**: ✅ git 側が ff 不可なら exit code != 0 → `{ ok: false }` → reject。コード側で破壊的な操作は行わない

## Findings

### Critical（必須修正、GO を出すには対応必須）

該当なし。

### Major（強く推奨）

該当なし。

### Minor（任意）

- **n1（参考）**: `decideAutoPullAction` の skip-warn 経路で 2 行に分けて警告を出している（`verdict.message` + `--no-auto-pull set; auto-pull skipped`）が、`verdict.message` の冒頭が `info: ...` で始まるため、`--no-auto-pull` 経路では先頭ラベルが `info:` のまま表示される。実害は小さいが、ユーザー視点では `warning:` プリフィックスに統一されると視認性が一段階上がる。今回スコープでは無視可。
- **n2（参考）**: `runAutoPull` の `e.stdout` / `e.stderr` 抽出ロジック（`git-sync.ts:387-399`）は Bun の `execFile` 失敗時の例外形に依存している。テストでは `Error & { stdout, stderr }` を投げる stub で動作確認済みだが、実 Bun ランタイムで `execFile` が `error.stdout` を Buffer で返す場合の挙動は手動 smoke で要確認（plan.md の smoke (a) で確認可）。

## Fix Required（NOGO の場合のみ）

該当なし（GO）。
