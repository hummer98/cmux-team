# Inspection — T394: shift+R/G/Q → ctrl+R/G/Q

検品対象: `task-394-1777548979/task` ブランチ（base = `main`、commit `153a885` からの未コミット差分）。

## 観点チェック表

| # | 観点 | 結果 | メモ |
|---|---|---|---|
| 1 | 変更の網羅性（plan.md「1. 変更対象」と一致） | pass | dashboard.tsx の 8 箇所（key 3 + help 5）+ CHANGELOG.md の Unreleased 追記、いずれも plan と一致 |
| 2 | 取りこぼし検証（`shift+(r|g|q)` / `Shift+(R|G|Q)` 残存） | pass | dashboard.tsx 内に `shift+(r|g|q)` の grep ヒット無し。`Shift+(R|G|Q)` の hit は CHANGELOG の説明文と過去履歴 (line 1063) のみで、コード非該当 |
| 3 | 検証実行（tsc + dashboard 関連テスト） | pass | `bun run tsc --noEmit` exit=0、4 テストファイル合計 49 pass / 0 fail |
| 4 | パーサ衝突チェック（小文字単独ハンドラとの並存） | pass | 小文字 `g` (1833) / `r` (1875) / `q` (1876) と Ctrl+ 版 (1745/1846/1881) が共に存在。`@rezi-ui/core` の trie で `codepoint:0` と `codepoint:ZR_MOD_CTRL` の別キー扱いになるため衝突しない |
| 5 | CHANGELOG エントリの整合性 | pass | `[Unreleased]` 直下に `### Changed` を新設し plan.md「5. CHANGELOG 記載案」と同一文言で追記。マークダウン構文に欠損なし |
| 6 | その他（無関係 diff・スコープ逸脱の有無） | pass | `git diff --stat` は CHANGELOG.md と dashboard.tsx の 2 ファイルのみ、+12 / -8 行。末尾空白や無関係改行などのノイズなし |

## 詳細

### 観点 1: 変更の網羅性

`git diff` で確認した変更箇所（plan.md の line 表記と一致）:

- キーバインド本体（trie 登録キー）
  - line 1745: `"shift+r"` → `"ctrl+r"`
  - line 1846: `"shift+g"` → `"ctrl+g"`
  - line 1881: `"shift+q"` → `"ctrl+q"`
- ヘルプ表記（`ui.kbd(...)`）
  - line 1548 (journal): `g/G` → `g/Ctrl+G`
  - line 1556 (log): `g/G` → `g/Ctrl+G`
  - line 1584 (issues): `R` → `Ctrl+R`
  - line 1592 (metrics): `g/G` → `g/Ctrl+G`
  - line 1609 (global): `Q` → `Ctrl+Q`
- CHANGELOG.md: `[Unreleased]` セクションに `### Changed` 追加 + plan の文言

### 観点 2: 取りこぼし検証

実行した grep:

```bash
grep -nE 'shift\+(r|g|q)' skills/cmux-team/manager/dashboard.tsx
# → NO MATCH

grep -rnE 'Shift\+(R|G|Q)' skills/cmux-team/manager/ README.md README.ja.md docs/spec/ CHANGELOG.md
# → CHANGELOG.md:7 (今回の変更前説明文・OK)
# → CHANGELOG.md:1063 (4.x 系の過去リリースノート・OK)
```

ソースコード内に旧キー名が残存していないことを確認。

### 観点 3: 検証実行

- `bun run tsc --noEmit` → exit=0（型エラーなし）
- `bun test --timeout 30000` 結果（plan.md「2-A」指定の 4 ファイル）

| ファイル | pass | fail | expect |
|---|---|---|---|
| dashboard-conductor.test.tsx | 6 | 0 | 17 |
| dashboard-issues.test.tsx | 11 | 0 | 27 |
| dashboard-metrics.test.tsx | 30 | 0 | 52 |
| dashboard-pool.test.tsx | 2 | 0 | 11 |
| **合計** | **49** | **0** | **107** |

CLAUDE.md の指示通り `bun test` 全体実行は禁忌のため未実行。impl-notes.md の検証結果と完全一致。

### 観点 4: パーサ衝突チェック

dashboard.tsx 内のハンドラ登録:

```text
1745:    "ctrl+r": (ctx) => { ...                    // issues sync
1833:    g: () => app.update((s) => { ...            // 先頭へ
1846:    "ctrl+g": () => app.update((s) => { ...     // 末尾へ
1875:    r: (ctx) => { if (focusedArea === "global") ... // daemon reload
1876:    q: (ctx) => { ...                            // quit
1881:    "ctrl+q": (ctx) => { ...                    // full quit confirmation
```

小文字単独キーと Ctrl+ 版が両方独立に登録されており、trie 上は別 codepoint として扱われるため衝突しない。

### 観点 5: CHANGELOG 整合性

`CHANGELOG.md` 冒頭:

```markdown
## [Unreleased]

### Changed

- **dashboard のキーバインド `Shift+R` / `Shift+G` / `Shift+Q` を `Ctrl+R` / `Ctrl+G` / `Ctrl+Q` に変更（T394）**。 ...
```

plan.md「5. CHANGELOG 記載案」の文言と一致。配置・マークダウン構文に問題なし。

### 観点 6: その他

```text
$ git diff --stat
 CHANGELOG.md                           |  4 ++++
 skills/cmux-team/manager/dashboard.tsx | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

変更は 2 ファイルのみ、plan.md の対象範囲と完全一致。スコープ逸脱なし。

## 残課題（GO 後の手動検証 — 実装フェーズ外）

plan.md「4. 検証手順」の手動検証は実機が必要なため Inspector では検証できない。Conductor / レビュアーが以下を確認すること:

1. macOS Terminal.app と iTerm2（または kitty）の 2 端末以上で `cmux-team start` 起動
2. Ctrl+G（journal/log/metrics で末尾ジャンプ）/ Ctrl+R（issues sync）/ Ctrl+Q（full quit 確認ダイアログ）が発火
3. 小文字 g / r / q が変更前と同じく動作
4. ヘルプ表記（`g/Ctrl+G` 等）が狭幅 cmux pane で折り返さないか
5. Ctrl+G で BEL 音が鳴らないこと（plan 3-A）/ Ctrl+Q が flow control に消費されないこと（plan 3-B）

これらは構造的に raw mode 下で問題ないと予想されるが、実機の最終確認は必須。

---

**判定: GO**
