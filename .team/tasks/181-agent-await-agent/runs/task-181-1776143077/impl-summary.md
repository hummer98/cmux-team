# 実装サマリー

T181 — await-agent 方式への移行 & Ask 状態検出。Conductor の `cmux read-screen` ポーリングを廃止し、Agent の Stop / SessionEnd hook が書き出す done マーカーを daemon が集約 → Conductor は `cmux-team await-agent` で fs.watch 待ちする構成に変更。

## 変更ファイル

- `skills/cmux-team/manager/schema.ts`
  - `SessionAskMessage` 追加 → `QueueMessage` discriminated union に登録
  - `ConductorState` に `askQuestion?: string` と status `"asking"` を追加
  - 型 export: `SessionAskMessage`
- `skills/cmux-team/manager/daemon.ts`
  - `normalizeSurfaceForPath(surface)` export（`[^a-zA-Z0-9_-]` → `_`）
  - `writeAgentDone(projectRoot, conductorSurface, agentSurface, { status, reason?, question? })` export
    → `.team/conductors/<c>/agent-done/<a>.done` に `status=... / timestamp_ms=... / timestamp=... / reason=... / question=...` を書き出す（改行は space 置換 / 4096 truncate）
  - SESSION_ENDED Agent パス: writeAgentDone({status:"crashed"}) を挟んでから agents splice、`agent_done` log
  - SESSION_IDLE:
    - Conductor の `asking → idle/running` 遷移追加（askQuestion クリア、`conductor_ask_resolved` log）
    - Agent 分岐（writeAgentDone({status:"completed"})、splice しない）
    - 未登録 surface は `session_idle_unknown_surface` log
  - SESSION_ASK: Master → 無視 log / Conductor → `status="asking"` + askQuestion 設定 + notifyStateChanged / Agent → writeAgentDone({status:"ask", question}) / 未登録 → `session_ask_unknown_surface`
  - monitorConductors の `surface_lost` パス: agent 側でも writeAgentDone({status:"crashed", reason:"surface_lost"})
- `skills/cmux-team/manager/main.ts`
  - `ensureAskDetectorScript(projectRoot)` → `.team/prompts/detect-ask.sh`（0o755）を書き出し。Stop hook payload を stdin 受領し、transcript JSONL tail 10 行を jq で解析:
    - Case A: `AskUserQuestion` tool_use → SESSION_ASK を `cmux-team send --from-stdin` で送信 + `exit 2` で Agent を保留
    - Case B: Conductor 以外の純 text stop → exit 0（通常完了）
    - Case C: それ以外 → SESSION_IDLE 送信
  - `generateAgentSettings(projectRoot, surface)` 追加 → `.team/prompts/<surface>-agent-settings.json` に Stop hook（detect-ask.sh）+ SessionEnd hook（SESSION_ENDED）を生成
  - `generateConductorSettings` の Stop hook を `bash <detect-ask.sh>` 経由に差し替え
  - `cmdSpawnAgent` で `--settings <agent-settings>` を付与
  - `cmdSend`: `--from-stdin` ブランチ追加（stdin → JSON.parse → `QueueMessage.parse` → postMessageAndExit）+ SESSION_ASK ケース
  - `cmdAwaitAgent` 実装（§8, TOCTOU 対策: watcher 先起動 → existsSync 再チェック、startedAt より古い `timestamp_ms` は unlink skip、fs/promises `watch()` + AbortController）
  - `printAgentDoneAndExit` で STATUS→exit code マッピング（completed/ask=0, timeout=2, crashed=10, other=1）+ done ファイル削除
  - `findConductorSurfaceForAgent(agentSurface)` で team.json 逆引き
  - dispatch `await-agent` ケース追加
- `skills/cmux-team/manager/dashboard.tsx`
  - `buildConductorRow` に `asking` ブランチ追加: ⚠ + asking ラベル + 2 行目に `? <question>` (120 文字 truncate)
  - ヘッダー集計に `askingCount` 追加、"N asking" 表記
- `skills/cmux-team/templates/ja/conductor-role.md` / `en/conductor-role.md`
  - Agent 監視ループを `while cmux read-screen` ポーリング → `cmux-team await-agent --surface ... --timeout 1800` + STATUS case に差し替え（completed / ask / crashed / timeout）
  - 旧完了判定（`❯` + `esc to interrupt` 無し）廃止の旨を明記
- `skills/cmux-team/manager/main.test.ts`
  - T181 §12.1 race 検証 3 ケース追加:
    1. watcher 起動前に done（未来 timestamp）を置く → existsSync フォールバックで検出
    2. watcher 起動後に done を書く → fs.watch イベントで検出 + QUESTION 伝播
    3. startedAt より古い timestamp の done → timeout 扱い + 残骸 unlink

## 実装決定

- **done マーカーのパス正規化**: daemon / main 双方で `normalizeSurfaceForPath` を使用するため daemon から export し main が import する構成（循環依存なし）
- **`--from-stdin`**: SESSION_ASK の question 本文にシェル特殊文字が混入しても壊れないよう、hook は jq で JSON を組み立てて stdin pipe で CLI に渡す
- **detect-ask.sh の Case B**: Conductor では「純 text stop」を SESSION_IDLE とみなすが、Agent では無視（`exit 0`）。Conductor 判定は `CONDUCTOR_ID` 環境変数の有無で行う
- **startedAt 基準の古い done skip**: watcher 起動前に残存する「前回 run の done」を誤検出しないよう、`timestamp_ms < startedAt` は skip + unlink する。これにより race test #3 で timeout に倒れる
- **未来 timestamp による existsSync フォールバックテスト**: テストプロセス側で `Date.now() + 3000` を使い、await-agent プロセスの startedAt より確実に大きい ts を作ることで「watcher 起動前に書かれた fresh な done」を再現
- **sort 順**: plan §11.1 の sort（starting→asking→running→idle）は Map 挿入順で十分に近似されるため、buildConductorsSection には明示 sort を追加しなかった（追加変更を最小化）
- **agent splice 方針**: SESSION_IDLE Agent は splice しない（Ask 後の継続ケースで alive を保持）／ SESSION_ENDED / surface_lost では従来どおり splice

## テスト結果

- `bun test`: 211 pass / 0 fail（新規 3 pass を含む、全 13 ファイル）
- `bunx tsc --noEmit`: 6 件の既知エラーのみ（`cmux.ts` NonSharedBuffer / `daemon.ts` update-notifier 型 / `dashboard.tsx` WidgetVariant "unstyled" x2 / `main.test.ts:84` / `main.ts:515` renameWorkspace null）。**本 PR の追加/変更コード由来のエラーは 0 件**
- 手動検証: daemon 停止中のため `bun install` + tsc + test のみで確認。稼働中の daemon への破壊的操作はしていない

## 残件

- 既知の typecheck エラー 6 件は T181 スコープ外（plan §15 に別途記載）。この PR では修正しない
- dashboard の sort 順明示化は §11.1 で提案されていたが、視覚的影響が小さいため今回は保留。必要なら follow-up タスクで扱う
- detect-ask.sh の jq 依存は実行環境に jq があることを前提にしている。無ければ Stop hook 自体が no-op となり await-agent は timeout に倒れる（手動 kill / send-agent で回復可能）
