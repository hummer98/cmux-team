# T439 実装ノート

## 採用した DI 設計

### `KeymapDeps` の拡張 (3 件追加)

`skills/cmux-team/manager/dashboard-keymap.ts` の `KeymapDeps` に以下を追加:

```ts
handleCopyChord: (ctx: KeyContext<AppState>) => void;
cancelChord: (ctx: KeyContext<AppState>) => void;
schedule: (ms: number, cb: () => void) => () => void;
```

- `handleCopyChord` / `cancelChord` は dashboard.tsx の closure scope に実装し、ctx 経由で呼び出す
- `schedule` は `setTimeout` をラップして cancel 関数を返す。テストでは fake schedule に差し替え可能

### `withChordCancellation` 純粋関数 (C1 採用)

```ts
export function withChordCancellation<H extends BindingHandler>(
  handler: H, binding: BindingSpec, deps: Pick<KeymapDeps, "cancelChord">,
): H { ... }
```

- 全 binding の handler を `createDashboardBindings` の return で wrap
- copy chord 自身 (`COPY_CHORD_BINDING_ID = "artifacts.copy-path"`) は noop（pending を進めるロジックは handler 内）
- それ以外で `cChordPending != null` → `cancelChord` を呼んでから handler 実行
- 文字列リテラル一致のミス防止のため `COPY_CHORD_BINDING_ID` 定数を export（design-review m_new1 反映）

### `resolveMarkdownViewer(which?)` の DI 化

```ts
export async function resolveMarkdownViewer(
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): Promise<string>
```

- デフォルトは `Bun.which` 直接呼び出し。テストは stub を渡して deterministic 化
- `mado` 検出時は `"mado"`、未検出時は `"cat"` (env override が最優先)

## テスト方針

### 純粋関数を抽出してテスト容易にする (plan §5.3)

`dashboard.tsx` から以下の reducer を export:
- `reduceCKeyPress(state, now)` — 1 回目 / 2 回目を `firstPress` flag で区別
- `reduceClearChord(state)` — idempotent (pending null なら同一参照)
- `reduceShowToast(state, kind, message, now, durationMs?)`
- `reduceClearToast(state)` — idempotent
- `formatToastMessage(toast, columns)` — 末尾優先 truncate（`max(8, cols - prefixLen)`）

closure 側 `handleCopyChord` / `showToast` / `cancelChord` はこれらを `app.update` 経由で呼ぶ薄い wrapper。

### テストファイル構成

| ファイル | テスト数 |
|---|---|
| `dashboard-mado-viewer.test.ts` (新規) | 4 |
| `dashboard-toast.test.ts` (新規) | 12 |
| `dashboard-chord.test.ts` (新規) | 12 |
| `dashboard-keys.test.tsx` (拡張) | +4 (合計 19) |
| `dashboard-keymap.test.ts` (fixture 更新のみ) | 18 (変化なし) |
| `dashboard-issues.test.tsx` (fixture 更新のみ) | 11 (変化なし) |

合計 76 test passed (新規 28 + 既存 48)。

### fake schedule ハーネス（toast lifecycle）

`bun:test` には `vi.useFakeTimers` 相当 API が無いので、`KeymapDeps.schedule` の DI に頼る。dashboard-toast.test.ts では `makeHarness()` 内で fake schedule を実装し、「showToast 後 cb 発火 → toast = null」「連続発火 → 前 timer cancel」を verify。

## 主要な決定とその根拠

| 項目 | 採用 | 理由 |
|---|---|---|
| chord state 保持 | `AppState.cChordPending` (non-optional + null 許容) | rezi-ui chord trie は 1000ms ハードコードで観測不可 (D1) / equality 安定化 (m5) |
| chord cancellation 実装 | `withChordCancellation` 純粋関数で全 binding wrap | testability 確保 (D1 / C1) |
| timer DI | `schedule(ms, cb): () => void` 単一 IF | chord と toast を共通化 (D10 / D18) |
| mado 起動方式 | `Bun.spawn(["mado", path], { stdio: ignore }) → proc.unref()` | manager kill で道連れ閉鎖を回避 (D2 / M2) |
| `findExistingBrowserSurface` | 完全削除 | mado は GUI window で URL 不要 (D3 / §0.2 Master 照会) |
| toast 配置 | body column 末尾、footer 直上 | footer (statusBar) は専用 widget で行追加困難 (D6) |
| `cc` → `c-` 表示切替 | dashboard.tsx の status bar 描画で post-process strict equality 置換 | registry を汚さず描画層で吸収 (D8 / m_new4) |
| `copyArtifactPath` の DI 化 | 直書き (`Bun.spawn(["pbcopy"], { stdin: "pipe" })`) | 1 関数の I/O のみ。test は purelogic 抽出で代替し、副作用 spawn は手動確認で検証 (m_new6 直書き案) |

