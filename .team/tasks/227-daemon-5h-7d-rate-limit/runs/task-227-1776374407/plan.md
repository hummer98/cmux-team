# T227 実装計画 — daemon 再起動時に最後の 5h/7d rate limit を復元する（revision 2）

> v1 からの差分（Design Review の必須指摘 4 件 + Minor B/E）:
> 1. stale ガードを dashboard だけでなく throttle 判定 5 箇所すべてに入れる（§2-4, §3, §4 Step 8）
> 2. fire-and-forget のエラーはログ付き二段構造に統一（§2-2, §4 Step 3）
> 3. `.team/.gitignore` は既存ファイルでも `rate-limit.json` 行を追記するマイグレーションを実装（§4 Step 6, §7）
> 4. `loadRateLimit` は Zod スキーマ (`RateLimitInfoSchema`) で `safeParse` しフィールド健全性を検証（§2-3, §4 Step 1-2, §5）
> Minor 反映: B. `isStale` は「5h/7d reset のいずれかが未来にある間は non-stale（OR 判定）」と明記 / E. `buildRateLimitDisplay` を `rate-limit-display.ts` として純粋関数モジュールに切り出し

## 1. 概要

daemon の `state.rateLimit` は現状 in-memory のみで、`cmux-team start` で再起動すると `null` にリセットされる。次の API 応答ヘッダーが来るまで dashboard の 5h/7d 使用率バーが `Rate: --` のまま表示されず、既にスロットリング近傍にいる場合のユーザー判断材料を失う。

本タスクでは `RateLimitInfo` を JSON 形式で `.team/rate-limit.json` に永続化し、daemon boot 時に `state.rateLimit` に注入する。`extractRateLimit` は全フィールド JSON シリアライズ可能なので構造変換は不要。ただし復元直後は最新でない可能性があるため「stale」概念を導入し、throttle 判定すべてで stale ガードを行う。

## 2. 設計判断

### 2-1. 永続化先: `.team/rate-limit.json`

- `.team/` 配下は既存の永続物（`task-state.json`, `team.json`, `proxy-port`）と同じ粒度で扱える。
- `proxy-port` と同じく「最後に観測した外部状態のスナップショット」であり、`team.json`（構造定義）や `task-state.json`（タスク状態）と混ぜない。
- `.team/.gitignore` は既に `team.json` / `proxy-port` を無視しているが、`rate-limit.json` もセッション固有なので追加で ignore する（§4 Step 6 の migration 実装で既存ワークツリーもカバー）。

代替案: `team.json` 内に `rateLimit` フィールドを追加 → 却下。`team.json` は `updateTeamJson` が全書き換えする構造で、proxy 側から同時に書き込むと race が起きる。責務分離のため別ファイル。

### 2-2. 書き込みタイミング: proxy 更新時の非同期ベストエフォート flush（ログ付き二段 catch）

- `proxy.ts` の `extractRateLimit` が non-null を返した直後（2 箇所：streaming `L322-326` / non-streaming `L357-361`）に、`state.rateLimit` を更新した後で `persistRateLimit(projectRoot, state.rateLimit)` を fire-and-forget で呼ぶ。
- writeFile は `.team/rate-limit.json.tmp` → `rename` の atomic write（`task.ts:111-116` の `saveTaskState` と同じパターン）。
- エラー処理は **`drainAndLog` (proxy.ts:342-344) と同じ二段構造** に統一する。空の `.catch(() => {})` は CLAUDE.md の「ロギングポリシー > 禁止事項」に抵触するため使わない。

  ```ts
  persistRateLimit(root, rl).catch((e: any) =>
    log("rate_limit_persist_failed", e.message).catch(() => {})
  );
  ```

  外側 `.catch` で `log()` を呼び、`log()` 自身の I/O 失敗だけを内側 `.catch(() => {})` で握る。API レスポンスは絶対にブロックしない。
