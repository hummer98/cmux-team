# T158: mo ビューアで既存ブラウザを再利用する — 実装計画

## 概要

`dashboard.tsx` の `openArtifactInViewer` 関数を修正し、`cmux browser open` の前に既存ブラウザ surface を検出して再利用する。

## 変更対象

- `skills/cmux-team/manager/dashboard.tsx` の `openArtifactInViewer` 関数（747行目付近）

## 実装方針

### 現状（769行目）

```typescript
Bun.spawn(["cmux", "browser", "open", viewerUrl], { stdio: ["ignore", "ignore", "ignore"] });
```

毎回 `cmux browser open` で新しいブラウザ split を作成している。

### 変更後

`cmux browser open` の代わりに、以下のロジックを実装:

1. **既存ブラウザ surface の検出**:
   - `cmux tree --json --workspace <workspace>` を実行
   - JSON 出力をパースし、`type === "browser"` の surface を探す
   - workspace は `process.env.CMUX_WORKSPACE_ID` または caller の workspace を使用（dashboard.tsx では環境変数を使う）

2. **分岐**:
   - **既存ブラウザあり** → `cmux browser <surface_ref> goto <viewerUrl>` で URL を変更
   - **既存ブラウザなし** → 従来通り `cmux browser open <viewerUrl>` で新規作成

### 具体的なコード変更

`openArtifactInViewer` 関数の mo ブランチ内（現在の769行目付近）を以下に置換:

```typescript
// 既存ブラウザ surface を検出して再利用
const browserSurface = await findExistingBrowserSurface();
if (browserSurface) {
  Bun.spawn(["cmux", "browser", browserSurface, "goto", viewerUrl], { stdio: ["ignore", "ignore", "ignore"] });
} else {
  Bun.spawn(["cmux", "browser", "open", viewerUrl], { stdio: ["ignore", "ignore", "ignore"] });
}
```

`findExistingBrowserSurface` ヘルパー関数を追加:

```typescript
async function findExistingBrowserSurface(): Promise<string | null> {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  const args = ["cmux", "tree", "--json"];
  if (workspace) args.push("--workspace", workspace);
  
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  
  try {
    const tree = JSON.parse(output);
    for (const w of tree.windows ?? []) {
      for (const ws of w.workspaces ?? []) {
        for (const p of ws.panes ?? []) {
          for (const s of p.surfaces ?? []) {
            if (s.type === "browser") return s.ref;
          }
        }
      }
    }
  } catch {}
  return null;
}
```

## 完了条件

1. TUI で artifact を開くとき、既存ブラウザがあれば `goto` で URL 変更する
2. 既存ブラウザがなければ従来通り `browser open` で新規作成する
3. TypeScript の型エラーがないこと（`bun build` 通過）
