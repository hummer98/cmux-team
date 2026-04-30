# 実装計画: T355 ANTHROPIC_CUSTOM_HEADERS を改行区切りに修正

## 概要

`api_usage.role` 列に `master, x-cmux-surface: surface:123` のような汚染値が保存されている問題を、**送信側 (`ANTHROPIC_CUSTOM_HEADERS`) のセパレータをカンマから改行 (`\n`) に直すだけ**で解消する。proxy / DB スキーマには既に `role` 列と `surface` 列が分離した正しい受け入れ口があり (`proxy.ts:619-623`, `:1055-1056`)、追加処理は不要。

公式仕様 (https://code.claude.com/docs/en/llm-gateway) では `ANTHROPIC_CUSTOM_HEADERS` は **改行 (`\n`) 区切り** の `Key: Value` ペア。カンマ区切りは仕様外で SDK は全体を1ヘッダー値として送ってしまうため、proxy 側の `req.headers.get("x-cmux-role")` がカンマ以降を含む汚染値を拾っていた。

DB に既に保存されている汚染データの物理 migration はしない（タスクの「やってほしくないこと」）。

## 変更対象ファイル一覧

タスク本文に記載された行番号は古く、実際の grep 結果と一致しなかった。以下が 2026-04-27 時点の正しい位置。

### 1. `skills/cmux-team/manager/main.ts:1957` — master surface

**Before:**
```ts
// L1954
    // T304/T323: Claude Code native の ANTHROPIC_CUSTOM_HEADERS 経由でロール識別 + surface 識別。
    // proxy 側は x-cmux-surface 優先で MasterState/ConductorState の tokenHandle を解決する。
    env: {
      ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master, x-cmux-surface: ${surface}`,
    },
```

**After:**
```ts
    // T304/T323/T355: Claude Code native の ANTHROPIC_CUSTOM_HEADERS は改行区切り（公式仕様）。
    // カンマ区切りで連結すると SDK が全体を 1 ヘッダー値として送り role 列が汚染されるため \n で分離する。
    env: {
      ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master\nx-cmux-surface: ${surface}`,
    },
```

### 2. `skills/cmux-team/manager/main.ts:2114` — conductor surface

**Before:**
```ts
// L2111
  const conductorSettings: Record<string, any> = {
    // T304/T323: Claude Code native の ANTHROPIC_CUSTOM_HEADERS 経由でロール + surface 識別。
    env: {
      ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor, x-cmux-surface: ${surface}`,
    },