- graceful shutdown (SIGINT/SIGTERM) では `state.rateLimit` が non-null なら最後にもう一度 `await persistRateLimit(...)` する。proxy 側 fire-and-forget が in-flight の場合に shutdown の書き込みと交差する可能性はあるが、どちらも同じ `state.rateLimit` を読むため最終的に同値に収束する（Minor Note A の懸念は実害なしとして注釈のみ残す）。
- 定期フラッシュは行わない（更新頻度 = API 応答頻度なので実質同じ）。

### 2-3. 読み込みタイミング: `initInfra` 直後、`daemon_started` ログの前（Zod で健全性検証）

- `createDaemon` では `rateLimit: null` のままにしておく（IO を純粋な factory から外す）。
- `cmdStart` の `initInfra` 呼び出し後に `loadRateLimit(projectRoot)` を呼び、non-null なら `state.rateLimit` に注入する。
- 内部で `RateLimitInfoSchema.safeParse(JSON.parse(raw))` を通し、**JSON 破損 or フィールド型不一致のどちらでも null フォールバック**。失敗時は `log("rate_limit_persist_failed", "load: <reason>")`。
- ログで復元結果を明示する：
  - 成功: `rate_limit_restored unified5h=<pct> unified7d=<pct> stale=<bool>`
  - ファイルなし or parse 失敗: `rate_limit_restored empty`
- Minor Note C への注釈: `startDashboard` は `cmdStart` の後段で呼ばれるため、load が先に完了している限り boot 中から復元値が反映される。

### 2-4. 古いデータの扱い: リセット時刻を過ぎていても破棄しない。stale として表示しつつ **全 throttle 判定を無効化**

理由：
- `unified5hReset` / `unified7dReset` を過ぎている = 使用率がリセットされている可能性が高いが、「リセット後の新しい使用率」は次の API 応答まで不明。古い値を 0% と仮定して表示すると誤解を招く。
- 最も正直な表示は「これは直前セッションの値で、リセット時刻を過ぎている」と明示すること。
- **`isStale` の判定ロジック（OR 判定 / Minor Note B）**:
  - `unified5hReset` / `unified7dReset` のいずれかが **未来にある間は non-stale**（=まだ有効な観測値）
  - 両方とも過去 or 両方 null の場合のみ stale
  - 片方 null + もう片方が過去 → stale（「部分的に stale」を理由に判定を甘くしない）
  - `isStale(rl, now = Date.now())` のシグネチャで純粋関数として実装し、テストから `now` を注入可能にする
- **stale なデータでは throttle 判定を一切しない**。これは dashboard 表示だけでなく **daemon のタスク割当抑止・proxy の `/rate-limit` エンドポイント・dashboard の強制赤表示** すべてに適用される（詳細は §3 の変更対象ファイル表と §4 Step 8-12）。
- dashboard 表示: stale ならバーを GRAY (dim) 化し末尾に `(stale)` ラベルを付与。新しい応答が来れば `proxy.ts` が上書きして通常表示に戻る。
- throttle 判定側: `!isStale(state.rateLimit) && (... >= THROTTLE_5H_THRESHOLD)` の形で 5 箇所すべてをガードする。

### 2-5. `unifiedStatus` の扱い: 復元するが stale なら無視する

- `rate_limited` は一過性のサーバーステータスで、リセット時刻を過ぎていれば解除されている可能性が高い。
- しかし API を叩かないと確認できないため、デフォルトは「復元するが、reset を過ぎていれば `null` 相当として扱う」方針。
- 実装：dashboard の `forceRed` 判定 (`dashboard.tsx:236`) および `daemon.ts:1770-1771` の `unifiedStatus === "rate_limited"` 分岐を `... && !isStale(state.rateLimit)` でガード。

