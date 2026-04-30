# T301: daemon auto-restart 機能の完全廃止 — 実装計画

## 1. 課題分析

### 現状の問題点

daemon の `source_changed` 検知 → `daemon_auto_restart`（exit 42）機能は、cmux-team 自身の dev-loop 用 hot reload として導入されたが、自己参照的な race を起こして実害が出ている。

- **T298**: daemon auto-restart が Conductor の `close-task` より先に走り、`task_aborted reason=resume_no_worktree` の誤検知が log に残った（task-state は間に合って closed に上書きされた）
- **T300**: 同じレースで `close-task` が daemon socket に届かず、`task-state.json` が aborted のまま固定。`runs/<taskRunId>/summary.md` と `git log main` に完了痕跡があるにもかかわらず machine-readable な state には反映されない

### 根本原因

Conductor の完了手順 Step 9（`git merge --ff-only`）が、daemon の source watcher をトリガーして daemon 自身を落とす。daemon.ts / git-sync.ts など daemon が監視しているファイルを編集するタスクでは、**merge = 自分の完了通知経路を殺す**という自己参照的構造になっている。

完了通知（`close-task` / `CONDUCTOR_DONE`）は HTTP POST で daemon socket に届くため、socket 側が死んだ直後に届いた通知は握り潰される。exit 42 再起動で復活した新 daemon は、旧 daemon がまだ state を永続化し切る前に落ちた場合、directly に fallback ロジック（assigned → aborted 等）に進む。

### 影響範囲

- cmux-team 自身を開発するこのリポジトリのみで発火する機能。一般ユーザー（npm global install で別プロジェクトで使用）は `manager/*.ts` を編集しないため実質発火しない
- 撤去による DX 低下は限定的（bun の起動は速く、手動で `kill <pid>` → `cmux-team start` に戻すのに実害なし）

## 2. 技術アプローチ

### 採用: auto-restart 機構の完全撤去 + exit 42 ループ全削除

自己参照 race の根本対策として、再起動ループそのものを持たない構造に倒す。

- `initSourceWatcher` / `checkSourceChanged` / `DaemonState.sourceMtimes` / `DaemonState.restartRequested` を削除
- `tick()` の source_changed ブロック、`main.ts` の auto_restart ブロックを削除
- bin/cmux-team.js と main.ts onReload の **exit 42 再起動ループを同時に削除**（デッドコード化するため）
- docs/spec の auto-restart / exit 42 記述を削除

### 代替案とその却下理由

1. **debounce で race を回避**: source_changed を検知しても実 restart 前に N 秒待つ。→ 却下。待ち時間を伸ばしても merge 完了と通知配送タイミングは揺らぐため race は消えない。構造的解決にならない
2. **監視対象から daemon.ts / git-sync.ts を除外**: 特定ファイルのみ watch から外す。→ 却下。除外リストがメンテ不能になる。また「開発中に daemon.ts 以外を触る」状況でも close-task と衝突するケースは残る
3. **merge を別プロセスで行う**: Conductor が merge する際に daemon を一時 pause。→ 却下。導入コスト高・正しい pause タイミングを決めるのは別の race を生む

### 構造的解決の検討

「hot reload と自己完結な完了通知が同一プロセスで動く」こと自体が構造的な矛盾。**片方を殺す（= auto-restart を撤去する）**のが最も単純で正しい構造変更。hot reload を本当に戻したくなった場合は、別プロセス（外部の `entr` / `nodemon` 等）で SIGTERM を送る経路に切り替える設計が適切だが、本タスクのスコープ外。

### 既存パターンとの整合性

- `stopDaemon(state)` は **残す**。onReload / shutdown / onFullQuit 経路からは引き続き呼ばれる
- `proxyPortChanged` / `proxy_port_changed` は **残す**。proxy 再利用時（外部で proxy を再起動したケース）の Master 再接続トリガーとして独立に機能する
- `daemon_reload` / `onReload` ホットキー（dashboard の `r` キー）は **残す**。ユーザーが明示的に再読み込みする経路は生きた機能

## 3. 変更対象

