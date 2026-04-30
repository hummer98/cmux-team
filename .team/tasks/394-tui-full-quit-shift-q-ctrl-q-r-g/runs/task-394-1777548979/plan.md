# 実装計画: shift+R/G/Q → ctrl+R/G/Q

## 背景

T376 で trie 後勝ち上書き問題（`@rezi-ui/core` パーサーが大文字小文字を区別せず lowercase 化する）を `shift+letter` 構文で解消したが、kitty keyboard protocol / CSI-u 非対応の端末（標準 xterm 系・iTerm2 既定など）では `shift+R` などが text event の codepoint としてしか届かず、`shift` modifier 情報が落ちて trie マッチしないため発火しなかった。

`ctrl+letter` は制御バイト（`Ctrl+R`=0x12 / `Ctrl+G`=0x07 / `Ctrl+Q`=0x11）として全端末で確実に送られるため、modifier 情報を保たない端末でも `codepoint:ZR_MOD_CTRL` キーで trie マッチする。`letter`（`codepoint:0`）とは別キーなので小文字ハンドラとも衝突しない。

## 1. 変更対象（全ファイル全行）

### 1-A. キーバインド本体（`skills/cmux-team/manager/dashboard.tsx`）

| line | 修正前 | 修正後 |
|---|---|---|
| 1745 | `"shift+r": (ctx) => {` | `"ctrl+r": (ctx) => {` |
| 1846 | `"shift+g": () => app.update((s) => {` | `"ctrl+g": () => app.update((s) => {` |
| 1881 | `"shift+q": (ctx) => {` | `"ctrl+q": (ctx) => {` |

### 1-B. ヘルプ表示（`skills/cmux-team/manager/dashboard.tsx`）

`ui.kbd(...)` 文字列を Ctrl 表記に揃える。`g`（先頭へ）など小文字側は据え置き、大文字側のみ `Ctrl+X` 表記に変える。

| line | focus / tab | 修正前 | 修正後 |
|---|---|---|---|
| 1548 | journal | `ui.kbd("g/G"), ui.text("top/bottom")` | `ui.kbd("g/Ctrl+G"), ui.text("top/bottom")` |
| 1556 | log | `ui.kbd("g/G"), ui.text("top/bottom")` | `ui.kbd("g/Ctrl+G"), ui.text("top/bottom")` |
| 1584 | issues | `ui.kbd("R"), ui.text("sync")` | `ui.kbd("Ctrl+R"), ui.text("sync")` |
| 1592 | metrics | `ui.kbd("g/G"), ui.text("top/bottom")` | `ui.kbd("g/Ctrl+G"), ui.text("top/bottom")` |
| 1609 | global | `ui.kbd("Q"), ui.text("full quit")` | `ui.kbd("Ctrl+Q"), ui.text("full quit")` |

> 1607 の `ui.kbd("r")` (= 小文字 r、daemon reload) と 1608 の `ui.kbd("q")` (= 小文字 q、quit) は `r` / `q` 単独キーのハンドラ（line 1875 / 1876）に対応しており影響なし。

### 1-C. ドキュメント / リリースノート

| ファイル | line | 内容 |
|---|---|---|
| `README.md` / `README.ja.md` | — | 該当キーバインドを直接記述している箇所は grep ヒットなし。修正不要 |
| `docs/spec/` | — | 該当キーバインドを記述している箇所は grep ヒットなし（`docs/spec/01-skill-cmux-team.md:228` の `ctrl+c` は cmux 側の中断キー説明で本タスク対象外）。修正不要 |
| `CHANGELOG.md` | 先頭 Unreleased セクション | 後述の「5. CHANGELOG 記載案」を追記 |

### 1-D. テスト

| ファイル | 内容 |
|---|---|
| `dashboard-conductor.test.tsx` / `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx` / `dashboard-pool.test.tsx` | `shift+r` / `shift+g` / `shift+q` / `ctrl+r` / `ctrl+g` / `ctrl+q` の grep ヒットなし。直接の更新対象なし |

## 2. テスト方針

### 2-A. 既存テスト

dashboard 系テスト（`dashboard-*.test.tsx`）は当該キーバインドを直接検証していない。修正は不要だが、回帰確認のため一通り実行する：

```bash
cd skills/cmux-team/manager && for f in dashboard-conductor.test.tsx dashboard-issues.test.tsx dashboard-metrics.test.tsx dashboard-pool.test.tsx; do bun test --timeout 30000 "$f"; done
```

### 2-B. 新規テスト

シミュレートが難しい領域なので、**新規ユニットテストは追加しない**。理由：
- `@rezi-ui/core` の trie 登録キーが文字列定数なので、tsc 型チェックで誤入力は防げない
- 端末側の制御バイト送出は実機でしか再現できない
- 過剰なフォールバックは作らない方針（auto memory `feedback_best_effort_features.md`）

代わりに **手動検証の golden path / edge** を「4. 検証手順」で明示する。

## 3. リスク・確認事項

### 3-A. Ctrl+G (BEL = 0x07)