## 3. 変更対象ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | 新規 export: `RateLimitInfoSchema = z.object({...})`。既存 `RateLimitInfo` interface は `z.infer` で置き換える（同じ形なのでコンパイル影響なし）。 |
| `skills/cmux-team/manager/rate-limit-persistence.ts` | 新規。`persistRateLimit(root, rl)` / `loadRateLimit(root)` / `isStale(rl, now?)` を export。atomic write + `safeParse` + ログ付き二段 catch。 |
| `skills/cmux-team/manager/rate-limit-display.ts`（Minor E） | 新規。`buildRateLimitDisplay(rl, now?)` を Ink 非依存の純粋関数として切り出し。`dashboard.tsx` からは import するだけにする。色は文字列定数 or enum を返し、Ink 依存を持ち込まない。 |
| `skills/cmux-team/manager/proxy.ts` | (1) streaming (L321-326) / non-streaming (L357-361) の両分岐で、`state.rateLimit` 代入直後に `persistRateLimit` を **ログ付き二段 catch** で fire-and-forget。 (2) `/rate-limit` エンドポイント (L181-184) の `throttled` 判定に `!isStale(rl)` を追加。 |
| `skills/cmux-team/manager/main.ts` | `cmdStart` の `initInfra` 直後に `loadRateLimit` を呼び `state.rateLimit` に注入。shutdown 内で `state.rateLimit` が non-null なら最後の flush を `await` 付きで呼ぶ。 |
| `skills/cmux-team/manager/dashboard.tsx` | (1) `buildRateLimitDisplay` の呼び出しを新モジュールに差し替え、`(stale)` ラベル対応の結果をそのまま描画。 (2) `isThrottled` (L918) の式に `!isStale(daemon.rateLimit)` を追加。 (3) `forceRed` 相当のロジックは新モジュールに移動、`dashboard.tsx` 内 L236 の処理は削除 or 委譲。 |
| `skills/cmux-team/manager/daemon.ts` | (1) `.team/.gitignore` 生成ロジック (L393-421) を拡張し、**既存ファイルでも `rate-limit.json` 行が無ければ追記**（`team_gitignore_migrated path=... added=rate-limit.json` をログ）。 (2) `tick()` 内のタスク割当抑止 (L1313) の `throttled5h` 判定に `!isStale(state.rateLimit)` を追加。 (3) 全体 throttle 判定 (L1770-1771) に `!isStale(state.rateLimit)` を追加。 |
| `skills/cmux-team/manager/rate-limit-persistence.test.ts` | 新規。persist/load の round-trip、stale 判定、破損 JSON / フィールド型不一致のフォールバックをカバー。 |
| `skills/cmux-team/manager/rate-limit-display.test.ts`（Minor E） | 新規。`buildRateLimitDisplay` が stale データで `(stale)` ラベルを付け全パーツを GRAY 化することを検証。純粋関数なので Ink 非依存。 |
| `docs/spec/05-install-and-infrastructure.md` | `.team/rate-limit.json` の説明を追加（型・更新タイミング・stale 表示方針・`.gitignore` 管理）。 |
| `docs/spec/01-skill-cmux-team.md` | dashboard のレート制限表示で stale ラベルが出る可能性、および stale 中は throttle 判定が無効化されることを記載。 |

> 注: 前回 plan で「`daemon.ts:918` 付近」と書いていた箇所は `dashboard.tsx:918` の typo。本版では修正済み。

## 4. 実装ステップ（TDD 順）

1. **`schema.ts` に `RateLimitInfoSchema` を追加**
   - `z.object({ tokensRemaining: z.number(), tokensLimit: z.number(), tokensReset: z.string(), inputTokensRemaining: z.number(), outputTokensRemaining: z.number(), unified5hUtilization: z.number().nullable(), unified7dUtilization: z.number().nullable(), unified5hReset: z.string().nullable(), unified7dReset: z.string().nullable(), unifiedStatus: z.string().nullable(), resetRemaining: z.string().nullable() })` を定義（interface の現状に合わせる）
   - 既存 `RateLimitInfo` interface を `z.infer<typeof RateLimitInfoSchema>` に置き換え（同じ形なのでコンパイル影響なし）
   - `extractRateLimit` (proxy.ts) の戻り値が schema を満たすことを型レベルで保証

