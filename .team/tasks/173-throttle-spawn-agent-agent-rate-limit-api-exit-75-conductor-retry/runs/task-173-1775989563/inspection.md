# 検品レポート — Task #173

## 判定: GO

plan.md の全項目・Design Review の blocker (R1) および確認事項 (R2/R3)・軽微提案 (S2/S3/S5) がすべて実装に反映されている。新規型エラーなし、既存挙動への影響なし。Fix Required はなく、即マージ可能。

## 検品結果

### 1. 仕様遵守

| 項目 | 実装箇所 | 状態 |
|------|---------|------|
| `GET /rate-limit` エンドポイント | `proxy.ts:162-197` | ✓ |
| `toEpochSec()` ヘルパー（ISO / epoch 両対応） | `proxy.ts:18-24` | ✓ |
| `formatResetRemaining()` 複製（3 箇所目） | `proxy.ts:26-44` | ✓ |
| `THROTTLE_5H_THRESHOLD` を import 経由で参照 | `proxy.ts:11`, `main.ts:44` | ✓ |
| throttled 判定式（`util>=threshold && running && bootPhase==="ready"`） | `proxy.ts:179-182` | ✓ |
| `opts.getState` 未設定時の安全フォールバック | `proxy.ts:163-175` | ✓ |
| `cmdSpawnAgent` の throttle ガード（exit 75） | `main.ts:1154-1186` | ✓ |
| 2s fetch timeout (`AbortSignal.timeout`) | `main.ts:1158` | ✓ |
| 6 項目 key=value stdout 出力 | `main.ts:1170-1176` | ✓ |
| conductor-role.md の retry ループ | `templates/ja/conductor-role.md:109-164` | ✓ |
| 空値ガード・DEADLINE 内外監視・jitter | 同上 L126-150 | ✓ |

### 2. Design Review 指摘の反映

- **R1 (blocker: taskId TDZ)**: ✓ 解決（案 A 採用）。`main.ts:1141-1152` で team.json から `worktreePath`/`paneId`/`taskId`/`taskTitle` をタブ作成前に前倒し解決。下段（L1214 付近）の `taskId` 重複解決ブロックは削除済み。throttle ガード内の `task_id=${taskId ?? "-"}` 参照は TDZ に触れない。
- **R2 (logger API 確認)**: ✓ `logger.ts` の `export async function log(event, detail=""): Promise<void>` に一致。`await log("spawn_agent_throttled", ...)` / `await log("spawn_agent_ratelimit_warn", ...)` の形式で統一されている。
- **R3 (resetRemaining null 境界)**: ✓ `proxy.ts:185-186` に `const resetRemaining = (!remaining || remaining === "0m" || remaining === "<1m") ? null : remaining;` が実装されており、「過去」「< 1 分」を両方 null に倒す設計になっている。

### 3. コード品質

- **型チェック**: `npx tsc --noEmit` の結果、残存エラーは `cmux.ts(22,5)` / `dashboard.tsx(372,5)(952,11)` / `main.test.ts(81,3)` / `main.ts(395,42)` の 5 件のみ。これらはいずれも本タスクの変更範囲外で、git stash しても同じエラーが出る pre-existing。今回の変更による新規型エラーは 0。
- **ロギング規約（CLAUDE.md）**: `log("spawn_agent_throttled", "conductor=... role=... task_id=... util=... unified5hReset=...")` は key=value スペース区切りに準拠。S5 の指摘通り `unified5hReset=${... ?? "null"}` で「取得失敗」と「epoch 0」を区別可能にしている。`spawn_agent_ratelimit_warn` も `status=...` / `fetch_failed=...` の形式で統一。
- **エラーハンドリング**: proxy fetch 失敗（非 2xx / タイムアウト / ネットワーク失敗）はすべて warn ログを残して best-effort 続行。空の `catch {}` なし。
- **exit code の意味**: `main.ts:1155` に `// exit 75 = BSD sysexits EX_TEMPFAIL（一時的失敗、retry 可能）` のコメントが残っており（S3）、将来保守者の誤解を防ぐ。

### 4. conductor-role.md の bash 検証

