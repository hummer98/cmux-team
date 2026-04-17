# 実装計画 — Task #173: THROTTLE 中の spawn-agent ブロック

## ゴール

THROTTLE 発動中に `cmux-team spawn-agent` が新規サブ Agent を起動してしまう穴を塞ぐ。
proxy に rate-limit 公開エンドポイントを追加し、spawn-agent CLI が起動前に確認、throttled なら exit 75 で拒否する。Conductor 側は exit 75 を検知して reset まで待機 → retry する。

## 変更対象ファイル一覧

| ファイル | 範囲 | 変更内容 |
|---------|------|---------|
| `skills/cmux-team/manager/proxy.ts` | L102-131（GET ルーティング） + 先頭 import | `GET /rate-limit` 追加。`THROTTLE_5H_THRESHOLD` を schema から import。`formatResetRemaining` を同ファイル内に複製。`toEpochSec` ヘルパーで reset を ISO/epoch 両対応で epoch 秒に正規化。 |
| `skills/cmux-team/manager/main.ts` | L1125-1170（`cmdSpawnAgent` 冒頭、タブ作成直前） | proxy へ fetch → throttled なら stdout + exit 75。 |
| `skills/cmux-team/templates/ja/conductor-role.md` | L109-118（既存 spawn-agent 呼び出し） | retry ループに置換（空値・デッドラインガード込み）。 |

## 1. proxy.ts の変更

### 追加位置

L131 の `}` の直前（`/conductors` 分岐の直後、`// Master 状態更新エンドポイント` の直前）に追加する。

### ヘルパー関数の共有判断

- **推奨: proxy.ts 内にローカル定義を複製**
  - `formatResetRemaining` は daemon.ts と dashboard.tsx で既に複製されており（daemon.ts:1242, dashboard.tsx:189）、コメントでもコピー運用を明示している。
  - proxy.ts はモジュール境界を増やしたくない（React/Ink から独立という設計意図）ため、3箇所目のコピーを許容する。
  - 将来的な整理は別タスク（#175 等）で。
- **代案（やらない）**: 共通 util モジュール化。今回は保守一貫性のため見送り。

### reset 値の型と正規化（重要）

Anthropic の `anthropic-ratelimit-unified-5h-reset` / `-unified-7d-reset` ヘッダーは **ISO 8601 文字列** で返る。`schema.ts:159` の RateLimitState でも `unified5hReset: string | null` / `unified7dReset: string | null` 型になっている。

plan 初版の `Number(resetIso)` 単純変換では ISO 文字列が NaN → null となり、Conductor 側の `RESET_EPOCH=0` で内側 while が即抜け → 無限 retry ループに陥る。

`daemon.ts:1244-1245` が epoch 秒（10桁以上の数値）と ISO 文字列の両対応を既に実装しているので、同ロジックをヘルパー関数として proxy.ts 内に複製する:

```ts
// epoch 秒（10桁数値）または ISO 8601 文字列を受けて unix epoch 秒に正規化
function toEpochSec(raw: string | null): number | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (!isNaN(asNum) && asNum > 1e9) return Math.floor(asNum);
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}
```

`/rate-limit` のレスポンス `unified5hReset` / `unified7dReset` は常に **unix epoch 秒（整数）または null** で返す。

### レスポンス仕様

```ts
// GET /rate-limit
{
  throttled: boolean,                   // 判定式（後述）
  threshold: number,                    // THROTTLE_5H_THRESHOLD をそのままシリアライズ（literal ではなく import 参照）
  unified5hUtilization: number | null,
  unified5hReset: number | null,        // unix epoch 秒、ISO → epoch 変換済み、不正値 / 未取得 → null
  unified7dUtilization: number | null,
  unified7dReset: number | null,        // 同上
  unifiedStatus: string | null,
  resetRemaining: string | null,        // "1h42m" 形式。reset が null / 不正 / 過去 → null
}
```

`resetRemaining` の計算は `formatResetRemaining` を使うが、結果が `""` / `"0m"` / `"<1m"` のように「reset が過去または取得不能」を示す場合は null で返す方が CLI 側で扱いやすい。過去の場合は null、未来の場合のみ `"1h42m"` 文字列、という仕様とする。

### throttled 判定式