2. **`rate-limit-persistence.ts` のテストを書く** (`rate-limit-persistence.test.ts`)
   - `persist → load` が `RateLimitInfo` を round-trip する
   - ファイルが存在しない場合 `loadRateLimit` は `null` を返す
   - 破損した JSON の場合 `null` を返しログ出力する
   - **フィールド型が違う JSON（例: `unified5hUtilization: "0.5"` 文字列）は `safeParse` が失敗し `null` + ログ**（新規必須ケース）
   - **必須フィールド欠落の JSON も `null`**（同上）
   - `isStale(rl, now)` のケース:
     - 両方 null → stale（未知なので保守的に stale 扱い）
     - `unified5hReset` のみ未来 / `unified7dReset` null → non-stale
     - `unified7dReset` のみ未来 / `unified5hReset` null → non-stale
     - 両方過去 → stale
     - 両方未来 → non-stale
     - 片方過去 + 片方 null → stale
     - `unifiedStatus === "rate_limited"` は `isStale` の直接判定には含まない（stale 判定はリセット時刻ベース）

3. **`rate-limit-persistence.ts` を実装** — テストを green にする
   - `persistRateLimit`: `.team/rate-limit.json.tmp` に書いて `rename`
   - `loadRateLimit`: `readFile` → `JSON.parse` → `RateLimitInfoSchema.safeParse` → 失敗時 null + ログ
   - `isStale`: 両 reset 文字列を `Number(x) * 1000` で unix ms に変換して `now` と比較（`unified*Reset` は unix 秒文字列であることが `extractRateLimit` 仕様）

4. **`proxy.ts` に persist 呼び出しを追加**（2 箇所）
   - 既存の `if (rl) opts.getState().rateLimit = rl;` 直後に:
     ```ts
     if (rl) persistRateLimit(projectRoot, rl).catch((e: any) =>
       log("rate_limit_persist_failed", e.message).catch(() => {})
     );
     ```
   - `projectRoot` は `opts` 経由で渡す（既存 `opts.getState` と同じ注入パターン、必要なら `createProxy` のシグネチャに追加）
   - **空の `.catch(() => {})` は使わない**（Review 指摘 2）

5. **`proxy.ts:181-184` の `throttled` 判定に `isStale` ガード**
   - `const throttled = !isStale(rl) && (rl?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD && !!state.running && state.bootPhase === "ready";`
   - spawn-agent が `/rate-limit` を叩いた際に「stale データで throttled=true」にならないことを担保

6. **`daemon.ts` の `.team/.gitignore` migration を実装**（Review 指摘 3）
   - 現状 (L393-421) の `if (!existsSync(gitignore))` 分岐はそのまま（新規作成時に `rate-limit.json` を含めて生成）
   - **`else` ブランチを追加**:
     - `readFile(gitignore, "utf-8")` で既存内容を読む
     - 行単位で split して `rate-limit.json` エントリが既に含まれていないかチェック（`trim()` で比較、コメント行は除外）
     - 含まれていなければ「セッション固有」セクションの末尾（`traces/` 等の直後、空行直前）に追記。境界検出が複雑なら `proxy-port` 行の直後にシンプルに挿入する冪等実装でよい
     - `await log("team_gitignore_migrated", \`path=${gitignore} added=rate-limit.json\`)` を記録
     - 冪等性: 既に `rate-limit.json` 行があれば何もしない（ログも出さない）
   - 副次的に `team.json` / `proxy-port` も同じパターンで管理されているが、今回は `rate-limit.json` のみスコープ。共通化は YAGNI。

7. **`main.ts` `cmdStart` に load 呼び出しを追加**
   - `initInfra(state)` 直後:
     ```ts
     const restored = await loadRateLimit(PROJECT_ROOT);
     if (restored) {
       state.rateLimit = restored;
       await log("rate_limit_restored",
         `unified5h=${restored.unified5hUtilization} unified7d=${restored.unified7dUtilization} stale=${isStale(restored)}`);
     } else {
       await log("rate_limit_restored", "empty");
     }
     ```