- BEL は伝統的に「出力時の端末アラート音」用。**入力として 0x07 が届いた場合、端末は通常ベルを鳴らさず、そのままアプリに渡す**。
- TUI モード（`@rezi-ui/core` が raw mode で stdin を読む）では端末側の line discipline を経由しないため、副作用なし。
- 念のため macOS Terminal.app / iTerm2 / kitty / Alacritty / WezTerm で Ctrl+G を押下してもアラート音が鳴らないこと、`ctrl+g` ハンドラが発火することを手動確認する。

### 3-B. Ctrl+Q (XOFF = 0x11) / Ctrl+S (XON = 0x13)

- **要確認の最重要リスク**。tty の `ixon` フラグが有効な状態で stdin が cooked mode なら、Ctrl+Q は flow control として消費されアプリに届かない。
- `@rezi-ui/core` が `process.stdin.setRawMode(true)` を呼んでいれば line discipline がバイパスされ、`ixon` の影響を受けず Ctrl+Q が生バイトで届く。
- raw mode 下では XOFF / XON は flow control として解釈されないため、cmux 内 / 直接ターミナル起動どちらでも問題なく届くと期待される。
- 実装後、以下の組み合わせで Ctrl+Q が確認ダイアログを開くことを実機検証する：
  - 直接 `cmux-team start` 起動（macOS Terminal.app, iTerm2）
  - cmux 経由起動（pane 内で confirmation が出るか）
  - SSH 越し（PuTTY 系を含む可能性が将来あるが今回は対象外）

### 3-C. Ctrl+R (DC2 = 0x12)

- 制御コードとしてはほぼ未使用。`readline` の reverse-i-search 用途があるが、raw mode 下では line discipline が無効なので影響なし。
- リスク低。

### 3-D. パーサ衝突

- タスク概要記載の通り、`ctrl+letter` は trie キー `codepoint:ZR_MOD_CTRL` で `letter` (`codepoint:0`) と別キー扱い。小文字ハンドラ（line 1875 `r`, 1876 `q`, 1833 `g`）と競合しない。
- 確認のため、変更後に `r` / `q` / `g` の小文字ハンドラが意図通り発火するかも手動検証に含める。

### 3-E. ヘルプ表記の幅

- `Ctrl+G` / `Ctrl+R` / `Ctrl+Q` は従来の単文字より長く、フッターが折り返す可能性あり。
- 実機で 80 桁・狭幅 cmux pane の見た目を確認する。問題があれば後続タスクで `^G` 表記に置換する余地を残す（今回は明示性優先）。

## 4. 検証手順

```bash
# 型チェック
cd skills/cmux-team/manager && bun run tsc --noEmit

# 既存テスト（dashboard 関連のみ。bun test 全体実行は禁忌）
cd skills/cmux-team/manager && for f in dashboard-conductor.test.tsx dashboard-issues.test.tsx dashboard-metrics.test.tsx dashboard-pool.test.tsx; do bun test --timeout 30000 "$f"; done
```

### 手動検証（必須）

別 cmux pane / 別ターミナルで `cmux-team start` を起動し、以下を確認：

1. **Ctrl+G / journal タブ**: ↑/↓ で履歴を遡った後、`Ctrl+G` で末尾（最新）へジャンプし autoScroll OFF になる
2. **Ctrl+G / log タブ**: 同上
3. **Ctrl+G / metrics タブ**: 末尾までスクロール
4. **Ctrl+R / issues タブ**: gh sync が走り journal に `issues_sync_*` イベント記録（ネットワーク到達不能でもエラーが journal に出れば成功）
5. **Ctrl+Q / global**: フッターに `Full quit? Y/N` が表示される。`n` で取り消し、`Y` で daemon と全 surface が落ちる
6. **小文字ハンドラ**: `g`（先頭へ）/ `r`（daemon reload）/ `q`（quit）が変更前と同じく発火する
7. **ヘルプ表記**: 各タブのフッターで `Ctrl+G` / `Ctrl+R` / `Ctrl+Q` が表示されている

検証ターミナルは最低限 `macOS Terminal.app` と `iTerm2`（または `kitty`）の 2 つ以上で確認する。

## 5. CHANGELOG 記載案

`CHANGELOG.md` の Unreleased（または次バージョン）セクションに追記：

```markdown
- **dashboard のキーバインド `Shift+R` / `Shift+G` / `Shift+Q` を `Ctrl+R` / `Ctrl+G` / `Ctrl+Q` に変更（T394）**。kitty keyboard protocol / CSI-u 非対応の標準ターミナル（macOS Terminal.app, 既定設定の iTerm2 など）では `shift+letter` が text event の codepoint としてしか届かず shift modifier が trie マッチしないためハンドラが発火しなかった回帰を、全端末で確実に制御バイト（0x12 / 0x07 / 0x11）として届く `ctrl+letter` ベースに切り替えて構造的に修正。ヘルプ表記も `g/G` → `g/Ctrl+G`, `R sync` → `Ctrl+R sync`, `Q full quit` → `Ctrl+Q full quit` に更新
```

## 6. 作業境界

- コード変更は実装フェーズの担当者が行う（本計画は plan.md のみ）
- `.team/artifacts/` への書き込みは行わない
- 出力先以外への成果物は作らない
