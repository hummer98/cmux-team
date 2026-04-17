# T211 — statusline を proxy HTTP API 化: 結果サマリー

## タスク概要

`skills/cmux-team/manager/statusline.sh` の描画ロジック（~140 行の bash + jq）を proxy の HTTP エンドポイント `POST /statusline` に移設し、shell 側は薄い curl wrapper にする。あわせて:

- `CMUX_ROLE` 環境変数を main.ts から完全削除（4 箇所）
- `CONDUCTOR_ID` guard を廃止し Master 専用 hook を `.claude/settings.json` から `master-settings.json` に移設（責務分離）
- Agent セッションが Master state を汚染する副次バグを解消

## 実行フロー

| Phase | Agent | 結果 |
|---|---|---|
| Phase 1 | Planner | plan.md 作成 (26KB) → Changes Requested → v2 改訂 (31KB) |
| Phase 2 | Design Reviewer (Round 1) | Changes Requested: Critical 1件 (curl -sSf 必要), Important 5件, Minor 7件 |
| Phase 2 | Design Reviewer (Round 2) | **Approved** — 10 項目すべて反映確認 |
| Phase 3 | Implementer | 全 4 Phase を一気に実装、`bun test` 342 pass / 0 fail |
| Phase 4 | Inspector | **GO** — 7 観点すべてパス、Critical/Important issue なし |

## 変更ファイル

### 新規

- `skills/cmux-team/manager/statusline.ts` — `formatStatusline` 純関数＋ヘルパー (`resolveRole`, `shortModel`, `ctxPct`, `ctxColor`, `truncateTitle`, `openTaskCount`)
- `skills/cmux-team/manager/statusline.test.ts` — master/conductor busy/idle/agent/unknown/色境界/Nerd Font/切り詰めの全ケース

### 変更

- `skills/cmux-team/manager/proxy.ts` — `POST /statusline` handler 追加（`proxy.ts:205-237`）
- `skills/cmux-team/manager/proxy.test.ts` — /statusline e2e 追加 + `.claude/settings.json` 構造 regression
- `skills/cmux-team/manager/statusline.sh` — 33 行の curl wrapper（`curl -sSf --max-time 2` で fail-fast、`|| true` で 4xx/5xx/timeout を空出力フォールバック）
- `skills/cmux-team/manager/main.ts` — `generateMasterSettings` を追加 (`main.ts:1327-1363`)、`cmdLaunchMaster` で `--settings master-settings.json` 適用、`CMUX_ROLE` env 設定を 4 箇所から削除
- `skills/cmux-team/manager/main.test.ts` — `generateMasterSettings` regression + `CMUX_ROLE` 完全削除 regression
- `.claude/settings.json` — Master 専用 UserPromptSubmit/Stop hook を削除、`.team/tasks/` 保護 PreToolUse は残す
- `CHANGELOG.md` — T211 の 3 エントリ追加
- `docs/spec/05-install-and-infrastructure.md` — `POST /statusline` と statusline.ts/wrapper の記述追加

### Python hook 独立スクリプト（`main.ts` から生成）

- `.team/prompts/master-hook-busy.py` — UserPromptSubmit hook（CONDUCTOR_ID guard なし）
- `.team/prompts/master-hook-stop.py` — Stop hook（CONDUCTOR_ID guard なし）

## テスト結果

```
bun test v1.3.12
 342 pass
 0 fail
 700 expect() calls
Ran 342 tests across 15 files. [9.68s]
```

## 検証結果

- ✅ `bun test` グリーン
- ✅ `rg CMUX_ROLE skills/ bin/ .claude/ commands/ docs/spec/` は main.test.ts の regression 記述のみヒット（ソースコード本体は 0 件）
- ✅ Agent 汚染 regression: `.claude/settings.json` に UserPromptSubmit/Stop hook が含まれないことを test で assert
- ✅ 現行 bash 版と TypeScript 版の出力フォーマットが一致（色境界・Nerd Font・切り詰めテスト追加）

## 設計判断（Round 1 レビューで修正）

1. **wrapper の `curl -sSf`** — Critical: Round 1 の plan では `curl -sS` だったため 4xx/5xx の error body が statusline に漏れる問題。`-f` (fail-fast) で修正
2. **Python hook を独立スクリプト化** — Important: 現行の `python3 -c` 2 段エスケープは修正難度が高い。`.team/prompts/master-hook-{busy,stop}.py` に切り出し
3. **末尾改行は意識的に非互換** — proxy レスポンスは末尾改行なし。現行 bash の `echo ""` とは挙動差あり（plan.md §4 Phase 1 で明示）

## Implementer の逸脱

- **Minor**: `statusline.sh` は `exec curl` ではなく通常パイプ + `|| true`。plan には `exec` が書かれていたが `exec cmd || true` は成立しない（exec は shell を置換するので `|| true` が評価されない）ため、Implementer が正しく判断して通常パイプに調整。スクリプト先頭コメントで明記済み。Inspector も確認して正当と判断。
- **Minor**: Implementer は impl-report.md の書き出しを忘れた。git diff と実ファイルから Inspector が検証可能だったため実害なし。

## マージ情報

- ブランチ: `task-211-1776271184/task`
- マージ先: `main`
- マージコミット: （完了時に埋める）
