# Summary: T201 startMaster PID フォールバック実装

## 結果

**成功** — 受け入れ基準を全て満たし、`bun test` で 280/280 pass。

## 実施フェーズ

| Phase | Agent | 結果 |
|---|---|---|
| 1 Plan | planner | plan.md 作成（Option A 採用） |
| 2 Design Review | design-reviewer | Approved + 軽微な改善提案 2 件 |
| 3 Implementation (TDD) | impl | daemon.ts + daemon.test.ts 修正 |
| 4 Inspection | inspector | GO（280 pass / 0 fail） |

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | +30 行（startMaster の生存判定を if/else 二段構えに分岐、ログ拡張） |
| `skills/cmux-team/manager/daemon.test.ts` | +163 行（`describe("startMaster pid fallback (T201)", ...)` 4 ケース追加） |

`master.ts` / `cmux.ts` への変更なし。新規ファイルなし。

## 設計判断

**Option A**（pid 未登録時に surface 検証へフォールバック）を採用。

- 最小変更でマイグレーション互換を回復
- T195 で削除した `cmux tree` 依存を **daemon 起動時 1 回限り** に限定（ポーリング経路には戻さない）
- 既存 `.team/master.surface` フォーマット変更不要
- 将来「pid 必須」に統一する際の削除ポイントが 1 箇所に集まる

不採用: B（ps 発見=実装が脆い）/ C（マーカー変更=過剰）/ D（SESSION_STARTED 強制 push=境界違反）

## 主な変更点

### `daemon.ts:startMaster`

```typescript
let alive = false;
let aliveVia: "pid" | "surface_fallback" | null = null;
if (restoredMasterPid != null) {
  // pid あり: 通常の PID 経路（T195 以降の標準）
  alive = await isMasterAlive(state.projectRoot);
  if (alive) aliveVia = "pid";
} else {
  // pid なし: surface 生存確認にフォールバック（v3.46.0 → v3.47.0 マイグレーション互換）
  const pane = await cmux.getPaneForSurface(surface, state.workspace ?? undefined);
  alive = pane !== undefined;
  if (alive) {
    aliveVia = "surface_fallback";
    await log(
      "master_alive_via_surface_fallback",
      `${formatSurface(surface, "U")} pane=${pane} reason=team_json_pid_missing`,
    );
  }
}
```

- フォールバック経路では `state.masterPid` を埋めない（PID 不明）
- フォールバック経路では `spawnMasterPidWatcher` をスキップ
- `master_restored` ログに `via=${aliveVia}` 付与
- `master_check_failed` ログに `reason=${pid_dead|surface_missing}` 付与（Design Review Rec 2）

### 新規ログイベント

| event | detail |
|---|---|
| `master_alive_via_surface_fallback` | `U[NN] pane=pane:NN reason=team_json_pid_missing` |
| `master_restored` (拡張) | `U[NN] pid=<num\|unknown> via=<pid\|surface_fallback>` |
| `master_check_failed` (拡張) | `U[NN] alive=false reason=<pid_dead\|surface_missing>` |

このログにより、マイグレーション互換コードが発動した環境を後追いで識別できる。発動が消えれば将来削除可能。

### テストケース (`daemon.test.ts`)

| # | シナリオ | 検証内容 |
|---|---|---|
| 1 | pid あり + プロセス生存 | `via=pid`、spawn しない |
| 2 | pid あり + プロセス死亡 | `reason=pid_dead`、spawn する |
| 3 | **pid なし + surface 生存** | `master_alive_via_surface_fallback`、`via=surface_fallback`、`state.masterPid === undefined`、spawn しない |
| 4 | **pid なし + surface 不在** | `reason=surface_missing`、spawn する |

`__setIsAliveImpl` (Rec 1) と `__setTreeImpl` でモック、`try/finally` でリセット。

## テスト結果

```
$ bun test daemon.test.ts -t "startMaster pid fallback"
 4 pass / 0 fail / 26 expect()

$ bun test daemon.test.ts
 70 pass / 0 fail / 169 expect()

$ bun test
 280 pass / 0 fail / 587 expect() across 14 files
```

## 受け入れ基準

| 基準 | 状況 |
|---|---|
| v3.46.0 → v3.47.0 daemon 再起動で重複 spawn されない | ✓ ケース 3 で `master_spawning` 不在を検証 |
| team.json の master.pid 欄が空でも既存 Master を復元 | ✓ `state.masterSurface` / `masterStatus="idle"` を検証 |
| 既存 daemon.test.ts / cmux.test.ts が通る | ✓ 70 + 8 pass（リグレッションなし） |
| 「pid 無し + surface 生存」テスト追加 | ✓ ケース 3 として追加 |

## スコープ外

- U[55] のゾンビ Master 掃除（タスク本文「副作用」セクションの判断通り別タスク化）
- `state.masterPid` の埋め直し（フォールバック経路では undefined のまま、次回 SESSION_STARTED で埋まる）
- `.team/master.surface` マーカーフォーマット変更（Option C を不採用）

## 納品

main へローカルマージ予定。
