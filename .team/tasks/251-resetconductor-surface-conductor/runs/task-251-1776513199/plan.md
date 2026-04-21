# T251 実装計画: resetConductor で surface 実在確認を行い幽霊 Conductor を防ぐ

## 1. サマリー

`resetConductor` (`skills/cmux-team/manager/conductor.ts:502`) の冒頭で surface 実在確認を行い、
surface 不在時は cleanup を最小限に絞った上で **broken** 状態に倒す。これにより pane 消失済みの
Conductor が `idle` として team.json に滞留する「幽霊 Conductor」を防ぐ。変更範囲は
`conductor.ts` 1 箇所と、`conductor.test.ts` のテスト追加のみ。

## 2. 設計判断

### D1. surface 実在確認の API — `getPaneForSurface` の undefined 判定を使う

- タスク本文が指定する `cmux.validateSurface` は存在しない（grep で確認済み）。
- `cmux.getPaneForSurface(surface, workspace)` (`cmux.ts:150`) は
  - surface が tree に見つからない → `undefined`
  - tree コマンド失敗 → `undefined`（内部で catch してログ出力）
  を返すため、**「surface がどの pane にも存在しない」の判定に最小差分で流用できる**。
- `listSiblingSurfaces` は「pane 内に自分しかいない」ケースと区別できないため使わない。
- tree 失敗（cmux がダウン等）で誤って broken 判定する懸念はあるが、
  tree が死んでいる時点で Conductor 操作は成立しないため、broken 判定で問題ない（fail-safe）。

### D2. idle 遷移時の surface 欠損 → **broken に倒す (A)**

- 本タスクの目的（幽霊 Conductor 防止）から、surface 不在なら `targetStatus` の
  指定に関わらず `broken` に倒すのが正しい。
- `idle` で握りつぶすと次 tick で assignTask の対象になり、send が失敗するまで
  時間を浪費する。broken に倒せば `cmux-team clear-conductor` でユーザーが
  明示的に回復させるまで割当対象から外れる。
- surface 不在が検出された事実は `reason=surface_missing` としてログに残す。

### D3. 既に broken な Conductor に再 reset({"broken"}) が来た場合の idempotency

- 既に status が `broken` の Conductor に再度 reset が来ても、**従来通り cleanup
  (sibling close / worktree remove / branch delete) は最後まで実行する**。
  worktree / branch は冪等削除で副作用はなく、sibling close も不在なら no-op で済む。
- `disconnectedAt` は broken 経路で保持する既存ロジックに従う。
- 「何もせず早期 return」は採用しない — 呼び出し側が cleanup を期待している場面
  （例: forceCloseDisconnectedConductor の再送）を壊す。

### D4. ログの reason

- 既存の `conductor_broken reason=...` / `conductor_reset reason=...` に
  `surface_missing` を追加する。既存 reason (`disconnect_timeout`, `cleared` 等) と
  競合しない新規トークン。
- 呼び出し側が reason を渡していた場合（例: `disconnect_timeout`）は **surface_missing を優先**する
  — 「なぜ broken になったか」の最も根源的な原因を記録するため。

### D5. テスト追加方針

`cmux.getPaneForSurface` を `spyOn` でモックして 2 ケース追加：

1. `targetStatus` 省略（idle 要求）で surface 不在 → `broken` に倒れ `reason=surface_missing`
2. `targetStatus="broken"` 明示で surface 不在 → `broken` のまま `reason=surface_missing`

ログ検証は既存テスト同様 spy を使わず状態のみ assert（テスト簡潔化のため、
reason 文字列の確認はログファイル読み込み or `log` モック化のいずれか — 既存パターン無しのため
状態 assert のみに留める）。

## 3. 変更ファイル

### 3-1. `skills/cmux-team/manager/conductor.ts`

`resetConductor` 冒頭、`try` ブロック内の sibling close より前に surface 実在確認を追加。

```ts
export async function resetConductor(
  conductor: ConductorState,
  projectRoot: string,
  workspace?: string,
  opts?: { targetStatus?: "idle" | "broken"; reason?: string },
): Promise<void> {
  try {
    // 0. surface 実在確認（T251: 幽霊 Conductor 防止）
    //    surface が tree に存在しない場合は idle 要求でも broken に倒す。
    //    tree 失敗時も undefined になるが、tree が死んでいる状況で Conductor 操作は
    //    成立しないため fail-safe に broken 判定する。
    const pane = await cmux.getPaneForSurface(conductor.surface, workspace);
    const surfaceMissing = pane === undefined;
    const effectiveTargetStatus: "idle" | "broken" = surfaceMissing
      ? "broken"
      : (opts?.targetStatus ?? "idle");
    const effectiveReason = surfaceMissing
      ? "surface_missing"  // 最も根源的な原因を優先
      : opts?.reason;

    // 1. タブ内のサブ surface を閉じる（既存処理）
    const siblings = await cmux.listSiblingSurfaces(conductor.surface, workspace);
    // ... 既存のまま ...

    // 2. worktree 削除（既存処理、冪等）
    // ...

    // 4. ConductorState リセット
    const targetStatus = effectiveTargetStatus;   // ← 置き換え
    conductor.status = targetStatus;
    // ... 既存のまま ...

    const reasonSuffix = effectiveReason ? ` reason=${effectiveReason}` : "";
    await log(
      targetStatus === "broken" ? "conductor_broken" : "conductor_reset",
      `${formatSurface(conductor.surface, "C")}${reasonSuffix}`,
    );
  } catch (e: any) {
    await log("error", `resetConductor failed: ${e.message}`);
  }
}
```

