## Verdict: Changes Requested

## Summary

Plan は T266 の収集基盤化という根本対策を十分に網羅しており、DB migration パターン（T243 踏襲）、hook 全送信ポリシー（T216 踏襲）の選択は概ね妥当。ただし T216 不変条件の扱い、受け入れ条件 2 を満たす CLI 変更の漏れ、hook env の実在性未検証という 3 点が Major で、実装前に方針整理が必要。

## Findings

### 1. [Major] D1 決定が T216 不変条件「handleMessage 入口で全シグナル無条件記録」を破る

Plan 161-181 行で採用された「NOTIFICATION 限定で handleMessage 入口の `insertHookSignal` を skip し case 内で enrichment 付き insert を 1 回だけ実行」方針は、`daemon.ts:1234-1240` の T216 コメント（"hook 全送信ポリシー — ルーティング分岐の前に全シグナルを trace DB に記録する"）という全体不変条件を NOTIFICATION に限り破る。Plan 自身が Decision Log D1 で却下した UPDATE 代替案（入口で INSERT → case 内で UPDATE）は、却下理由の「lastInsertRowid を case 内に伝播する必要がある」は `insertHookSignal` が既に `lastInsertRowid` を return しており、`handleMessage` 入口で `const hookId = insertHookSignal(...)` とすれば解決する。フェーズ C タスク 11 の「二重 INSERT 回避専用テスト」が必要になっている時点で、設計の筋が悪い signal。

### 2. [Major] 受け入れ条件 2 を満たす main.ts `cmdTraceHooks` / `buildHookDetail` の変更が「変更対象」表に欠落

Plan 224-235 行の変更対象表に main.ts の `cmdTraceHooks`（main.ts:3653）と `buildHookDetail`（main.ts:3641）の変更が挙がっていない。実装調査結果:

- `cmdTraceHooks` は `--type` / `--surface` / `--task-run` / `--limit` フラグしか受けない。受け入れ条件 2「`trace-hooks --type NOTIFICATION --json` で role / task_id / message / notification_type が取得できる」のうち `--json` モードは行をそのまま出力するため新列は自然に出るが、**非 JSON モードの `buildHookDetail`** は NOTIFICATION 固有列（role / task_id / ntype / message）を表示する分岐がない。
- タスクスペック 3.7 / 受け入れ条件 2 が暗に求める `--role` / `--task-id` フィルタは Plan フェーズ B タスク 9（optional 扱い）のみに記載。しかし Plan D7 で「本タスクの受け入れ条件 2 に明記されているので実装は必須」と矛盾した表記。

変更対象表とフェーズ分割の両方を更新し、`cmdTraceHooks` 本体・`buildHookDetail`・CLI フラグ追加を明示的に必須タスク化すべき。

### 3. [Major] hook env `${CMUX_SURFACE_ID}` / `${CMUX_WORKSPACE_ID}` の env 名実在性が未検証

Plan 57-58 行の hook command で使う `${CMUX_SURFACE_ID:-}` / `${CMUX_WORKSPACE_ID:-}` は cmux が設定する env 名として未検証（Plan 自身 5.4 リスクで認めている）。cmux-team の既存 hook は `${CMUX_SURFACE}` のみを参照しており、UUID 系 env の設定有無は未確認。env 名が異なる場合（実名は `CMUX_SURFACE_UUID` / `CMUX_WORKSPACE_UUID` 等の可能性）:
- 受け入れ条件 2 の「surface_uuid が取れる」が実質達成不能
- formatSurface の UUID 付与（Plan の目玉機能の一つ）が常時無効化
- 実装完了後に 3 hook 全修正が必要になる手戻り

検証タスクをフェーズ G（最終 E2E）ではなくフェーズ A 着手前 / 並行で配置し、`echo "env dump: $(env | grep -i cmux)" >> /tmp/cmux-env.log` 等で実名を確定させるべき。

### 4. [Minor] タスクスペック `C[192/22D8F9]` (6 文字) と Plan D6 (8 文字) の記述不整合

タスクスペック manager.log 例は `22D8F9`（6 文字）、Plan D6 決定は「末尾 8 文字・大文字化」。実装時にどちらに従うか不明瞭。Plan D6 の「衝突確率 2^32」根拠は妥当だが、タスクスペック例との整合を取るために 6 文字に合わせるか、タスクスペックの例を修正する判断を明示すべき。

### 5. [Minor] manager.log の `message="..."` quote エスケープルール未定義

Plan 194 行「message に `=` / スペース / 改行が含まれる可能性があるので double-quote wrap」とあるが、message 本体に `"` が含まれる場合のエスケープ方針（`\"` 置換 / JSON.stringify 採用 / 事前 sanitize）が書かれていない。Claude Code の Notification message は本体に "..." 引用を含む可能性が高く（"Claude is waiting for your input" の類）、parseability を確保するためにエスケープルールを明示すべき。

### 6. [Minor] notification_type / message 抽出のキー優先順位が仮説

Plan 117-118 行のキー優先順位（`notification_type` / `type` / `subtype` 等）は Claude Code stdin JSON schema が非公開のため仮説。初回実装で payload_json をサンプリングしてから確定させる運用タスクを明示しておかないと、空の notification_type が大量記録される可能性。フェーズ G に「初回 10 サンプル取得後にキー優先順位を確定・調整」タスクを追加推奨。

### 7. [Minor] SURFACE_REQUIRED_TYPES への NOTIFICATION 追加が --from-stdin 経路を通らない

