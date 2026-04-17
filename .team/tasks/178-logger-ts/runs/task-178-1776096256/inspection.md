# T178 検品結果

## 判定: GO

## 確認した観点
- [x] logger.test.ts 存在 (`skills/cmux-team/manager/logger.test.ts`)
- [x] 3 ケース全て pass
- [x] bun test: 145 pass / 0 fail（既存 142 + 追加 3）
- [x] beforeEach/afterEach で PROJECT_ROOT 退避・復元
- [x] tmpdir は `mkdtemp` + `rm -rf`（recursive/force）
- [x] sentinel がユニーク（`Date.now()` + `Math.random().toString(36)`）
- [x] ケース 2 が module-level 化で fail すること（独自検証済み）
- [x] logger.ts 本体に変更なし（`git diff` 空）
- [x] 変更ファイルは logger.test.ts のみ（untracked、他に変更なし）

## テスト構成の確認

- ケース 1: `PROJECT_ROOT = tmpdirA` 設定後 `log()` → tmpdirA 配下の `.team/logs/manager.log` に書かれることを assert
- ケース 2: 同一プロセス内で `PROJECT_ROOT` を tmpdirA → tmpdirB へ切替。各々のログに自身のイベントのみ存在、相手のイベント不在を assert（`toContain`/`not.toContain` の双方向）
- ケース 3: `PROJECT_ROOT` を tmpdir に向けた `log()` が cwd の `.team/logs/manager.log` の sentinel 出現数を変化させないことを assert（件数ベース、並行実行耐性あり）
- 追加ガード: `beforeAll`/`afterAll` で sentinel 件数のベースライン/事後比較を行い、テスト全体で cwd を汚染していないことを保証

## 独自検証ログ

`logger.ts` の `log()` を以下の module-level cache 版に一時変更:

```ts
const PROJECT_ROOT_CACHED = process.env.PROJECT_ROOT || process.cwd();
export async function log(event, detail = "") {
  const projectRoot = PROJECT_ROOT_CACHED;
  ...
}
```

`bun test logger.test.ts` 実行結果:

```
1 pass
2 fail
1 expect() calls
Ran 3 tests across 1 file.

(fail) logger - PROJECT_ROOT 遅延評価 > log() 呼び出し時に PROJECT_ROOT を都度評価する
  ENOENT: no such file or directory, open '/var/folders/.../cmux-logger-test-a-.../.team/logs/manager.log'
(fail) logger - PROJECT_ROOT 遅延評価 > 同一プロセス内で PROJECT_ROOT を切り替えると書き込み先も切り替わる
  ENOENT: no such file or directory, open '/var/folders/.../cmux-logger-test-a-.../.team/logs/manager.log'
```

→ **ケース 2（本命 regression 検出ケース）が module-level cache 化で確実に fail する** ことを確認。
ケース 1 も同時に fail するため、二重に regression を検出できる堅牢な構成。

復元後:

```
$ git diff skills/cmux-team/manager/logger.ts
(空出力)

$ git status
Untracked files: skills/cmux-team/manager/logger.test.ts
nothing added to commit
```

→ logger.ts 本体は完全に復元済み。

復元後の最終テスト:

```
145 pass / 0 fail / 327 expect() calls
Ran 145 tests across 10 files.
```

## 備考

- sentinel 汚染ガード（`beforeAll`/`afterAll`）で並行実行時の誤判定にも耐える設計。
- 既存 `envrc-prompt.test.ts` と一貫したスタイル（`bun:test` の import、`describe`/`test` 構成、日本語テスト名）。
