# Plan: TUI の Enter キーで mo + cmux browser open による Markdown 表示

## 変更対象

- `skills/cmux-team/manager/dashboard.tsx`（1ファイルのみ）

## 変更概要

`openArtifactInViewer` 関数（L746-783）を書き換え、TUI を停止せずに `mo` + `cmux browser open` で Markdown を表示する。

## 現状の問題

- `openArtifactInViewer` は `app.stop()` → ビューア実行 → `app.start()` で TUI を一時停止している
- `mo` はサーバー起動後すぐプロセスが返るため、TUI が一瞬ちらつくだけで実用にならない

## 修正内容

### 1. `openArtifactInViewer` の書き換え

**Before:**
- 引数: `app`, `filePath`, `onResumed`
- TUI 停止 → ビューア実行（await） → TUI 再開

**After:**
- 引数: `filePath` のみ（`app` と `onResumed` は不要）
- TUI を停止しない（`dashboardActive = false`、`app.stop()`、`app.start()` を削除）
- `mo` をバックグラウンドで実行（`Bun.spawn(["mo", filePath])`、await しない）
- 500ms 程度待ってから `cmux browser open http://localhost:6275` を実行
- `mo` が見つからない場合は `cat` フォールバック（従来通り `app.stop()` → `cat` → `app.start()` の TTY 引き継ぎ方式）

**新しい関数シグネチャ:**
```typescript
async function openArtifactInViewer(
  app: NodeApp<AppState>,
  filePath: string,
  onResumed: () => void,
): Promise<void>
```

注: `app` と `onResumed` はシグネチャを維持する（`cat` フォールバック時に必要）。`mo` パスの場合のみ TUI 停止をスキップする。

### 2. 実装ロジック

```
1. resolveMarkdownViewer() で viewer を判定
2. if viewer === "mo":
   a. Bun.spawn(["mo", filePath]) — バックグラウンド実行（await しない、stdio は "ignore"）
   b. await Bun.sleep(500) — mo サーバー起動待ち
   c. Bun.spawn(["cmux", "browser", "open", "http://localhost:6275"]) — ブラウザ surface 作成
   d. return（TUI は停止しない）
3. else (cat フォールバック):
   a. 従来通り app.stop() → cat 実行 → app.start() → onResumed()
```

### 3. 呼び出し元の変更

呼び出し元（L1087-1097, L1106-1116）は変更不要。`onResumed` は `mo` パスでは呼ばれないが、`cat` フォールバック時には呼ばれるため、呼び出し元のコールバックはそのまま残す。

ただし、`mo` パスでは `dashboardActive` を false にしないため、`onResumed` で `dashboardActive = true` に戻す処理が空振りになるが、冪等なので問題ない。

### 4. 注意事項

- `mo` は既にサーバーが起動済みの場合、ファイルを追加するだけ（同一ポート 6275）
- `cmux browser open` は cmux コマンドのため、cmux 環境でなければ失敗する（ログのみで握りつぶしてよい）
- `mo` の stdio は "ignore" にする（TUI と干渉させない）
- `cmux browser open` の stdio も "ignore"

## 完了条件

- `bun run --cwd skills/cmux-team/manager check` が通ること（型チェック）
- TUI を停止せずにビューアが開けること（E2E は手動確認）
