# T256 完了サマリー: caffeinate フラグを -i から -dis に強化

## 概要

Manager daemon 起動中にも Mac がスリープする事象への対処として、`caffeinate -i` を `caffeinate -dis` に変更。display sleep 経由の system sleep 連鎖と AC 電源時の system sleep を併せて抑止する。副作用としてディスプレイが常時点灯する（バッテリー消費増）。

## 実行フロー

- Phase 1: Planner Agent で plan.md 作成（surface:143）
- Phase 2: Design Review は中規模タスクのためスキップ（設計判断なし、既存パターンに沿った変更）
- Phase 3: Implementer Agent で実装（surface:144）
- Phase 4: Inspector Agent で検品 → **GO**（surface:145）

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | L423: `Bun.spawn(["caffeinate", "-i"], ...)` → `Bun.spawn(["caffeinate", "-dis"], ...)` |
| `skills/cmux-team/manager/i18n.ts` | EN L91 / L101, JA L734-735 / L744-745 の 4 箇所のヘルプテキスト。`-dis` 明記 + フラグの論旨（display sleep 抑止・AC 電源時 system sleep 抑止）を英日両方で追記 |
| `CHANGELOG.md` | `[Unreleased]` の `### Changed` 先頭に T256 エントリ追加。破壊的変更（ディスプレイ常時点灯）を明記 |

`git diff --stat`:
```
 CHANGELOG.md                     |  1 +
 skills/cmux-team/manager/i18n.ts | 10 ++++++----
 skills/cmux-team/manager/main.ts |  2 +-
 3 files changed, 8 insertions(+), 5 deletions(-)
```

## 検証結果

- 型チェック: `bunx tsc --noEmit` エラーなし
- grep 検証: `-i` の残存なし、全て `-dis` に置換済み
- CLAUDE.md / docs/spec/: caffeinate 言及なしで更新不要（plan.md の判断通り）
- 副作用チェック: `sleepPrevention` (boolean) 周辺コード・README への波及なし

## 納品方法

ローカルマージ（main）。小さな変更かつ個人プロジェクトでタスクファイルに PR 指示なしのため。

## マージコミット

（commit 後に追記）

## マージ結果

- Feature commit: 8899710f04449981256f2c19808be1bba0709e80
- Merge commit: ce5fa6a04fc6d338b1cc216d58606c787c3e74ae
- 納品先: main