実装は dashboard.tsx:882 の条件に準拠する（daemon.ts:824 の `isThrottled` は「utilization >= threshold」のみで、 `state.running && state.bootPhase === "ready"` の追加条件は dashboard.tsx:882 の判定ロジック）。spawn-agent ガードとしては「起動完了後の常時判定」を使いたいので dashboard.tsx:882 準拠とする:

```ts
const rl = state.rateLimit;
const throttled =
  (rl?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD
  && state.running
  && state.bootPhase === "ready";
```

- `state.running` / `state.bootPhase` は `opts.getState()` から取得可能（daemon.ts:40-41 で既に定義）。
- rate-limit 情報未取得時は `throttled: false, unified5hUtilization: null`（既存の fallback と同じ挙動）。

### import 追加

```ts
import { QueueMessage, THROTTLE_5H_THRESHOLD } from "./schema";
```

`threshold` フィールドはこの import 経由の定数を直接シリアライズする（テスト容易性と値の一元管理のため、literal `0.9` を書かない）。

### エラーハンドリング

- `opts?.getState` が未設定（= daemon 以外で proxy を起動している場合）は `{ throttled: false, threshold: THROTTLE_5H_THRESHOLD, ...全て null }` を返す（`/state` は 404 だが `/rate-limit` は安全側に倒す）。
- reset 値は `toEpochSec()` 経由で epoch 秒 / ISO 文字列の両方を受け入れる（daemon.ts:1244-1245 と同ロジック）。

## 2. main.ts `cmdSpawnAgent` の変更

### 追加位置

L1136 以降、L1137 の「`// --- 1. プロキシポート読み取り + 生存確認 ---`」の直後（L1138 `resolveProxyPort()` は既存、その下）。
タブ作成（L1141-1170）の **前** に throttle チェックを差し込む。

### 追加コード概要

```ts
// --- 1.5 throttle ガード ---
if (proxyPort) {
  try {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/rate-limit`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const rl = await resp.json() as {
        throttled: boolean;
        unified5hReset: number | null;
        unified5hUtilization: number | null;
        resetRemaining: string | null;
      };
      if (rl.throttled) {
        const util = rl.unified5hUtilization ?? 0;
        console.log(`THROTTLED=true`);
        console.log(`RESET_EPOCH=${rl.unified5hReset ?? 0}`);
        console.log(`RESET_REMAINING=${rl.resetRemaining ?? ""}`);
        console.log(`UTILIZATION=${(util * 100).toFixed(1)}%`);
        console.log(`THRESHOLD=${(THROTTLE_5H_THRESHOLD * 100).toFixed(0)}%`);
        console.log(`MESSAGE=Rate limit exceeded. Wait until RESET_EPOCH before retrying spawn-agent.`);
        await log("spawn_agent_throttled",
          `conductor=${conductorSurface} role=${role} task_id=${taskId ?? "-"} util=${(util * 100).toFixed(1)}% reset_epoch=${rl.unified5hReset ?? 0}`);
        process.exit(75);
      }
    } else {
      await log("spawn_agent_ratelimit_warn", `status=${resp.status}`);
    }
  } catch (e: any) {
    await log("spawn_agent_ratelimit_warn", `fetch_failed=${e?.message ?? e}`);
    // best-effort: 続行
  }
}
```

### 判断のポイント

- `proxyPort` が解決できない場合は throttle チェックせず通常続行（proxy 自体ダウン時も止めない）。
- fetch のタイムアウトは 2 秒（`AbortSignal.timeout`）。proxy がハングしていても spawn 全体をブロックしない。
- exit 75 = BSD sysexits の `EX_TEMPFAIL`。「一時的失敗、retry 可能」のセマンティクスに一致。
- stdout に key=value 1 行形式で出力（Conductor 側が `grep` + `cut -d=` でパースしやすい形）。
- `THROTTLE_5H_THRESHOLD` は schema からの import で参照。
- ログに `task_id` を含めることで複数 Conductor 並列時のトレースを容易にする。

### import 追加

`main.ts` 冒頭の import 群に:

```ts
import { THROTTLE_5H_THRESHOLD } from "./schema";
```

（既に zod 型などを import している場合は同じ行に統合）

## 3. conductor-role.md の変更

### 置換対象

L109-118 の既存ブロック全体:

```bash
# 2. Agent spawn（--prompt-file でファイルパスだけを渡す）
# 注意: --bare は OAuth 認証（Claude Max）をスキップするため使用禁止
RESULT=$(cmux-team spawn-agent \
  --conductor-surface $CMUX_SURFACE \
  --role impl \
  --task-title "<サブタスクの簡潔な説明>" \
  --prompt-file "$PROMPT_FILE")
