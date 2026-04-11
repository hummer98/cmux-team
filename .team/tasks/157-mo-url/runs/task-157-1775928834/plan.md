# 実装計画: mo ビューアでファイル指定URLを使い直接フォーカスする

## 概要

TUI の Tasks パネルで Enter を押して mo で Markdown を開くと、ファイルリストの一番上が表示されてしまう問題を修正する。
`mo file.md --json` の出力からファイル固有 URL を取得し、`cmux browser open` に渡す。

## 修正対象

- `skills/cmux-team/manager/dashboard.tsx` の `openArtifactInViewer` 関数（754-759行付近）

## 修正内容

### 現状のコード（754-759行）

```typescript
if (viewer === "mo") {
  Bun.spawn(["mo", filePath], { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(500);
  Bun.spawn(["cmux", "browser", "open", "http://localhost:6275"], { stdio: ["ignore", "ignore", "ignore"] });
  return;
}
```

### 修正後のコード

```typescript
if (viewer === "mo") {
  // mo をバックグラウンドで起動し、--json で URL を取得
  const moProc = Bun.spawn(["mo", filePath, "--json"], { stdout: "pipe", stderr: "ignore" });
  const moOutput = await new Response(moProc.stdout).text();
  await moProc.exited;

  // JSON から file-specific URL を取得（フォールバック付き）
  let viewerUrl = "http://localhost:6275";
  try {
    const parsed = JSON.parse(moOutput);
    if (parsed.files?.[0]?.url) {
      viewerUrl = parsed.files[0].url;
    }
  } catch {}

  Bun.spawn(["cmux", "browser", "open", viewerUrl], { stdio: ["ignore", "ignore", "ignore"] });
  return;
}
```

### 変更のポイント

1. `Bun.spawn(["mo", filePath])` → `Bun.spawn(["mo", filePath, "--json"], { stdout: "pipe" })` で stdout をキャプチャ
2. `mo --json` の stdout をパースして `files[0].url` を取得
3. URL 取得成功時: ファイル固有 URL（`http://localhost:6275/?file=<id>`）を使用
4. JSON パース失敗時: フォールバックとして `http://localhost:6275` を使用
5. `await Bun.sleep(500)` は不要になる（`mo --json` の完了を `await moProc.exited` で待つため）

## テスト方針

- 自動テストなし（E2E で動作確認が必要な箇所）
- コードの型チェック: `bun build --dry-run` または TypeScript の型チェック
- フォールバックパスも網羅されていることをコードレビューで確認

## リスク

- 低リスク: 単一関数の修正、フォールバック付き
- `mo --json` の出力フォーマットが変わった場合もフォールバックで既存動作を維持
