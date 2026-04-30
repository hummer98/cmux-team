# Summary — T394: TUI Full Quit 回帰修正 (shift+R/G/Q → ctrl+R/G/Q)

## 結果

**完了 (Inspector 判定: GO)**

## 変更内容

`skills/cmux-team/manager/dashboard.tsx` のキーバインドとヘルプ表記、`CHANGELOG.md` の Unreleased セクション。+12 / -8 行、2 ファイル。

### キーバインド本体（trie 登録キー）

| line | before | after |
|---|---|---|
| 1745 | `"shift+r"` | `"ctrl+r"` (issues sync) |
| 1846 | `"shift+g"` | `"ctrl+g"` (journal/log/metrics 末尾へ) |
| 1881 | `"shift+q"` | `"ctrl+q"` (full quit 確認) |

### ヘルプ表記（`ui.kbd(...)`）

| line | tab | before | after |
|---|---|---|---|
| 1548 | journal | `g/G` | `g/Ctrl+G` |
| 1556 | log | `g/G` | `g/Ctrl+G` |
| 1584 | issues | `R` | `Ctrl+R` |
| 1592 | metrics | `g/G` | `g/Ctrl+G` |
| 1609 | global | `Q` | `Ctrl+Q` |

## なぜ ctrl+ にしたか

`shift+letter` は kitty keyboard protocol / CSI-u 非対応の端末（macOS Terminal.app, 既定設定の iTerm2 など）で text event の codepoint としてしか届かず、`shift` modifier が trie マッチしないため発火しなかった。`ctrl+letter` は制御バイト（0x12 / 0x07 / 0x11）として全端末で確実に届き、`@rezi-ui/core` の `codepointToCtrlKeyCode` で `key=letter, mods=ctrl` に合成されるため確実にマッチする。小文字単独ハンドラ（`g`/`r`/`q`）は trie キーが `codepoint:0` なので `codepoint:ZR_MOD_CTRL` の Ctrl+ 版と衝突しない。

## 検証

- `bun run tsc --noEmit`: exit=0
- `dashboard-{conductor,issues,metrics,pool}.test.tsx`: 49 pass / 0 fail / 107 expects
- 取りこぼし grep: dashboard.tsx 内に `shift+(r|g|q)` 残存なし、README/docs/spec に旧表記なし

`bun test` 全体実行は CLAUDE.md の禁忌指示通り未実行。

## 残課題（実機検証が必要）

plan.md「4. 検証手順」の手動検証は実機でしか実行できない:

1. macOS Terminal.app / iTerm2（または kitty）の 2 端末以上で `cmux-team start`
2. Ctrl+G / Ctrl+R / Ctrl+Q がそれぞれ正しく発火
3. 小文字 g / r / q が変更前と同じく動作
4. Ctrl+G で BEL 音が鳴らない（plan 3-A）
5. Ctrl+Q が flow control に消費されない（plan 3-B、raw mode 下で問題ない見込みだが実機確認必須）
6. ヘルプ表記（`g/Ctrl+G` 等）が狭幅 cmux pane で折り返さないか

raw mode 下では line discipline がバイパスされるため構造的に問題ないと予想されるが、リリース前に最低 2 端末で確認すること。

## 関連

- 元コミット: `4070df3` (T376) — `R/G/Q` → `shift+letter` 変更で trie 後勝ち上書き問題を修正したが、CSI-u 非対応端末で発火しない回帰を生んだ
- 本タスク: ctrl+letter ベースに切り替えて構造的に解決
- マージ後: 次回リリースの CHANGELOG に反映済み（Unreleased セクション）
