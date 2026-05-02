# T361 Inspection Result

## 判定: GO

plan.md §2.1〜§2.5 の挿入指示が逐語で反映され、opt-in トーンが保持されており、Master template / SKILL / commands/watch.md などへの非介入も守られている。grep 検証は plan.md §4.1 の既知の整合不一致（`/cmux-team:watch` の出現回数が README で 2 となる件 — impl-result.md でも明示されており NOGO 理由にしない）を除き全 PASS。`package-lock.json` の差分は最終的に working tree から消えており、commit 対象に混入する懸念もない。

## 観点別結果

### A. plan.md との整合

- ☑ §2.1 `docs/spec/glossary.md`: 164 行目に `| watch mode | …` が逐語挿入。`event channel` 行（163）と `hook` 行（165）の間に正しく配置。
- ☑ §2.2 `docs/spec/00-project-overview.md`: 37-48 行目に `### events channel（opt-in、Phase 1）` 段落が逐語挿入。アーキテクチャ図のコードブロック終端（35）直後・`## Target Users`（50）直前。前後空行も plan 通り。
- ☑ §2.3 `CLAUDE.md`: 200-210 行目に `### events stream（opt-in watch mode 用）` サブセクションが逐語挿入。「進捗情報の取得方法」テーブル末尾（198）直後、`## Ready 昇格時の sync state ガード`（212）直前。
- ☑ §2.4.1 `README.md`: 206 行目に `/cmux-team:watch` 行が `/master`（205）と `/team-spec`（207）の間に逐語挿入。
- ☑ §2.4.2 `README.md`: 265 行目（Communication テーブル末尾、`Conductor ← Agent` 行直後）に `daemon → external readers` 行が逐語挿入。
- ☑ §2.5.1 `README.ja.md`: 194 行目に `/cmux-team:watch` 行が `/master`（193）と `/team-spec`（195）の間に逐語挿入。
- ☑ §2.5.2 `README.ja.md`: 268 行目（通信モデル テーブル末尾、`daemon → Master` 行直後）に `daemon → 外部 reader` 行が逐語挿入。
- ☑ 重複挿入なし: glossary.md の `events stream`（162）/ `event channel`（163）行は未変更。
- ☑ plan.md §2 で「触らない」とされた箇所（アーキテクチャ図内、Key Principles、glossary.md §11、`.team/` ディレクトリ構造ブロック等）に変更なし（`git diff --stat` で 5 ファイル合計 +30 行のみ、すべて指定位置）。

### B. opt-in トーン保持

- ☑ 「常時 watch」「常時監視」「watch mode を default」「必ず watch」「watch を有効化すべき」のいずれも追加箇所に出現せず（§F の grep で確認、exit=1）。
- ☑ キーワード配置:
  - `opt-in`: glossary.md（watch mode 行）/ 00-project-overview.md（h3 タイトル + 本文）/ CLAUDE.md（h3 タイトル）/ README.md（Slash Commands 行 + Communication 行）/ README.ja.md（スラッシュ行 + 通信モデル行）すべてに含む。
  - `default 無効`: glossary.md / CLAUDE.md に明記。
  - `user が能動 invoke` 系: 00-project-overview.md（「user が `/cmux-team:watch` を能動 invoke した」）/ CLAUDE.md（「user が `/cmux-team:watch` を能動 invoke したときのみ」）に明記。
  - `Phase 1`: 00-project-overview.md の h3 タイトル（`events channel（opt-in、Phase 1）`）および本文（「Phase 1 では opt-in」）に明記。CLAUDE.md には Phase 2 への留保コメント（`> Master template … は Phase 2 で別途検討`）として配置。

### C. Master template 非介入

`git status --porcelain` で以下のファイルが **未編集** であることを確認:

- ☑ `skills/cmux-team/templates/master.md`（ja/en 両系統に存在 — 両方とも未変更）
  - `skills/cmux-team/templates/ja/master.md`
  - `skills/cmux-team/templates/en/master.md`
- ☑ `skills/cmux-team/SKILL.md`
- ☑ `commands/master.md`
- ☑ `commands/watch.md`（本タスク編集対象外）

`git status` 出力は `CLAUDE.md` / `README.ja.md` / `README.md` / `docs/spec/00-project-overview.md` / `docs/spec/glossary.md` の 5 ファイルのみ。

### D. 用語表記の一貫性

- ☑ `events stream` / `event channel` / `watch mode` / `/cmux-team:watch` / `.team/logs/events.jsonl` / `cmux-team events`: 全箇所でバッククォート + 表記が plan.md §3.3 の規定通り。
- ☑ ハイフン化（`events-stream` / `watch-mode`）の混入なし。
  - `events-stream` の grep hit はすべて `10-events-stream.md` というファイル名（spec ファイル）への参照のみ。watch mode 文脈の表記揺れではない。
  - `watch-mode` の grep hit ゼロ。
