# T334 リリース作業 (v4.7.0 → v4.9.1)

## 結論

- **正式リリース: v4.9.1** （npm / GitHub Release / plugin marketplace すべて反映済み）
- **v4.9.0 は欠番**（タグ・GitHub Release・npm すべて未作成のまま skip）

## 経緯

### 1. 初期状態の特定

- 現バージョン: `4.8.0`（package.json / plugin.json / marketplace.json）
- 最新タグ: `v4.7.0`（`git describe`）
- v4.7.0..HEAD のコミット 32 件、うち feat 11 件 → minor bump 判定で **v4.9.0** に決定
- 注: `v4.8.0` タグは local/remote 両方に存在するが HEAD の祖先ではない別 SHA（過去 rebase の残骸）。npm には 4.8.0 publish 済み。今回は触らずそのまま温存

### 2. v4.9.0 リリース試行 → publish 段階で hang（中断）

| 時刻 (UTC) | イベント |
|---|---|
| 23:37:47 | `git push origin v4.9.0` で release.yml 起動 (run 24943364763) |
| 23:38頃 | "Install manager dependencies" まで完了 |
| 23:38頃〜00:09 | "Publish to npm (OIDC Trusted Publishing)" が **30 分以上 in_progress** |
| 00:09 | npm 側に 4.9.0 が無いことを確認、release.yml の中身を確認 |
| 00:11 | Master からの追加指示で原因が判明 |
| 00:12 | `gh run cancel 24943364763` 実行（cancel 確認済み） |

#### 原因（Master 側で特定済み・本セッションで再確認）

- `package.json` の `prepublishOnly = "cd skills/cmux-team/manager && bun test"` が GHA `Publish to npm` ステップで暗黙起動される
- A021（T327, 2026-04-25）に記録: **`bun test` 全体実行は同一プロセス内で O(N²) 級に劣化し 13 分経過しても 420 tests しか進まない**
- v4.8.0 → v4.9.0 でテストが 3,689 行追加され症状が深刻化、13 分タイムアウトすら超えて publish に到達不能

### 3. 方針判断

| 選択肢 | 判断 |
|---|---|
| v4.9.0 を打ち直して再 publish | ❌ — prepublishOnly が壊れている限り同じ罠を踏む |
| v4.9.0 タグを残して欠番化 | △ — 孤児タグが履歴に残り混乱要因 |
| **v4.9.0 タグを削除して v4.9.1 として再リリース** | ✅ **採用** — 履歴がクリーン、Master 推奨と整合 |
| prepublishOnly 修正を本タスク内で行う | ✅ **採用** — 直さないと v4.9.1 も同じ罠を踏む |
| CI test workflow 整備は別タスクに切り出す | ✅ — 設計判断を伴うため T334 のスコープ外、T336 として draft 起票 |

### 4. v4.9.1 リリース実行

| 操作 | 結果 |
|---|---|
| `git tag -d v4.9.0` + `git push origin :refs/tags/v4.9.0` | local + remote 両方から削除完了 |
| `package.json` から `prepublishOnly` 行を削除 | 完了 |
| 3 ファイルを `4.9.0` → `4.9.1` に bump | 完了 |
| CHANGELOG.md: `[4.9.0]` → `[4.9.1]` リネーム + skip notice 追記 | 完了 |
| `git commit -m "chore: release v4.9.1 (skip 4.9.0 — prepublishOnly hang)"` | 54496ec |
| `git push origin main` + `git push origin v4.9.1` | 完了 |
| GHA run 24944034670 | **completed/success（数十秒で完了）** |
| `npm view @hummer98/cmux-team@4.9.1 version` | `4.9.1` |
| `npm install -g @hummer98/cmux-team` | 4.9.1 ローカル反映、`cmux-team --version` で確認 |
| GitHub Release v4.9.1 | 作成済み |
| plugin marketplace pull + uninstall + install | 4.9.1 キャッシュ確認済み、4.8.0 / 4.9.0 キャッシュ削除 |

### 5. 本リリースの中身 (v4.8.0 → v4.9.1)

CHANGELOG `[4.9.1]` 参照。主要項目のみ:

- **Added**: Global token pool 機能（T318/T319/T320/T321/T322/T323/T325, A019）, opencode Agent 統合 (Issue #37), `cmux-team delete-task --force` (T333), `/cmux-team:help` `/cmux-team:retro` コマンド
- **Changed**: CLAUDE.md state tracking チェックリスト追加 (PR #40), bun.lock 追跡開始, Conductor Step 6.5 厳格化
- **Fixed**: SESSION_ENDED race (T302), dashboard focus 周辺修正
- **Fixed (release pipeline)**: prepublishOnly = bun test 全体実行を削除（本タスク T334 内で実施）

## 残課題

- **T336（draft）**: CI test workflow を整備して prepublishOnly 削除の埋め合わせをする。本リリース後にテスト実施ポイントが消えたままなので早めに進めるのが望ましい
- **A021 の root cause（bun test 全体実行 O(N²) 劣化）の根治**: 別タスク。`eventBus.ts` の EventEmitter / `bun:sqlite` Database ハンドルの module-level singleton 蓄積疑いだが未確定
- **v4.8.0 タグの SHA 不一致（HEAD 系列と別）**: 既知の履歴汚れ、リリース動作に影響無いので放置

## 納品

| 項目 | 値 |
|---|---|
| マージ先ブランチ | `main` |
| 納品方式 | ローカルマージ（直接 main に commit + tag push） |
| マージ SHA | `54496ec` (`chore: release v4.9.1`) |
| タグ | `v4.9.1` |
| npm | `@hummer98/cmux-team@4.9.1` |
| GitHub Release | `v4.9.1` |
| plugin marketplace cache | `~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/4.9.1/` のみ |
| 後続タスク | T336 (draft) — CI test workflow 整備 |
