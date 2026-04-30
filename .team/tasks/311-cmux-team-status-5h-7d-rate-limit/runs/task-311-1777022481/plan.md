# T311 実装計画: `cmux-team status` に 5h/7d Rate Limit セクションを追加

## 1. 課題分析

### 現状の問題

- `cmux-team status` は header / Masters / Conductors / Tasks / Log tail の 5 セクションしか表示しない（`skills/cmux-team/manager/main.ts` L1305-1384）
- **dashboard（TUI）** では右上に 5h/7d utilization が出るが、`cmux-team status` では **rate limit 情報が一切見えない**
- ユーザーがヘッドレス環境・CI・他ターミナルから `status` を叩いたときに、API 制限まで何％残っているか・いつリセットされるかを把握できない
- 現状わかるのは `.team/logs/manager.log` の末尾数行だけで、throttle 発動などのイベントログが流れていなければ全く情報がない

### 影響範囲

- **追加表示するだけ**で既存 5 セクションの動作は変えない（Log tail の前に 1 セクション挿入）
- 変更対象ファイルは `main.ts::cmdStatus()` のみ（本体）。純粋ロジックは新モジュール `rate-limit-status.ts` に切り出す
- `.team/rate-limit.json` が存在しない環境（daemon 起動直後・proxy 未稼働・旧 runtime）でも他セクションが正常に出ること

### データソース

`.team/rate-limit.json`（`persistRateLimit` / `loadRateLimit` で R/W。schema は `RateLimitInfoSchema`）。

| フィールド | 型 | 用途 |
|---|---|---|
| `unified5hUtilization` | `number \| null`（0.0-1.0） | 5h バー |
| `unified7dUtilization` | `number \| null`（0.0-1.0） | 7d バー |
| `unified5hReset` | `string \| null`（unix 秒 string or ISO） | reset 相対・絶対時刻 |
| `unified7dReset` | `string \| null`（同上） | reset 相対・絶対時刻 |
| `unifiedStatus` | `string \| null`（`allowed`/`rate_limited`/その他） | status 行・⚠マーク |
| `updatedAt` | `string`（ISO 8601） | `updated Ns ago` / stale 警告 |

---

## 2. 技術アプローチ

### 責務分割

**`main.ts` は副作用を伴う CLI 本体でユニットテストしにくい**（bun test は spawn して output を assert する形になり、日時・locale の決定性を担保しづらい）。そこで:

| 層 | 責務 | 配置 |
|---|---|---|
| I/O | `.team/rate-limit.json` 読み込み・null フォールバック | **既存** `rate-limit-persistence.ts::loadRateLimit` を再利用 |
| stale 判定 | 軸独立 stale | **既存** `rate-limit-persistence.ts::isStale5h / isStale7d` を再利用 |
| 純粋整形 | `RateLimitInfo \| null` と `now` ms から表示行 `string[]` を構築 | **新規** `rate-limit-status.ts::buildRateLimitStatusLines` |
| レンダリング | console.log で出力・セクション区切り線付与 | `main.ts::cmdStatus()`（薄く） |

### 既存モジュール再利用方針

- **`rate-limit-display.ts` は再利用しない**: これは Rezi/Ink 用に `RateLimitPart[]` を返す構造で、CLI の plain-text 用途とは**返り値型が別物**。共通化すると dashboard 側に CLI の色要件（plain / ⚠ マーク付与）が漏れ出すため、**責務が違うので分離したまま**とする。
- **`formatDurationShort`（`dashboard-metrics.ts` L146-158）は再利用しない**: 同ファイル内の **private 関数**で export されておらず、さらに Rezi 依存の他ロジックと同居している。`rate-limit-status.ts` 内に**独自に短いフォーマッタを書く**（コードは 10 行弱、独立 import を増やすより軽い）。
- **`rate-limit-display.ts::formatResetRemaining`（L115-133）も private**。同様に `rate-limit-status.ts` 内で同じパース流儀（`Number(resetIso)` で unix 秒 string 判定 → fallback で `new Date(resetIso)`）を再実装する。

### 代替案と却下理由

| 案 | 却下理由 |
|---|---|
| A: `main.ts::cmdStatus()` 内に直接 rate-limit 整形を書く | `main.ts` 肥大化、ユニットテスト不可能、locale 依存で snapshot 困難 |
| B: `rate-limit-display.ts` を CLI でも使えるよう汎化する | 現 `RateLimitPart[]`（color literal）を CLI 向け string[] に変える破壊的変更。dashboard 側の `dashboard.tsx` も影響。責務が別のため分離のほうが安全 |
| C: `dashboard-metrics.ts` の `formatDurationShort` を export して再利用 | 再利用したいのは 1 関数のみ、代わりに dashboard 依存が増える。新モジュールに 10 行コピーするほうが凝集度が高い（将来再利用したくなった時に別 PR で切り出しを検討） |
| D（採用）: 新モジュール `rate-limit-status.ts` で閉じた純粋関数を書く | `main.ts` は薄く、テストは決定的、既存 dashboard 側に一切影響なし |