### 変更ファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `sourceMtimes` / `restartRequested` フィールド削除、`initSourceWatcher` / `checkSourceChanged` 関数削除、`createDaemon` 初期化削除、`tick()` の source_changed ブロック削除 |
| `skills/cmux-team/manager/main.ts` | `initSourceWatcher` import 削除、`state.sourceMtimes = await initSourceWatcher()` 削除、`if (state.restartRequested)` ブロック削除、`onReload` の exit 42 while ループを単発 execFileSync + `process.exit(0)` に置換 |
| `bin/cmux-team.js` | `start` コマンド分岐の exit 42 while ループを削除し、全コマンドが単発 `execFileSync` の共通経路に統合 |
| `docs/spec/05-install-and-infrastructure.md` | L66（`exit code 42 による自動再起動をサポート`）削除、L154（`ソースファイル mtime 監視によりコード変更時は自動再起動（exit code 42）。auto-restart 後に proxy ポートが変わった場合は Master を自動再接続する。`）を `proxy ポートが変わった場合は Master を再接続する。` のみに縮約、L193（`daemon の auto-restart 後にポートが変わった場合は Master セッションを自動再接続`）を `daemon 起動時に proxy を再利用し、前回ポートと異なる場合は Master セッションを自動再接続` に書き換え |
| `docs/spec/06-implementation-tasks.md` | L23（`exit code 42 で自動再起動`）と L119（`ソースファイル mtime 監視による自動再起動（exit code 42）`）を削除、L198（`**daemon auto-restart 後の Master proxy 再接続（T115）** — proxy ポート変化を検出して Master を自動再起動`）を `**proxy 再利用時の Master 再接続（T115）** — proxy ポート変化を検出して Master を再接続` に書き換え |
| `CLAUDE.md` | L435 `restartRequested / onReload の全経路で release され、正常系では` → `onReload / onFullQuit / shutdown 全経路で release され、正常系では` に修正 |

### 新規作成ファイル

なし。

### 削除ファイル

なし（関数・フィールド・ブロック単位の削除のみ）。

## 4. サブタスク分割

### サブタスク 1: ドキュメント先行削除（スコープ明示のため）

- **目的**: 実装中に grep で「どこにまだ残っているか」を即座に可視化するため、先にドキュメントから参照を落とす
- **対象ファイル**: `docs/spec/05-install-and-infrastructure.md`, `docs/spec/06-implementation-tasks.md`, `CLAUDE.md`
- **作業**:
  1. `docs/spec/05-install-and-infrastructure.md` L66 の `start コマンドの場合: exit code 42 による自動再起動をサポート（最大10回）` 行を削除し、`その他のコマンド: 引数を透過して` と統合して「全コマンド共通で引数を透過する」記述に書き換え
  2. 同 L154 の auto-restart 言及を削除。`proxy ポートが変わった場合は Master を再接続する。` のみ残す
  3. 同 L193 の `daemon の auto-restart 後にポートが変わった場合は Master セッションを自動再接続` を `daemon 起動時に proxy を再利用し、前回ポートと異なる場合は Master セッションを自動再接続` に書き換え（auto-restart 前提を削除。`proxyPortChanged` / `proxy_port_changed` は残るため機能自体は生きる）
  4. `docs/spec/06-implementation-tasks.md` L23（`exit code 42 で自動再起動`）を `bin/cmux-team.js で bun を透過呼び出し` のみに縮約
  5. 同 L119（`ソースファイル mtime 監視による自動再起動（exit code 42）`）の bullet を削除
  6. 同 L198 の `**daemon auto-restart 後の Master proxy 再接続（T115）** — proxy ポート変化を検出して Master を自動再起動` を `**proxy 再利用時の Master 再接続（T115）** — proxy ポート変化を検出して Master を再接続` に書き換え（Phase 6 Task 6.1 L119 と同じ扱い：実装履歴記述から auto-restart 前提を外す）
  7. `CLAUDE.md` L435 の `restartRequested / onReload の全経路で release` を `onReload / onFullQuit / shutdown 全経路で release` に書き換え
