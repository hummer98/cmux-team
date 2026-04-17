# T190 実装計画

## 修正方針サマリー

6 件の tsc エラーを**型注釈のみ・実行時挙動に影響しない最小変更**で解消する。`update-notifier` のみ `@types/update-notifier` を devDependencies に追加する（install 必要）。

## 修正一覧

### 1. cmux.ts:22 — `execFile` の `NonSharedBuffer` union

**現状のコード**（`skills/cmux-team/manager/cmux.ts:20-22`）:

```ts
async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("cmux", args, opts);
```

**原因**: `promisify(execFileCb)` の返り値は `{ stdout: string | NonSharedBuffer; stderr: string | NonSharedBuffer }`（Bun の Node 型定義）。宣言された返り値 `{ stdout: string; stderr: string }` と不一致。

**修正案**: 結果を destructure して `.toString()` で string に絞る。

```ts
async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile("cmux", args, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e: any) {
    ...
```

**根拠**: `execFile` は encoding オプション未指定時は実際には string を返すため、`.toString()` は no-op（string に対する `.toString()` は自身を返す）。型注釈のみの修正で実行時挙動は不変。

---

### 2. daemon.ts:20 — `update-notifier` の型定義欠落

**現状のコード**（`skills/cmux-team/manager/daemon.ts:20`）:

```ts
import updateNotifier from "update-notifier";
```

**原因**: T187 で `update-notifier` を runtime deps に追加したが、`@types/update-notifier` を入れていない。

**修正案**:

1. `skills/cmux-team/manager/package.json` の `devDependencies` に `@types/update-notifier` を追加
2. `cd skills/cmux-team/manager && bun install` で lock を更新

```json
"devDependencies": {
  "@types/bun": "latest",
  "@types/react": "^19.2.14",
  "@types/update-notifier": "^6.0.8",
  "ink-testing-library": "^4.0.0"
}
```

**根拠**: 型定義の追加のみ。実行時挙動に影響なし。バージョンは DefinitelyTyped の current major（`update-notifier@7` に対応）。

---

### 3. dashboard.tsx:373 — `dsVariant: "unstyled"` 無効値（sectionTitle）

**現状のコード**（`skills/cmux-team/manager/dashboard.tsx:368-377`）:

```tsx
function sectionTitle(label: string) {
  return ui.button({
    id: `section-${label}`,
    label: `─ ${label} ${HR_FILL}`,
    px: 0,
    dsVariant: "unstyled",
    style: { dim: true },
    focusable: false,
  });
}
```

**原因**: `@rezi-ui/core` の `WidgetVariant = "solid" | "soft" | "outline" | "ghost"`（`node_modules/@rezi-ui/core/dist/ui/designTokens.d.ts:76`）。`"unstyled"` は未定義。

**ランタイム検証**: `readWidgetVariant("unstyled")` は `undefined` を返し（themeTokens.js:3-8）、`isButtonVariant("unstyled")` も false（leaf.js:12）。つまり `"unstyled"` は実行時には**「dsVariant 未指定」と等価**。

**修正案**: `dsVariant` プロパティを削除する。

```tsx
function sectionTitle(label: string) {
  return ui.button({
    id: `section-${label}`,
    label: `─ ${label} ${HR_FILL}`,
    px: 0,
    style: { dim: true },
    focusable: false,
  });
}
```

**根拠**: `"unstyled"` は runtime で undefined と同義のため、プロパティ削除でランタイム挙動は完全に不変。

---

### 4. dashboard.tsx:1000 — `dsVariant: "unstyled"`（Tasks タブボタン）

**現状のコード**（`skills/cmux-team/manager/dashboard.tsx:996-1004`）:

```tsx
ui.button({
  id: "section-tasks",
  label: `─ Tasks ${daemon.openTasks} open ${HR_FILL}`,
  px: 0,
  dsVariant: "unstyled",
  style: { dim: true },
  focusable: false,
  onPress: () => { ... },
}),
```

**修正案**: 同様に `dsVariant: "unstyled"` 行を削除。

**根拠**: 3 と同一の理由。

---

### 5. main.test.ts:84 — regex match の `m[1]` が `string | undefined`

**現状のコード**（`skills/cmux-team/manager/main.test.ts:79-85`）:

```ts
function extractHookScript(settings: any): string {
  const cmd: string = settings.hooks.PreToolUse[0].hooks[0].command;
  const m = cmd.match(/^bash -c '([\s\S]*)'$/);
  if (!m) throw new Error(`unexpected hook command format: ${cmd}`);
  return m[1];
}
```

**原因**: TS 4.x 以降、RegExp キャプチャグループは `string | undefined`。関数シグネチャは `: string`。

**修正案**: `m[1]!` で non-null 断言（直前の `if (!m)` ガード後、capture group 1 は必ず存在する）。

```ts
  return m[1]!;
```

**根拠**: 型注釈のみ（TS コンパイラへの表明）。実行時挙動不変。

---

### 6. main.ts:515 — `state.workspace` が `string | null`

**現状のコード**（`skills/cmux-team/manager/main.ts:513-515`）:

```ts
const folderName = basename(PROJECT_ROOT);
await cmux.renameWorkspace(folderName, state.workspace);
```

**原因**: `state.workspace` は `string | null`、`cmux.renameWorkspace(title: string, workspace?: string)` は `string | undefined` を期待。

**修正案**: `?? undefined` で変換。

```ts
await cmux.renameWorkspace(folderName, state.workspace ?? undefined);
```

**根拠**: null → undefined への単純変換。`renameWorkspace` 内部の optional 処理は undefined 前提なので、挙動は null 渡しと等価（ただし型的に正しくなる）。

## 検証手順

1. `cd skills/cmux-team/manager && bun install`（@types/update-notifier 導入）
2. `cd skills/cmux-team/manager && bunx tsc --noEmit` → エラー 0 件を確認
3. `cd skills/cmux-team/manager && bun test` → 211 pass 以上を確認
4. `git diff` で変更が上記 6 箇所 + package.json + bun.lock のみであることを確認

## リスク

- **低**: すべて型注釈レベルの修正。実行時挙動は不変。
- `cmux.ts:22` の `.toString()` は runtime で string に対して呼ぶため no-op だが、万一 Bun の execa が将来的に Buffer を返す実装変更をした場合にも安全側に倒れる。
- `@types/update-notifier` のバージョン差（`^6.0.8`）が `update-notifier@7` と僅かに乖離する可能性があるが、DefinitelyTyped は v7 対応済み（major 6 系が v7 に対応）。不整合あれば `bun install` 時点で判明する。
- `dsVariant: "unstyled"` 削除は「明示的意図の消失」にも見えるが、runtime で undefined と同義であることを確認済み。必要ならコメントで「sectionTitle は装飾なしのラベル用途」と補足可能（必須ではない）。
