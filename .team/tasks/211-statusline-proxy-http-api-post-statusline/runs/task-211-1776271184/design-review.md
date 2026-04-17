# Design Review: T211 (Round 2)

## Decision

**Approved**

## Summary

Round 1 で指摘した 10 項目すべてが plan.md に反映されている。Critical だった wrapper の `curl -sSf` + `exec` は行 233 で修正済み、Important 4 件（末尾改行方針明示、リスク表 2 行追加、Python hook 外部ファイル化、regression assert 追加）と Minor 5 件も全て取り込まれた。新たな矛盾は見当たらず、全体として実装可能な粒度に整っている。Phase 順序（Phase 1 → 2 → 3 → 4）も妥当で、各 Phase のロールバック可能性も維持されている。

## Changes from Round 1

| # | 指摘項目 | Round 2 での状態 | 箇所 |
|---|----------|------------------|------|
| 1 (Critical) | wrapper `curl -sSf` + `exec` | ✅ 反映 | plan.md:233 `exec curl -sSf --max-time 2 -X POST \` + 行 241-244 で `-f` / `-sS` / `exec` / `|| true` の意図を個別解説 |
| 2 (Important) | proxy レスポンス末尾改行方針 | ✅ 反映 | plan.md:212 で「proxy は末尾改行を含めない、§5.1 スナップショットも同方針、現行 `echo ""` は意識的に非互換」と明記 |
| 3 (Important) | リスク表 2 行追加 | ✅ 反映 | plan.md:384（既存 Master degraded）+ 385（他プロジェクト `~/.claude/statusline.sh` 自動上書き + CHANGELOG 周知） |
| 4 (Important) | Python hook を独立スクリプトに切り出し | ✅ 反映 | plan.md:254-260 で `master-hook-busy.py` / `master-hook-stop.py` を `.team/prompts/` に生成、`python3 <path>` で呼ぶ設計を明記。行 263-264 で `generateMasterSettings` が `writeFileSync` で生成する設計 |
| 5 (Important) | 論証コメント + .claude/settings.json 構造 regression | ✅ 反映 | plan.md:349（**論証**: hook が存在しない → POST /master-state 発火しえず state 不変）+ 350-355（proxy.test.ts 側の構造 regression assert 4 点） |
| 6 (Minor) | §2.3 行番号ずれ note | ✅ 反映 | plan.md:50 `> **Note**: task.md の行番号 (1371/1456/1501/1659) は旧版の値で、現在の実装では -5 ずれている。以下の表は最新の行番号を反映。` |
| 7 (Minor) | §4 Phase 4 step 6 書き換え | ✅ 反映 | plan.md:287-289 「`cmdSpawnAgent` の `exportVars` から `CMUX_ROLE=` が消えたことを検証するテストを新規追加する」+ 既存 0 件の確認コメント |
| 8 (Minor) | ヘッダー default 値明記 | ✅ 反映 | plan.md:206（`X-Cmux-Nerd-Font` 未指定時 `true`、`"0"` / `"false"` のみ false）+ 207（`X-Cmux-Statusline-Color` 未指定時 `false`、`"1"` / `"true"` のみ true） |
| 9 (Minor) | curl timeout 2 秒の補足 | ✅ 反映 | plan.md:371 リスク表 row 2 の補足「`--max-time 2` は Claude Code の statusline 推奨 300ms を超えているが、local HTTP（127.0.0.1）なので実測 5-20ms に収まり問題なし」+ 将来 1 秒に絞る余地を明示 |
| 10 (Minor) | §4 Phase 4 step 5 の rg スコープに `.team/prompts/` 追加 | ✅ 反映 | plan.md:285 `rg -n CMUX_ROLE skills/ bin/ .claude/ commands/ docs/ .team/prompts/`（§7.2 の行 398 にも同スコープ反映済み） |

## Findings

### Critical

(なし)

### Important

(なし)

### Minor / Nitpicks

- **N1. `docs/` と `docs/spec/` のスコープ表記** — §4 Phase 4 step 5（plan.md:285）の rg スコープは `docs/` 全体だが、§7.2（plan.md:398）は `docs/spec/` に絞り込んでいる。実害は無い（`docs/` ⊃ `docs/spec/`）が、両者を揃えておくと実装者の見落としを防げる。**修正不要、記録のみ**。

- **N2. `generateMasterSettings` の Python 定数保持箇所** — plan.md:263-264 は `master-hook-busy.py` / `master-hook-stop.py` の内容を「テンプレート文字列を内部定数として保持」とだけ記述している。実装時に `const MASTER_HOOK_BUSY_PY = \`...\`;` のようなトップレベル定数にするのか、`generateMasterSettings` 関数内のローカル定数にするのかが未確定だが、どちらでもテストしやすく粒度的には Round 2 でさらに詰める必要はない。**実装者判断に委ねて OK**。

- **N3. `.claude/settings.json` の `PreToolUse` エントリ保持の検証位置** — plan §5.3（main.test.ts）と §5.4（proxy.test.ts）の両方で「`PreToolUse` の `.team/tasks/` 保護が残ること」を assert する設計になっている。重複は冗長だが、前者が「生成ファイルの構造」、後者が「Agent 汚染 regression」と観点が異なるため両方残しておくのは妥当。**修正不要**。

## Recommendations

(Approved のため不要)