### 表示フォーマット

`skills/cmux-team/templates/master.md` 等の既存 ASCII 流儀と、`cmdStatus` のセクション区切りスタイルに合わせる:

```
─ Rate Limit ────────────────────────────────────────────
  5h: 55% █████░░░░░  reset in 1h23m  (2026-04-24 19:00)
  7d: 38% ███░░░░░░░  reset in 22h    (2026-04-25 17:00)
  status: allowed  (updated 10s ago)
```

フォーマット仕様:

- **区切り線**: 他セクションと同じく `─ Rate Limit ${"─".repeat(...)}`（合計幅 60）
- **バー**: 幅 10、`█` / `░`。`pct = Math.round(util * 100)`、`filled = Math.round(pct / 100 * 10)`
- **reset 相対時刻**: `<1m` / `45m` / `1h23m` / `22h` / `1d4h`（最大 2 単位、`rate-limit-display.ts` L114-133 の流儀）。過去 / 解釈不能は `expired`
- **reset 絶対時刻**: `new Date(resetMs).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })` — **locale 固定**でテスト決定性を確保。`timeZone` はユーザー環境依存を受け入れ（テストは注入した固定タイムゾーンで検証）
- **updated**: `updated Ns ago` / `updated Nm ago` / `updated Nh ago`。`now - parseISO(updatedAt)` が 60s 超なら `(stale, updated Nm ago)` と括弧付き警告
- **status 行**: `status: allowed` / `status: ⚠ rate_limited` / `status: unknown`（unifiedStatus が null の場合）
- **axis stale 表示**: 軸が stale（reset が過去 / null）なら行末に `(stale)` を付ける。5h / 7d 独立に判定
- **ファイル不在**: 単一行 `  (no rate limit data — proxy not running?)` を出してセクションは続行
- **ファイル破損**: `loadRateLimit` が null を返すので上記と同じ扱い（既存 `log()` で warn は既に出る）
- **section 継続性**: どのケースでも `console.log` 失敗で例外を投げない（他セクションを潰さない）

---

## 3. 変更対象

### 新規ファイル

| パス | 責務 |
|---|---|
| `skills/cmux-team/manager/rate-limit-status.ts` | `buildRateLimitStatusLines(rl, now): string[]` + 内部ヘルパー（`formatRelativeDuration` / `formatAgoDuration` / `formatAbsoluteTime` / `buildBar` / `parseReset`） |
| `skills/cmux-team/manager/rate-limit-status.test.ts` | 上記純粋関数のユニットテスト |

### 変更ファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/main.ts` | import 1 行追加、`cmdStatus()` 内の Tasks セクションと Log tail の間に `loadRateLimit` → `buildRateLimitStatusLines` → console.log 印字を挿入（10 行程度） |
| `skills/cmux-team/manager/i18n.ts`（任意） | `help_status` の文言に「`─ Rate Limit ─` セクションが追加されました」と一文書き足す（ja/en 両方） |

### 注意事項

- `rate-limit-status.ts` は **Rezi / Ink / `@rezi-ui/core` に一切 import しない**（CLI 専用、純粋 TS）
- `i18n.ts` を編集する場合は ja (L169 付近) / en (L949 付近) 両方を揃える
- 既存の `rate-limit-display.ts` / `rate-limit-persistence.ts` は**一切変更しない**（dashboard 動作に影響が出ないことを構造的に担保）

---

## 4. サブタスク分割

### ST1. 新モジュール `rate-limit-status.ts` の雛形を作成

- **対象ファイル**: `skills/cmux-team/manager/rate-limit-status.ts`（新規）
- **完了条件**:
  - `export function buildRateLimitStatusLines(rl: RateLimitInfo | null, now: number): string[]` が存在する
  - 内部ヘルパー（`parseReset` / `formatRelativeDuration` / `formatAgoDuration` / `formatAbsoluteTime` / `buildBar`）が**非 export**（module-private）
  - `bunx tsc --noEmit skills/cmux-team/manager/rate-limit-status.ts` が通る
