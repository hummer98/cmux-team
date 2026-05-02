# T380 整合チェック結果（plan §F）

実行日時: 2026-05-01（ローカル）
実行環境: worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-380-1777565426/`
global cmux-team バージョン: `4.22.0`（metrics サブコマンド未収録）

> **前提**: T379 で実装された `cmux-team metrics` サブコマンドは未リリース（v4.22.0 時点では global 版に同梱されていない）。
> このため F.6 は **方式 B（source 直接実行）** を一次手段とし、global 版での確認は次回 release 後に再実施する。

---

## F.1 metric 名と計算式の整合（PASS）

```bash
grep -nE 'tool_call_total|tool_failure_rate|time_to_first_edit_ms|deny_rate|tool_call_stddev|duration_ms_mean|completion_rate|abort_rate|forced_close_rate' \
  docs/spec/11-metrics.md \
  skills/cmux-team/manager/metrics-aggregate.ts \
  skills/cmux-team/manager/metrics-cli.ts
```

ヒット件数:
- `docs/spec/11-metrics.md`: 24 行
- `skills/cmux-team/manager/metrics-aggregate.ts`: 35 行
- `skills/cmux-team/manager/metrics-cli.ts`: 30 行

各 metric が 3 ファイルすべてに出現することを確認した。

---

## F.2 SQL CTE 名と JOIN key（PASS）

```bash
grep -n 'session_to_task' docs/spec/11-metrics.md skills/cmux-team/manager/trace-store.ts
```

- `docs/spec/11-metrics.md`: §3.5 タイトル + 本文 + コードブロック + 脚注 + §7 後続タスク参照（5 件）
- `trace-store.ts`: 1167（コメント） / 1179（CTE 本体・countToolCallsByTask） / 1187（JOIN） / 1204（コメント） / 1220（firstEditPerTask） / 1228（JOIN） / 1258（failureRateByTask） / 1275（JOIN）

spec §3.5 で行番号 1179-1184 / 1219-1225 / 1257-1263 を脚注に記載済み。逐語コピーした CTE 全文も spec §3.5 に転載。

---

## F.3 events.jsonl の terminal 4 event（PASS）

```bash
grep -n 'task_completed\|task_aborted\|task_completed_state_mismatch\|conductor_disconnect_timeout' \
  docs/spec/11-metrics.md skills/cmux-team/manager/metrics-aggregate.ts
```

- spec §3.1 の 4 event（150-153 行）が `metrics-aggregate.ts:113-118` の `TERMINAL_EVENTS` set および `classifyOutcome`（120-133）と完全に一致。

---

## F.4 出力 JSON フィールド名（PASS）

```bash
grep -nE '^\s+(task_id|outcome|assigned_ts|closed_ts|duration_ms|tool_calls|tool_call_total|tool_failure_rate|time_to_first_edit_ms|tokens):' \
  skills/cmux-team/manager/metrics-aggregate.ts
