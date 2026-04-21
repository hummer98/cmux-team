# Inspection: T259 pidfile ロック

## 判定

**GO**

## 完了条件チェック

- [x] 同一 `.team/` に 2 回目 start が fail-stop (exit 1) — `cmdStart` の L275 で `acquireOrExit(pidFilePath, PROJECT_ROOT)` を呼び、`PidFileLockedError` を捕捉して `console.error` + `log("pidfile_locked")` + `process.exit(1)` する実装を `pidfile.ts:148-163` で確認
- [x] stale pidfile の自動掃除 — `acquirePidFile` の EEXIST 分岐で `isAliveImpl(existingPid) === false` → `unlink` → 再試行（`pidfile.ts:106-108`）。pidfile.test.ts の Step 4（dead 上書き）で検証済み
- [x] 正常 SIGTERM / cmdStop で pidfile 削除 — `shutdown`（main.ts:464）/ `onFullQuit`（main.ts:551）/ `restartRequested`（main.ts:756）/ `onReload`（main.ts:485 execFileSync 直前）/ `cmdStop`（main.ts:1884 保険）の 5 経路に `releasePidFile` を挿入済み
- [x] auto-restart ループが壊れない — `onReload` の execFileSync 直前 L485 で release、`restartRequested` の exit 42 直前 L756 で release。どちらの経路でも子が新 PID で acquire できる構造を確認
- [x] 既存テストを壊さない — `bun test` 全体 543 pass / 0 fail

## レビュー指摘の取り込み

- [x] 改善 1: `isAlive` を `cmux.ts` から re-export — `pidfile.ts:19` で `import { isAlive as realIsAlive }`、L24 で `export { isAlive } from "./cmux"`。重複定義なし
- [x] 改善 2: `cmdStop` の sleep ループ省略 — sleep を削除し `existsSync` + 1 回の `readFile` + `isAlive` だけで即判定（main.ts:1879-1888）。体感レスポンス遅延なし
- [x] 改善 3: `acquireOrExit` の薄いラッパー — `pidfile.ts:148-163` に実装。`cmdStart` 側の追加は 3 行のみ（main.ts:274-276）
- [x] 改善 4: proxy との関係を 1 行明記 — `pidfile.ts:6-7` と `CLAUDE.md:431-432` の両方に「pidfile は daemon main.ts プロセスのみを指し、proxy は別ライフサイクル」を明記
- [x] 改善 5: CLAUDE.md 更新 — 「Manager プロトコル（内部実装）」に `### 多重起動防止（pidfile ロック — T259）` サブセクション（L422-432）、`.team/` ディレクトリ構造表に `daemon.pid` 行（L556）を追加
- [x] 改善 6: `restartRequested` で `updateTeamJson` の後・`exit(42)` の前に release — main.ts:752-757 で `updateTeamJson(state)` → `releasePidFile` → `process.exit(42)` の順を厳守

## テスト実行結果

- `bun test pidfile.test.ts`: **21 pass / 0 fail** (27 expect calls, 47ms)
- `bun test` (全体): **543 pass / 0 fail** (1211 expect calls, 20.39s)
- `bunx tsc --noEmit`: **エラーなし**

## 実装の所見

### 良い点

- **stale 判定の 4 層優先順位が明確** — (1) `isAlive` false → stale、(2) alive + ps が cmux-team → locked、(3) alive + ps が別プロセス → PID 再利用とみなし stale、(4) alive + ps 空文字 → 保守的 locked、と分岐が読みやすい。特に (4) の「誤って稼働中 daemon を潰さないため保守的に locked」は plan.md Section 2.3 の方針に従い、test で明示的に固定されている（pidfile.test.ts L248-262）
- **DI 設計が既存慣行と整合** — `isAliveImpl` / `psCommandImpl` を optional 引数で注入可能。`cmux.ts` の `__setIsAliveImpl` と重ならず、かつ決定論的なユニットテストが書ける
- **release 順序の厳格化** — 5 経路すべてで「state 永続化 → release → exit」の順を守っており、journal/team.json と pidfile の整合性が保たれる
- **auto-restart の所有権移転が 2 重に保証されている** — onReload（親）の execFileSync 直前 + restartRequested（子）の exit 42 直前、どちらの経路でも release が仕込まれている。親子どちらが先に reload を始めても壊れない
- **`cmdStop` の保険が軽量** — レビュー指摘通り sleep ループを撤去し、既存 `cmdStop` の「postMessage → 即 return」セマンティクスを壊していない

### 気になる点（GO だが将来の改善候補）

- **shutdown 経路の「保険の保険」不在** — `shutdown` 関数が例外で中断した場合、pidfile が残る可能性がある。ただし次回起動時に stale 判定で自動掃除されるため実害は限定的。仕様書でも「SIGKILL 等では残留を許容」とあるので OK
- **`psCommand` の 2 秒 timeout** — macOS/Linux の `ps -p` は通常ミリ秒で返るため 2 秒は十分だが、極端な高負荷時に timeout → 空文字 → 保守的 locked → fail-stop になり得る。実害時は `retries` 指定で吸収できるし、ログで追跡可能なので現状で十分
- **Windows サポート** — `psCommand` は win32 で常に空文字 → `isAlive` true 時は常に保守的 locked。Windows は元々対象外なので実害なし

## 総評

完了条件 5 項目・レビュー改善 6 項目をすべて満たし、テスト 543 件 pass + 型エラーなし。stale/PID 再利用/ps 失敗時の保守的 locked など境界条件が pidfile.test.ts で網羅され、auto-restart の所有権移転も onReload/restartRequested の 2 経路で二重化されている。実装品質は十分高く、このまま main にマージして問題ない。
