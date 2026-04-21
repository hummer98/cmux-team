# T291 実装ノート

## 変更ファイル一覧

```
 skills/cmux-team/manager/main.test.ts | 182 ++++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/main.ts      |  77 +++++++++++++-
 2 files changed, 254 insertions(+), 5 deletions(-)
```

## 追加した関数 / テストのファイル名と行番号

### 実装（`skills/cmux-team/manager/main.ts`）

- `resolveCanonicalTaskId(inputId: string): Promise<string | undefined>` — 新規 export（main.ts:288）
  - `findTaskFile` の直後に配置
  - findTaskFile 結果の frontmatter `id: <value>` を読み出して canonical id を返す
- 5 コマンドで `requireArg("task-id")` 直後に canonical 化パターンを挿入:
  - `cmdUpdateTask`: main.ts:2893-2901
  - `cmdCloseTask`: main.ts:3013-3021
  - `cmdAbortTask`: main.ts:3502-3508
  - `cmdRestartTask`: main.ts:3675-3681
  - `cmdDeleteTask`: main.ts:3790-3796

### テスト（`skills/cmux-team/manager/main.test.ts`）

- import に `resolveCanonicalTaskId` を追加（main.test.ts:17）
- T183 describe を拡張（main.test.ts:603-706）:
  - update-task slug 渡しテスト（main.test.ts:609）
  - close-task slug 渡しテスト（main.test.ts:625）
  - close-task slug 経由 CONDUCTOR_DONE テスト（main.test.ts:636）
  - delete-task slug 渡しテスト（main.test.ts:660）
  - abort-task slug 渡しテスト（main.test.ts:671）
  - close-task エラーメッセージテスト（main.test.ts:684）
  - update-task エラーメッセージテスト（main.test.ts:696）
- 新 describe `resolveCanonicalTaskId (T291)`（main.test.ts:713-760）:
  - 数値 id 完全一致
  - slug 先頭マッチ
  - ディレクトリ名全体渡し
  - 該当タスク不在（undefined）
  - frontmatter に id 行なし（undefined）

ユニットテストは PROJECT_ROOT が main.ts 読み込み時に固定される制約のため、bun subprocess（`bun -e`）経由で `resolveCanonicalTaskId` を呼び出す方式を採用。

## `bun test` の結果

### manager/main.test.ts 単体

```
124 pass
0 fail
350 expect() calls
```

### manager 配下全テスト

```
994 pass
0 fail
2369 expect() calls
Ran 994 tests across 35 files. [54.34s]
```

## `bunx tsc --noEmit` の結果

T291 起因の新規エラーは **0 件**。

tsc 実行時に 3 件のエラーが検出されるが、いずれも T291 の変更前から存在する既知のエラー（stash で変更を退避して再実行し再現確認済み）:

```
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3956,9): error TS2322: Type '"new_session"' is not assignable to type ...
daemon.ts(1597,22): error TS2352: Conversion of type 'string | undefined' ...
```

これらは main.ts / main.test.ts 以外のファイル（conductor.ts / daemon.ts / daemon.test.ts）で、
T291 のスコープ外。別タスクで修正すべきもの。

## 受け入れ基準のセルフチェック

### タスク本文の受け入れ基準（4 項目）

- [x] `cmdCloseTask` / `cmdUpdateTask` / `cmdAbortTask` / `cmdDeleteTask` / `cmdRestartTask`
      が frontmatter `id:` を canonical key として使う
  → 5 コマンドすべてで `resolveCanonicalTaskId` が呼ばれ、以降 `taskId = canonical` で統一
- [x] slug 渡し・数字 id 渡しどちらでも `task-state.json` の既存エントリが正しく更新される
  → 統合テスト `update-task (T291)` / `close-task (T291)` / `delete-task (T291)` /
    `abort-task (T291)` で assert、既存の数字 id テスト（T183）は回帰なし
- [x] close-task 後 `team.json.conductors[].taskId` マッチに成功し CONDUCTOR_DONE が送られる
  → 統合テスト `close-task (T291): slug 渡しで team.json.conductors[].taskId マッチが成功し
    CONDUCTOR_DONE が送られる` で mock HTTP 経由で assert
