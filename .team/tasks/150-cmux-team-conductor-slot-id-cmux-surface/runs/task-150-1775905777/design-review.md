# Design Review: T150

## 判定: Approved

計画書は網羅的かつ正確であり、全タスク要件をカバーしている。以下の Minor findings があるが、いずれも実装上問題にはならない。

## Findings

### [Minor] Risk 3 のファイル名変更に関する記述が不正確

**場所**: 計画書「リスクと注意点」Risk 3

計画書は「surface 値は以前の slotId と同じ値（例: `surface:xxx`）なのでファイル名は変わらない」と述べているが、これは **conductor.ts 経由のパスについてのみ正確** である。

`initializeConductor` / `restartConductor`（main.ts L1564, L1650）では現在 `conductor.surface.replace("surface:", "")` で "surface:" プレフィクスを除去した値を使っている:

```typescript
const slotId = conductor.surface.replace("surface:", "");
// → slotId = "xxx" (stripped)
```

変更後は `CMUX_SURFACE` の値 `surface:xxx`（full）が使われるため、settings ファイル名は `xxx-settings.json` → `surface:xxx-settings.json` に変わる。conductor.ts 経由のパスでは既に `surface:xxx-settings.json` が使われており、これにより全パスが統一されるため、むしろ改善である。機能への影響はない。

同様に、`CONDUCTOR_ID` 環境変数も initializeConductor/restartConductor パスでは stripped 値 → full 値に変わるが、daemon の `findConductor()` は `message.surface` で検索するため `conductorId` の値変更は影響しない。

### [Minor] cmdResume の CMUX_SURFACE チェック位置が曖昧

**場所**: 計画書 Change 4 vs Risk 4

Before/After コードは L914（タスク情報取得後）の位置での変更を示しているが、Risk 4 では「cmdResume の冒頭（タスク情報取得前）に移動することで、不要な処理を回避できる」と述べている。

- Before/After 通りに L914 位置で変更する場合: 機能的に問題なし
- Risk 4 通りに冒頭に移動する場合: CMUX_SURFACE 未設定時に task-state.json ロード等を省略でき、わずかに効率的

どちらでも正しく動作するが、実装者の混乱を避けるため意図を明確にすべき。**推奨: 冒頭（L884 の `if (hasHelpFlag())` 直後）に配置** し、Before/After コードを以下のように修正:

```typescript
async function cmdResume(): Promise<void> {
  if (hasHelpFlag()) showHelp("Usage: cmux-team resume <task-id>");
  const surface = process.env.CMUX_SURFACE;
  if (!surface) {
    console.error("Error: CMUX_SURFACE environment variable is required");
    process.exit(1);
  }
  const taskId = args[1];
  // ...（以降は既存の task-state.json ロード等）
  process.env.CONDUCTOR_ID = surface;
```

### [Minor] i18n.ts の After コードが部分的

**場所**: 計画書 Change 10, 11

help_conductor の After で Usage と Environment セクションのみ示されており、既存の Options / Notes セクションの保持が明示されていない。実装者は Options (`--model`) と Notes セクションをそのまま残す必要がある。意図は明らかだが、完全な After を示す方が安全。

## 検証結果サマリ

| 観点 | 結果 |
|------|------|
| 網羅性 | OK - 全タスク要件がカバーされている |
| 正確性 | OK - 全 Before スニペットが実コード（L763-L924 の i18n.ts 含む）と一致 |
| 依存関係 | OK - 変更順序に問題なし |
| 副作用 | OK - `grep slot-id/slotId` で全箇所を確認、計画書に含まれない変更箇所なし |
| リスク分析 | Minor issues あり（上記参照）、いずれも機能影響なし |
