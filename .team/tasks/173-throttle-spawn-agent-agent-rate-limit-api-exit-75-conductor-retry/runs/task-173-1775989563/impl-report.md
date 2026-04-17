# 実装レポート — Task #173

## 変更ファイル一覧

| ファイル | 追加 | 削除 | 概要 |
|---------|------|------|------|
| `skills/cmux-team/manager/proxy.ts` | +69 | -1 | `GET /rate-limit` + `toEpochSec`/`formatResetRemaining` ヘルパー複製、`THROTTLE_5H_THRESHOLD` import |
| `skills/cmux-team/manager/main.ts` | +45 | -8 | `cmdSpawnAgent` に throttle ガード追加、`taskId` 解決を前倒し（R1 対応）、`THROTTLE_5H_THRESHOLD` import |
| `skills/cmux-team/templates/ja/conductor-role.md` | +57 | -7 | spawn-agent を exit 75 検知の retry ループに置換（空値・DEADLINE 内側監視・jitter 0-30s） |

合計: 167 insertions(+), 16 deletions(-)（package-lock.json を除く）

## 各変更の要約

### 1. proxy.ts (+69 / -1)
- 先頭に `toEpochSec()` と `formatResetRemaining()` をローカル定義（dashboard.tsx / daemon.ts の 3 箇所目コピー。整理は別タスク）。
- `GET /rate-limit` を `/conductors` の直後に追加。`dashboard.tsx:882` 準拠の `throttled = util >= THRESHOLD && running && bootPhase === "ready"` 判定。
- R3: `formatResetRemaining` の `""` / `"0m"` / `"<1m"` を null に倒すラッパー実装済み。
- `opts.getState` 未設定時は throttled=false 固定で返す（独立 proxy モード対応）。

### 2. main.ts cmdSpawnAgent (+45 / -8)
- R1 対応: team.json 解決ブロック（`worktreePath` / `paneId` / `taskId` / `taskTitle`）を `resolveProxyPort()` 直後に前倒し、下段の重複ブロックは削除。throttle ガードで `taskId` を参照しても TDZ に触れない。
- `proxyPort` がある場合のみ `/rate-limit` を 2s timeout で fetch。`rl.throttled === true` の場合、6 項目 key=value を stdout に出力 → `log("spawn_agent_throttled", ...)` → `process.exit(75)`。
- S3/S5 取り込み: exit 75 コメントを throttle ブロック冒頭に記載、ログの `reset_epoch=...` は `unified5hReset=${rl.unified5hReset ?? "null"}` とし `0` vs 取得失敗の曖昧さを回避。
- fetch 失敗 / 非 2xx は `spawn_agent_ratelimit_warn` で warn して best-effort 続行（従来動作維持）。
- `THROTTLE_5H_THRESHOLD` を schema から import。

### 3. templates/ja/conductor-role.md (+57 / -7)
- L109-118 の単発 spawn-agent を retry ループに置換。
- 空値ガード: `RESET` が空 or 非整数 or 0 → 60s+jitter で retry。
- DEADLINE 監視: 外側ループと内側 `while sleep 60` の両方に DEADLINE チェック。`RESET >= DEADLINE` は即 exit 1。
- jitter: reset 後 `$(( RANDOM % 30 ))` で同時 spawn 殺到を回避。
- exit 75 以外の非 0 は従来通り即 abort。

## R1〜R3 + 軽微提案の反映状況

| 項目 | 状態 | メモ |
|------|------|------|
| R1 (blocker) taskId TDZ | ✅ 解決（案 A） | `cmdSpawnAgent` 冒頭で taskId 解決、下段の重複を削除 |
| R2 logger API 確認 | ✅ OK | `logger.ts:26` `export async function log(event, detail=""): Promise<void>`。`await log(event, detail)` 形式で一致 |
| R3 resetRemaining null 境界 | ✅ 反映 | `(!remaining \|\| remaining === "0m" \|\| remaining === "<1m") ? null : remaining` |
| S2 3 箇所目コピーコメント | ✅ 反映 | 「dashboard.tsx / daemon.ts からコピー — 別タスク（#175 等）で整理予定」を統一文言で記載 |
| S3 exit 75 コメント | ✅ 反映 | `// exit 75 = BSD sysexits EX_TEMPFAIL（一時的失敗、retry 可能）` |
| S5 reset_epoch 曖昧さ | ✅ 反映 | ログでは `unified5hReset=${rl.unified5hReset ?? "null"}` を採用 |

## 型チェック結果

`cd skills/cmux-team/manager && npx tsc --noEmit` を実行。

以下 5 件のエラーが出るが、すべて **変更前から存在する pre-existing エラー**（git stash 後の実行で同一のエラーが出ることを確認済み）:

- `cmux.ts(22,5)` — Bun の execSync 型
- `dashboard.tsx(372,5)` / `(952,11)` — Ink WidgetVariant
- `main.test.ts(81,3)` — テストコードの型
- `main.ts(394,42)` — 別箇所の既存エラー（L394 は今回の変更範囲外）

**今回の変更による新規型エラーなし。**

## 動作確認結果

- 手元の daemon（稼働中）は今回の変更前の bundle を利用しているため、`curl http://127.0.0.1:$PORT/rate-limit` は現状 404 を返す（想定通り）。
- 新コードで daemon を再起動すれば `/rate-limit` が有効化される。bundle は不要（`bin/cmux-team.js` は `bun run main.ts` を直接呼ぶラッパーのため、`main.ts` 変更は即反映）。
- Conductor retry ループの動作確認はモック daemon か `unified5hUtilization` を 0.95 に強制する必要があるため、本タスク範囲では未実行。plan 5 章の手順に沿って後続で検証可能。

## 懸念・残課題

- **実機テスト未実施**: plan 5 章のテスト方針に沿った手動 throttle シミュレーション（`.team/queue/incoming/` 経由の強制書き換え等）は別途行う必要がある。Conductor 側の空値ガード発動の実機確認も同様。
- **英語テンプレート未対応**: `templates/en/conductor-role.md` は plan の対象外。日英並行時は別タスクで同期。
- **pre-existing 型エラー**: 既存の 5 件は本タスクとは無関係だが、将来的に `tsc --noEmit` を CI に組み込む場合は別タスクでの解消が必要。