- **完了条件**: 次の拡張 grep が 0 件
  ```
  grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|auto[-_]restart|自動再起動|exit[ _]code[ _]?42|exit\(42\)|status === 42' docs/ CLAUDE.md README*.md
  ```
- **検証コマンド**: `grep -rnE 'exit code 42|auto-restart|auto_restart|自動再起動|ソースファイル mtime' docs/ CLAUDE.md`

### サブタスク 2: テストファイル再確認

- **目的**: 計画時点で grep 0 件だが、mock や間接参照が残っていないかを最終確認
- **対象ファイル**: `skills/cmux-team/manager/*.test.ts`
- **作業**:
  1. `grep -nE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|restartRequested' skills/cmux-team/manager/*.test.ts` を実行
  2. 0 件であればサブタスク 2 は何もせずスキップ
  3. 見つかった場合は該当テスト（またはアサーション行）を削除
- **完了条件**: 上記 grep が 0 件

### サブタスク 3: daemon.ts から削除

- **目的**: auto-restart の核である source watcher ロジックと state field を削除
- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **作業**:
  1. **L68**: `sourceMtimes: Map<string, number>;` を削除
  2. **L69**: `restartRequested: boolean;` を削除
  3. **L332-333**: `createDaemon` 内の `sourceMtimes: new Map(),` と `restartRequested: false,` を削除
  4. **L402-418**: `initSourceWatcher()` 関数全体を削除
  5. **L420-438**: `checkSourceChanged()` 関数全体を削除
  6. **L1282-1291**: `tick()` 内の `if (state.sourceMtimes.size > 0) { ... }` ブロック全体を削除（`stopDaemon(state)` / `state.restartRequested = true;` を含む）
  7. 未使用 import の整理:
     - `readdir` は `daemon.ts:706` の `restoreMasters`（`mastersDir` 読み取り）で使用中のため **残す**
     - `stat` は `daemon.ts:411` / `daemon.ts:428`（いずれも `initSourceWatcher` / `checkSourceChanged` 内）でしか使われていないため、今回の関数削除で完全未使用になる → import 文から **削除する**
     - 念のため `grep -nE '\bstat\(' skills/cmux-team/manager/daemon.ts` で 0 件を確認してから import 削除
- **メソッド制約**:
  - `stopDaemon(state)` 自体は削除しない（`onReload` / `shutdown` 経路で使用中）
  - `DaemonState` 型宣言の他フィールドの順序は変更しない
- **完了条件**: `grep -nE 'source_changed|initSourceWatcher|checkSourceChanged|sourceMtimes|restartRequested' skills/cmux-team/manager/daemon.ts` が 0 件
- **検証コマンド**: `bunx tsc --noEmit 2>&1 | grep 'skills/cmux-team/manager/daemon\.ts'`（新規エラー 0 件）

### サブタスク 4: main.ts から削除

- **目的**: daemon 側の削除と整合する形で call site と exit 42 再起動ループを撤去
- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **作業**:
  1. **L33**: import 文の `initSourceWatcher` を削除（他 import はそのまま）
  2. **L557-558**: `// ソースファイル mtime 監視を初期化` コメント + `state.sourceMtimes = await initSourceWatcher();` を削除
  3. **L1050-1060**: `// ソース変更による再起動要求` コメント + `if (state.restartRequested) { ... process.exit(42); }` ブロック全体を削除
  4. **L713-744**: `onReload` 内の exit 42 while ループを以下に置換:
     ```ts
     const { execFileSync } = require("child_process");
     try {
       execFileSync("bun", ["run", latestMainTs, "start"], {
         stdio: "inherit",
         env: process.env,
         cwd: process.cwd(),
       });
     } catch (e: any) {
       await log("error", `daemon reload exec failed status=${e.status ?? 1}`);
     }
     process.exit(0);
     ```
  5. `MAX_RESTARTS` / `daemon_reload_restart` ログイベントの参照が onReload 内に残らないことを確認
- **メソッド制約**:
  - `await log("daemon_reload")` と `await log("daemon_reload_target", latestMainTs)` は残す（dashboard `r` キー経由のユーザー操作ログ）
  - `stopDaemon(state)` / `state.fileWatcherAbort?.abort()` / `releasePidFile(pidFilePath)` の呼び出し順序は変更しない（onReload 冒頭の watcher 停止 → pidfile release → exec の流れは維持）
  - `unmountDashboard()` は onReload 冒頭に残す