- **メソッド制約**:
  - import は `RateLimitInfo`（`./schema`）と `isStale5h` / `isStale7d`（`./rate-limit-persistence`）のみ
  - Rezi / Ink / dashboard 系 import 禁止
- **検証コマンド**:
  ```bash
  grep -E "^import" skills/cmux-team/manager/rate-limit-status.ts | grep -vE "^import \{.*\} from \"\./(schema|rate-limit-persistence)\";?$" && echo "UNEXPECTED IMPORT" || echo OK
  ```

### ST2. ユニットテストを先に書く（TDD）

- **対象ファイル**: `skills/cmux-team/manager/rate-limit-status.test.ts`（新規）
- **完了条件**:
  - 下記 9 ケース以上を `describe("buildRateLimitStatusLines")` で網羅
  - `NOW` を固定 unix ms（例: `1700000000000`）として注入、ISO / unix 秒 string 両方のテストデータを使う
  - `bun test skills/cmux-team/manager/rate-limit-status.test.ts` が **RED**（実装未完成なので当然）
- **テストケース**:
  1. `rl=null` → `["  (no rate limit data — proxy not running?)"]` を含む
  2. 通常表示（5h 55%、7d 38%、両軸 future reset、updatedAt=now-10s、allowed）
  3. 5h axis stale（`unified5hReset` が過去 unix 秒 string）→ その行だけ `(stale)` サフィックス
  4. 7d axis stale（`unified7dReset` が過去 ISO）→ その行だけ `(stale)` サフィックス
  5. 両軸 stale → 両行に `(stale)`
  6. `unifiedStatus = "rate_limited"` → status 行が `status: ⚠ rate_limited`
  7. `unifiedStatus = null` → `status: unknown`
  8. `updatedAt` 5 分前 → status 行末尾に `(stale, updated 5m ago)` 相当
  9. 相対時刻エッジ: <1m / 90m（→ `1h30m`）/ 25h（→ `1d1h`）/ 過去（→ `expired`）
  10. `unified5hUtilization = null` → 5h 行は出さず 7d 行だけ出す（axis 欠落フォールバック）
- **メソッド制約**: `expect(...).toContain(...)` で柔軟に assert、完全文字列一致は避ける（文言微調整で壊れないように）
- **検証コマンド**:
  ```bash
  bun test skills/cmux-team/manager/rate-limit-status.test.ts 2>&1 | tail -20
  # 実装未完のため FAIL が出ること
  ```

### ST3. `buildRateLimitStatusLines` 本体を実装

- **対象ファイル**: `skills/cmux-team/manager/rate-limit-status.ts`
- **完了条件**:
  - ST2 のテストが全て **GREEN**
  - `bun test skills/cmux-team/manager/rate-limit-status.test.ts` 成功
- **メソッド制約**:
  - `parseReset(reset: string | null): number | null`: `Number(reset)` が `> 1e9` なら秒 → ms 変換、それ以外は `new Date(reset).getTime()`、`NaN` は null
  - `buildBar(util: number, width: number = 10): string`: `Math.round(util * 100)` で pct、`"█".repeat(filled) + "░".repeat(width - filled)`
  - `isStale5h` / `isStale7d` で軸 stale 判定
  - updatedAt stale 判定は**関数内 inline**（>60s）、`rate-limit-persistence` の export 拡張はしない
- **検証コマンド**:
  ```bash
  bun test skills/cmux-team/manager/rate-limit-status.test.ts
  ```

### ST4. `main.ts::cmdStatus()` に Rate Limit セクションを挿入

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **完了条件**:
  - Tasks セクション（L1362-1363）と Log tail セクション（L1366-）の間に以下が入る:
    ```ts
    // --- Rate Limit ---
    console.log(`─ Rate Limit ${"─".repeat(45)}`);
    try {
      const rl = await loadRateLimit(PROJECT_ROOT);
      const lines = buildRateLimitStatusLines(rl, Date.now());
      for (const line of lines) console.log(line);
    } catch {
      console.log(`  (rate limit read failed)`);
    }
    ```
  - `import { buildRateLimitStatusLines } from "./rate-limit-status";` を追加（`loadRateLimit` は L73 で既に import 済み）
  - `bunx tsc --noEmit skills/cmux-team/manager/main.ts` が通る
  - **受け入れ: Log tail より前に表示される**
- **メソッド制約**:
  - `loadRateLimit(PROJECT_ROOT)` を使う（直接 `readFile` 禁止）
  - try/catch は `loadRateLimit` 内で全失敗系を null に畳んでいるが、念のため外側にもガードを置く
  - console.log 1 回あたり 1 行のみ（既存 cmdStatus 流儀）