- ☑ 別言（`watcher` / `watch コマンド` / `Watch Mode` キャピタライズ / `/watch` の prefix なし表記）の混入なし。
  - `watcher` の grep hit は既存の `PID watcher`（glossary.md:88、CLAUDE.md:35）のみ。watch mode とは無関係の文脈。

### E. リンク整合

- ☑ 00-project-overview.md（48 行目）→ `[`10-events-stream.md`](10-events-stream.md)`（同ディレクトリ相対）— 解決可能。
- ☑ glossary.md（164 行目）→ `[`../../commands/watch.md`](../../commands/watch.md)`（`docs/spec/` から `commands/` への相対）— 解決可能。
- ☑ glossary.md（164 行目）→ `[`10-events-stream.md`](10-events-stream.md)`（同ディレクトリ相対）— 解決可能。
- ☑ CLAUDE.md（203, 208 行目）の `docs/spec/10-events-stream.md` / `commands/watch.md`（バッククォート、リンク化なし）— ファイル実在を確認。

```bash
$ test -f docs/spec/10-events-stream.md && echo OK    # OK
$ test -f commands/watch.md && echo OK                  # OK
$ test -f docs/spec/../../commands/watch.md && echo OK  # OK
```

### F. grep 検証

```
$ grep -c "^| watch mode |" docs/spec/glossary.md                            => 1   ✓ (expect 1)
$ grep -c "events channel（opt-in、Phase 1）" docs/spec/00-project-overview.md => 1   ✓ (expect 1, 全角括弧)
$ grep -c "### events stream（opt-in watch mode 用）" CLAUDE.md                => 1   ✓ (expect 1, 全角括弧)
$ grep -c "/cmux-team:watch" README.md                                        => 2   ※ (impl-result.md で既知 — Slash 表 + Communication 表で意図的に 2)
$ grep -c "/cmux-team:watch" README.ja.md                                     => 2   ※ (同上)
$ grep -c "events.jsonl" README.md                                            => 1   ✓ (expect >= 1)
$ grep -c "events.jsonl" README.ja.md                                         => 1   ✓ (expect >= 1)
$ grep -c "^| events stream |" docs/spec/glossary.md                          => 1   ✓ (重複なし)
$ grep -c "^| event channel |" docs/spec/glossary.md                          => 1   ✓ (重複なし)

$ grep -E "(常時 watch|常時監視|watch mode を default|必ず watch|watch を有効化すべき)" \
    docs/spec/glossary.md docs/spec/00-project-overview.md CLAUDE.md README.md README.ja.md
   exit=1, hit 0 件                                                                  ✓ (強い推奨表現なし)
```

※ `/cmux-team:watch` が README で 2 となるのは、本タスクの inspector 指示書 §F 末尾および impl-result.md §4.1 注釈で「plan.md §2.4 / §2.5 の編集指示に従った結果なので NOGO 理由にしない」と既に明記されている既知の整合不一致。

### G. package-lock.json 既知問題

- ☑ `git status` 時点で `package-lock.json` は working tree から消えており、変更ファイルは 5 ファイル（CLAUDE.md / README.ja.md / README.md / docs/spec/00-project-overview.md / docs/spec/glossary.md）のみ。Conductor 側で staging から外す以前に working tree からも回復させたか、もしくは impl-result.md 記述時から状態が更新されたと推測。いずれにせよ、commit 対象に `package-lock.json` の差分が混入する懸念はない。
- ☑ `git diff --stat` は plan.md §2 の編集対象 5 ファイルの +30 行のみ（impl-result.md 時点の +32 -2 から、`package-lock.json` 分の差分が消えた状態）。

```
$ git diff --stat
 CLAUDE.md                        | 12 ++++++++++++
 README.ja.md                     |  2 ++
 README.md                        |  2 ++
 docs/spec/00-project-overview.md | 13 +++++++++++++
 docs/spec/glossary.md            |  1 +
 5 files changed, 30 insertions(+)
```

## Critical findings（NOGO の場合）

なし。

## Minor findings（GO だが指摘あり）

- impl-result.md §「git diff --stat」では `package-lock.json` を含む 6 ファイル / +32 -2 と記述されているが、inspection 時点の実測は 5 ファイル / +30 のみ。Conductor が完了処理に進む前に impl-result.md を更新する必要はないが、もし最終 commit 後に PR 説明や成果物サマリを書く場合は最新の `git diff --stat` を参照すること（軽微・運用上の指摘）。
