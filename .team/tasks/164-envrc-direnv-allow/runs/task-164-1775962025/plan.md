# T164 実装計画 — `.envrc` 追記成功時の direnv allow 案内メッセージ

## 1. 背景・ゴール

T162 で `.envrc` への `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記機能を実装したが、追記しただけでは現セッションの環境変数には反映されない。Y 分岐成功時に、ユーザーが反映に必要な手順（exit → `direnv allow` → `cmux-team start` 再実行）を理解できるよう、stdout に明示的な案内を表示する。

## 2. 変更対象ファイルと行範囲

| ファイル | 変更内容 | 行範囲（現状） |
|---|---|---|
| `skills/cmux-team/manager/envrc-prompt.ts` | Y 分岐 (`appendExportLine` 成功直後) に案内メッセージ出力 + warnings 表示の整理 | 192〜222（特に 221 直前） |
| `skills/cmux-team/manager/envrc-prompt.test.ts` | 新メッセージが console.log に出力されることを検証するテスト追加 | 末尾に新 `describe` ブロック追加 |

`main.ts` 等の呼び出し側は変更不要（`ensureEnvrcHookPrompt` の戻り値型 `EnvrcCheckResult` は維持）。

## 3. メッセージの定義場所

**結論: ハードコード日本語のまま envrc-prompt.ts 内のモジュール定数として定義する（i18n 化はしない）。**

理由:
- 既存 envrc-prompt.ts は `PROMPT_TEXT` を含めて i18n (`i18n.ts` の `t()`) を一切使っていない。今回だけ片方を i18n 化すると一貫性が崩れる。
- i18n.ts には envrc 関連キーが一つも無い。新メッセージのために英訳テーブルを追加するなら既存 `PROMPT_TEXT` も i18n 化すべきで、スコープが拡大する。
- T164 の主目的は「現セッションに反映されないことをユーザーに伝える」こと。i18n 化は別タスク（envrc-prompt 全体の i18n 化）として切り出すのが筋。

実装案（`PROMPT_TEXT` の隣に置く）:

```ts
const POST_ADD_REMINDER =
  ".envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。\n" +
  "反映には以下の手順が必要です:\n" +
  "\n" +
  "  1. 現在のセッションを exit\n" +
  "  2. シェルで: direnv allow\n" +
  "  3. cmux-team start を再実行\n" +
  "\n" +
  "（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）";
```

エクスポートはしない（テストは console.log の捕捉で検証する）。

## 4. Y 分岐内のフロー詳細

現状の Y 分岐（192〜222 行）:
1. `appendExportLine(envrcPath)` — 失敗時は `console.error` + return
2. `direnvPath` 検出
3. direnv あり → `direnv allow` 実行（失敗時は warnings に追加）
4. direnv なし → warnings に "direnv が見つかりません — シェルを再起動するまで反映されません" を追加
5. `log("envrc_hook_disabled_added", ...)` + return

**変更後のフロー:**
1〜4 は同じ。
5. **新規:** `console.log(POST_ADD_REMINDER)` で標準案内を出力
6. **新規:** `warnings` が空でなければ `console.warn` で 1 件ずつ出力（既存は呼び出し側で warnings を処理する想定だったが、stdout/stderr で確実にユーザーに見せる）
7. `log("envrc_hook_disabled_added", ...)` + return

> 注: 6 の warnings 出力を実装に含めるかは判断分かれる。`main.ts` 側で既に warnings を表示しているなら二重表示になる。**実装前に `main.ts` で `result.warnings` がどう処理されているかを Read で確認すること。** 既に表示している場合は 6 をスキップし、5 のみ追加する。

## 5. テスト追加方針

### 既存テストパターンの踏襲

`envrc-prompt.test.ts` は Bun test (`bun:test`) で、`mkdtemp` で隔離ディレクトリを作り `ensureEnvrcHookPrompt(testDir, opts)` を呼ぶ形式。

### 新規テスト

`describe("ensureEnvrcHookPrompt - 追記成功時の案内", ...)` を追加。

**console.log 捕捉方法:** Bun test の `spyOn` を使う。

```ts
import { spyOn } from "bun:test";

test("Y 入力で direnv allow 手順案内が console.log に出力される", async () => {
  await writeFile(join(testDir, ".envrc"), "source_up\n");
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const r = await ensureEnvrcHookPrompt(testDir, {
      ...baseOpts,
      direnvPath: "/usr/bin/direnv",
      runDirenvAllow: async () => {},
      ask: ttyAsk("Y"),
    });
    expect(r.action).toBe("added");
    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました");
    expect(allOutput).toContain("direnv allow");
    expect(allOutput).toContain("cmux-team start を再実行");
  } finally {
    logSpy.mockRestore();
  }
});