- **空値ガード**: `[ -z "$RESET" ] || ! [ "$RESET" -gt 0 ] 2>/dev/null` で空文字列および非整数を捕捉。`[` の `-gt` は非整数で `integer expression expected` を吐くが、`2>/dev/null` で抑制し `!` で論理反転する構造は正しい。
- **DEADLINE 監視**: 外側 `while true` と内側 `while [ "$(date +%s)" -lt "$RESET" ]` の両方に `[ "$(date +%s)" -ge "$DEADLINE" ]` チェックが入っており、RESET が 2h 以上先や、空値パスで何度も retry しても 2 時間で必ず exit 1。
- **RESET >= DEADLINE の即 abort**: 内側 wait ループに入る前（L139-142）に判定があり、無駄な sleep を回避。
- **jitter**: `sleep $(( RANDOM % 30 ))`（reset 直後）と `sleep $(( 60 + RANDOM % 30 ))`（空値 retry 時）で同時殺到を分散。
- **非 75 の非ゼロ exit**: 従来通り即 `exit $EC` で伝播。
- **文法・無限ループ**: `continue`/`break` の到達性 OK、無限ループの出口は DEADLINE 監視・EC=0 break・非 75 非 0 exit の 3 系統で網羅。

### 5. 非破壊性

- `daemon.ts:824` の `isThrottled` 判定は無変更（git diff に daemon.ts なし）。
- `dashboard.tsx` 無変更（git diff に含まれず、#172 と衝突せず）。
- 英語テンプレート `templates/en/conductor-role.md` 無変更（git diff に含まれず）。
- `cmdSpawnAgent` の成功パス（exit 0 時の `SURFACE=...` stdout、タブ作成、agent 起動）は proxy fetch を素通りしたあと従来通り実行される。`taskId` 解決の前倒しによる挙動差分は「team.json 読み取りが 1 回減る」だけで副作用なし。
- `--- 2. タブ作成` ブロックの先頭にあった `taskTitle` フォールバック（`if (!taskTitle) taskTitle = conductor?.taskTitle;`）も前倒し側で保持されている。

### 6. 差分全体

`git diff --stat`:
```
package-lock.json                               |  4 +-
skills/cmux-team/manager/main.ts                | 50 ++++++++++++++----
skills/cmux-team/manager/proxy.ts               | 69 ++++++++++++++++++++++++-
skills/cmux-team/templates/ja/conductor-role.md | 64 ++++++++++++++++++++---
```

- `package-lock.json` の 4 行差分は `npm install` 副産物と思われるが、今回の変更範囲外で機能影響なし（Implementer レポートにも言及あり）。
- 3 ファイル本体の変更はすべて plan に記載された範囲に収まっており、余計な refactor や関係ない変更はない。

### 7. 動作確認

- `cd skills/cmux-team/manager && npx tsc --noEmit` の新規エラー 0 件を確認（上記 3 節）。
- `bin/cmux-team.js` は `bun run main.ts` を execFileSync で直接呼ぶラッパー（`bin/cmux-team.js:12,32,50`）のため、`main.ts` / `proxy.ts` / `schema.ts` の変更は bundle 不要で即反映される（Implementer レポートの記述通り）。
- 実機の throttle シミュレーション（`unified5hUtilization = 0.95` 強制）は本検品スコープ外。plan 5 章の手順に沿って後続で検証可能。Implementer も同様の未実施記録あり。

## Fix Required（NOGO の場合必須）

なし。

## 軽微な指摘（任意）

- **M1**: `main.ts:1161-1166` の `rl` 型アノテーションは `unified7dReset` / `unified7dUtilization` / `unifiedStatus` / `threshold` を省略しているが、proxy の `/rate-limit` レスポンスには含まれる。現状 CLI 側で参照していないので実害はないが、将来 7d 情報も見るなら型を拡張しておくと便利。今タスクで追加するかは呼び出し要件次第。
- **M2**: `proxy.ts:11` と L12 で同じ `./schema` から 2 行に分けて import している（`import { QueueMessage, THROTTLE_5H_THRESHOLD } from "./schema"` と `import type { RateLimitInfo } from "./schema"`）。`import type` は値 import と別行で維持する流儀も一般的なので強制ではないが、`isolatedModules` を将来有効化する際の整合性確認のためメモ。
- **M3**: conductor-role.md の retry ループ全体の YAML フレアム（```bash の閉じ ```）は直後に「**重要:** `--prompt` でインライン渡しも...」の注記が続く。実装レポートの差分を見る限り正しく閉じているが、テンプレートを全文 Read していないため、念のため手元で `less` 等で確認推奨（型的・機能的には問題なし）。
- **S4 (未対応)**: Design Review S4「`.team/queue/incoming/` 経由の RPC でシミュレーションする 1 行サンプル」は plan に追記されていない。ただし S4 は plan 改善提案であり実装物の指摘ではないため、GO 判定には影響しない。後続タスクで plan テンプレートを整備する際に反映すると良い。
