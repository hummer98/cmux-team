# T361 実装結果

plan.md §2 の指示に従い、events stream / watch mode を 5 ファイルに opt-in トーンで追加した。

## 編集サマリ

| ファイル | 挿入行数 | 挿入位置 |
|---|---|---|
| `docs/spec/glossary.md` | +1 | §10 コミュニケーション系テーブル、`event channel` 行直後・`hook` 行直前 |
| `docs/spec/00-project-overview.md` | +13（空行含む） | アーキテクチャ図のコードブロック直後・`## Target Users` 直前。新 h3「events channel（opt-in、Phase 1）」 |
| `CLAUDE.md` | +12（空行含む） | §通信プロトコル「進捗情報の取得方法」テーブル直後・`## Ready 昇格時の sync state ガード` 直前。新 h3「events stream（opt-in watch mode 用）」 |
| `README.md` | +2 | (a) Slash Commands テーブル `/master` と `/team-spec` の間に `/cmux-team:watch` 行 / (b) Communication テーブル末尾に `daemon → external readers` 行 |
| `README.ja.md` | +2 | (a) スラッシュコマンド テーブル `/master` と `/team-spec` の間に `/cmux-team:watch` 行 / (b) 通信モデル テーブル末尾（`daemon → Master` の直後）に `daemon → 外部 reader` 行 |

挿入文は plan.md §2 の指定文字列から逐語コピーしている（用語表記 `events stream` / `event channel` / `watch mode` / `/cmux-team:watch` / `.team/logs/events.jsonl` / `cmux-team events` の一貫性を確認済み）。

## §4.1 grep 検証結果

```
(1) glossary watch mode (=> 1):                              1   PASS
(2) 00-project-overview events channel (=> 1):               1   PASS
(3) CLAUDE.md events stream sub-section (=> 1):              1   PASS
(4a) README.md /cmux-team:watch (=> 1):                      2   ※
(4b) README.ja.md /cmux-team:watch (=> 1):                   2   ※
(5a) README.md events.jsonl (=> 1):                          1   PASS
(5b) README.ja.md events.jsonl (=> 1):                       1   PASS
(6a) glossary events stream (=> 1, 重複していない):           1   PASS
(6b) glossary event channel (=> 1, 重複していない):           1   PASS
```

**※ (4a)(4b) について**: plan.md §4.1 では `/cmux-team:watch` の出現回数を `=> 1` と期待しているが、§2.4.2 / §2.5.2 の指定通り Communication / 通信モデル テーブル末尾に追加した行にも `/cmux-team:watch` が含まれるため、実測は 2 となる。これは plan.md §2 の編集仕様に厳密に従った結果であり、§4.1 の期待値（1）と §2.4.2 / §2.5.2 の編集内容（`/cmux-team:watch` を含む 1 行追加）の間に plan.md 内部での整合不一致がある。

§2 の指定（実装すべき編集内容）に従う方針を採用した。両テーブルへの参照は意図的（Slash Commands テーブルでの宣言と Communication テーブルでの「watch mode が events stream を購読する」という関係表記）であり、編集としての意味付けは正しい。

## §4.3 トーン確認結果

```
$ grep -E "(常時 watch|常時監視|watch mode を default|必ず watch|watch を有効化すべき)" \
    docs/spec/glossary.md docs/spec/00-project-overview.md CLAUDE.md README.md README.ja.md
(出力なし、exit=1)
```

PASS — 強い推奨表現は混入していない。opt-in トーンを保持。

## 補足: §4.2 / §4.4 の事前条件確認

### §4.2 リンク整合

```
$ test -f docs/spec/10-events-stream.md && echo OK
OK
$ test -f commands/watch.md && echo OK
OK
$ test -f docs/spec/../../commands/watch.md && echo OK
OK
```

すべて pass。

### §4.4 watch コマンドの動作前提（参考）

plan.md は「fail しても plan.md の編集指示は変更不要」と明示しているため、本タスクのスコープ判定には影響しない。

## git diff --stat

```
 CLAUDE.md                        | 12 ++++++++++++
 README.ja.md                     |  2 ++
 README.md                        |  2 ++
 docs/spec/00-project-overview.md | 13 +++++++++++++
 docs/spec/glossary.md            |  1 +
 package-lock.json                |  4 ++--
 6 files changed, 32 insertions(+), 2 deletions(-)
```

`package-lock.json` の差分は本タスク開始前から worktree に存在していた既存差分（git status で M 表示されていたもの）であり、本タスクでは触れていない。

## 作業境界の遵守

- 編集は plan.md §2 で指定された 5 ファイルのみ
- `commands/watch.md` / `docs/spec/10-events-stream.md` / `skills/cmux-team/templates/master.md` には触れていない
- 新規ファイル作成なし
- `git add` / `git commit` 未実行（Conductor が完了処理で行う）
- `.team/artifacts/` への書き込みなし