8. **`main.ts` `shutdown` で最後の flush**
   - `shutdown` 内で `state.rateLimit` が non-null なら `await persistRateLimit(PROJECT_ROOT, state.rateLimit)` を呼ぶ（shutdown はすでに非同期なのでブロックしてよい）
   - エラー時は `log("rate_limit_persist_failed", ...)` のみで握りつぶす（shutdown を止めない）

9. **`dashboard.tsx` / `rate-limit-display.ts` の stale 対応**（Review 指摘 1 + Minor E）
   - `buildRateLimitDisplay` を `rate-limit-display.ts` に切り出し、Ink 非依存の純粋関数にする（色は enum or 文字列定数で返す）
   - シグネチャ: `buildRateLimitDisplay(rl: RateLimitInfo | null, now: number = Date.now()): { parts: Array<{ text: string; color: Color }> }`
   - stale なら全パーツを GRAY 化し末尾に `(stale)` を付与
   - `forceRed` (旧 L236) は `rl.unifiedStatus === "rate_limited" && !isStale(rl, now)` に変更
   - `dashboard.tsx` 側は import して結果を Ink の `<Text>` にマップするだけ

10. **`dashboard.tsx:918` の `isThrottled` に `isStale` ガード**（Review 指摘 1）
    - `const isThrottled = !isStale(daemon.rateLimit) && (daemon.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;`

11. **`daemon.ts:1313` の `throttled5h` に `isStale` ガード**（Review 指摘 1）
    - `const throttled5h = !isStale(state.rateLimit) && (state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD;`
    - stale 時にタスク割当が誤ってブロックされないことを担保

12. **`daemon.ts:1770-1771` の全体 throttle 判定に `isStale` ガード**（Review 指摘 1）
    - `const throttled = !isStale(state.rateLimit) && ((state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD || state.rateLimit?.unifiedStatus === "rate_limited");`

13. **`rate-limit-display.test.ts` を追加**
    - `buildRateLimitDisplay` が stale データで `(stale)` ラベルを付けることを検証
    - stale なら全パーツの color が GRAY であることを検証
    - non-stale かつ `unifiedStatus === "rate_limited"` なら赤（RED）になることを検証
    - non-stale かつ通常値ならしきい値に応じた色（GREEN/YELLOW/RED）になることを検証

14. **docs/spec の同期**
    - `docs/spec/05-install-and-infrastructure.md`: `.team/rate-limit.json` の章を追加（ファイルフォーマット・更新タイミング・stale 概念・gitignore 管理）
    - `docs/spec/01-skill-cmux-team.md`: dashboard の stale ラベル・throttle 判定が stale 中は無効化されることを追記

15. **手動 E2E**（§6 参照）

## 5. テスト計画

### 新規: `rate-limit-persistence.test.ts`

```ts
describe("persistRateLimit / loadRateLimit", () => {
  test("round-trip", async () => { /* 書いて読んで一致 */ });
  test("returns null when file absent", async () => { /* 空ディレクトリで null */ });
  test("returns null when JSON is corrupt", async () => { /* '{' だけ書いて null + ログ */ });
  test("returns null when field type is wrong", async () => {
    // 例: unified5hUtilization: "0.5"（文字列）
    // safeParse が失敗 → null + log("rate_limit_persist_failed", "load: ZodError ...")
  });
  test("returns null when required field is missing", async () => {
    // 例: tokensRemaining が欠落
  });
  test("atomic write uses .tmp → rename", async () => { /* writeFile + rename が呼ばれる */ });
});

describe("isStale", () => {
  test("returns true when both reset fields null", () => { /* 両方 null = 未知、保守的に stale */ });
  test("returns false when 5h reset in future, 7d null", () => { /* OR 判定で non-stale */ });
  test("returns false when 7d reset in future, 5h null", () => { /* OR 判定で non-stale */ });
  test("returns true when 5h reset passed and 7d null", () => { /* 片方過去 + 片方 null → stale */ });
  test("returns true when both resets passed", () => { /* 両方過去 → stale */ });
  test("returns false when at least one reset is in the future", () => { /* OR 判定 */ });
});
```

