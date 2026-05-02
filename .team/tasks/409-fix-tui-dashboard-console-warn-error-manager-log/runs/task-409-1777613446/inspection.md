# T409 検品レポート — dashboard 起動時の console.warn / console.error → manager.log redirect

**評価判定: GO with minor concerns**

実装は plan.md / 受け入れ条件をほぼ完全に満たしている。テスト・tsc も pass。
ユーザー体験面でいくつか fall-through 的な懸念（startup 失敗時の console.error 経路、
parseLogLine の prefix 未対応、fire-and-forget 時の Promise rejection）はあるが、いずれも
plan.md 内で議論済みかつ scope 外として明示されているため、本タスクの GO/NOGO 判定としては
GO。残課題は minor concerns に列挙する。

---

## 1. コードレビュー

### logger.ts (skills/cmux-team/manager/logger.ts)

- **責務分離**: `appendLine(level, event, detail)` を internal helper に切り出し、`log` / `warn` / `error` から呼ぶ構造は plan.md 通り。重複した mkdir/appendFile なし。
- **CMUX_TEAM_LOGGER_STRICT**: `appendLine` 内 1 箇所に集約され、warn / error にも自動適用される（plan §2.4 通り）。
- **行頭フォーマット**:
  - `log()` (level=info): `levelPrefix = ""` → `[<ts>] <event> <detail>` で **既存と完全互換**。logger.test.ts 165-202 行目の compat ケースで `\\] ${event} from=info-compat` と `\\] \\[warn\\] ${event}` の不一致をそれぞれ検証。
  - `warn()`: `levelPrefix = "[warn] "` → `[<ts>] [warn] <event> <detail>`。
  - `error()`: `levelPrefix = "[error] "` → `[<ts>] [error] <event> <detail>`。
- **import 影響**: `log` は引き続き export されており既存呼び出し 26 箇所に regression なし（grep 確認済み）。

### dashboard.tsx

- **import 追加** (dashboard.tsx:19): `installDashboardConsoleRedirect` を `./dashboard-console-redirect` から import。plan §3.3 通り。
- **install 位置** (dashboard.tsx:1464-1467): `process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1"` の直後・`createNodeApp` 呼び出し直前。plan §3.2 通り、TUI セットアップの一部として正しく配置されている。
- **コメント**: `// T409: ...` で意図が明示されている。

### dashboard-console-redirect.ts (新規)

- **API**: `installDashboardConsoleRedirect(): { restore: () => void }` を export。plan §3.1 通り。
- **monkey-patch**: `console.warn` / `console.error` を保存して `logWarn` / `logError` 経由で append にすり替える実装。
- **formatArgs**:
  - `Error` instance: `${a.message}\n${a.stack}` → 適切。
  - `string`: そのまま。
  - その他: `JSON.stringify(a)` → 失敗時 `String(a)` で fallback。
  - 循環参照テスト・`undefined`/`null` 等の edge ケースは plan に明示なし。`JSON.stringify(undefined)` は `undefined` 値を返し最終的に `.join(" ")` で空文字になるが副作用なし。
- **循環呼び出し**: `logWarn` / `logError` は **`appendLine` 経由で fs append のみ** を行い、内部で `console.warn` / `console.error` を呼ばない（logger.ts に console 呼び出しなし）。再帰の懸念なし。
- **fire-and-forget**: `void logWarn(...)`。詳細は §3 minor concerns で議論。

### dashboard-console-redirect.test.ts (新規)

- 3 ケース。plan §4.3 からの逸脱は impl-summary §2 に明記された stderr capture → 原 console function 参照スタブへの変更。意図不変条件（dashboard 中に元 console 経路が起動しないこと）を等価に検証しており妥当。
- `flushAsyncLog`: `setTimeout(50ms) + setImmediate * 5`。impl-summary §2 / plan §6.4 で議論済み。実行は 124ms で安定。

### logger.test.ts 追加分

- 3 ケース: warn prefix / error prefix / log 既存互換。互換性検証で `[warn]` / `[error]` が prefix として注入されない negative 検証も含み、十分。

### 既存 console.warn / console.error 呼び出しへの副作用

