# T287 実行サマリ — pidfile 取得前に `.team/` を mkdir -p

## 結論

**GO** 判定で完了。案 B（pidfile モジュールが自分の格納先を作る）で修正。

## 完了したサブタスク

| Phase | 結果 | 成果物 |
|---|---|---|
| Plan | 完了 | plan.md（案 A/B 比較、採用案 B） |
| Impl | 完了 | pidfile.ts / pidfile.test.ts 修正、全テスト pass |
| Inspection | **GO** | inspect-report.md |

Design Review は中規模タスクのため skip（採用案が明確、設計上のリスクは plan 段階で案比較済み）。

## 変更ファイル一覧

| ファイル | 変更行数 |
|---|---|
| `skills/cmux-team/manager/pidfile.ts` | +9 / -1 |
| `skills/cmux-team/manager/pidfile.test.ts` | +19 / -0 |

### 差分要約

- `pidfile.ts` L16-17 の import に `mkdir` (`fs/promises`) と `dirname` (`path`) を追加
- `acquirePidFile` 先頭（opts デストラクチャ直後 / attempt loop 前）に `await mkdir(dirname(path), { recursive: true })` を 1 回だけ追加
- `pidfile.test.ts` に `describe("acquirePidFile - missing parent directory", ...)` を 2 ケース追加（`.team/` 未作成から成功 / 既存は no-op）

## テスト結果

| コマンド | 結果 |
|---|---|
| `bun test pidfile.test.ts` | 25 pass / 0 fail（新規 2 ケース含む） |
| `bun test`（全体） | 854 pass / 0 fail |
| `bunx tsc --noEmit` | 新規エラー 0 件（既存 3 件は T287 以前から存在。stash で確認済み） |

既存 tsc エラー 3 件（conductor.ts TS1016 / daemon.test.ts TS2322 / daemon.ts TS2352）は本タスクの scope 外。

## 期待される効果

- 新規フォルダ（`git init` 直後、`.team/` 未作成）で `cmux-team start` を実行しても ENOENT が発生せず daemon 起動が進行
- 既存 `.team/` があるプロジェクトでの挙動は不変（recursive mkdir は冪等 no-op）
- 2 回目の `cmux-team start` は従来通り `PidFileLockedError` で fail-stop（T259 既存挙動）
- `release` の ENOENT 黙殺との対称性改善（acquire は parent 自動作成 / release は不在許容）

## 納品

- 方式: ローカルマージ（`git merge --ff-only`）
- マージコミット: `3db48e3` (fix: cmux-team start が新規フォルダで ENOENT で落ちる問題を修正 (T287))

## 関連

- T259: pidfile による多重起動防止（本バグの根本原因: 取得タイミングを createDaemon 前に移動した結果、`.team/` 未作成での writeFile が発生）
- T286: layout restore 自己修復（別バグ、独立）
