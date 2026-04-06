# 実装計画: GitHub issue 番号の OSC 8 ハイパーリンク化

## 1. 現状分析

### 既存コード（コミット 1f94843）

`dashboard.tsx` には以下の仕組みが実装済み:

- **`resolveGitHubRepoUrl(projectRoot)`** (L29-69): git remote URL から GitHub リポジトリ URL を解決。SSH/HTTPS 両対応。結果はキャッシュされる。
- **`buildTitleWithLinks(text, repoUrl, baseStyle?)`** (L71-106): テキスト中の `#(\d+)` パターンを検出し、`ui.link({ url, label, style })` で GitHub issue リンクを生成。周囲のテキストと `ui.row({ gap: 0 })` で結合。

使用箇所:
- Conductor セクション (L365, L384): タスクタイトル表示
- Tasks セクション (L480, L490): タスク一覧
- Journal セクション (L507): ジャーナルエントリ

### rezi-ui の ui.link() パイプライン

調査により、以下のレンダリングパイプラインを確認:

1. **`ui.link({ url, label, style })`** — `LinkProps` 型のウィジェットを生成
   - `url`: ハイパーリンク先URL
   - `label`: 表示テキスト（未指定時はURLをそのまま表示）
   - `style`: テキストスタイル（`TextStyle` 型）

2. **`renderTextWidgets.js` (L868-886)** — リンクウィジェットのレンダリング:
   ```
   builder.setLink(url, id)    // OSC 8 開始
   builder.drawText(...)       // テキスト描画
   builder.setLink(null)       // OSC 8 終了
   ```

3. **drawlist builder (`builder.js`)** — `setLink()` で URI を参照番号（`linkUriRef`）としてバイナリ drawlist に格納

4. **native engine (`rezi_ui_native.darwin-arm64.node`)** — Rust コンパイル済みバイナリ。drawlist を処理し、`supportsHyperlinks === true` の場合に OSC 8 エスケープシーケンスを出力

### ターミナル検出（`terminalProfile.js`）

rezi-ui の node backend は環境変数からターミナル種別を自動検出:

```javascript
// L46-48
const isGhostty = envText(env, "GHOSTTY_RESOURCES_DIR") !== undefined ||
    termProgram === "ghostty" ||
    term.includes("ghostty");

// L87
const supportsHyperlinks = osc8Override ?? 
    (isKitty || isWezTerm || isGhostty || isIterm2 || isWindowsTerminal || isXterm);
```

- cmux は Ghostty ベースなので `GHOSTTY_RESOURCES_DIR` が設定されていれば自動検出される
- `REZI_TERMINAL_SUPPORTS_OSC8` 環境変数で明示的にオーバーライド可能

### ダッシュボード初期化

```typescript
// dashboard.tsx L682-703
const app = createNodeApp<AppState>({
    initialState: { ... },
    config: { executionMode: "inline" },
});
```

inline バックエンド (`nodeBackendInline.js` L644) で `supportsHyperlinks` をネイティブエンジンに渡している。

## 2. 問題の特定

### 確定している事実

- rezi-ui は OSC 8 サポートの完全なパイプラインを持っている（drawlist → native → terminal）
- Ghostty ターミナルは OSC 8 対応済み
- ダッシュボードの daemon プロセスは `stdio: "inherit"` で起動されるため、ターミナル環境変数は伝播される

### 不確定な事項（検証が必要）

1. **ネイティブエンジンが実際に OSC 8 を出力しているか**: Rust バイナリの内部実装は確認不可。drawlist に `linkUriRef` が正しく記録されていても、ネイティブエンジンが OSC 8 シーケンスを生成していない可能性がある。

2. **`GHOSTTY_RESOURCES_DIR` が daemon プロセスに伝播しているか**: cmux がペインを作成する際に環境変数がどう継承されるかは実測が必要。cmux の daemon ペインは `cmux new-session` → `cmux send "cmux-team start"` で起動されるため、シェルの環境変数は通常継承される。