`grep -n "console\\.\\(warn\\|error\\)" dashboard.tsx` で確認した結果、dashboard.tsx 内の console.error は 2 箇所のみ（2430-2431）で、いずれも `app.start()` 失敗時の path（後述 minor concern §1）。他ファイルへの影響は redirect が dashboard プロセスに閉じているため皆無。

---

## 2. テスト・tsc 実行結果

### bun test

```bash
$ cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-console-redirect.test.ts
bun test v1.3.13 (bf2e2cec)
 3 pass
 0 fail
 6 expect() calls
Ran 3 tests across 1 file. [124.00ms]

$ bun test --timeout 30000 logger.test.ts
bun test v1.3.13 (bf2e2cec)
 22 pass
 0 fail
 33 expect() calls
Ran 22 tests across 1 file. [40.00ms]
```

合計 **25 pass / 0 fail**。impl-summary の数字と一致。

### tsc

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | wc -l
0
```

エラー 0 行。変更ファイル関連の新規エラーなし。

---

## 3. 受け入れ条件 (plan.md §5) チェック

| # | 条件 | 結果 | 根拠 |
|---|------|------|------|
| 1 | `logger.ts` に `warn` / `error` が export | ✅ | logger.ts:90/94 |
| 2 | append 経路が共通 helper に集約 | ✅ | logger.ts:69-86 `appendLine` |
| 3 | `warn()` 出力行が `[<ts>] [warn] <event> <detail>` | ✅ | logger.test.ts:172-178 |
| 4 | `error()` 出力行が `[<ts>] [error] <event> <detail>` | ✅ | logger.test.ts:182-188 |
| 5 | `log()` は既存形式と完全互換 | ✅ | logger.test.ts:192-201 で negative 検証 |
| 6 | `CMUX_TEAM_LOGGER_STRICT` が warn/error にも適用 | ✅ | appendLine 内 1 箇所集約 |
| 7 | `dashboard-console-redirect.ts` 新規作成 | ✅ | 45 行、import / formatArgs / install |
| 8 | `installDashboardConsoleRedirect()` が `{ restore }` 返却 | ✅ | dashboard-console-redirect.ts:14-31 |
| 9 | `dashboard.tsx` 内 `createNodeApp` 直前で install 呼び出し | ✅ | dashboard.tsx:1467 |
| 10 | dashboard.tsx 冒頭に import | ✅ | dashboard.tsx:19 |
| 11 | redirect 中 `console.warn` / `console.error` が原経路を起動せず manager.log に流れる | ✅ | dashboard-console-redirect.test.ts case 2 |
| 12 | `console.log` の挙動は変更されない | ✅ | install 関数は warn/error のみ touch |
| 13 | CLI 一発モードでは redirect 非起動 | ✅ | install 呼び出しは `startDashboard()` 内のみ。`cmdStatus` / `cmdStart` の preflight からは呼ばれない |
| 14 | 新規 3 ケースが pass | ✅ | 3 pass |
| 15 | `logger.test.ts` 追加 3 ケースが pass | ✅ | 22 pass（含む追加 3） |
| 16 | regression なし | ✅ | logger.test.ts 全 22 ケース pass |
| 17 | 既存 `log()` 呼び出し 26 箇所が従来通り動作 | ✅ | log() の signature・出力フォーマット完全互換 |

**受け入れ条件 17/17 全て充足。**

### 「Manager TUI 上で `type=POST_TOOL_USE size=NNNN` の残骸が出ない」の検証

コードレベル検証: dashboard 起動後に external lib が `console.warn(...)` / `console.error(...)` を呼ぶと `dashboard-console-redirect.ts:18-23` でつかまり stderr に書かれず manager.log に流れる。したがってペイン上に残骸は出ない（理屈上保証される）。

実機検証（実際に巨大 hook payload を送り込む）は本セッションでは未実施だが、不変条件レベルでは redirect が動いていれば残骸は防げる構造になっている。

---

## 4. Minor Concerns（GO に影響しないが将来検討推奨）

### MC1: dashboard.tsx 2430-2431 の console.error が manager.log に飲み込まれる

```ts
} catch (e: any) {
  cleanup();
  console.error(t("dashboard_startup_failed", { message: e.message }));
  console.error(t("dashboard_startup_hint"));
  return { scheduleRefresh: () => {} };
}
```

`installDashboardConsoleRedirect()` 後・`app.start()` 失敗 → cleanup() → console.error 2 行。
これは redirect 後の console を呼ぶため stderr ではなく manager.log に流れる。
plan §3.4 / §6.2 で議論済みかつ「原状維持」の方針が明示されているため GO。
将来 UX 問題が判明したら、`installDashboardConsoleRedirect()` の戻り値を保持して
catch 内で `restore()` を呼んでから console.error する 1 行追加で吸収可能。

### MC2: parseLogLine が `[warn]` / `[error]` prefix を level として認識しない

`dashboard.tsx:327-337` の `parseLogLine`:

```ts
const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)/);
// ...
const event = match[2] ?? "";
const isError = event === "error";
const level = isError ? "error" as const : "info" as const;
```

新フォーマット `[<ts>] [warn] console_warn detail` を入力すると `match[2] = "[warn]"`、
`event = "[warn]"`、`level = "info"` となる。`parseJournalEntries` は具体的な event 名
（`task_received` など）にしかマッチしないため、これらの行は journal タブで filter out される
（continue）。**画面壊れは起きない**が「warn / error 行は journal に表示されない」状態になる。
plan §6.3 で scope 外と明示されているため GO。journal で warn / error も表示したい場合は
`parseLogLine` を `[warn]` / `[error]` prefix に対応させる別タスクで吸収する。

### MC3: `void logWarn(...)` の Promise rejection が unhandled

`dashboard-console-redirect.ts:18-23` で `void logWarn(...)` / `void logError(...)` を fire-and-forget。
`appendLine` 内で：
- `CMUX_TEAM_LOGGER_STRICT=1` かつ `PROJECT_ROOT` 未設定 → throw。
- `mkdir` / `appendFile` の I/O 失敗 → throw。

これらが起きると **UnhandledPromiseRejection** になる。dashboard 通常実行下で `PROJECT_ROOT`
は確実に set されており disk 書き込みも通常通るため、実害は極めて低い。一方、disk full や
permission denied のような edge ケースを考えると `.catch(() => {})` を 1 行追加しておくと
安全（既存の `log("...").catch(() => {})` パターンと一貫する）。

plan §6.1 で fire-and-forget の順序保証は許容と明記されているが rejection の取り扱いは
明示されていない。**hardening として推奨**するが本タスク GO の阻害要因ではない。

### MC4: `flushAsyncLog` の 50ms wait が将来 flaky になる可能性

impl-summary §2 / plan §6.4 で議論済み。現時点で 124ms 実行・3/3 pass で安定しているため
GO。CI 環境で flake が出始めたら `installDashboardConsoleRedirect` 側に pending Promise の
`drainPending()` 的 hook を追加する案を再検討する。

### MC5: `formatArgs` の循環参照ケースは未テスト

`JSON.stringify` が circular で throw → catch → `String(a)` で fallback する実装は正しいが、
テストでは検証されていない。将来 React component instance 等を console.warn される依存
ライブラリがあった場合に hardening として 1 ケース追加しても良い。GO 阻害要因ではない。

---

## 5. 結論

- **判定: GO with minor concerns**
- 受け入れ条件 17/17 充足、テスト 25/25 pass、tsc エラー 0 件、コード規約・既存 log() 互換性も維持。
- minor concerns は全て plan.md 内で「scope 外」「将来検討」として明示済みか、disk full のような edge ケース。
- 即マージ可能。MC1 / MC3 については別タスク化または follow-up commit を推奨。

### 推奨フォロー（任意）

1. MC3 の hardening: `void logWarn(...).catch(() => {})` 1 行追加で `appendFile` 失敗時の unhandled rejection を抑止（既存 `log(...).catch(() => {})` パターンと整合）。
2. MC2 の parseLogLine 拡張: `[warn]` / `[error]` prefix を吸い上げて `level` を返す（既に `level` を返す signature を持っているため小修正）。journal タブで warn/error 行が見えるようになる。
3. MC1 の startup 失敗 UX: 必要なら `restore()` を catch 内で呼んでから console.error する 1 行追加。