test("n 入力では案内は出力されない", async () => {
  await writeFile(join(testDir, ".envrc"), "source_up\n");
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("n") });
    expect(r.action).toBe("skipped_once");
    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).not.toContain("CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました");
  } finally {
    logSpy.mockRestore();
  }
});

test("N 入力でも案内は出力されない", async () => {
  await writeFile(join(testDir, ".envrc"), "source_up\n");
  await mkdir(join(testDir, ".team"), { recursive: true });
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("N") });
    expect(r.action).toBe("silenced");
    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).not.toContain("CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました");
  } finally {
    logSpy.mockRestore();
  }
});

test("appendExportLine が失敗した場合は案内も出力されない", async () => {
  // .envrc 自体は存在させ、append 時に失敗させるのは難しいため、
  // モジュールのアンエクスポート関数を直接 mock するのは過剰。
  // 代替: action !== "added" のケースで案内が出ないことを n/N で担保済みとし、
  // append 失敗ケースは既存テスト範囲外（実装の return 直前で console.log を呼ばないことを実装で保証）。
});
```

### 既存テストへの影響

既存テスト `Y 入力で .envrc に追記される / config は不変` 等は console.log mock を入れていないため、新メッセージが実テストランナーの stdout に出力される。Bun test の出力が汚れるだけで pass/fail には影響しないが、気になる場合は既存テストにも `spyOn(console, "log").mockImplementation(() => {})` を追加する（任意）。

## 6. 実装手順（TDD）

1. **テスト追加** — `envrc-prompt.test.ts` に上記 3 ケース（Y で出力 / n で非出力 / N で非出力）を追加。`bun test envrc-prompt.test.ts` を実行して fail することを確認。
2. **実装** — `envrc-prompt.ts` の Y 分岐に `POST_ADD_REMINDER` 定数定義と `console.log(POST_ADD_REMINDER)` 呼び出しを追加。
3. **テスト緑化** — `bun test envrc-prompt.test.ts` で全テストが pass することを確認。
4. **既存テスト確認** — 念のため `bun test` で他のテストへの副作用がないことを確認。
5. **手動確認（任意）** — テスト用 `.envrc` を作って `bun run skills/cmux-team/manager/main.ts start` を実行し、Y を入力して案内が表示されるか確認。

## 7. 実装前に確認すべき事項

1. **`main.ts` での warnings 処理** — `ensureEnvrcHookPrompt` 呼び出し箇所を grep し、`result.warnings` が既に表示されているか確認。表示済みなら本実装で warnings を再表示しない。
   ```bash
   grep -rn "ensureEnvrcHookPrompt\|EnvrcCheckResult" skills/cmux-team/manager/
   ```
2. **`spyOn` の import パス** — Bun test の `spyOn` は `bun:test` から import 可能。バージョンによって挙動差がある可能性があるので、まず最小 1 ケースで動作確認してから残りを書く。

## 8. 懸念事項・判断保留

| 懸念 | 判断 |
|---|---|
| direnv 未導入判定で表示メッセージを変えるか | **変えない**。タスク指示の文面通り、固定メッセージ末尾に「direnv 未導入の場合は…」の注記を含む。direnv なしでも warnings は別途出るので二重案内になるが、ユーザー視点で安全側（手順を読めば対応できる）。|
| direnv allow を case 内で既に実行している場合の案内文の整合性 | direnv ありで `direnv allow` が成功しても、**現セッションの環境変数は更新されない**（子プロセスで実行しているため）。よって「exit → direnv allow → 再実行」の案内は direnv 有無に関わらず正しい。|
| `console.log` か `console.error` か | **`console.log`（stdout）**。エラーではなく成功時の情報案内なので。タスク指示も「stdout に表示」と明記。|
| i18n 化 | 本タスクではしない（4 章参照）。必要なら別タスクとして起票。|
| 将来 `result.action === "added"` 時の戻り値に reminder メッセージを含めて呼び出し側で表示する設計に変えるべきか | しない。`ensureEnvrcHookPrompt` は対話的副作用（readline）を持つ関数なので、案内も同関数内で完結する方が責務として自然。|

## 9. 完了条件 (DoD)

- [ ] `envrc-prompt.test.ts` に Y/n/N 各分岐の console.log 出力検証テストが追加されている
- [ ] `bun test envrc-prompt.test.ts` が全件 pass する
- [ ] Y 分岐成功時に指定の 6 行（タイトル + 空行 + 3 手順 + 空行 + direnv 未導入注記）が console.log で stdout に出力される
- [ ] n / N 分岐では案内が出力されない
- [ ] `bun test`（全体）が regression なし
