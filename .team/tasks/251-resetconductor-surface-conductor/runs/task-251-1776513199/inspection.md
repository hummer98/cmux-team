# T251 検品結果

## 判定: GO

## 検証項目

### 1. plan.md 準拠

- **D1 (getPaneForSurface 使用)**: OK
  `conductor.ts:515` で `cmux.getPaneForSurface(conductor.surface, workspace)` を呼び出し、
  `undefined` 判定で surface 不在を検出している。plan の API 選定通り。
- **D2 (surface 不在 → broken 強制)**: OK
  `conductor.ts:517-519` で `surfaceMissing ? "broken" : (opts?.targetStatus ?? "idle")` と
  なっており、`targetStatus` 指定を無視して broken に倒す。
- **D3 (cleanup は冪等実行)**: OK
  surface 不在でも sibling close / worktree remove / branch delete は従来通り実行される
  （早期 return していない）。
- **D4 (surface_missing reason 優先)**: OK
  `conductor.ts:522` で `surfaceMissing ? "surface_missing" : opts?.reason` と
  なっており、disconnect_timeout 等の呼び出し側 reason より surface_missing を優先する。
- **D5 (テスト 3 本追加)**: OK
  `conductor.test.ts` に T251 専用 describe を追加し、
  (1) 不在+idle要求→broken、(2) 不在+broken明示→broken、(3) 存在+idle要求→idle の 3 ケースをカバー。

### 2. テスト実行結果

```
# cd skills/cmux-team/manager && bun test conductor.test.ts
bun test v1.3.12 (700fc117)
 17 pass
 0 fail
 70 expect() calls
Ran 17 tests across 1 file. [9.49s]

# cd skills/cmux-team/manager && bun test
 525 pass
 0 fail
 1193 expect() calls
Ran 525 tests across 23 files. [21.22s]

# cd skills/cmux-team/manager && bunx tsc --noEmit
exit 0（出力なし）
```

### 3. 既存機能への影響

- **disconnect timeout 経路 (daemon.ts:2331)**: 維持
  `targetStatus: "broken"` で呼び出すが、surface 不在の場合 reason が `disconnect_timeout` →
  `surface_missing` に置き換わる。broken 状態と cleanup 動作は同一。
- **CONDUCTOR_CLEAR 経路 (daemon.ts:1049)**: 維持
  broken → idle に戻す正常経路。対象 surface は実在するため従来通り idle。
  既存テスト `CONDUCTOR_CLEAR で broken Conductor が idle に戻る（正常経路）` が
  getPaneForSurface モック追加で pass している。
- **正常 reset 経路 (daemon.ts:1791)**: 維持
  タスク完了後の reset。surface 実在時は従来通り idle。
- **late cleanup 経路 (daemon.ts:2358)**: 維持
  daemon.test.ts の `disconnected + CONDUCTOR_DONE で late cleanup が走る` も
  getPaneForSurface モック追加で pass。

### 4. plan 外の変更

- **daemon.test.ts (2テスト)**: 妥当
  plan 3-2 の「既存 T250 テストへの影響」と同じ問題。daemon.test.ts でも resetConductor
  を通る 2 テスト（`disconnected + CONDUCTOR_DONE`、`CONDUCTOR_CLEAR で broken Conductor
  が idle に戻る`）は surface 存在ケースを想定しているため、getPaneForSurface の spy を
  追加する必要があった。plan に明示されていなかったが、plan 3-2 の論理的拡張であり、
  意図を壊していない（`paneSpy.mockResolvedValue("pane:1")` で存在ケースに固定）。
- **package-lock.json (version bump)**: 妥当
  3.53.0 → 3.54.1 は既に `package.json` が 3.54.1 である（`ac269f6 chore: release v3.54.1`）ための
  整合性回復。bun/npm install の副産物で、コード変更には直接関連しない。
- **コード変更の最小性**: OK
  conductor.ts 変更は冒頭の 15 行追加 + 2 箇所の変数差し替えのみ。
  既存の sibling close / worktree remove / status 代入ロジックは無変更。

### 5. ログフォーマット

- `conductor_broken` / `conductor_reset` に `reason=surface_missing` を追加する形。
  CLAUDE.md の「ログフォーマット」`key=value` スペース区切りに準拠。
- `formatSurface(conductor.surface, "C")` で surface 表記も規約通り。

### 6. コメントの質

- `conductor.ts:509-514` のコメントは plan D2/D3 の根拠（fail-safe 判定、cleanup 冪等性）を
  簡潔に記録しており、将来の読者が「なぜこの判定か」を追跡可能。過剰ではない。

## 総評

- plan.md の D1〜D5 を忠実に実装している。
- 新規テスト 3 本 + 既存テスト拡張 2 本（conductor.test.ts + daemon.test.ts）で
  回帰は全 525 pass、型チェックも clean。
- plan 外の変更（daemon.test.ts モック追加、package-lock.json）はいずれも実装に
  必要な対応であり、余分な refactoring は含まれない。
- 「幽霊 Conductor を防ぐ」というタスク本文の目的を最小差分で達成している。

**判定: GO** — このままマージ可能。
