# T340 リリース完了サマリー

## バージョン

- 旧: v4.10.0
- 新: v4.11.0
- bump 種別: minor（`feat(sync)` 1 件 + `chore(ci)` 1 件 → 最大が minor）

## 含まれるコミット

- `955cef3` feat(sync): behind-ff + main checkout 中は git pull --ff-only を自動実行 (T339)
- `3c2e7fe` chore(ci): per-file bun test を回す独立 workflow を追加 (T336)

## 変更ファイル（リリースコミット）

- `CHANGELOG.md` — `[4.11.0]` セクション追加（Added: T339 / Changed: T336）
- `package.json` — `4.10.0` → `4.11.0`
- `.claude-plugin/plugin.json` — `4.10.0` → `4.11.0`
- `.claude-plugin/marketplace.json` — `plugins[0].version` `4.10.0` → `4.11.0`

## 検証

- リリースコミット: `f4b78d6 chore: release v4.11.0`
- タグ: `v4.11.0` push 済み
- GitHub Actions `release.yml` (run 24950636809): **success**
- plugin marketplace pull: 完了（fast-forward）
- 旧 plugin キャッシュ削除: `4.9.1` 削除、`4.10.0` 保持
- plugin uninstall + install: 完了、`~/.claude/plugins/cache/.../4.11.0/` が反映
- npm レジストリからインストール: `cmux-team --version` → `cmux-team 4.11.0`

## 注意点

- JSON 編集に `python3 json.dump` を使ったところ `ensure_ascii=True` のデフォルトで日本語が `\uXXXX` にエスケープされ、`keywords` の compact array も多行展開されてしまったため、一旦 `git checkout` で revert し sed で `version` 文字列のみ置換する方式に切り替えた。差分は各 JSON 1 行のみに収束
- v4.11.0 の release workflow は push 直後に既に success を取っていたため、`gh run watch` は不要だった

## 納品方式

ローカル ff-only マージ — main に直接コミット・push したため worktree branch に納品物なし。`--deliverable-kind merged` で close する。
