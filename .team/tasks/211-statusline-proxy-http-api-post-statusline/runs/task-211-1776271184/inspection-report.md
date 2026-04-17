# Inspection Report: T211 — statusline を proxy HTTP API 化

## Decision

**GO**

## Summary

- Phase 1〜4 の全変更が plan.md と一致。`POST /statusline` エンドポイント追加、`statusline.ts` 純関数移植、`statusline.sh` の curl wrapper 化、Master hook の `master-settings.json` 移設、`CMUX_ROLE` 完全削除がすべて実施されている。
- `bun test` は 342 pass / 0 fail。`/statusline` の正常系 + 異常系、`generateMasterSettings`、`CMUX_ROLE` regression、`.claude/settings.json` 構造 regression の追加テストが網羅的に追加されている。
- `rg CMUX_ROLE skills/ bin/ .claude/ commands/ docs/spec/` はソースコード本体で 0 件（main.test.ts の regression assert 記述と CHANGELOG の履歴記述のみ）。
- `impl-report.md` の書き出し漏れが Implementer 側で起きているが、git diff と実ファイルから検証する観点では実装が計画と整合していることを確認できた。
- `statusline.sh` で `exec` ではなくパイプ + `|| true` を使っている点だけ plan.md §4 Phase 2 の箇条書きと文言上ズレがあるが、技術的には `exec curl || true` が成立しないための正当な調整（スクリプト先頭コメントで明記）であり再実装は不要。

## Checks

| # | 観点 | 結果 | 備考 |
|---|------|------|------|
| 1 | proxy エンドポイント (`POST /statusline`) | ✅ | `proxy.ts:205-237` に handler 追加。`X-Cmux-Surface` 必須 (400)、`getState` 未設定 (503)、未知 surface (200 empty)、`text/plain; charset=utf-8` / 末尾改行なし。`proxy.test.ts:228-375` に master / conductor busy / conductor idle / agent / ヘッダー欠損 / 503 / 未知 surface / color モード / 改行なしの全ケース追加 |
| 2 | TypeScript フォーマッタ (`statusline.ts`) | ✅ | `formatStatusline` + `resolveRole` + `shortModel` / `ctxPct` / `ctxColor` / `truncateTitle` / `openTaskCount` を純関数として export。role 判定順（master → conductor → agents 線形探索 → unknown）、Nerd Font on/off、色境界（0/59/60/79/80）、20 codepoint 切り詰め、`▸ <role> \| T<id> \| ctx N%` / `♦ T<id> <title> \| <branch> \| ctx N% \|  M <model>` / `♦ idle \| ctx N% \|  M <model>` / `♦ Master \| M <model> \| ctx N% \| T:N \|  <branch>` の全フォーマットが現行 bash 版と一致。`statusline.test.ts` に単体テストが完備（色境界テスト含む）|
| 3 | wrapper (`statusline.sh`) | ✅ | 33 行の curl wrapper。`command -v curl` / `git rev-parse --show-toplevel` / `.team/proxy-port` 存在チェックで早期 exit 0。`curl -sSf --max-time 2 -X POST` で fail-fast、`\|\| true` で 4xx/5xx/timeout を空出力に落とす。`X-Cmux-Surface` / `X-Cmux-Nerd-Font` (default 1) / `X-Cmux-Statusline-Color` (default 0) を env から header に転送。末尾改行なし（curl 出力そのまま）で proxy と整合 |
| 4 | postinstall | ✅ | `bin/postinstall.js:36-44` は既存の `copyFileSync(statusline.sh → ~/.claude/statusline.sh) + chmod 0755` を維持。新 wrapper は同名ファイルで強制上書きされるため旧 bash 版から自動移行する |
| 5 | Master hook 移設 | ✅ | `.claude/settings.json` から `UserPromptSubmit` / `Stop` が削除され、`PreToolUse` の `.team/tasks/` 保護 hook のみ残存。`main.ts:1327-1363` の `generateMasterSettings(projectRoot)` が `master-settings.json` に両 hook を書き込み、`main.ts:1671` の `cmdLaunchMaster` が `claude --settings masterSettingsPath` で適用。Python スクリプト本体は `.team/prompts/master-hook-busy.py` / `master-hook-stop.py` に切り出し（`CONDUCTOR_ID` guard は構造的に不要なので削除済）。`main.test.ts:963-1011` に hook 構造 + Python 本体の regression テスト追加。`proxy.test.ts:379-398` に `.claude/settings.json` 構造 regression assert も追加 |
| 6 | CMUX_ROLE 削除 | ✅ | `main.ts` から 4 箇所すべて削除済。`rg CMUX_ROLE skills/ bin/ .claude/ commands/ docs/spec/` は main.test.ts の regression 記述のみヒット（`CHANGELOG.md` は履歴として保持）。`main.test.ts:1015-1021` に `main.ts` 内 `CMUX_ROLE` 残存 0 件の regression テスト追加。`cmdSpawnAgent` の `exportVars` (`main.ts:1807-1813`) にも `CMUX_ROLE` なし |
| 7 | CHANGELOG / docs | ✅ | `CHANGELOG.md:6-10` に T211 の 3 エントリ（statusline 移設 / Master hook 移設 / CMUX_ROLE 削除）追加。`docs/spec/05-install-and-infrastructure.md:16,103,104,195` に `POST /statusline` と `statusline.ts` / wrapper の記述追加 |

## Critical Issues

なし。

## Important Issues

なし。plan.md §4 Phase 1-4 の想定範囲にすべて収まっている。

## Minor / Nitpicks

1. **`statusline.sh` が `exec curl` ではなく通常パイプを使っている**: plan.md §4 Phase 2 の箇条書きには「`exec`: subshell を回避して余分なプロセスを起こさない」と書かれているが、実装は `statusline.sh:23-24` のコメントで明記されている通り `exec cmd || true` は成立しない（exec は shell プロセス自体を置換するため `|| true` が評価されない）ため、通常パイプ + `|| true` に切り替えている。技術的に正しい調整で fail-fast / 空出力フォールバックの目的は達成されている。plan の文言の側が実装不可能だったケース。修正不要。
2. **Implementer が `impl-report.md` を書き出していない**: Conductor への報告に影響するが、実装そのものは git diff から検証可能で完了している。Conductor 側で必要なら Implementer に再走行を依頼するか、本 inspection report を兼ねる判断でよい。

## Fix Required

なし（GO）。

## 検証コマンド結果

```
$ bun test 2>&1 | tail -5
 342 pass
 0 fail
 700 expect() calls
Ran 342 tests across 15 files. [9.44s]

$ rg -n CMUX_ROLE skills/ bin/ .claude/ commands/ docs/spec/
skills/cmux-team/manager/main.test.ts:1013:// --- T211 Phase 4: CMUX_ROLE 削除 regression ---
skills/cmux-team/manager/main.test.ts:1015:describe("T211 Phase 4: CMUX_ROLE 完全削除 regression", () => {
skills/cmux-team/manager/main.test.ts:1016:  test("main.ts 内に `CMUX_ROLE` 参照が残っていない", async () => {
skills/cmux-team/manager/main.test.ts:1019:    expect(src).not.toContain("CMUX_ROLE");
```

（`main.test.ts` のヒットは regression テスト自体が文字列「CMUX_ROLE」を含むため。ソースコード本体からは完全に除去されている。CHANGELOG は履歴として保持。）
