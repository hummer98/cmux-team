# T392 — Agent の API エラーを StopFailure hook で TUI に可視化する

## 概要

Claude Code の `StopFailure` hook を Master / Conductor / Agent の settings.json に登録し、daemon が payload を受けて state を更新、dashboard で kind 別アイコン + RED 表示する。proxy 改造ゼロで完結。

## フェーズ実行

| Phase | Agent | Round | 結果 |
|---|---|---|---|
| 1. Plan | Planner | 1 → 2 (DR 反映) | plan.md 651 行 |
| 2. Design Review | Design Reviewer | 1 (CR) → 2 (Approved) | 必須 2 件・任意 5 件すべて反映 |
| 3. Impl | Implementer | 1 → 2 (Inspector minor 反映) | 全テスト pass / tsc 0 |
| 4. Inspect | Inspector | 1 (GO) | Minor 2 件は Round 2 で消化 |

## 完了したサブタスク

### コア配管
- `schema.ts`: `StopFailureMessage` 新設（pid required）+ AgentState/ConductorState/MasterState の status に `"error"` 追加 + `lastApiError` optional
- `main.ts`:
  - `generateMasterSettings` / `generateAgentSettings` / `generateConductorSettings` に StopFailure hook 登録（`--role <kind>` を hardcode）
  - `cmdSend` Usage 行と `SURFACE_REQUIRED_TYPES` に STOP_FAILURE を追加
  - `buildMessageFromHookInput` の STOP_FAILURE 分岐
  - `cmdAwaitAgent` help / `printAgentDoneAndExit` の status → exit code に `api_error → 11` を追加
- `daemon.ts`:
  - `case "STOP_FAILURE"` 追加（NOTIFICATION 直後、SHUTDOWN 直前）
  - `resolveStopFailureTarget`（Notification と同じ逆引き優先順位）
  - `AGENT_SPAWNED` / `SESSION_STARTED` / `SESSION_IDLE` / `SESSION_ASK` で `lastApiError` リセット
  - `writeAgentDone` の status enum に `"api_error"` 追加（任意の `kind` / `message` 含む）
- `events-writer.ts`: `EventStreamRecord` union に `api_error_received` 追加（schema_version は bump せず add-only）
- `dashboard.tsx`:
  - `API_ERROR_ICONS`（⏳/🔒/💰/⚡）+ `apiErrorIcon` / `truncateApiErrorMessage` ヘルパー
  - `function buildMasterSection` を `export function` 化（Design Review 必須修正 #2）
  - Master / Conductor / Agent 行に `error` 状態の RED + アイコン + 80 字短縮 message
  - asking と error の並立は asking 優先（任意修正 §3.6）
  - `formatConductorsSectionLabel` に `error` カウント追加（Round 2 minor）

### spec / docs
- `docs/spec/07-state-machine.md`: §1.1 状態一覧 + §1.2 遷移表 + §1.4 mermaid + §1.5 不変条件 C-I4 を更新
- `docs/spec/04-templates.md`: settings.json hook 一覧表を新設
- `docs/spec/08-runtime-boundary.md`: 正規化イベント表に `STOP_FAILURE → api_error_received` 追加
- `docs/spec/glossary.md`: hook 用語に `StopFailure` を明記

### テスト
| ファイル | 件数 | 種別 |
|---|---|---|
| `schema.test.ts` | +10 | StopFailureMessage round-trip + lastApiError |
| `main.test.ts` | +9 | hook 登録 / buildMessageFromHookInput / await-agent api_error |
| `daemon.test.ts` | +9 | STOP_FAILURE handler 全パターン + SESSION_ASK reset |
| `events-writer.test.ts` | +1 | api_error_received |
| `dashboard-conductor.test.tsx` | +9 | Agent error / Conductor error / asking 優先 / sectionLabel error カウント |
| `dashboard-master.test.tsx`（新規） | +6 | buildMasterSection error 表示 + 既存回帰 |

## 変更ファイル一覧（git diff --stat）

```
docs/spec/04-templates.md             |  15 +
docs/spec/07-state-machine.md         |  58 ++--
docs/spec/08-runtime-boundary.md      |   1 +
docs/spec/glossary.md                 |   2 +-
skills/cmux-team/manager/daemon.test.ts            | 340 +++
skills/cmux-team/manager/daemon.ts                 | 178 ++
skills/cmux-team/manager/dashboard-conductor.test.tsx | 197 ++
skills/cmux-team/manager/dashboard.tsx             |  94 +-
skills/cmux-team/manager/events-writer.test.ts     |  17 +
skills/cmux-team/manager/events-writer.ts          |   9 +
skills/cmux-team/manager/main.test.ts              | 135 +
skills/cmux-team/manager/main.ts                   |  76 +-
skills/cmux-team/manager/schema.test.ts            | 117 +
skills/cmux-team/manager/schema.ts                 |  61 +-
skills/cmux-team/manager/dashboard-master.test.tsx |  ++ (新規)
14 files + 1 new = 1266 insertions / 34 deletions
```

## テスト結果

- 全 60 ファイル pass / fail 0（CLAUDE.md 規定の安全な順次実行）
- `bunx tsc --noEmit` exit 0（新規エラー 0）

## 受け入れ基準（タスク本文 8 項目）

- [x] 1. Master / Conductor / Agent settings.json に StopFailure hook 登録
- [x] 2. `cmux-team send STOP_FAILURE --from-stdin` 動作
- [x] 3. AgentState / MasterState / ConductorState 拡張
- [x] 4. daemon STOP_FAILURE 受信で state 更新 + events.jsonl 記録
- [x] 5. dashboard kind 別アイコン + 80 字短縮 + RED 表示
- [x] 6. await-agent `STATUS=api_error KIND=<kind>` exit 11
- [x] 7. artifact A025 と spec 整合
- [x] 8. 既存テスト pass

## マージコミット / PR

（後段で埋める）

## 既知の懸念

- `resolveStopFailureTarget` の role 不在 fallback は実質 dead code（settings.json は `--role` を hardcode で送る契約のため、将来互換性のためのみ維持）
- `shadowObserveConductor` への STOP_FAILURE 流入なし（reducer 監視は P3 まで shadow only / `error` 状態は P3 で reducer 拡張する）
- `EVENTS_SCHEMA_VERSION` は bump せず add-only（reader が unknown event を skip する前提）
- アイコン互換性: 標準 Unicode/絵文字のみ。ターミナルによっては絵文字幅計算ずれの可能性（必要なら別タスクで `nerdIcon` 経由に拡張）
- 5xx 沈黙タイマーは未実装（A025 で「不要」確定）

## 関連

- artifact A025: `.team/artifacts/A025-api-error-hook-probe.md`
- 検証スクリプト残骸: `/tmp/api-error-probe/`（手動削除）
- 検証 surface: workspace:1 surface:479 "API-Error-Probe"（close-surface）
