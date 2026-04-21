# T256 実装ノート

## 変更したファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | L423: `caffeinate -i` → `caffeinate -dis` |
| `skills/cmux-team/manager/i18n.ts` | EN L91 / EN L101 / JA L734 / JA L744 の 4 箇所のヘルプテキストを `-dis` に変更し、`-d` 追加による挙動変化（display sleep + AC 電源時 system sleep 抑止）の補足文を追記 |
| `CHANGELOG.md` | `[Unreleased]` の `### Changed`（既存セクション）の先頭に T256 エントリを追記 |

`### Changed` セクションは plan.md の調査時点では不在となっていたが、実装時点では既に T242 のエントリが存在していたため新設は行わず、先頭に挿入した。

## 検証結果

### 型チェック

`bun check` スクリプトは package.json に未定義のため、`bunx tsc --noEmit` を実行。出力なし＝エラー無しで完了。

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(出力なし、exit 0)
```

### grep 検証（`-i` の残存有無）

```bash
$ grep -nE "caffeinate (-i|-dis)" skills/cmux-team/manager/main.ts skills/cmux-team/manager/i18n.ts
skills/cmux-team/manager/i18n.ts:91:  --no-sleep-prevention    disable macOS sleep prevention (caffeinate -dis)
skills/cmux-team/manager/i18n.ts:101:  - Sleep prevention: on macOS, caffeinate -dis is used while any agent is active
skills/cmux-team/manager/i18n.ts:735:  --no-sleep-prevention    macOS スリープ抑止を無効化（caffeinate -dis を使わない）
skills/cmux-team/manager/i18n.ts:745:  - スリープ抑止: macOS では稼働中エージェントがある間 caffeinate -dis を実行します
```

main.ts は `caffeinate -dis` のみを含み grep にヒットせず（`["caffeinate", "-dis"]` という配列リテラルで `-i)` パターンに合わない）。実体を直接確認:

```bash
$ grep -n "caffeinate" skills/cmux-team/manager/main.ts
415:  // macOS スリープ抑止（caffeinate 管理）
418:  // caffeinate assertion を管理するため、どれか1つがアクティブなら Mac はスリープしない。
423:      caffeinateProc = Bun.spawn(["caffeinate", "-dis"], {
```

L423 が `-dis` になっていることを確認。`-i` の記述は完全に消えている。

### CHANGELOG 確認

`head -12 CHANGELOG.md` で `[Unreleased]` → `### Changed` 直下に T256 エントリが配置されていることを確認。既存 T242 エントリの直前に挿入。

### CLAUDE.md / docs/spec の caffeinate 言及確認

```bash
$ rg -i caffeinate CLAUDE.md docs/spec/
(出力なし)
```

plan.md の判断通り、caffeinate への言及は CLAUDE.md / docs/spec/ いずれにも存在しないため更新不要。

## 予期せぬ問題

なし。plan.md の手順通りに完了。`bun check` スクリプトが未定義だった点だけは plan.md および実装指示書の記述と乖離していたが、`bunx tsc --noEmit` で代替したため実害なし。

## 作業境界の遵守

- コミット・`git add` / `git commit` / `git push` は実行していない
- 編集は worktree 内のみ