**変更ポイント:**
- `getPaneForSurface` 呼び出しの追加（新規 1 行 + 判定 + 変数 3 本）
- `opts?.targetStatus ?? "idle"` → `effectiveTargetStatus` に差し替え
- `opts?.reason` → `effectiveReason` に差し替え
- 既存の sibling close / worktree remove / status 代入ロジックは一切変更しない

### 3-2. `skills/cmux-team/manager/conductor.test.ts`

既存の `describe("resetConductor targetStatus オプション (T250)", ...)` に続けて
`describe("resetConductor surface 実在確認 (T251)", ...)` を追加。

```ts
describe("resetConductor surface 実在確認 (T251)", () => {
  let listSiblingsSpy: ReturnType<typeof spyOn>;
  let closeSurfaceSpy: ReturnType<typeof spyOn>;
  let getPaneForSurfaceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listSiblingsSpy = spyOn(cmux, "listSiblingSurfaces").mockResolvedValue([]);
    closeSurfaceSpy = spyOn(cmux, "closeSurface").mockResolvedValue(undefined as any);
    getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue(undefined);
  });

  afterEach(() => {
    listSiblingsSpy.mockRestore();
    closeSurfaceSpy.mockRestore();
    getPaneForSurfaceSpy.mockRestore();
  });

  test("surface 不在 + idle 要求(省略) なら broken に倒す", async () => {
    const conductor: ConductorState = {
      surface: "surface:ghost-1",
      startedAt: new Date().toISOString(),
      taskRunId: "task-100-xxx",
      taskId: "100",
      agents: [],
      status: "idle",
    };

    await resetConductor(conductor, testDir);

    expect(conductor.status).toBe("broken");
    // surface_missing は broken 扱いなので disconnectedAt は保持 (ただし元々未設定なので undefined)
    expect(conductor.taskRunId).toBeUndefined();
  });

  test("surface 不在 + broken 明示指定 なら broken のまま", async () => {
    const conductor: ConductorState = {
      surface: "surface:ghost-2",
      startedAt: new Date().toISOString(),
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      taskRunId: "task-200-xxx",
      taskId: "200",
      agents: [],
      status: "disconnected",
    };

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "disconnect_timeout",
    });

    expect(conductor.status).toBe("broken");
    expect(conductor.disconnectedAt).toBe("2026-04-18T10:00:00.000Z");
    expect(conductor.taskRunId).toBeUndefined();
  });

  test("surface 存在 + idle 要求 なら従来通り idle", async () => {
    getPaneForSurfaceSpy.mockResolvedValue("pane:1");  // 存在する
    const conductor: ConductorState = {
      surface: "surface:alive-1",
      startedAt: new Date().toISOString(),
      taskRunId: "task-300-xxx",
      taskId: "300",
      agents: [],
      status: "running",
    };

    await resetConductor(conductor, testDir);

    expect(conductor.status).toBe("idle");
  });
});
```

**既存 T250 テストへの影響:**
- 既存 3 テストは `getPaneForSurface` をモックしていないため、実 tree 呼び出しに流れる。
  `cmux tree` は子プロセス起動で失敗する → `getPaneForSurface` が undefined を返す →
  本変更で全て broken 判定になり**既存テストが壊れる**。
- 対策: 既存 `describe("resetConductor targetStatus オプション (T250)")` の beforeEach にも
  `getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");` を追加する。
  （「surface 存在ケース」として扱い T250 テストの意図を保つ）

## 4. TDD 手順

1. **RED-1**: 上記 3-2 の新規テスト 3 本を追加 → 既存 T251 なし実装で fail
2. **RED-2**: 既存 T250 テストの beforeEach に `getPaneForSurface` モックを追加
   → 実装側未変更のため pass のまま（getPaneForSurface は呼ばれていない）
3. **GREEN**: `resetConductor` 冒頭に surface 実在確認ロジックを追加（3-1 の差分）
   → 新規 3 テスト pass、T250 既存 3 テストも pass
4. **Verify**: `bun test conductor.test.ts` で全 6 テスト pass を確認
5. **Lint/Type check**: 既存 CI スクリプト相当（`bun run tsc --noEmit` 等）

## 5. 非範囲

- `initializeLayout` 側の pane 割当ロジック変更（T255 の責務）
- `team.json` から幽霊 Conductor を既に取り除く GC 処理（別タスク）
- `cmux-team clear-conductor` CLI の挙動変更（既存のまま — broken → idle に戻す手段として機能）
- disconnect timeout の閾値調整・再 spawn ロジック（T250 で決着済み）
- hook push (SESSION_ENDED 等) による事前の surface 不在検知（daemon.ts handleMessage の責務）
- conductor.ts 内の他関数（`assignTask`, `collectResults` 等）の surface 確認追加