```

**After:**
```ts
  const conductorSettings: Record<string, any> = {
    // T304/T323/T355: ANTHROPIC_CUSTOM_HEADERS は改行区切り（公式仕様）。
    env: {
      ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor\nx-cmux-surface: ${surface}`,
    },
```

### 3. `skills/cmux-team/manager/main.ts:2043` — agent surface（変更不要）

```ts
    env: {
      ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: agent",
    },
```

agent は **単一ヘッダーのみ**で連結されていないため、汚染は発生せず修正対象外。タスク本文も「現状は連結なしだが grep で他箇所の同種汚染指定も確認」とあり、grep 結果からも他に連結指定は無いことを確認済み（下記）。

## grep 結果

```
$ grep -rn "ANTHROPIC_CUSTOM_HEADERS" skills/cmux-team/
skills/cmux-team/manager/runtime-backend.ts:178:  // ANTHROPIC_CUSTOM_HEADERS  → metadata で表現   ← コメントのみ
skills/cmux-team/manager/main.ts:1954:    // T304/T323: ...                                         ← コメント
skills/cmux-team/manager/main.ts:1957:      ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master, ...`   ← 修正対象 (master)
skills/cmux-team/manager/main.ts:2041:    // T304: ...                                              ← コメント
skills/cmux-team/manager/main.ts:2043:      ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: agent",        ← 修正不要 (単一値)
skills/cmux-team/manager/main.ts:2112:    // T304/T323: ...                                         ← コメント
skills/cmux-team/manager/main.ts:2114:      ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor, ...` ← 修正対象 (conductor)
skills/cmux-team/manager/main.ts:2273:    // per-surface settings ...                               ← コメント
skills/cmux-team/manager/main.ts:2360:    // per-surface settings ...                               ← コメント
skills/cmux-team/manager/main.ts:2413:    // per-surface settings ...                               ← コメント
skills/cmux-team/manager/main.test.ts:1891-1927:  ...期待値で参照                                  ← テスト追従修正対象
skills/cmux-team/manager/claude-code-backend.ts:107,111: ...コメント                                ← コメントのみ
```

- **`skills/cmux-team/templates/`** には `ANTHROPIC_CUSTOM_HEADERS` も `x-cmux-role` も `x-cmux-surface` も無し（grep 結果ゼロ件）。テンプレート側の修正は不要。
- **`docs/research/research-claude-code-observability.md`** には研究ノート（公式仕様の引用）として既に `\n` 区切り例が書かれており、今回の修正方針と整合している。

## 既存テストへの影響評価

`skills/cmux-team/manager/main.test.ts` の以下 2 箇所が**期待文字列をカンマ区切りで固定している**ため、改修と同時にテスト側も改行区切りに更新する必要がある。これは production code と一緒に直すべき正当な追従修正。

- `main.test.ts:1891-1898` — master 用 expected が `"x-cmux-role: master, x-cmux-surface: surface:100"`
- `main.test.ts:1907-1914` — conductor 用 expected が `"x-cmux-role: conductor, x-cmux-surface: surface:200"`
- `main.test.ts:1922-1928` — agent 用 expected `"x-cmux-role: agent"` は **変更不要**

`proxy.test.ts` の既存テスト（L1210, L1260, L1309, L1395, L1426, L1479, L1517 等）は **既に分離ヘッダー** (`{ "x-cmux-role": "master", "x-cmux-surface": "surface:m1" }`) で fetch を呼ぶ形になっているため、今回の修正で壊れない。

## テスト追加方針

### 追加先: `skills/cmux-team/manager/main.test.ts`

既存の `describe("generateMasterSettings ...")` / `describe("generateConductorSettings ...")` ブロック内の expected 値を改行区切りに更新する。

**Before (L1895-1897):**
```ts
expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
  "x-cmux-role: master, x-cmux-surface: surface:100",
);
```

**After:**
```ts
expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
  "x-cmux-role: master\nx-cmux-surface: surface:100",
);
```

conductor 側 (L1911-1913) も同様に `"x-cmux-role: conductor\nx-cmux-surface: surface:200"` に更新。

加えて T355 regression として「カンマ + 半角スペース (`, `) が `ANTHROPIC_CUSTOM_HEADERS` 値の中に **含まれていない**」アサーションを 1 ケース追加し、将来の意図せぬ退行を検出する。

```ts
test("T355: ANTHROPIC_CUSTOM_HEADERS にカンマ区切りが混入しない（改行区切り厳守）", () => {
  const masterPath = generateMasterSettings(testDir, "surface:100");
  const conductorPath = generateConductorSettings(testDir, "surface:200");
  const master = JSON.parse(readFileSync(masterPath, "utf-8"));
  const conductor = JSON.parse(readFileSync(conductorPath, "utf-8"));
  expect(master.env.ANTHROPIC_CUSTOM_HEADERS).not.toContain(", x-cmux-surface");
  expect(conductor.env.ANTHROPIC_CUSTOM_HEADERS).not.toContain(", x-cmux-surface");
});
```

### 追加先: `skills/cmux-team/manager/proxy.test.ts`

公式 SDK が改行区切りの `ANTHROPIC_CUSTOM_HEADERS` を受け取って **分離ヘッダー** として送信したシナリオを再現するテストを追加する。`fetch` 呼び出し時に `x-cmux-role` と `x-cmux-surface` を別キーで渡す形は既存テストと同じだが、追加するのは「DB の `api_usage.role` / `api_usage.surface` 列に分離値が正しく入ること」の検証。

```ts
test("T355: 分離ヘッダー (x-cmux-role + x-cmux-surface) で送信時、DB に role/surface が分離保存される", async () => {
  // upstream モック起動 → proxy 起動 → fetch で分離ヘッダー送信
  const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "x-cmux-role": "master",
      "x-cmux-surface": "surface:123",
    },
    body: JSON.stringify({ model: "claude-opus-4-7", messages: [] }),
  });
  expect(res.status).toBe(200);
  await res.text();
  await new Promise((r) => setTimeout(r, 100)); // safeInsertApiUsage の遅延 INSERT 待ち

  // trace DB を直接読んで role / surface 列を検証
  const row = db.prepare("SELECT role, surface FROM api_usage ORDER BY id DESC LIMIT 1").get();
  expect(row.role).toBe("master");
  expect(row.surface).toBe("surface:123");
  expect(row.role).not.toContain("x-cmux-surface"); // 汚染が無いことの明示
});
```

既存テスト（L1200 周辺の token state 更新検証など）は同じ proxy 経路を使うため、追加テストの DB 部分の組み立ては既存パターン（`startUpstreamWithRateLimit` + `start(testDir, ...)` + trace DB の読み取り）を流用する。trace DB のオープン方法は `trace-store.test.ts` を参考にする。

## 検証手順（修正完了後に Conductor が手動で行うべき確認）

1. `cd skills/cmux-team/manager && bun test main.test.ts proxy.test.ts` で関連テストが緑になることを確認。
2. ルート CLAUDE.md の規約に従い、全テストは `for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` で順次実行（`bun test` 全体はハングするため禁忌）。
3. Manager を再起動 (`cmux-team start`) し、master/conductor/agent から実 API リクエストを 1 回ずつ発行。
4. `sqlite3 .team/traces/traces.db "SELECT DISTINCT role FROM api_usage WHERE timestamp > datetime('now','-5 minutes')"` で `role` 列が `master` / `conductor` / `agent` の **3 値のみ**になっていることを確認。汚染値（`master, x-cmux-surface: ...` 等）は新規 INSERT されないこと。
5. `SELECT DISTINCT surface FROM api_usage WHERE timestamp > datetime('now','-5 minutes')` で `surface:NNN` 形式の値のみが格納されていることを確認。
6. Manager TUI の Metrics タブのロール別集計が **3 行**で表示されることを目視確認。

## リスク・前提

- 「やってほしくないこと」を確認済み:
  - ✅ DB の汚染データを物理 migration しない（既存データは残置）。
  - ✅ `proxy.ts:619-623` の `x-cmux-role` 取得ロジックは触らない。
  - ✅ DB スキーマ変更なし。
  - ✅ `ANTHROPIC_CUSTOM_HEADERS` 以外の環境変数は触らない。
- リスク: Claude Code SDK が `ANTHROPIC_CUSTOM_HEADERS` の改行区切りを **公式通りに分離ヘッダーで送信する** という前提に依存している。仕様根拠は https://code.claude.com/docs/en/llm-gateway 。実機検証（検証手順 4-6）で実際に分離保存されることを確認するまで完全には保証できない。
- リスク: 既存の汚染データは Metrics タブで残り続けるが、これは仕様通り（migration なし）。新規データのみクリーンになる。
- 前提: agent 用 (`main.ts:2043`) は単一値のため改修不要だが、将来 surface を追加する場合は **必ず `\n` 区切り**で連結すること。コメントに T355 を追記して意図を残す。

## 実装ステップ（TDD）

1. **失敗テスト追加**: `main.test.ts` の expected を改行区切りに書き換え (`L1895-1897` / `L1911-1913`)、加えて T355 regression テスト（カンマ混入禁止）を追加。`proxy.test.ts` に分離ヘッダー → DB 分離保存の検証テストを追加。この時点で `bun test main.test.ts` は **赤**（実装側がまだカンマ区切り）。
2. **失敗確認**: `cd skills/cmux-team/manager && bun test main.test.ts` を実行し、master/conductor 関連テストが意図通り fail することを確認。
3. **実装**: `main.ts:1957` (master) と `main.ts:2114` (conductor) のテンプレート文字列の `, ` を `\n` に置換。コメントに T355 追記。`main.ts:2043` (agent) は単一値のため触らない。
4. **緑化確認**: `bun test main.test.ts proxy.test.ts` が pass することを確認。
5. **全テストパス確認**: CLAUDE.md の規約通り、`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` で全 manager テストを順次実行し regression が無いことを確認。
6. **コミット**: `feat(manager): ANTHROPIC_CUSTOM_HEADERS を改行区切りに修正して role/surface 汚染を止める (T355)` 等のメッセージで 1 コミット。
7. **クローズ前検証**: 上記「検証手順」の 3-6 を Conductor 側で実機実行し、Metrics タブの 3 行表示と DB の分離値を確認してから `close-task` する。
