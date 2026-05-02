# T381 fix report

Inspector 指摘 (Major 1 + Minor 2) の修正対応。

## Fixed Items

| # | severity | finding | result |
|---|----------|---------|--------|
| 1 | major | help_metrics_compare の deny_rate 表記削除 (en + ja) | done |
| 2 | minor | buildPayload を CohortPayload type に置換 | done |
| 3 | minor | resolveUnderRoot を metrics-path.ts に集約 (3 ファイル → 1 ファイル) | done |

## Files Changed

### 修正 1: i18n.ts の help から deny_rate を削除

- `skills/cmux-team/manager/i18n.ts:674` (en): `rates: completion_rate, abort_rate, forced_close_rate, deny_rate diffs (z-test)` → `rates: completion_rate, abort_rate, forced_close_rate diffs (z-test)`
- `skills/cmux-team/manager/i18n.ts:1637` (ja): `rates: completion_rate, abort_rate, forced_close_rate, deny_rate の差分（z-test）` → `rates: completion_rate / abort_rate / forced_close_rate の差分（z-test）`
- 他箇所 (`help_metrics_snapshot` 内) の deny_rate 言及は touch せず維持。

### 修正 2: metrics-compare.ts に CohortPayload 型を導入

- `skills/cmux-team/manager/metrics-compare.ts:584-593`: `type CohortPayload = { ... }` を `formatTextCohort` 直前に追加。
- 同ファイル末尾にあった `function buildPayload(): { ... } { return {} as never }` (629-640) を削除。
- `formatTextCohort(p: ReturnType<typeof buildPayload>)` を `formatTextCohort(p: CohortPayload)` に変更。
- ランタイムの dead 関数を消し、純粋な type 宣言に置換。

### 修正 3: resolveUnderRoot の集約

- 新規ファイル `skills/cmux-team/manager/metrics-path.ts` を追加。
  - `export type ResolveUnderRootResult = { path: string; outside: boolean }`
  - `export function resolveUnderRoot(root, value, opts?: { allowOutside?: boolean }): ResolveUnderRootResult`
  - 引数順序は `(root, value)` に統一（指示の API 仕様に合わせた）。
  - `outside` フラグ + `allowOutside` opts により、呼び出し側で「outside でも path を採用する」ケースを 1 関数で表現。
- `skills/cmux-team/manager/metrics-snapshot.ts`:
  - 旧ローカル `resolveUnderRoot` (219-227) を削除。
  - `import { resolveUnderRoot } from "./metrics-path"` を追加。
  - 不要になった `relative`、未使用になった `resolve` を `path` import から除去。
  - `--out` 解決ロジックを `resolveUnderRoot(root, value, { allowOutside })` 1 行に統合。挙動は不変（outside かつ `--allow-outside-project` 未指定で error message + exit 1）。
- `skills/cmux-team/manager/metrics-compare.ts`:
  - 旧ローカル `resolveUnderRoot` (498-506) を削除。
  - `import { resolveUnderRoot } from "./metrics-path"` を追加。
  - `path` import から `relative`, `resolve` を除去（`join` のみ残存）。
  - `--snapshot-dir` 解決ロジックを共通化。
- `skills/cmux-team/manager/metrics-health.ts`:
  - 旧ローカル `resolveUnderRoot` (133-141) を削除。
  - `import { resolveUnderRoot } from "./metrics-path"` を追加。
  - `path` import から `relative`, `resolve` を除去（`join` のみ残存）。
  - `--snapshot-dir` 解決ロジックを共通化。

## Verification

### grep invariant

```
$ grep -nE "function resolveUnderRoot" skills/cmux-team/manager/metrics-{snapshot,compare,health}.ts
(no matches — all 3 removed)

$ grep -nE "buildPayload" skills/cmux-team/manager/metrics-compare.ts
(no matches)

$ grep -nE "type CohortPayload|interface CohortPayload" skills/cmux-team/manager/metrics-compare.ts
584:type CohortPayload = {

$ grep -nE "resolveUnderRoot|metrics-path" \
    skills/cmux-team/manager/metrics-{snapshot,compare,health,path}.ts
metrics-snapshot.ts:26:import { resolveUnderRoot } from "./metrics-path";
metrics-snapshot.ts:272:    const resolved = resolveUnderRoot(opts.projectRoot, parsed.out, {
metrics-compare.ts:22:import { resolveUnderRoot } from "./metrics-path";
metrics-compare.ts:530:    const r = resolveUnderRoot(opts.projectRoot, parsed.snapshotDir, {
metrics-health.ts:15:import { resolveUnderRoot } from "./metrics-path";
metrics-health.ts:157:    const r = resolveUnderRoot(opts.projectRoot, parsed.snapshotDir, {
metrics-path.ts:14:export function resolveUnderRoot(

$ grep -n "deny_rate" skills/cmux-team/manager/i18n.ts
(help_metrics_compare 周辺で 0 件 — 残存は help_metrics_snapshot 側のみで指示通り維持)
```

### tsc

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
exit 0
```

### bun test (全 metrics 系)

```
metrics-stats.test.ts       31 pass / 0 fail (40 expect)
metrics-snapshot.test.ts    15 pass / 0 fail (44 expect)
metrics-compare.test.ts     26 pass / 0 fail (65 expect)
metrics-health.test.ts      10 pass / 0 fail (20 expect)
metrics-e2e.test.ts          2 pass / 0 fail (21 expect)
metrics-cli.test.ts         16 pass / 0 fail (33 expect)
metrics-aggregate.test.ts   18 pass / 0 fail (53 expect)
events-cli.test.ts          19 pass / 0 fail (93 expect)
                            -----------
total                      137 pass / 0 fail
```

path traversal 関連テスト (compare / health / snapshot 各 CLI の `--allow-outside-project` 系) は全て pass。リファクタによる挙動変化なし。

## Issues Encountered

- 修正 3 で `resolveUnderRoot` の API シグネチャを `(value, projectRoot) -> string | null` から `(root, value, opts?) -> { path, outside }` に変更した。これは指示書の API 仕様（`resolveUnderRoot(root: string, value: string, opts?: { allowOutside?: boolean }): { path: string; outside: boolean }`）に厳密に従ったもの。引数順序が反転しているため呼び出し箇所 3 箇所すべてを書き換えた。`--allow-outside-project` の動作は外部仕様として不変（同一の error message、同一の exit code）。
- 既存テストの書き換えは行っていない（リファクタは外部観測動作を変えていないため）。

## Scope

修正対象は finding 1 / 3 / 4 のみ。finding 2 (A026 artifact 未作成) は指示通り対象外（Conductor の完了処理 Step 6 で自動 artifact 化）。