- [x] 存在しない task-id 渡し時のエラーメッセージは従来通り（元の入力値で表示）
  → 統合テスト `close-task (T291) / update-task (T291): 存在しない task-id で元の入力値が
    エラーメッセージに表示される` で確認（`taskIdInput` を stderr に表示）

### 実装者向けセルフチェック（plan 追加 5 項目）

- [x] `resolveCanonicalTaskId` のユニットテストが 5 ケース（数値 / 部分 slug / フル dir /
      不在 / id 欠落）通る
  → `describe("resolveCanonicalTaskId (T291)")` で 5 test すべて pass
- [x] 既存の T183 TASK_UPDATED テストが全て通る（回帰なし）
  → 既存 7 test 全て pass（全体 124 pass / 0 fail）
- [x] 追加した slug 渡し統合テスト 3 件（close / update / delete）が通る
  → 3 + 2 件（abort, restart 経由の close/no-conductor）pass
- [x] CONDUCTOR_DONE 送信テスト（slug 経由）が通る
  → `close-task (T291): slug 渡しで team.json.conductors[].taskId マッチが成功し
    CONDUCTOR_DONE が送られる` pass
- [x] `bun test` 全体グリーン / `bunx tsc --noEmit` 0 エラー（T291 起因）
  → 994 pass / 0 fail、tsc T291 起因 0 件

## 設計判断・悩んだ点

### 1. `resolveCanonicalTaskId` の testability

plan 4.1 では「ユニットテスト」を要求しているが、`PROJECT_ROOT` は main.ts モジュール読み込み
時に `findProjectRoot()` で固定される。bun test 内で import した場合、テスト毎に PROJECT_ROOT
を差し替えることができない。

**採用した方針**: bun subprocess（`bun -e` + dynamic import）経由で resolveCanonicalTaskId を
呼び出し、環境変数 `PROJECT_ROOT=testDir` を毎回注入する。import 自体は型検査目的で残す
（`expect(typeof resolveCanonicalTaskId).toBe("function")` で compile-time 参照を保持）。

**却下案**:
- resolveCanonicalTaskId に projectRoot 引数を追加: 既存の `findTaskFile` が PROJECT_ROOT
  closure を参照している設計と整合しない。plan の「既存下流コード一切変更しない」にも反する
- PROJECT_ROOT を env 毎回読み直しに変更: 広い副作用。T291 のスコープ外

subprocess 方式は 1 テスト ~500ms と遅めだが、5 ケース × 500ms = 2.5s で許容範囲。
全 124 テスト 12.46 秒、回帰無し。

### 2. `cmdAbortTask` / `cmdRestartTask` の「canonical 不明で exit 1」への変更

plan 3.2.3 / 3.2.4 の通り採用。現状は `findTaskFile` 不在でも続行する設計だが、T291 では
**taskFile が無い場合に taskState を書き換えると孤児 entry が確定的に生まれる**ため、exit
に倒す方が本タスクの目的（孤児 entry 防止）と整合する。

- 現行テスト（既存のテストケース）にはこの経路を叩くものは無く、回帰なし
- 新規テストでは正常経路（taskFile 存在 + slug 渡し）のみ assert

### 3. 既存の `findTaskFile` 呼び出しは 5 コマンドで残す

plan 3.2.1 / 5.3 通り: `resolveCanonicalTaskId` が内部で `findTaskFile` を呼ぶが、各コマンドの
後段で `taskFile` パスを body 書き換え / frontmatter 編集 / cascade 等に使うため 2 度呼ぶ。
タスク数 < 1000 のプロジェクトでは無視できるコスト。パフォーマンス問題になるなら
resolveCanonicalTaskId が taskFile を同時に返すよう拡張する（今回は YAGNI）。

### 4. 既存の「to-not-found」エラー（コマンド内部）の取り扱い

防御線として残す（plan 3.2.1）。到達不能だが canonical 解決 → taskFile 再取得の間に
タスクが削除される race を考慮すれば保持に意味はある。