3. **ui.link() の layout 制約**: `ui.link()` はフォーカス可能なインタラクティブウィジェット。`ui.row({ gap: 0 })` 内に `ui.text()` と混在させた場合、レイアウトエンジンが正しく幅を計算しているか。

### 最も可能性の高い問題パターン

**パターン A: ネイティブエンジンが OSC 8 を出力している → 正常動作**
- この場合は既存実装で問題なし。cmd+click で開けるはず。
- 検証: ダッシュボードを起動し、issue 番号を含むタスクを表示して cmd+click をテスト

**パターン B: 環境変数の伝播問題で `supportsHyperlinks = false`**
- daemon が cmux ペイン内で起動される際に `GHOSTTY_RESOURCES_DIR` が失われる
- 検証: daemon 起動時に `process.env.GHOSTTY_RESOURCES_DIR` をログ出力

**パターン C: ネイティブエンジンが OSC 8 を生成しない / 正しく生成しない**
- rezi-ui のバージョンの問題、またはネイティブエンジンのバグ
- 検証: シンプルな rezi-ui アプリで `ui.link()` が OSC 8 を出力するかテスト

## 3. 修正方針

### フェーズ 1: 診断（コード変更なし）

実装に入る前に以下を検証:

1. **環境変数チェック**: daemon 起動時に以下をログ出力
   ```typescript
   log("terminal_env", 
     `GHOSTTY_RESOURCES_DIR=${process.env.GHOSTTY_RESOURCES_DIR ?? "unset"} ` +
     `TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "unset"} ` +
     `TERM=${process.env.TERM ?? "unset"}`);
   ```

2. **capabilities チェック**: `createNodeApp` 後に `app.getCaps()` 等で `supportsHyperlinks` の値を確認（API があれば）

3. **OSC 8 出力の実測**: ダッシュボードの stdout をファイルにリダイレクトし、OSC 8 シーケンス（`\x1b]8;;`）の有無を `hexdump` で確認

### フェーズ 2A: ui.link() が正常動作する場合

既存実装で十分。以下の改善のみ:

- `ui.link()` の `focusable: false` を明示的に設定（ダッシュボード内のリンクはフォーカス不要）
- テスト確認し、ドキュメント更新

### フェーズ 2B: ui.link() が OSC 8 を出力しない場合

#### 方針 B1: `REZI_TERMINAL_SUPPORTS_OSC8=1` 環境変数を設定

環境変数の伝播が問題の場合、daemon 起動時に明示的に設定:

```typescript
// main.ts の daemon 起動前
process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1";
```

#### 方針 B2: ui.text() で直接 OSC 8 シーケンスを埋め込む

rezi-ui の `ui.text()` にエスケープシーケンスを直接含める:

```typescript
const osc8Start = `\x1b]8;;${url}\x1b\\`;
const osc8End = `\x1b]8;;\x1b\\`;
parts.push(ui.text(`${osc8Start}#${issueNum}${osc8End}`, baseStyle ?? {}));
```

**リスク**: rezi-ui の drawlist builder がテキスト内のエスケープシーケンスをストリップする可能性が高い。TUI フレームワークはセル単位で描画を管理するため、生のエスケープシーケンスが正しく通過するかは不明。

#### 方針 B3: rezi-ui のバージョンアップ

現在のバージョンで OSC 8 が未実装の場合、rezi-ui の最新版にアップデート。`supportsHyperlinks` のインフラが存在するため、実装が進んでいる可能性がある。

#### 方針 B4: drawlist builder の setLink() を直接使う（高度）

`ui.link()` ウィジェットの代わりに、rezi-ui のカスタム描画 API（`ui.canvas()` 等）で drawlist builder を直接操作し、`setLink()` を呼ぶ。

**リスク**: 内部 API への依存度が高く、アップデート耐性が低い。

### 推奨フロー

```
診断（フェーズ1）
    ├── OSC 8 出力あり → フェーズ2A（minor fix + 完了）
    └── OSC 8 出力なし
         ├── 環境変数問題 → 方針 B1（最も簡単）
         ├── rezi-ui の実装問題 → 方針 B3（バージョンアップ）
         └── 根本的に未サポート → 方針 B2 or B4（ワークアラウンド）