- **検証コマンド**:
  ```bash
  grep -n "Rate Limit" skills/cmux-team/manager/main.ts
  grep -n "buildRateLimitStatusLines" skills/cmux-team/manager/main.ts
  # 両方 1 件ずつヒットすること
  ```

### ST5. 実機確認（`.team/rate-limit.json` が存在する環境）

- **対象**: worktree 上で `bun run skills/cmux-team/manager/main.ts status` を実行
- **完了条件**:
  - 5 つのチェック項目:
    1. `rate-limit.json` が存在する worktree で `─ Rate Limit ─` セクションが Log tail の直前に出る
    2. 一時的に `.team/rate-limit.json` を `.bak` にリネーム→ `(no rate limit data ...)` 表示、他セクションは正常
    3. 破損 JSON を書き込んで同様に fallback することを確認（終わったら restore）
    4. Tasks セクション以前の表示・件数は変わっていない
    5. 戻り値 exit code 0
- **検証コマンド**:
  ```bash
  # 正常
  bun run skills/cmux-team/manager/main.ts status

  # 不在（破壊的操作: 必ず restore する）
  mv .team/rate-limit.json /tmp/rate-limit.json.bak
  bun run skills/cmux-team/manager/main.ts status
  mv /tmp/rate-limit.json.bak .team/rate-limit.json

  # 破損
  cp .team/rate-limit.json /tmp/rate-limit.json.bak
  echo "{broken" > .team/rate-limit.json
  bun run skills/cmux-team/manager/main.ts status
  cp /tmp/rate-limit.json.bak .team/rate-limit.json
  ```

### ST6. 型チェック・全体テスト回帰

- **対象**: プロジェクト全体
- **完了条件**:
  - `bunx tsc --noEmit` に**新規エラーが増えていないこと**
  - `bun test` が全件 pass（事前に `bun test` を走らせて baseline を取り、差分ゼロであること）
- **検証コマンド**:
  ```bash
  bunx tsc --noEmit 2>&1 | tee /tmp/tsc.after.log
  bun test 2>&1 | tail -30
  ```

### ST7.（任意）`help_status` 文言の追記

- **対象ファイル**: `skills/cmux-team/manager/i18n.ts`
- **完了条件**: ja / en 両方の `help_status` 末尾付近に「Rate Limit セクションは `.team/rate-limit.json` から 5h/7d 使用率・reset 時刻・updatedAt を表示します」相当の 1 行を追加
- **検証コマンド**:
  ```bash
  grep -nA3 "help_status" skills/cmux-team/manager/i18n.ts | grep -i "rate"
  ```

---

## 5. リスク

| リスク | 影響 | 緩和策 |
|---|---|---|
| `.team/rate-limit.json` 破損 / 不在 | status 全体が落ちる | `loadRateLimit` が null を返すので `buildRateLimitStatusLines(null, now)` で `(no rate limit data ...)` 1 行。外側に try/catch も置く |
| `toLocaleString` の TZ 依存でテストが flakey | CI vs 開発者 PC で時刻文字列が異なる | テストでは**絶対時刻部分は `toContain` ではなく "reset in XX" 相対時刻と `(YYYY-` プレフィクスのみ**を検証、時刻フル文字列は assert しない。TZ 固定は将来的に必要なら `Intl.DateTimeFormat` with `timeZone: "UTC"` への切り替えを別 PR で |
| `main.ts` を import しているテスト（`main.test.ts` 等）に影響 | 既存テスト崩壊 | `main.test.ts` は `runCli` で subprocess 経由に spawn しており関数レベルの import はしていない（確認済み）。念のため ST6 で全体 test を回す |
| 新規 import が循環依存を引き起こす | build 失敗 | `rate-limit-status.ts` は `schema` と `rate-limit-persistence` しか import しない。両者は既に `main.ts` から import 済みの葉ノード。循環リスクなし |
| unified{5h,7d}Utilization が **片方だけ null** | 片軸表示の扱いが曖昧 | ST2 ケース 10 で担保。null の軸は行を出さず、もう片方だけ出す |
| `unifiedStatus` に想定外の文字列が入る | 表示が崩れる | null チェック + `rate_limited` 以外は `status: <文字列そのまま>` で出力（⚠ は `rate_limited` のみ） |
| updatedAt が未来時刻（時計ズレ） | `updated -5s ago` と出る可能性 | `sec = Math.max(0, sec)` でクランプ、負値は `updated 0s ago` |

---

## 6. 既存型エラーの先読み

触る予定のファイル群について `bunx tsc --noEmit` を実行し既存エラーを確認した:

```
bunx tsc --noEmit 2>&1 | grep -E "rate-limit|main\.ts|dashboard-metrics"
→ （出力なし）
```

- `main.ts` / `rate-limit-display.ts` / `rate-limit-persistence.ts` / `dashboard-metrics.ts` / `schema.ts` に **既存 type エラーは無い**。
- 本タスクで解消すべき既存エラー: **該当なし**
- 後続に分離すべき既存エラー: **該当なし**

---

## 7. Decision Log

| # | 判断 | 選択肢 | 決定 | 理由 |
|---|---|---|---|---|
| D1 | 整形ロジックの配置 | main.ts 直書き / rate-limit-display.ts 拡張 / 新モジュール | **新モジュール `rate-limit-status.ts`** | main.ts は副作用で testable でない。display.ts は Rezi 用で責務が別（構造的正しさ優先） |
| D2 | `formatDurationShort` の再利用 | export 拡張して import / コピー | **コピー（10 行程度）** | dashboard-metrics.ts を CLI から import すると Rezi 依存が芋づるで増える。本当に共通化したくなったら別 PR で 3 ファイル共通の `time-format.ts` を作る |
| D3 | 色表現 | ANSI エスケープ / plain text + `⚠` マーク | **plain text + `⚠` マーク** | タスク指示書の方針（ログ tail と同じく plain）。CI ログ・パイプ用途でも読める |
| D4 | 絶対時刻の locale | `toLocaleString()` default / `"ja-JP"` 固定 / UTC 固定 | **`"ja-JP"` 固定**（TZ はユーザー環境依存） | 日本語プロジェクト規約。TZ 固定までやるとテストは安定するがユーザー体験が悪化。テスト側で絶対時刻はフル一致を避ける |
| D5 | 挿入位置 | Tasks の前 / Log tail の前 | **Log tail の前（Tasks の後）** | タスク指示書受け入れ条件「Log tail より前」。情報の抽象度順（操作対象 → 環境）として自然 |
| D6 | エラー時の fail-fast | 例外投げる / null フォールバック | **null フォールバック（既存 loadRateLimit の流儀に従う）** | status コマンドは閲覧系、他セクションを潰さないのが最優先（タスク指示書受け入れ条件） |
| D7 | セクション幅 | 60 / 58 | **合計 60（`─ Rate Limit ` 13 char + `─` × 45 ≈ 58）** | 他セクション（Conductors / Tasks）と揃える |
| D8 | `unified5hReset` の 過去値扱い | axis stale とみなす / reset=`expired` と表示のみ | **axis stale（`isStale5h` 準拠）** | 既存 dashboard 挙動と一貫。`rate-limit-persistence.ts` の semantics に従う |
| D9 | help_status の文言更新 | 必須 / 任意 | **任意（ST7）** | 実装完了に必須ではなく、時間があれば |

---

## 8. 実装順序サマリ

1. **ST1**: `rate-limit-status.ts` の型・import 骨組みだけ作る
2. **ST2**: `rate-limit-status.test.ts` を RED で書く（TDD）
3. **ST3**: `buildRateLimitStatusLines` 本体を実装 → GREEN に
4. **ST4**: `main.ts::cmdStatus()` に 10 行程度のセクションを挿入
5. **ST5**: 実機で 3 シナリオ（正常 / 不在 / 破損）を確認
6. **ST6**: `bunx tsc --noEmit` + `bun test` で回帰確認
7. **ST7**（任意）: `help_status` の文言を 1 行追加

**推定工数**: 正味実装 45 分〜1 時間（新規 150 行 + テスト 150 行程度、既存改修は 12 行程度）。

---

## 9. 受け入れ条件チェックリスト（実装完了後に必ず通すこと）

- [ ] `cmux-team status` で 5h / 7d の使用率・バー・reset 時刻・updatedAt が表示される
- [ ] `.team/rate-limit.json` 不在時に `(no rate limit data ...)` 表示、他セクション継続
- [ ] `.team/rate-limit.json` 破損時に同上
- [ ] axis 片方だけ stale のとき、その軸だけ `(stale)` 付与
- [ ] `unifiedStatus = "rate_limited"` のとき status 行に `⚠`
- [ ] Log tail セクションは Rate Limit セクションより**後ろ**に出る
- [ ] `bunx tsc --noEmit` の新規エラーゼロ
- [ ] `bun test` 全件パス
- [ ] `rate-limit-status.test.ts` のテストケースが 9 件以上存在し全件 GREEN
- [ ] `main.ts` の変更は 15 行以内（薄さ担保）