Plan 93 行「`SURFACE_REQUIRED_TYPES` に "NOTIFICATION" を追加し、UUID 形式の `--surface` も受け付ける」は、main.ts:888-932 の `--from-stdin` 早期 return により実効せず。本番経路が hook からの `--from-stdin` のみなら、`buildMessageFromHookInput` 側で surface 正規化するか、`--from-stdin` でも SURFACE_REQUIRED_TYPES を通るように処理順を変更する必要あり。Plan はここに触れていない。

### 8. [Minor] `insertHookSignal` シグネチャ変更（`enrichment?` 追加）の既存呼び出し箇所への影響が未記述

Plan は `insertHookSignal(db, message, enrichment?)` への拡張を提案するが、既存呼び出し箇所（daemon.ts:1236 + trace-store.test.ts）への影響確認タスクが欠落。後方互換 optional 引数なので破壊はないが、既存テストが新 8 列の NULL 挙動を検証するように更新が必要かの判断が plan に無い。

### 9. [Minor] CLAUDE.md 「hook 全送信ポリシー（T216）」節への修正範囲が曖昧

Plan フェーズ F タスク 20 で「NOTIFICATION ルーティング例外（T266）を追記」とあるが、T216 節本文の「**実装上の不変条件:** `handleMessage` の入口（switch 分岐より前）で必ず `insertHookSignal` を呼ぶ」という既存記述（CLAUDE.md 該当節）と NOTIFICATION 例外が直接矛盾する。追記だけでなく既存段落の改訂（「NOTIFICATION を除き」等の条件句追加）が必要で、Plan の「追記」表現では漏れるリスク。

## Recommendations

### Finding 1 の対応（最優先）

Decision Log D1 を以下の代替案に差し替える:

```ts
// handleMessage 入口（既存の T216 不変条件を維持）
let hookSignalId: number | null = null;
if (state.traceDb) {
  try {
    hookSignalId = insertHookSignal(state.traceDb, message);
  } catch (e: any) {
    await log("hook_signal_insert_failed", `type=${message.type} ${e?.message ?? e}`);
  }
}

// case "NOTIFICATION" 内
if (hookSignalId !== null && state.traceDb) {
  const enrichment = resolveNotificationEnrichment(state, message);
  updateNotificationEnrichment(state.traceDb, hookSignalId, enrichment);
  await log("notification_received", formatNotificationLog(message, enrichment));
}
```

`updateNotificationEnrichment(db, id, enrichment)` は `UPDATE hook_signals SET role=?, task_id=?, ... WHERE id=?` の単一 stmt。これによりフェーズ C タスク 11（二重 INSERT 回避テスト）は不要になり、T216 不変条件も維持される。

### Finding 2 の対応

変更対象表とフェーズに以下を追加:

- **変更対象表に追記**: `main.ts` に `cmdTraceHooks` / `buildHookDetail` 変更追加
- **フェーズ B タスク 9 を必須化**: `getHookSignals` に `role` / `taskId` フィルタ追加
- **新フェーズ追加**: 「cmdTraceHooks CLI 拡張」(`--role` / `--task-id` フラグ + `buildHookDetail` NOTIFICATION 分岐) を B〜C の間に配置

### Finding 3 の対応

フェーズ A 着手前に以下の検証タスクを追加:

```bash
# 既存 Master/Conductor/Agent セッションで env 名を確認
cmux-team start
cmux-team spawn-agent ...
# hook 内に一時的に `env | grep -i cmux >> /tmp/cmux-env-probe.log` を埋め込み
# 実在する env 名（CMUX_SURFACE_ID / CMUX_SURFACE_UUID / ...）を確定
```

検証結果に応じて hook command の env 参照を修正。cmux が UUID 系 env を設定していない場合は、Plan 5.4 の通り surfaceUuid / workspaceUuid を常時 undefined として受け入れるか、spawn-agent 側で env を注入する設計に変更。

### Finding 4-9 の対応

- **4**: 実装に先立ち UUID 長を 6 / 8 どちらか確定し、タスクスペックまたは Plan D6 を修正
- **5**: `formatNotificationLog` 内で `message` を `JSON.stringify(msg).slice(0, 82)` で wrap する等、エスケープ仕様を明記
- **6**: フェーズ G 開始直後に初回サンプル取得 → キー優先順位確定のサブタスクを追加
- **7**: `buildMessageFromHookInput` の NOTIFICATION 分岐内で `normalizeSurfaceArg` を呼び surface を正規化する旨を明記
- **8**: フェーズ B タスク 5-7 に「既存 trace-store.test.ts / daemon.test.ts が新列 NULL 挙動で green のまま動くことを確認」を追加
- **9**: フェーズ F タスク 20 を「CLAUDE.md の T216 節本文を『NOTIFICATION 以外では』条件句付きに改訂」+「新節 T266 追加」の 2 本に分割

## CRITICAL チェック項目の評価

| 項目 | 結果 |
|------|------|
| サブタスクカバレッジ（全変更対象が分割されているか） | **NG** — Finding 2 の通り cmdTraceHooks / buildHookDetail / CLI フラグ追加が欠落 |
| 統合テスト/検証（コンポーネント間の接続検証） | **NG** — Finding 3 の env 名実在性検証がフェーズ G に先送りで手戻り危険 |
| 削除タスクの完全性 | OK（純増機能のため削除なし） |
| 既存テストへの影響（test 修正タスクの有無） | **NG** — Finding 8 の通り既存 trace-store / daemon テストへの影響確認タスク欠落 |