### 新規: `rate-limit-display.test.ts`（Minor E で新設）

```ts
test("buildRateLimitDisplay shows (stale) suffix when reset is in the past", () => {
  const rl: RateLimitInfo = { /* unified5hReset = 過去の unix, unified7dReset = 過去 or null */ };
  const now = /* 現在 */;
  const { parts } = buildRateLimitDisplay(rl, now);
  expect(parts.some(p => p.text.includes("(stale)"))).toBe(true);
  expect(parts.every(p => p.color === GRAY)).toBe(true);
});

test("buildRateLimitDisplay forces RED when unifiedStatus=rate_limited and not stale", () => {
  const rl: RateLimitInfo = { unifiedStatus: "rate_limited", unified5hReset: /* 未来 */ };
  const { parts } = buildRateLimitDisplay(rl, Date.now());
  expect(parts.some(p => p.color === RED)).toBe(true);
});

test("buildRateLimitDisplay ignores unifiedStatus=rate_limited when stale", () => {
  const rl: RateLimitInfo = { unifiedStatus: "rate_limited", unified5hReset: /* 過去 */, unified7dReset: null };
  const { parts } = buildRateLimitDisplay(rl, Date.now());
  expect(parts.every(p => p.color === GRAY)).toBe(true);
});
```

### 既存テストへの影響

- `proxy.test.ts` は基本変更なし（書き込みは side effect）。ただし `/rate-limit` エンドポイントの `throttled` が `isStale` でガードされるため、既存テストが「stale データで throttled=true を期待」している場合は更新が必要。事前に grep して影響範囲を確認する。
- `daemon.test.ts`（存在すれば）: `tick` の throttle 判定に `isStale` が加わるため、既存テストのフィクスチャで `unified5hReset` を未来に設定していなければ挙動が変わる可能性あり。

### 既存 `proxy.test.ts` の `extractRateLimit` 検証は変更不要

`extractRateLimit` の戻り値が既存テストで検証済みなので、そのシリアライズ可能性は `rate-limit-persistence.test.ts` の round-trip で間接的にカバーされる。Zod スキーマを新設することで将来の互換性チェックも自動化される。

## 6. 受け入れ条件の検証方法（手動 E2E）

前提: cmux 起動済み、cmux-team のローカル変更が `bun install`/`npm run build` などで反映可能。

1. `cmux-team start` — 初回起動。`.team/rate-limit.json` は存在しないことを確認：`test ! -f .team/rate-limit.json`
2. Master から簡単なタスクを投げて、Conductor が API を 1 回以上叩くのを待つ（`manager.log` で `proxy_request` が流れれば OK）
3. `.team/rate-limit.json` が作成されたことを確認：`cat .team/rate-limit.json | jq .unified5hUtilization`
4. dashboard の右上に `5h: X% ████░░░░░░` 等が表示されていることを確認
5. `cmux-team stop` → `cmux-team start`
6. **受け入れ条件A**: 再起動直後、API 応答が来る前の時点で dashboard に前回の 5h/7d 値が表示されていることを確認（`manager.log` の `rate_limit_restored unified5h=... stale=false` エントリも確認）
7. **受け入れ条件B（stale 表示）**: `unified5hReset` / `unified7dReset` 両方を過去の値に手動で書き換えたファイルを用意して再起動 → dashboard に `(stale)` ラベルが付き GRAY になることを確認。スロットリングバナー（`⏸ THROTTLED`）も出ないことを確認
8. **受け入れ条件B'（stale 中の throttle 抑止）**: `unified5hUtilization: 0.95` かつ `unified5hReset` 過去の `rate-limit.json` を用意して再起動。open task を 1 件 ready にして、
   - `manager.log` に `throttled_rate_limit` が出ないこと
   - Conductor にタスクが割り当てられること（stale ガードが tick のタスク割当抑止を解除していることを確認）
   - `curl http://localhost:<proxy-port>/rate-limit` で `{"throttled": false, ...}` が返ることを確認