AGENT_SURFACE=$(echo "$RESULT" | grep -o 'SURFACE=surface:[0-9]*' | cut -d= -f2)
echo "Agent spawned: $AGENT_SURFACE"
```

### 置換後（retry ループ — 空値・デッドラインガード付き）

```bash
# 2. Agent spawn（throttle 時 exit 75 を検知して reset まで待機 → retry）
# 注意: --bare は OAuth 認証（Claude Max）をスキップするため使用禁止
# exit 75 = BSD sysexits EX_TEMPFAIL（一時的失敗、retry 可能）
MAX_WAIT_SEC=7200   # 最大 2 時間で諦める
DEADLINE=$(( $(date +%s) + MAX_WAIT_SEC ))
while true; do
  RESULT=$(cmux-team spawn-agent \
    --conductor-surface $CMUX_SURFACE \
    --role impl \
    --task-title "<サブタスクの簡潔な説明>" \
    --prompt-file "$PROMPT_FILE")
  EC=$?

  if [ $EC -eq 75 ]; then
    RESET=$(echo "$RESULT" | grep '^RESET_EPOCH=' | cut -d= -f2)
    REMAINING=$(echo "$RESULT" | grep '^RESET_REMAINING=' | cut -d= -f2-)

    # ガード: RESET が空 or 非整数 or 0 の場合は 60s jitter で retry
    if [ -z "$RESET" ] || ! [ "$RESET" -gt 0 ] 2>/dev/null; then
      echo "THROTTLED but RESET missing/invalid; retrying after ~60s"
      sleep $(( 60 + RANDOM % 30 ))
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "spawn-agent throttled beyond deadline (2h)"
        exit 1
      fi
      continue
    fi

    # RESET が DEADLINE を超えている場合は即諦める
    if [ "$RESET" -ge "$DEADLINE" ]; then
      echo "spawn-agent reset ($RESET) beyond deadline ($DEADLINE); aborting"
      exit 1
    fi

    echo "THROTTLED. Waiting until reset: $REMAINING (epoch $RESET)"
    # reset まで 60 秒単位で待機（内側ループも DEADLINE 監視）
    while [ "$(date +%s)" -lt "$RESET" ]; do
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "spawn-agent throttled beyond deadline (2h)"
        exit 1
      fi
      sleep 60
    done
    # jitter 0-30 秒（複数 Conductor の同時 reset 殺到を避ける）
    sleep $(( RANDOM % 30 ))
    continue
  fi

  if [ $EC -ne 0 ]; then
    echo "spawn-agent failed (exit $EC): $RESULT"
    exit $EC
  fi

  AGENT_SURFACE=$(echo "$RESULT" | grep -o 'SURFACE=surface:[0-9]*' | cut -d= -f2)
  echo "Agent spawned: $AGENT_SURFACE"
  break