- **完了条件**: `grep -nE 'source_changed|daemon_auto_restart|initSourceWatcher|sourceMtimes|restartRequested|exit\(42\)|status === 42|daemon_reload_restart' skills/cmux-team/manager/main.ts` が 0 件
- **検証コマンド**: `bunx tsc --noEmit 2>&1 | grep 'skills/cmux-team/manager/main\.ts'`（新規エラー 0 件）

### サブタスク 5: bin/cmux-team.js から exit 42 ループ削除

- **目的**: CLI ラッパー側のデッドコード化する再起動ループを撤去
- **対象ファイル**: `bin/cmux-team.js`
- **作業**:
  1. L26-47 の `if (args[0] === "start") { ... } else { ... }` 分岐を削除
  2. 代わりに全コマンド共通で以下のみを実行:
     ```js
     try {
       execFileSync("bun", ["run", mainTs, ...args], { stdio: "inherit" });
     } catch (e) {
       process.exit(e.status ?? 1);
     }
     ```
- **完了条件**:
  - `grep -nE 'MAX_RESTARTS|restarts|status === 42|auto-restart' bin/cmux-team.js` が 0 件
  - `cmux-team start` が単発 `bun run main.ts start` で起動し、終了コードがそのまま親に伝播する
- **検証コマンド**: `node bin/cmux-team.js status`（副作用なしコマンドで wrapper が生きていることを確認）

### サブタスク 6: 受け入れ条件の grep 確認

- **目的**: タスク記載の受け入れ条件を機械的に確認
- **作業**:
  1. `grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|restartRequested' skills/cmux-team/manager/` → 0 件
  2. 次の拡張 grep が docs / メタ情報から 0 件:
     ```
     grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|auto[-_]restart|自動再起動|exit[ _]code[ _]?42|exit\(42\)|status === 42' docs/ CLAUDE.md README*.md
     ```
  3. `grep -rnE 'exit.*42|exit 42|status === 42|exit\(42\)' bin/ skills/cmux-team/manager/ docs/ CLAUDE.md` → 0 件
- **完了条件**: 上記 3 つすべて 0 件

### サブタスク 7: 静的検査と自動テスト

- **目的**: コンパイル・テスト両方の回帰検知
- **作業**:
  1. `bunx tsc --noEmit` を実行 → 新規エラー 0 件であること
  2. `cd skills/cmux-team/manager && bun test` を実行 → 全件 pass
- **完了条件**:
  - tsc の出力差分が 0（着手前と同じ）
  - `bun test` が全 pass（skip 含む）

### サブタスク 8: 手動動作確認（E2E）

- **目的**: 実際に daemon を起動し直して操作が通ることを確認
- **作業**:
  1. 既存 daemon があれば `cat .team/daemon.pid | xargs kill` で停止
  2. `cmux-team start` で再起動（初回 log に `daemon_started` が出ることを確認）
  3. `cmux-team status` で Conductor 一覧が取れることを確認
  4. 簡単なタスクを 1 件 `ready` 昇格 → 割り当て → close まで通ることを確認（任意：既存の `summary.md` 生成タスクを流用）
  5. 上記手順を summary.md に記載
- **完了条件**: daemon の起動・停止・タスク割当が通常通り動作し、`manager.log` に以下のログが **1 件も新規発火しない** こと
  - `source_changed`
  - `daemon_auto_restart`
  - `daemon_reload_restart`（Decision Log D2 と整合：exit 42 ループ撤去後は発火経路なし）

## 5. リスク

### 既存機能への影響