```

## 4. 変更対象ファイルと変更箇所

### 診断フェーズ

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | daemon 起動時にターミナル環境変数をログ出力（一時的） |
| `skills/cmux-team/manager/dashboard.tsx` | `createNodeApp` 後に capabilities をログ出力（一時的） |

### 修正フェーズ（パターンにより異なる）

| ファイル | フェーズ2A | フェーズ2B-B1 | フェーズ2B-B2 |
|---------|-----------|-------------|-------------|
| `dashboard.tsx` L90-94 | `focusable: false` 追加 | 同左 | `buildTitleWithLinks` を OSC 8 直書きに変更 |
| `main.ts` | — | `REZI_TERMINAL_SUPPORTS_OSC8` 設定 | — |
| `manager/package.json` | — | — | — (B3 の場合はバージョン更新) |

### buildTitleWithLinks の変更例（方針 B1/B2A 想定）

```typescript
// 現在（L88-95）
parts.push(ui.link({
    url: `${repoUrl}/issues/${issueNum}`,
    label: `#${issueNum}`,
    style: { fg: rgb(100, 149, 237) },
}));

// 改善案（focusable: false 追加）
parts.push(ui.link({
    url: `${repoUrl}/issues/${issueNum}`,
    label: `#${issueNum}`,
    style: { fg: rgb(100, 149, 237) },
    focusable: false,
}));
```

## 5. テスト方法

### 基本テスト

1. cmux-team を起動: `cmux-team start`
2. GitHub issue 番号を含むタスクを作成:
   ```bash
   cmux-team create-task --title "Fix #93 dashboard links" --status ready --body "test"
   ```
3. ダッシュボードの Tasks セクション / Journal で `#93` が青色下線で表示されることを確認
4. `#93` を cmd+click して `https://github.com/hummer98/cmux-team/issues/93` がブラウザで開くことを確認

### 環境変数テスト

```bash
# Ghostty 環境変数が伝播しているか確認
cmux-team start
grep "terminal_env" .team/logs/manager.log
# → GHOSTTY_RESOURCES_DIR が設定されていることを確認
```

### OSC 8 出力の直接確認

```bash
# ダッシュボード出力をキャプチャして OSC 8 シーケンスを検索
# （rezi-ui はフルスクリーンアプリなので直接リダイレクトは難しいが、
# script コマンドや cmux read-screen で確認可能）
cmux read-screen --surface <manager-surface> | hexdump -C | grep "1b 5d 38"
```

### rezi-ui 単体テスト

```typescript
// test-link.ts — シンプルな rezi-ui アプリで ui.link() の動作確認
import { ui } from "@rezi-ui/core";
import { createNodeApp } from "@rezi-ui/node";

const app = createNodeApp({
    initialState: {},
    config: { executionMode: "inline" },
});

app.render(() => ui.link({
    url: "https://github.com/hummer98/cmux-team/issues/1",
    label: "#1 test link",
}));

app.start();
```

## 6. まとめ

### 現状の評価

rezi-ui の `ui.link()` は OSC 8 をサポートするための完全なインフラ（drawlist → native engine → terminal output）を備えている。Ghostty ターミナルの自動検出も実装済み。既存の `buildTitleWithLinks()` の実装ロジック自体は正しい。

### 最小の変更で解決する可能性が高い

1. **環境変数の伝播確認** → 伝播していれば問題なし（`REZI_TERMINAL_SUPPORTS_OSC8=1` で強制もできる）
2. **`focusable: false` の追加** → レイアウト・フォーカス問題の回避
3. **rezi-ui のバージョン確認** → 最新版で OSC 8 出力が改善されている可能性

### リスク

- rezi-ui のネイティブエンジン（Rust バイナリ）の内部実装は確認不可能。OSC 8 出力が本当に実装されているかは実測でしか確認できない
- `ui.text()` への OSC 8 直書きは rezi-ui の描画パイプラインと干渉する可能性が高く、最終手段とすべき