```

- `Lifecycle` interface（33-37）: task_id / assigned_ts / closed_ts / duration_ms / outcome
- `PerTaskMetrics` interface（41-50, 311）: 同 5 + tool_calls / tool_call_total / tool_failure_rate / time_to_first_edit_ms / tokens

spec §5.1 の JSON keys 列挙（assigned_ts / closed_ts / duration_ms / outcome / task_id / time_to_first_edit_ms / tokens / tool_call_total / tool_calls / tool_failure_rate）と一致。F.6 の jq 出力でも同 10 key を確認済み。

---

## F.5 Caveats 3 点の転載（PASS）

spec §6（行 240 周辺、`docs/spec/11-metrics.md:240-261` 周辺）に以下 3 点を転載:

1. ✓ deny_rate は cmux-team の Bash deny 率であり汎用 hook block 率ではない
2. ✓ task_assigned 前に発火した hook は集計外（task_sessions JOIN）
3. ✓ tool_response.content は 1KB に切り詰め

`help_metrics`（`i18n.ts` ja: 591-627 / en: 1478-1514）と同じ意味内容で転載していることを目視確認した。

---

## F.6 CLI 例の妥当性

### 方式 A: global インストール版（cmux-team 4.22.0）

```bash
cmux-team metrics --since 7d --format json
# => Unknown command: metrics
```

global 版は metrics 未収録（T379 が未リリース）。次回 release 後に再実施する。

### 方式 B: worktree 内 source 直接実行（一次手段、PASS）

```bash
bun run skills/cmux-team/manager/main.ts metrics --since 7d --format json | jq '.[0] | keys'
```

出力:

```json
[
  "assigned_ts",
  "closed_ts",
  "duration_ms",
  "outcome",
  "task_id",
  "time_to_first_edit_ms",
  "tokens",
  "tool_call_total",
  "tool_calls",
  "tool_failure_rate"
]
```

→ spec §5.1 の期待 keys と完全一致（10 key）。

```bash
bun run skills/cmux-team/manager/main.ts metrics --group-by day --since 14d --format csv | head -1
```

出力:

```
bucket,tasks_assigned,tasks_completed,tasks_aborted,completion_rate,abort_rate,forced_close_rate,deny_rate,tool_call_total,tool_call_stddev,duration_ms_mean,duration_ms_stddev,tokens_input,tokens_output,tokens_cache
```

→ spec §5.2 のヘッダー（`metrics-cli.ts:222-238` の `PER_BUCKET_HEADER`）と完全一致（15 列）。

```bash
bun run skills/cmux-team/manager/main.ts metrics --task-id 379 --format text
```

出力:

```
task_id=379 outcome=completed assigned_ts=2026-04-30T15:20:44.950Z closed_ts=2026-04-30T16:10:26.075Z duration_ms=2981125 tool_call_total=0 tool_failure_rate=0.0000 time_to_first_edit_ms=null tokens_input=0 tokens_output=0 tokens_cache=0 tokens_requests=0 tool_calls={}
```

→ spec §5.3 の text format と一致。`tool_calls={...}` の JSON-encoded value（m-8 対応）も確認した。

### 出力差分対応の申し送り

global 版 (4.22.0) と worktree source の出力比較は、次回 release 以降に再実施する必要がある。
差分検出時の対応:

- 出力フィールド差分 → worktree source の方が ahead。global 再インストール（`npm install -g <publish 後>`）で更新
- global 版が ahead だった場合（理論上ありえない）→ worktree の rebase 漏れを疑う

---

## F.7 glossary 参照リンク（PASS）

```bash
grep -nE 'metrics SSOT|cohort comparison|baseline period|evaluation period|header rot|agent message GC' docs/spec/glossary.md
```

6 用語すべてが §11「Metrics 関連」表（行 177-182）に定義されていることを確認:

- ✓ metrics SSOT
- ✓ cohort comparison
- ✓ baseline period
- ✓ evaluation period
- ✓ header rot
- ✓ agent message GC

各用語は要約 1-2 行 + `11-metrics.md` の一次リンクのみ（DRY 方針）。

---

## F.8 CLAUDE.md の差分（PASS）

```bash
git diff --stat CLAUDE.md
# CLAUDE.md | 2 ++
# 1 file changed, 2 insertions(+)
```

差分は **+2 行のみ**:

1. 「リポジトリ構造」表に `docs/spec/11-metrics.md` を 1 行追加
2. 「進捗情報の取得方法」表に `cmux-team metrics ...` を 1 行追加

最小変更方針（plan §E、候補 2）に従い、新 H2 セクションは作成していない。

---

## まとめ

F.1〜F.8 の 8 項目すべて PASS（F.6 方式 A は global 4.22.0 未収録のため方式 B で代替確認）。

成果物 3 ファイル:

- `docs/spec/11-metrics.md`（新規、§1〜§7）
- `docs/spec/glossary.md`（§11「Metrics 関連」追加 + 目次更新）
- `CLAUDE.md`（+2 行、最小変更）

design-review-rev2 の Recommendations 5 件:

- ✓ Recommendation 1（α/N=0.0125 の数値記載）: §4.4 に記載済み
- ✓ Recommendation 2（global vs source 出力差分対応）: 本ファイル F.6 末に記載
- ✓ Recommendation 4（§2.1 / §2.2 注釈）: §2.1 末の 2 行注釈、§2.2 注を記載済み
- ✓ Recommendation 5（§5 JSON 例で assigned_ts / closed_ts / bucket）: §5.1 keys, §5.2 ヘッダー, §5.3 text 例で確認済み
- Recommendation 3（§D 文言整理）: plan.md 自体の編集は不要（任意）。本タスクではスキップ