9. **受け入れ条件C**: 新しい API 応答が来たら stale ラベルが消え、最新値で上書きされることを確認（Master から簡単なプロンプトを投げる）
10. **受け入れ条件D（破損耐性）**: 以下を順に試し、いずれも crash せず `rate_limit_persist_failed` または `rate_limit_restored empty` がログに出ることを確認:
    - 破損 JSON: `echo '{' > .team/rate-limit.json` → `cmux-team start`
    - フィールド型不一致: `echo '{"unified5hUtilization":"0.5"}' > .team/rate-limit.json` → `cmux-team start`
    - 必須フィールド欠落: `echo '{}' > .team/rate-limit.json` → `cmux-team start`
11. **受け入れ条件E（`.gitignore` migration）**: 既存 `.team/.gitignore` に `rate-limit.json` が無い状態で `cmux-team start` → ファイルを読むと `rate-limit.json` が追記されていること、`manager.log` に `team_gitignore_migrated path=... added=rate-limit.json` があること。もう一度 `cmux-team start` しても二重追記されないこと（冪等性）。

## 7. ロールバック・リスク

### リスク

- **破損 / 不整合 JSON を読んでクラッシュ**: `loadRateLimit` は `safeParse` + try/catch + null fallback で保護。フィールド型不一致のケースもテストで担保（Review 指摘 4）。
- **persist が API レスポンスをブロック**: fire-and-forget (ログ付き二段 catch) を徹底。proxy.ts のパスでは `await` しない。shutdown パスのみ `await` だが shutdown はもともとブロッキング許容。
- **stale 判定のバグで本物の throttle を見逃す**:
  - `isStale` のユニットテストで未来のリセット時刻は non-stale であることを保証（OR 判定のテストを網羅）
  - 数分以内の再起動であれば reset も未来にあるため通常ケースは従来と同等に throttle される
  - `unifiedStatus === "rate_limited"` は `!isStale` 条件下でのみ throttle 扱いに戻すので、非 stale な高負荷時は引き続き検知される
- **stale ガードの配線漏れで一部経路が stale データで誤動作**: throttle 判定 5 箇所（`dashboard.tsx:918`, `dashboard.tsx:236`→新モジュール, `proxy.ts:182`, `daemon.ts:1313`, `daemon.ts:1770`）すべてに適用。`grep -n THROTTLE_5H_THRESHOLD` / `grep -n 'unifiedStatus === "rate_limited"'` で残存していないことを PR レビュー時にチェック。
- **`.team/rate-limit.json` が git に commit されてしまう**:
  - 新規インストール: `.team/.gitignore` 初回生成に `rate-limit.json` を含める
  - 既存インストール: §4 Step 6 の migration で追記（Review 指摘 3）
  - 冪等性: 既に含まれている場合は追記しない（`rate-limit.json` 行存在チェック）
- **Minor Note A（shutdown race）**: proxy fire-and-forget が in-flight の状態で shutdown の `await persistRateLimit` が走ると、書き込みが交差した瞬間に「古い値で上書き」される可能性がある（最大で proxy 1 回分の遅れ）。実害は小さいため修正せず、ここに注記として残す。将来必要なら単一の write queue 化で解決可。

### ロールバック

- 問題発生時は以下で元の挙動に戻せる（全て localized な変更）：
  - `rm .team/rate-limit.json`
  - `main.ts` の `loadRateLimit` 呼び出しをコメントアウト（または revert）
  - `proxy.ts` の `persistRateLimit` 呼び出しをコメントアウト
  - throttle 判定 5 箇所の `!isStale(...)` ガードを外す（revert）
- dashboard 側の stale 表示はフィーチャーフラグ化しない（単純な条件分岐で、問題があれば revert だけで完結）。
- 全体 revert: このタスクのコミットを `git revert` すれば元の in-memory only 挙動に戻る。`.team/rate-limit.json` と `.team/.gitignore` への追記は残るが無害（次回起動で無視される）。
