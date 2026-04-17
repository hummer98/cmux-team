# Inspection — T181

## Verdict: GO

## 検品サマリー

- **plan 網羅性**: plan §14 の実装順序 1〜11 がすべて反映されている（schema / detect-ask.sh / generateAgentSettings / cmdAwaitAgent / daemon の SESSION_ASK・SESSION_IDLE(agent)・SESSION_ENDED(agent) / send --from-stdin / dashboard / conductor-role.md 日英 / race テスト 3 件）。
- **Critical 2 件**:
  - (1) TOCTOU race → `cmdAwaitAgent` は `watch()` 先起動 + `handleDoneIfFresh()` 冪等再チェック + `timestamp_ms < startedAt` skip + 残骸 unlink の 3 段構えで実装（main.ts:2217-2280）。
  - (2) exit 75 → 本体に「await-agent は done ファイルの fs.watch であり rate limit を直接受けない」コメントを埋め込み済み（main.ts:2182-2188）。exit 75 を返す経路なし。
- **Important 4 件**:
  - (3) Stop hook 途中ターン → detect-ask.sh で Case B を採用（tool_use/tool_result が 0 かつ `IS_CONDUCTOR=0` → exit 0、main.ts:1036-1041）。
  - (4) tail -n 10 → 適用済み（main.ts:1028）。
  - (5) --from-stdin → cmdSend に実装、zod で QueueMessage を検証して enqueue（main.ts:689-706）。
  - (6) done timestamp_ms → writeAgentDone で必ず埋め込み（daemon.ts:124-138）、await-agent が startedAt と比較して skip。
- **テスト**: `bun test` → 211 pass / 0 fail（新規 race 3 件含む、13 ファイル）。
- **tsc**: 既知エラー 6 件（cmux.ts / daemon.ts update-notifier / dashboard.tsx "unstyled" x2 / main.test.ts:84 / main.ts:515）のみ。**本 PR 由来のエラー 0 件**。

## Findings

### [Critical]
なし。NOGO 要因なし。

### [Important]
- **detect-ask.sh の python3 フォールバックで SURFACE env var が Python に届かない** (main.ts:1008-1011)
  - `python3 -c "..." SURFACE="$SURFACE"` と書かれているが、`SURFACE=...` が python3 の**引数**として渡っているため、Python 側の `os.environ.get("SURFACE", "")` は空を返す。本来は `SURFACE="$SURFACE" python3 -c "..."` と前置する必要がある。
  - 影響範囲は「jq も python3 も使う環境ではないが python3 はある」という限定的なケースで、かつ surface 欠落で daemon 側の `session_idle_unknown_surface` ログが出るだけなので degrade 挙動は保たれる。通常環境では jq パスに入るため目に見えない。
  - **GO には影響しない**（plan §5.2 の「fail-safe degrade」方針に沿っている）。follow-up で修正可。

### [Minor]
- **dashboard の明示 sort 追加が保留** — impl-summary.md §実装決定 にも記載あり。plan §11.1 は Suggestion 扱いで必須ではない。Map 挿入順で近似できるという判断は妥当。
- **cmdAwaitAgent の fs/promises watch を `await import` している** (main.ts:2260) — top-level import で済む。dynamic import は不要だが挙動上の問題はない。
- **detect-ask.sh の `TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")`** は ms 解像度を 000 固定にしているが zod の `datetime()` は通るので可。

## Fix Required
なし（GO）。

## 総評

plan v2 の [Critical] 2 件と [Important] 4 件はすべて実装で反映済み。特に TOCTOU 対策は watcher 先起動 + startedAt 比較 + 残骸 unlink の三段防御に unit テスト（未来 ts / watcher 後書き / 古い ts skip）が追随しており、設計と検証の両面で固い。破壊的変更（`"asking"` 追加、ConductorState.askQuestion、send --from-stdin 追加）は plan §11 の範囲内で、TypeScript 型の網羅性も既存コードを壊していない（bun test 211 pass、tsc は既知 6 件のみ）。テンプレート編集は `skills/cmux-team/templates/*` のみ（`.team/prompts/` 直接編集なし）で CLAUDE.md ルールに合致。日英 conductor-role.md も構造が 1:1 で揃っている。EventBus / logging ポリシーも実装済み（writeAgentDone 失敗時の log("error", ...)、SESSION_ASK の notifyStateChanged 呼び出しあり）。

残る Important（python3 fallback の SURFACE envvar バグ）は fail-safe degrade の枝葉で、主要経路（jq 有環境）には影響しない。follow-up タスクで拾える範囲。**実装を accept して良い。**