## TODO / 残課題

1. **closure scope timer の cleanup**: `chordTimerCancel` / `toastTimerCancel` は startDashboard closure 内にあり、top-level `cleanup()` から見えない。短命 timer (500ms / 2000ms) なので process exit 時の遅延は最大 2 秒。気になれば module-level `let` に昇格すべき
2. **`copyArtifactPath` の Linux 対応**: 現状 macOS の `pbcopy` 前提。Linux の `xclip` / `wl-copy` 対応は別タスク（CLAUDE.md "便利機能は best-effort" 方針）
3. **chord timeout の env override**: 現状 500ms ハードコード。テスト用に変えたいケースは出てくるかもしれない
4. **statusBarKey 後加工の strict equality**: 現状 `it.key === "cc"` で比較。registry に `statusBarKey: "cc"` を持つ binding が他に増えたら全部 `c-` 化される。ID ベースの判定に倒すなら別途 design

## 手動確認手順 (Conductor 後段で実施)

1. worktree で `cd skills/cmux-team/manager && bun main.ts start` (もしくは既存 daemon 再起動)
2. cmux dashboard を開く → `2` キーで Artifacts タブにフォーカス
3. `j` / `k` でカーソル移動して任意の artifact を選択
4. `c` を 1 回押下 → status bar 左端の `cc` が `c-` に切り替わる
5. 500ms 以内にもう一度 `c` 押下 → 緑 toast `✓ Copied: /Users/.../A0XX-*.md` が body 末尾に出現
6. `pbpaste` で絶対パスがコピーされていることを確認
7. 約 2 秒後 toast が自動消去される
8. `Enter` を押して mado が GUI window で起動することを確認 (TUI は維持)
9. `c` を 1 回押した後に `j` / `k` を押す → `c-` 表示が `cc` に戻る (C1 検証)
10. `c` を 1 回押した後にタブ切替 (e.g. `1`) → `cChordPending` がクリアされる (D17)
11. 別タブ (journal 等) で `c` を押しても何も起きないことを確認 (scope 違反)
12. `CMUX_TEAM_MD_VIEWER=cat` を export して再起動 → Enter で TUI が一時停止して cat 表示 → q で復帰
13. mado window を開いた状態で manager daemon を kill → mado window が生き残る (M2 検証)
14. `PATH=/tmp bun main.ts` で擬似的に pbcopy 不在状態を作る → `c c` で `✗ pbcopy not available` 失敗 toast (D19)

## 完了条件チェック

- [x] サブタスク 0 (binding 衝突再確認): `c` 単発 binding は無し
- [x] サブタスク 1-13 (実装): AppState 拡張 / i18n / mado 切替 / mo 削除 / toast レンダー / schedule DI / chord handler / binding 登録 / c- indicator
- [x] サブタスク 14 (既存テスト緑): dashboard-keymap (18) + dashboard-keys (19) + dashboard-issues (11)
- [x] サブタスク 15-17 (新規テスト緑): dashboard-toast (12) + dashboard-mado-viewer (4) + dashboard-chord (12)
- [x] `bunx tsc --noEmit` exit 0
- [x] `mo` 経路 / `findExistingBrowserSurface()` / `cmux browser` 連携の削除完了
- [x] サブタスク 19 (docs / README 更新): `docs/spec/01-skill-cmux-team.md` (Artifacts キー一覧 + CMUX_TEAM_MD_VIEWER 説明) / `docs/spec/05-install-and-infrastructure.md` (オプション依存ツール節)
- [ ] サブタスク 18 (手動確認): Conductor が後段で実施