| リスク | 軽減策 |
|---|---|
| `stopDaemon` を source_changed 経路から削除する際に、別経路の `stopDaemon` 呼び出しを誤って削除する | サブタスク 3 の作業 6 で対象行を行番号指定で限定削除。`stopDaemon` 関数定義（L363-385）には触れない |
| `onReload` exit 42 ループ削除で、想定外の exit 42 が出た場合に再起動しなくなる | auto-restart 以外に exit 42 を生成する経路は存在しない（grep で確認済み）。将来どこかで混入しても catch 節でログに残るため早期発見可能 |
| `DaemonState` 型から `sourceMtimes` / `restartRequested` を削除した際に、型参照箇所のコンパイルエラー | tsc が検知する。サブタスク 3 / 4 の完了条件に組み込み済み |
| docs の記述削除で他 doc の cross-reference 先が消える | `docs/spec/05` / `06` と `CLAUDE.md` 以外に該当言及は grep 0 件で確認済み |

### エッジケース

- **daemon 実行中に自分のソースを editor で保存しても何も起きない** のが新しい正常動作。既存ユーザーがこの挙動を頼りにしていた場合は振る舞いが変わる。ただし CLAUDE.md のメモリポリシー（後方互換性コードは不要）と T294（`task` モード廃止）の先例に従い、フォールバック・警告は追加しない
- **dashboard の `r` キー（onReload）は生きる**。ユーザーが明示的に reload を要求する経路のみ残るのは正しい（意図が明確な再起動だけが残る）
- **`daemon_reload_restart` ログイベントは発火経路がなくなる**。検索しても 0 件になるが、旧ログの閲覧には影響しない（新規発火しないだけ）

### テスト戦略

- 自動テスト: 既存 `bun test` suite（`daemon.test.ts` など）が新規フィールド参照なしで pass することを確認（サブタスク 7）
- 型検査: `bunx tsc --noEmit`（サブタスク 7）
- 手動 E2E: 実際の `cmux-team start` → タスク投入 → 完了（サブタスク 8）
- grep による **存在しないこと** の検査: 受け入れ条件に直接対応（サブタスク 6）

## 6. 既存型エラーの先読み

```
$ bunx tsc --noEmit 2>&1 | grep -E "^(skills/cmux-team/manager/daemon\.ts|skills/cmux-team/manager/main\.ts)"
（出力なし）
```

### 6.1 スコープで解消

- 該当なし（着手前から既存エラーなし）

### 6.2 後続 cleanup に分離

- 該当なし

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `DaemonState.restartRequested` フィールドを削除するか残すか | **削除** | 現状唯一の setter が `tick()` 内の source_changed ブロック（1 箇所）のみ。reader も `main.ts` の exit 42 ブロック 1 箇所のみ。両方消えるのでフィールド自体を残す意味がない。将来 restart 要求が必要になれば再度追加すれば足りる（YAGNI）。型定義の簡素化が監査容易性の観点でも正しい |
| D2 | `main.ts onReload` 内の exit 42 while ループ + `bin/cmux-team.js` の同等ループを削除するか残すか | **削除** | exit 42 を生成する経路は `main.ts` L1059 の `process.exit(42)` のみ。この 1 箇所を消すと exit 42 は永久に発生しなくなるため、ループ側もデッドコード。後続メンテ時に「なぜ exit 42 のみ特別扱いしているのか」を調査する工数を払わせるべきでない。両ファイルを同じコミットで修正して整合性を保つ |
| D3 | `daemon_reload` 機能（dashboard `r` キー）自体の使用状況 | **スコープ外 / 残す** | `dashboard.tsx:1678` で `r` キー → `opts.onReload?.()` の経路で使用中。grep 結果では dashboard 以外の呼び出し元はないが、ユーザーが TUI から明示的に要求する経路は**意図が明確な再起動**であり、auto-restart と性質が異なる。今回のタスクの問題（自己参照 race）とは無関係なので削除しない。もし実利用されていない場合の撤去は別タスクで判断する |

## 8. 備考

- T298 / T300 の log / task-state.json の事後修正は本タスクのスコープ外（T300 の `aborted` は残す）
- 一般ユーザーへの影響は実質なし（`manager/*.ts` を編集する経路は cmux-team 開発者のみ）
- CLI インターフェース変更なし、env / config の追加なし
- 開発者 DX: コード変更時は手動で `cat .team/daemon.pid | xargs kill` → `cmux-team start` に戻す。bun の起動は 1 秒以下でストレスにならない