done
```

### 方針メモ

- 最大待機時間: 2 時間（`MAX_WAIT_SEC=7200`）。超えたら Conductor 側で exit 1。
- 外側ループだけでなく **内側 wait ループも `DEADLINE` を監視**する（reset が 2h 以上先の場合の暴走を防ぐ）。
- `RESET` が空文字列の場合 `[ "$RESET" -lt ... ]` で `unary operator expected` エラーになるため、空値ガードを冒頭に置く。
- jitter: 0-30 秒（reset 直後に複数 Conductor が一斉に spawn するのを避ける）。
- `RESET_REMAINING` は表示用のみ（待機ロジックは epoch ベース）。
- exit 75 以外の非ゼロは従来通り即エラーで抜ける。
- exit 75 = BSD sysexits `EX_TEMPFAIL` のコメントを先頭に 1 行追加。

## 4. エッジケース

| ケース | 挙動 |
|-------|------|
| proxy ダウン（`resolveProxyPort()` が null） | throttle チェック skip、通常 spawn（従来動作維持） |
| proxy は生きているが `/rate-limit` が 404 や 5xx | warn ログ + 通常 spawn（best-effort） |
| `getState()` 未設定（独立 proxy モード） | `throttled: false` を返す（spawn は通る） |
| rate-limit 情報未取得（起動直後） | `unified5hUtilization == null` → `throttled: false` |
| reset が ISO 文字列（Anthropic デフォルト） | `toEpochSec()` で epoch 秒に変換してレスポンス |
| reset が epoch 秒（10桁数値） | `toEpochSec()` でそのまま epoch 秒として返す |
| reset が null / 不正値 | `unified5hReset: null`, `resetRemaining: null` → Conductor 側の空値ガードが発動し 60s jitter で retry |
| reset 時刻が過去（境界レース） | `resetRemaining: null`、`RESET_EPOCH` は過去値のまま → Conductor 内側 while が即抜け、jitter だけ待って retry |
| 複数 Conductor の同時 reset 待機 | jitter 0-30s で分散、それでも throttle なら再度 exit 75 で待機継続 |
| bootPhase ≠ "ready"（起動直後） | `throttled: false`（dashboard.tsx:882 の判定と一致） |
| reset が DEADLINE を超えている | Conductor は即 exit 1（2h 以上の待機を回避） |

## 5. テスト方針

### 手動 curl テスト

```bash
# daemon 稼働中のプロジェクトで
PORT=$(cat .team/proxy-port)
curl -s http://127.0.0.1:$PORT/rate-limit | jq
# → {"throttled": false, "threshold": 0.9, "unified5hReset": <epoch数値 or null>, ...} を期待
# unified5hReset が epoch 秒（整数）であること、ISO 文字列のまま漏れていないことを確認
```

### spawn-agent 単体テスト

throttled 状態をシミュレートする最小パス:
1. daemon を起動して通常通り rate-limit 情報が溜まるまで待つ（API を 1 回叩く）。
2. デバッグ用に `daemon.state.rateLimit.unified5hUtilization = 0.95` を一時的に強制（手段: `.team/queue/incoming/` 経由で RPC を入れるか、proxy を再コンパイル）。
3. `cmux-team spawn-agent --conductor-surface surface:XXX --role impl --prompt "test"` を実行。
4. 期待: exit 75、stdout に `THROTTLED=true` 他が出力される、`RESET_EPOCH` が妥当な unix 時刻（10桁）であること、タブは作成されない。

### Conductor retry ループ

1. 上記 throttled 状態で Conductor に手動で spawn-agent コマンドブロックを実行させる。
2. `THROTTLED. Waiting until reset: ...` が表示され、内側 while で sleep することを確認。
3. `RESET_EPOCH=0` を強制した場合、空値ガード経由で `retrying after ~60s` が表示されることを確認（無限ループに陥らない）。
4. `unified5hUtilization` を 0.8 に下げて retry が成功することを確認。

### 既存挙動の非破壊確認

- `daemon.ts:800-814` の isThrottled 判定（タスク割り当てブロック）が従来通り動作すること。
- `dashboard.tsx:882` の `isThrottled && running && bootPhase === "ready"` 表示が変わらないこと。
- `#172` と衝突しないこと（dashboard.tsx は一切触らない）。

## 6. やらないこと

- dashboard.tsx の変更（#172 と衝突回避）。
- daemon.ts の既存 throttle 判定（L824-832）の変更。
- 英語テンプレート（`templates/en/conductor-role.md`）の変更（対象外）。
- proxy `/rate-limit` の認証（localhost のみ、既存 `/state` 等と同様）。
- `formatResetRemaining` / `toEpochSec` の共通 util 化（別タスク）。

## 7. 実装順序の推奨

1. proxy.ts に `toEpochSec` + `formatResetRemaining` ヘルパー + `/rate-limit` エンドポイント追加 → `curl` で動作確認（ISO 文字列が epoch 整数に正規化されていること）。
2. main.ts `cmdSpawnAgent` に throttle チェック追加 → 手動で throttle 状態を作って exit 75 が返ることを確認。
3. templates/ja/conductor-role.md を書き換え（空値ガード・DEADLINE 内側監視込み）。
4. 統合テスト（Conductor 側から spawn-agent を叩き、throttle → retry → 成功の流れを確認）。

## 8. 完了条件

- `GET /rate-limit` が仕様通りの JSON を返す（特に `unified5hReset` が unix epoch 秒または null で、ISO 文字列が漏れていない）。
- `cmux-team spawn-agent` が throttled 時に exit 75 + 指定 stdout を出し、タブを作らない。
- `templates/ja/conductor-role.md` が retry ループに置換されており、空値・DEADLINE 超過の両ガードが入っている。
- daemon/dashboard の既存挙動が非破壊。
