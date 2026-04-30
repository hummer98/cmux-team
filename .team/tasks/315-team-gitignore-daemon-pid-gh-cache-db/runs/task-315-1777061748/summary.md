# T315 結果サマリー: 配布用 .team/.gitignore テンプレートに daemon.pid と gh-cache.db* を追加

## 完了したサブタスク

- S1. 新規生成テンプレート（`daemon.ts:initInfra`）に `daemon.pid` / `gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` の 4 項目を追加
- S2. migration ブロックに `daemon.pid` 追記判定を追加（anchor=`proxy-port` 直後 splice、未発見時は push、`!startsWith("#")` 判定）
- S3. migration ブロックに `gh-cache.db` 系 3 項目を `for` ループで追加（anchor 探索順: gh-cache.db-wal → -shm → db → rate-limit.json → proxy-port）
- S4. `team_gitignore_migrated` ログは既存 `added.join(",")` で自動的に新項目を集約（コード変更不要）
- S5/S6. `daemon.test.ts` に `describe("initInfra: .team/.gitignore (T315)")` を新設し、5 ケース（新規生成 / migration / 新規生成冪等 / migration 冪等 / コメントアウト行扱い）を追加
- S7. `bun test` 1231 pass / `bunx tsc --noEmit` 既存 3 件のみ残存（plan §6.2 列挙の事前エラー、touched files に新規エラーなし）

## 変更ファイル

| ファイル | 変更規模 | 内容 |
|---------|---------|------|
| `skills/cmux-team/manager/daemon.ts` | +52 行 | template 配列に 4 項目追加、migration ブロックに 4 項目分の追記判定追加 |
| `skills/cmux-team/manager/daemon.test.ts` | +128 行 | `initInfra` の gitignore 生成・migration テスト 5 ケース新設 |
| `package-lock.json` | ±2 行 | `npm install` による version sync（4.6.0 → 4.7.0、本タスク無関係） |

## テスト結果

```
$ bun test
1231 pass / 0 fail / 3010 expect() calls (41 files, 54.89s)

$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016        ← 既存（着手前から存在）
daemon.test.ts(3870,9): error TS2322     ← 既存（plan §6.2）
daemon.ts(1610,22): error TS2352         ← 既存（plan §6.2、+52 行で 1558→1610 シフトのみ）
```

新規 5 テスト全て pass。既存テスト無破壊。touched files (`daemon.ts` / `daemon.test.ts`) に新規型エラーなし。

## 検品結果

Inspector 判定: **GO**

`inspect-report.md` 参照。受け入れ条件 4 項目（新規プロジェクトでの包含 / 既存プロジェクトでの冪等追記 / bun test+typecheck 通過 / migrated ログ記録）をすべて充足。

## 設計判断（plan §7 Decision Log）

- D1: `gh-cache.db*` を ワイルドカード 1 行ではなく 3 行独立で追加（既存 T227/T229 の `lines.some(t === X)` 完全一致パターンと整合）
- D4: `daemon.pid` を `proxy-port` 直後に挿入（ランタイム生成系のグループとして近傍配置）
- D5: `added[]` ログは個別 3 項目（事後確認用途で個別可視化が有用）
- D6: state machine 等の構造化導入は本領域に動機なし（既知項目の線形追記のみ、状態遷移なし、バグ再発なし）

## マージ情報

（commit 後に追記）

- 納品方式: ローカル ff-only merge
- マージコミット: f632ed02aa23ce0d509b042385a6a53e7fd2a552
- ブランチ: `task-315-1777061748/task` → `main` に fast-forward
